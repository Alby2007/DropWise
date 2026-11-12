import type { Finding, Verdict } from './types';
import type { PhysicalSchema } from './prisma';
import type { HistoryIndex } from './history';
import type { MigrationOps, DropOp } from './sql';
import type { Result } from './git';

export interface ParsedMigration {
  /** Repo-relative path of migration.sql */
  path: string;
  /** Migration directory name (display) */
  name: string;
  ops: MigrationOps;
}

export interface ClassifyContext {
  base: string;
  head: string;
  baseSchema: Result<PhysicalSchema>;
  headSchema: Result<PhysicalSchema>;
  /** Lazily built history index; called only when a verdict needs it. */
  getHistory: () => Promise<HistoryIndex>;
  /** All migrations changed in this PR (for same-PR add detection). */
  migrations: ParsedMigration[];
  zeroDowntimeDeploys: boolean;
}

const short = (sha: string) => sha.slice(0, 7);

function target(op: DropOp): string {
  return op.kind === 'drop_column' ? `${op.table}.${op.column}` : op.table;
}

function targetNoun(op: DropOp): string {
  return op.kind === 'drop_column' ? 'column' : 'table';
}

function baseRecommendation(v: Verdict, op: DropOp, zeroDowntime: boolean): string {
  const noun = targetNoun(op);
  switch (v) {
    case 'SAME_PR_REMOVAL': {
      let r = `deploy code that no longer uses the ${noun} first. Once that version has fully rolled out, drop the ${noun} in a separate deployment.`;
      if (!zeroDowntime) {
        r += ` zero-downtime-deploys is off, so versions should not overlap — but background jobs or other services sharing the database may still reference the ${noun}.`;
      }
      return r;
    }
    case 'PRIOR_SCHEMA_REMOVAL': {
      let r = `confirm the version that removed the ${noun} from the schema has finished rolling out before deploying this migration.`;
      if (!zeroDowntime) {
        r += ` zero-downtime-deploys is off, so versions should not overlap — verify the removing deploy completed anyway.`;
      }
      return r;
    }
    case 'NO_PRIOR_SCHEMA_EVIDENCE':
      return `confirm manually whether any released version declared this ${noun} before relying on this verdict.`;
    case 'DESTRUCTIVE_REPLACEMENT':
      return 'prefer ALTER COLUMN ... TYPE ... USING, or add a new column, backfill it, and swap — a drop-then-recreate loses existing values.';
    case 'UNKNOWN':
      return 'review this migration manually before deploying.';
  }
}

function finding(
  op: DropOp | { kind: 'dynamic_sql' | 'unparsed'; table?: string; column?: string; detail?: string },
  migrationName: string,
  verdict: Verdict,
  summary: string,
  evidence: string[],
  recommendation: string,
  reason?: string,
): Finding {
  const operation =
    'order' in op
      ? { kind: op.kind, migration: migrationName, table: op.table, column: op.column }
      : { kind: op.kind, migration: migrationName, table: op.table, column: op.column, detail: op.detail };
  return { operation, verdict, summary, evidence, recommendation, reason };
}

function summaryFor(verdict: Verdict, op: DropOp, reason?: string): string {
  const noun = targetNoun(op);
  switch (verdict) {
    case 'SAME_PR_REMOVAL':
      return `Same-PR schema removal detected. The ${noun} is removed from the Prisma schema and the database in this pull request. Older application versions may still reference it during a rolling deployment.`;
    case 'PRIOR_SCHEMA_REMOVAL':
      return `The ${noun} is absent from the base schema, but git history shows it was declared earlier and later removed from the schema. This looks like a contract-style cleanup step; whether any deployed version still references it is unverified.`;
    case 'NO_PRIOR_SCHEMA_EVIDENCE':
      return `No declaration of this ${noun} was found in the searched history. This is not proof it never reached production.`;
    case 'DESTRUCTIVE_REPLACEMENT':
      return `The ${noun} is dropped and re-added in the same migration with no preceding data copy. Existing values will be lost.`;
    case 'UNKNOWN':
      return `Insufficient or unreliable evidence: ${reason}.`;
  }
}

export async function classifyDrop(
  op: DropOp,
  migration: ParsedMigration,
  ctx: ClassifyContext,
): Promise<Finding> {
  const key = target(op);
  const noun = targetNoun(op);
  const mk = (
    verdict: Verdict,
    evidence: string[],
    reason?: string,
    recommendation?: string,
  ): Finding =>
    finding(
      op,
      migration.name,
      verdict,
      summaryFor(verdict, op, reason),
      evidence,
      recommendation ?? baseRecommendation(verdict, op, ctx.zeroDowntimeDeploys),
      reason,
    );

  // --- same-migration structural checks (run before schema evidence) ---
  if (op.kind === 'drop_column') {
    const tableRename = migration.ops.renamedTables.get(op.table);
    if (tableRename !== undefined && tableRename < op.order) {
      return mk('UNKNOWN', [`migration renames a table to ${op.table}`],
        'column dropped on a renamed table; renames not yet supported');
    }
    const colRename = migration.ops.renamedColumns.get(key);
    if (colRename !== undefined) {
      if (colRename > op.order) {
        return mk('UNKNOWN', [`migration contains ALTER TABLE ... RENAME ... TO ${op.column}`],
          'swap pattern; renames not yet supported');
      }
      return mk('NO_PRIOR_SCHEMA_EVIDENCE', [
        `column renamed into place and then dropped within ${migration.name}`,
      ]);
    }
    const add = migration.ops.adds.find((a) => a.table === op.table && a.column === op.column);
    if (add && add.order > op.order) {
      return mk('DESTRUCTIVE_REPLACEMENT', [`column dropped and re-added within ${migration.name}`]);
    }
    if (add && add.order < op.order) {
      return mk('NO_PRIOR_SCHEMA_EVIDENCE', [`column added and dropped within ${migration.name}`]);
    }
  } else {
    const tableRename = migration.ops.renamedTables.get(op.table);
    if (tableRename !== undefined) {
      if (tableRename < op.order) {
        return mk('NO_PRIOR_SCHEMA_EVIDENCE', [
          `table renamed into place and then dropped within ${migration.name}`,
        ]);
      }
      return mk('UNKNOWN', [`migration renames a table to ${op.table} after dropping it`],
        'table swap pattern; renames not yet supported');
    }
    const create = migration.ops.creates.find((c) => c.table === op.table);
    if (create && create.order > op.order) {
      return mk('DESTRUCTIVE_REPLACEMENT', [`table dropped and re-created within ${migration.name}`]);
    }
    if (create && create.order < op.order) {
      return mk('NO_PRIOR_SCHEMA_EVIDENCE', [`table created and dropped within ${migration.name}`]);
    }
  }

  // --- schema evidence ---
  if (!ctx.baseSchema.ok) {
    return mk('UNKNOWN', [], `Prisma schema at base could not be used: ${ctx.baseSchema.error}`);
  }
  if (!ctx.headSchema.ok) {
    return mk('UNKNOWN', [], `Prisma schema at head could not be used: ${ctx.headSchema.error}`);
  }
  const baseT = ctx.baseSchema.value.tables.get(op.table);
  const headT = ctx.headSchema.value.tables.get(op.table);
  const inBase = op.kind === 'drop_table' ? !!baseT : !!baseT && baseT.columns.has(op.column!);
  const inHead = op.kind === 'drop_table' ? !!headT : !!headT && headT.columns.has(op.column!);

  // Schema-derived verdicts must disclose when extraction used the lenient
  // fallback — hand-verified evidence quality is lower there.
  const lenient: string[] = [];
  if (ctx.baseSchema.value.parser === 'lenient') lenient.push(`schema at base ${short(ctx.base)} extracted leniently (DMMF validation failed)`);
  if (ctx.headSchema.value.parser === 'lenient') lenient.push('schema at head extracted leniently (DMMF validation failed)');

  if (inBase && !inHead) {
    return mk('SAME_PR_REMOVAL', [
      `Prisma schema diff against base commit ${short(ctx.base)} and head schema`,
      ...lenient,
    ]);
  }
  if (inBase && inHead) {
    return mk('UNKNOWN', [`${noun} dropped in SQL but still declared in the head Prisma schema`],
      'schema and migration disagree');
  }

  // --- absent from base schema ---
  // Added in another migration within this PR?
  for (const m of ctx.migrations) {
    if (m === migration) continue;
    const added =
      op.kind === 'drop_column'
        ? m.ops.adds.some((a) => a.table === op.table && a.column === op.column)
        : m.ops.creates.some((c) => c.table === op.table);
    if (added) {
      return mk('NO_PRIOR_SCHEMA_EVIDENCE', [
        `${noun} added in ${m.name} and dropped in ${migration.name} within this pull request`,
      ]);
    }
  }
  if (inHead) {
    return mk('UNKNOWN', [
      `${noun} absent from base schema but declared in head schema; dropped in SQL with no adding migration found in this pull request`,
    ], 'schema and migration disagree');
  }

  const history = await ctx.getHistory();
  if (!history.ok) {
    return mk('UNKNOWN', [], history.error ?? 'git history could not be searched');
  }
  const hit =
    op.kind === 'drop_column'
      ? history.columnAdds.get(key)
      : history.tableCreates.get(op.table);
  if (hit) {
    return mk('PRIOR_SCHEMA_REMOVAL', [
      `absent from base schema at ${short(ctx.base)}; added by migration ${hit.migration} (commit ${short(hit.commit)})`,
      ...lenient,
    ]);
  }
  if (history.incomplete.length > 0) {
    return mk('UNKNOWN', [], `history search incomplete: ${history.incomplete[0]}${history.incomplete.length > 1 ? ` (+${history.incomplete.length - 1} more)` : ''}`);
  }
  return mk('NO_PRIOR_SCHEMA_EVIDENCE', [
    `${history.filesSearched} migration file(s) in git history searched; no declaration of ${key} found`,
    ...lenient,
  ]);
}

/** Findings for statements in a migration that cannot be analysed at all. */
export function dynamicFindings(migration: ParsedMigration): Finding[] {
  const out: Finding[] = [];
  if (!migration.ops.ok) {
    out.push(
      finding(
        { kind: 'unparsed', detail: migration.ops.parseError },
        migration.name,
        'UNKNOWN',
        `Insufficient or unreliable evidence: migration SQL could not be parsed (${migration.ops.parseError}).`,
        ['the migration file could not be parsed by the Postgres parser'],
        'review this migration manually before deploying.',
        `migration SQL could not be parsed: ${migration.ops.parseError}`,
      ),
    );
    return out; // no reliable ops from an unparsed file
  }
  for (const d of migration.ops.dynamic) {
    out.push(
      finding(
        { kind: 'dynamic_sql', detail: d },
        migration.name,
        'UNKNOWN',
        `Insufficient or unreliable evidence: this migration contains a ${d}, whose statements cannot be analysed.`,
        [`migration contains a ${d}`],
        'review this migration manually before deploying.',
        `dynamic SQL (${d}) cannot be analysed`,
      ),
    );
  }
  return out;
}
