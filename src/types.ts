export const REPORT_VERSION = 1;

export type Verdict =
  | 'SAME_PR_REMOVAL'
  | 'PRIOR_SCHEMA_REMOVAL'
  | 'NO_PRIOR_SCHEMA_EVIDENCE'
  | 'DESTRUCTIVE_REPLACEMENT'
  | 'UNKNOWN';

export type OperationKind = 'drop_column' | 'drop_table' | 'dynamic_sql' | 'unparsed';

export interface Operation {
  kind: OperationKind;
  /** Migration directory name or relative path of migration.sql */
  migration: string;
  /** Physical table name as written in SQL (for dynamic_sql: undefined) */
  table?: string;
  column?: string;
  /** Description for dynamic_sql operations, e.g. "DO block" */
  detail?: string;
}

export interface Finding {
  operation: Operation;
  verdict: Verdict;
  /** Human-readable explanation of what the verdict means */
  summary: string;
  /** Named evidence, e.g. "Prisma schema diff against base commit abc1234" */
  evidence: string[];
  /** Reason string; required for UNKNOWN */
  reason?: string;
  recommendation: string;
}

export interface MigrationReport {
  migration: string;
  findings: Finding[];
}

export interface ReportStats {
  migrationsChanged: number;
  migrationsWithDrops: number;
  migrationsWithDynamicSql: number;
  operationsTotal: number;
  byVerdict: Record<Verdict, number>;
}

export interface Report {
  tool: 'dropwise';
  reportVersion: number;
  mappingVersion: number;
  base: string;
  head: string;
  schemaPath: string | null;
  migrationsPath: string | null;
  shallowHistory: boolean | null;
  zeroDowntimeDeploys: boolean;
  migrations: MigrationReport[];
  stats: ReportStats;
  /** Fatal problems that prevented analysis of everything, e.g. "not a git repository" */
  fatal?: string;
  warnings: string[];
}
