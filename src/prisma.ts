import type { Result } from './git';

/**
 * Physical-name mapping conventions, MAPPING_VERSION = 1.
 * Bump when any convention changes:
 *  - model -> table: @@map(dbName) if set, else model name
 *  - field -> column: @map(dbName) if set, else field name; fields with
 *    kind 'object' (relations) are not columns
 *  - implicit many-to-many -> table "_<relationName>" with columns A and B;
 *    relationName defaults to "<ModelA>To<ModelB>" (model names, not @@map)
 *  - schema-qualified SQL identifiers -> last component
 *  - matching is case-sensitive (Prisma migrations quote identifiers)
 */
export const MAPPING_VERSION = 1;

export interface PhysicalTable {
  name: string;
  modelName?: string;
  columns: Set<string>;
  implicit?: boolean;
}

export interface PhysicalSchema {
  tables: Map<string, PhysicalTable>;
  warnings: string[];
  parser: 'prisma6' | 'prisma7' | 'lenient';
}

interface DmmfField {
  name: string;
  kind: string;
  type?: string;
  isList?: boolean;
  dbName?: string | null;
  relationName?: string;
  relationFromFields?: string[];
  relationToFields?: string[];
}

interface DmmfModel {
  name: string;
  dbName?: string | null;
  fields: DmmfField[];
}

type GetDmmf = (opts: { datamodel: string }) => Promise<{ datamodel: { models: DmmfModel[] } }>;

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

const PARSERS: { name: string; load: () => GetDmmf }[] = [
  // Prisma <= 6 schemas (datasource url required) — widest real-world coverage.
  { name: 'prisma6', load: () => require('@prisma/internals6').getDMMF as GetDmmf },
  // Prisma 7 schemas (datasource url removed).
  { name: 'prisma7', load: () => require('@prisma/internals').getDMMF as GetDmmf },
];

export interface ParsedSchema {
  datamodel: { models: DmmfModel[] };
  /** Which parser produced this result; 'lenient' means DMMF rejected the
   *  schema (duplicate models, missing opposite relations, view rules, …)
   *  and a structural fallback was used. */
  parser: 'prisma6' | 'prisma7' | 'lenient';
}

/**
 * Lenient structural fallback for schemas Prisma itself committed but DMMF
 * validation rejects (duplicate models, missing opposite relation fields,
 * view blocks, …). Used only after both DMMF parsers fail. Extracts the same
 * DmmfModel shape so toPhysicalSchema applies uniformly. Duplicated models
 * are merged.
 */
export function lenientParse(text: string): { datamodel: { models: DmmfModel[] } } | null {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const lines = clean.split('\n');

  const blocks: { kind: string; name: string; body: string[] }[] = [];
  let cur: { kind: string; name: string; body: string[] } | null = null;
  const headRe = /^\s*(model|view|type|enum)\s+(\w+)\s*\{/;
  for (const line of lines) {
    if (!cur) {
      const m = headRe.exec(line);
      if (m) cur = { kind: m[1], name: m[2], body: [] };
      continue;
    }
    if (/^\s*\}/.test(line)) {
      blocks.push(cur);
      cur = null;
      continue;
    }
    cur.body.push(line);
  }

  const modelNames = new Set(blocks.filter((b) => b.kind === 'model' || b.kind === 'view').map((b) => b.name));

  const models = new Map<string, DmmfModel>();
  for (const b of blocks) {
    if (b.kind !== 'model' && b.kind !== 'view') continue;
    const model = models.get(b.name) ?? { name: b.name, dbName: null, fields: [] };
    for (const raw of b.body) {
      const line = raw.trim();
      if (!line) continue;
      const mm = /@@map\(\s*(?:name:\s*)?"([^"]+)"/.exec(line);
      if (mm) {
        model.dbName = mm[1];
        continue;
      }
      if (line.startsWith('@')) continue;
      const fm = /^(\w+)\s+([\w.]+)\s*(\[\])?\s*\??\s*(.*)$/.exec(line);
      if (!fm) continue;
      const [, fname, ftype, isList, rest] = fm;
      const mapM = /@map\(\s*(?:name:\s*)?"([^"]+)"/.exec(rest);
      const relM = /@relation\(\s*(?:name:\s*)?"([^"]+)"/.exec(rest) ?? /name:\s*"([^"]+)"/.exec(rest);
      const isObject = modelNames.has(ftype);
      const list = !!isList;
      const field: DmmfField = {
        name: fname,
        kind: isObject ? 'object' : 'scalar',
        type: ftype,
        isList: list,
        dbName: mapM ? mapM[1] : null,
        relationFromFields: /fields\s*:/.test(rest) ? ['_'] : [],
        relationToFields: [],
      };
      if (isObject && list) {
        field.relationName = relM ? relM[1] : [b.name, ftype].sort().join('To');
      } else if (relM) {
        field.relationName = relM[1];
      }
      model.fields.push(field);
    }
    models.set(b.name, model);
  }

  if (models.size === 0) return null;

  // Pair un-named relation sides: a list field `x T[]` on M pairs with the
  // object field(s) on T of type M. DMMF assigns a shared relationName to
  // both sides; the lenient parser must do it structurally so m-n detection
  // downstream can tell a real implicit relation (two list sides) from an
  // ordinary one-to-many (one list side + one FK side).
  for (const m of models.values()) {
    for (const f of m.fields) {
      if (f.kind !== 'object' || !f.isList || !f.type) continue;
      const target = models.get(f.type);
      if (!target) continue;
      const counterparts = target.fields.filter(
        (g) => g.kind === 'object' && g.type === m.name,
      );
      const named = f.relationName
        ? counterparts.filter((g) => !g.relationName || g.relationName === f.relationName)
        : counterparts;
      if (named.length !== 1) continue;
      const rel = f.relationName ?? named[0].relationName ?? [m.name, f.type].sort().join('To');
      f.relationName = rel;
      named[0].relationName = rel;
    }
  }
  return { datamodel: { models: [...models.values()] } };
}

export async function parseSchema(datamodel: string): Promise<Result<ParsedSchema>> {
  const errors: string[] = [];
  for (const p of PARSERS) {
    try {
      const getDMMF = p.load();
      const dmmf = await getDMMF({ datamodel });
      return { ok: true, value: { datamodel: dmmf.datamodel, parser: p.name as ParsedSchema['parser'] } };
    } catch (e) {
      const msg = stripAnsi(e instanceof Error ? e.message : String(e))
        .split('\n')
        .filter((l) => l.trim().startsWith('error') || l.includes('Error'))
        .slice(0, 3)
        .join(' ');
      errors.push(`${p.name}: ${msg || 'parse failed'}`);
    }
  }
  const lenient = lenientParse(datamodel);
  if (lenient) {
    return { ok: true, value: { datamodel: lenient.datamodel, parser: 'lenient' } };
  }
  return { ok: false, error: `Prisma schema could not be parsed — ${errors.join(' | ')}` };
}

export function toPhysicalSchema(parsed: ParsedSchema): PhysicalSchema {
  const datamodel = parsed.datamodel;
  const tables = new Map<string, PhysicalTable>();
  const warnings: string[] = [];
  if (parsed.parser === 'lenient') {
    warnings.push('schema failed DMMF validation; extracted with lenient structural parser');
  }

  for (const model of datamodel.models) {
    const tableName = model.dbName ?? model.name;
    const table: PhysicalTable = { name: tableName, modelName: model.name, columns: new Set() };
    for (const f of model.fields) {
      if (f.kind === 'object') continue; // relation fields are not columns
      table.columns.add(f.dbName ?? f.name);
    }
    tables.set(tableName, table);
  }

  // Implicit many-to-many join tables. An implicit relation has BOTH sides
  // marked isList with no explicit FK fields; Prisma names the table
  // _<relationName>. An ordinary one-to-many has exactly one list side (the
  // other side carries the FK fields) — group all object fields by relation
  // name so the two cases are distinguishable.
  const relations = new Map<string, { model: string; field: DmmfField }[]>();
  for (const model of datamodel.models) {
    for (const f of model.fields) {
      if (f.kind !== 'object') continue;
      const key = f.relationName ?? '';
      if (!key) {
        if (f.isList) {
          warnings.push(`list relation ${model.name}.${f.name} has no relation name; implicit join table cannot be derived`);
        }
        continue;
      }
      const sides = relations.get(key) ?? [];
      sides.push({ model: model.name, field: f });
      relations.set(key, sides);
    }
  }
  const hasFk = (f: DmmfField): boolean =>
    (f.relationFromFields?.length ?? 0) > 0 || (f.relationToFields?.length ?? 0) > 0;
  for (const [relName, sides] of relations) {
    const listNoFk = sides.filter((s) => s.field.isList && !hasFk(s.field));
    if (sides.length === 2 && listNoFk.length === 2) {
      if (sides[0].model === sides[1].model) {
        warnings.push(`self relation "${relName}" maps to implicit join table _${relName}; A/B direction is ambiguous`);
      }
      tables.set(`_${relName}`, {
        name: `_${relName}`,
        columns: new Set(['A', 'B']),
        implicit: true,
      });
      continue;
    }
    if (listNoFk.length === 0) continue; // no potential join-table side
    if (sides.length > 2 || listNoFk.length > 1) {
      warnings.push(`relation "${relName}" has ${sides.length} side(s); implicit join table _${relName} may be ambiguous`);
      continue;
    }
    // exactly one unmatched list side — could be an implicit m-n whose
    // opposite side is missing (lenient-parsed schemas) or the parser did
    // not pair the names. Warn: join-table existence cannot be confirmed.
    if (sides.length === 1) {
      warnings.push(`relation "${relName}" has an unmatched list side; implicit join table _${relName} cannot be confirmed`);
    }
    // otherwise sides=2 with one list side + one scalar-bearing side:
    // an ordinary one-to-many — no warning.
  }

  return { tables, warnings, parser: parsed.parser };
}

export async function loadPhysicalSchema(datamodel: string): Promise<Result<PhysicalSchema>> {
  const parsed = await parseSchema(datamodel);
  if (!parsed.ok) return parsed;
  return { ok: true, value: toPhysicalSchema(parsed.value) };
}
