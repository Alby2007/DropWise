import { parse } from 'libpg-query';

export interface DropOp {
  kind: 'drop_column' | 'drop_table';
  table: string;
  column?: string;
  /** Ordering: statementIndex * 1000 + cmdIndex — lets us compare positions
   *  within one migration file. */
  order: number;
}

export interface MigrationOps {
  ok: boolean;
  parseError?: string;
  drops: DropOp[];
  /** Columns added by ALTER TABLE ... ADD COLUMN / CREATE TABLE column lists. */
  adds: { table: string; column: string; order: number }[];
  /** Tables created by CREATE TABLE in this migration. */
  creates: { table: string; order: number }[];
  /** "table.col" keys for columns that are the *target* of a RENAME COLUMN ... TO. */
  renamedColumns: Set<string>;
  /** Table names that are the target of ALTER TABLE ... RENAME TO. */
  renamedTables: Set<string>;
  /** Dynamic statements that cannot be analysed (DO blocks, functions, procedures). */
  dynamic: string[];
  hasUpdate: boolean;
}

type RawNode = Record<string, unknown>;

function unwrap(node: RawNode): { type: string; body: RawNode } {
  const keys = Object.keys(node);
  if (keys.length !== 1) return { type: '__unknown', body: node };
  return { type: keys[0], body: node[keys[0]] as RawNode };
}

function stringList(node: unknown): string[] {
  // PG name lists: [{String: {sval}}] or {List: {items: [...]}}
  const out: string[] = [];
  const visit = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const { type, body } = unwrap(n as RawNode);
    if (type === 'String') {
      const sval = (body as { sval?: string }).sval;
      if (typeof sval === 'string') out.push(sval);
    } else if (type === 'List') {
      const items = (body as { items?: unknown[] }).items ?? [];
      for (const i of items) visit(i);
    }
  };
  visit(node);
  return out;
}

function relname(relation: unknown): string | undefined {
  if (!relation || typeof relation !== 'object') return undefined;
  const r = (relation as { relname?: string }).relname;
  return typeof r === 'string' ? r : undefined;
}

export async function extractOps(sql: string): Promise<MigrationOps> {
  const result: MigrationOps = {
    ok: true,
    drops: [],
    adds: [],
    creates: [],
    renamedColumns: new Set(),
    renamedTables: new Set(),
    dynamic: [],
    hasUpdate: false,
  };

  let tree: { stmts?: { stmt: RawNode }[] };
  try {
    tree = (await parse(sql)) as { stmts?: { stmt: RawNode }[] };
  } catch (e) {
    result.ok = false;
    result.parseError = e instanceof Error ? e.message : String(e);
    return result;
  }

  const stmts = tree.stmts ?? [];
  for (let s = 0; s < stmts.length; s++) {
    const { type, body } = unwrap(stmts[s].stmt);
    const base = s * 1000;

    if (type === 'AlterTableStmt') {
      const objtype = body.objtype as string | undefined;
      if (objtype && objtype !== 'OBJECT_TABLE') continue;
      const table = relname(body.relation);
      if (!table) continue;
      const cmds = (body.cmds as RawNode[] | undefined) ?? [];
      for (let c = 0; c < cmds.length; c++) {
        const cmd = unwrap(cmds[c]);
        if (cmd.type !== 'AlterTableCmd') continue;
        const order = base + c;
        if (cmd.body.subtype === 'AT_DropColumn' && typeof cmd.body.name === 'string') {
          result.drops.push({ kind: 'drop_column', table, column: cmd.body.name, order });
        } else if (cmd.body.subtype === 'AT_AddColumn' && cmd.body.def) {
          const def = unwrap(cmd.body.def as RawNode);
          const colname =
            def.type === 'ColumnDef' ? (def.body as { colname?: string }).colname : undefined;
          if (colname) result.adds.push({ table, column: colname, order });
        }
      }
    } else if (type === 'DropStmt') {
      if (body.removeType !== 'OBJECT_TABLE') continue;
      const objects = (body.objects as unknown[] | undefined) ?? [];
      for (const obj of objects) {
        const parts = stringList(obj);
        const table = parts[parts.length - 1];
        if (table) result.drops.push({ kind: 'drop_table', table, order: base });
      }
    } else if (type === 'RenameStmt') {
      const renameType = body.renameType as string | undefined;
      const newname = body.newname as string | undefined;
      const table = relname(body.relation);
      if (renameType === 'OBJECT_TABLE' && newname) {
        result.renamedTables.add(newname);
      } else if (renameType === 'OBJECT_COLUMN' && table && newname) {
        result.renamedColumns.add(`${table}.${newname}`);
      }
    } else if (type === 'CreateStmt' || type === 'CreateTableAsStmt') {
      const table = relname(body.relation);
      if (!table) continue;
      result.creates.push({ table, order: base });
      const elts = (body.tableElts as RawNode[] | undefined) ?? [];
      for (const elt of elts) {
        const e = unwrap(elt);
        if (e.type === 'ColumnDef') {
          const colname = (e.body as { colname?: string }).colname;
          if (colname) result.adds.push({ table, column: colname, order: base });
        }
      }
    } else if (type === 'DoStmt') {
      result.dynamic.push('DO block');
    } else if (type === 'CreateFunctionStmt' || type === 'CreateProcedureStmt') {
      result.dynamic.push('function or procedure definition');
    } else if (type === 'UpdateStmt') {
      result.hasUpdate = true;
    }
  }

  return result;
}
