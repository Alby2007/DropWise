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
}

interface DmmfField {
  name: string;
  kind: string;
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

export async function parseSchema(datamodel: string): Promise<Result<{ datamodel: { models: DmmfModel[] } }>> {
  const errors: string[] = [];
  for (const p of PARSERS) {
    try {
      const getDMMF = p.load();
      return { ok: true, value: await getDMMF({ datamodel }) };
    } catch (e) {
      const msg = stripAnsi(e instanceof Error ? e.message : String(e))
        .split('\n')
        .filter((l) => l.trim().startsWith('error') || l.includes('Error'))
        .slice(0, 3)
        .join(' ');
      errors.push(`${p.name}: ${msg || 'parse failed'}`);
    }
  }
  return { ok: false, error: `Prisma schema could not be parsed — ${errors.join(' | ')}` };
}

export function toPhysicalSchema(dmmf: { datamodel: { models: DmmfModel[] } }): PhysicalSchema {
  const tables = new Map<string, PhysicalTable>();
  const warnings: string[] = [];

  for (const model of dmmf.datamodel.models) {
    const tableName = model.dbName ?? model.name;
    const table: PhysicalTable = { name: tableName, modelName: model.name, columns: new Set() };
    for (const f of model.fields) {
      if (f.kind === 'object') continue; // relation fields are not columns
      table.columns.add(f.dbName ?? f.name);
    }
    tables.set(tableName, table);
  }

  // Implicit many-to-many join tables. An implicit relation has both sides
  // marked isList with no explicit FK fields; Prisma names the table _<relationName>.
  const relations = new Map<string, { model: string; field: DmmfField }[]>();
  for (const model of dmmf.datamodel.models) {
    for (const f of model.fields) {
      if (f.kind !== 'object' || !f.isList) continue;
      if ((f.relationFromFields?.length ?? 0) > 0 || (f.relationToFields?.length ?? 0) > 0) continue;
      const key = f.relationName ?? '';
      if (!key) {
        warnings.push(`list relation ${model.name}.${f.name} has no relation name; implicit join table cannot be derived`);
        continue;
      }
      const sides = relations.get(key) ?? [];
      sides.push({ model: model.name, field: f });
      relations.set(key, sides);
    }
  }
  for (const [relName, sides] of relations) {
    if (sides.length !== 2) {
      warnings.push(`relation "${relName}" has ${sides.length} side(s); implicit join table _${relName} may be ambiguous`);
      continue;
    }
    const table: PhysicalTable = {
      name: `_${relName}`,
      columns: new Set(['A', 'B']),
      implicit: true,
    };
    tables.set(table.name, table);
  }

  return { tables, warnings };
}

export async function loadPhysicalSchema(datamodel: string): Promise<Result<PhysicalSchema>> {
  const parsed = await parseSchema(datamodel);
  if (!parsed.ok) return parsed;
  return { ok: true, value: toPhysicalSchema(parsed.value) };
}
