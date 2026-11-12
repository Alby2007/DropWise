import { createGit } from './git';
import type { Result } from './git';
import { discoverSchema, discoverMigrations, loadSchemaText } from './discover';
import { loadPhysicalSchema, MAPPING_VERSION, type PhysicalSchema } from './prisma';
import { extractOps } from './sql';
import { buildHistoryIndex, type HistoryIndex } from './history';
import { classifyDrop, dynamicFindings, type ClassifyContext, type ParsedMigration } from './classify';
import { REPORT_VERSION, type Report, type ReportStats, type MigrationReport, type Verdict, type Finding } from './types';

export interface AnalyzeOptions {
  cwd: string;
  base: string;
  head: string;
  schemaPath?: string;
  migrationsPath?: string;
  zeroDowntimeDeploys?: boolean;
}

function emptyStats(): ReportStats {
  return {
    migrationsChanged: 0,
    migrationsWithDrops: 0,
    migrationsWithDynamicSql: 0,
    operationsTotal: 0,
    byVerdict: {
      SAME_PR_REMOVAL: 0,
      PRIOR_SCHEMA_REMOVAL: 0,
      NO_PRIOR_SCHEMA_EVIDENCE: 0,
      DESTRUCTIVE_REPLACEMENT: 0,
      UNKNOWN: 0,
    },
  };
}

function fatalReport(opts: AnalyzeOptions, fatal: string, warnings: string[]): Report {
  return {
    tool: 'dropwise',
    reportVersion: REPORT_VERSION,
    mappingVersion: MAPPING_VERSION,
    base: opts.base,
    mergeBase: opts.base,
    head: opts.head,
    schemaPath: null,
    migrationsPath: null,
    shallowHistory: null,
    zeroDowntimeDeploys: opts.zeroDowntimeDeploys ?? true,
    migrations: [],
    stats: emptyStats(),
    fatal,
    warnings,
  };
}

function migrationName(path: string): string {
  const parts = path.split('/');
  return parts.length >= 2 ? parts[parts.length - 2] : path;
}

export async function analyzeRepo(opts: AnalyzeOptions): Promise<Report> {
  const git = createGit(opts.cwd);
  const warnings: string[] = [];
  const zeroDowntimeDeploys = opts.zeroDowntimeDeploys ?? true;

  const inside = await git.insideWorkTree();
  let isRepo = inside.ok && inside.value.trim() === 'true';
  if (!isRepo && !inside.ok && /dubious ownership/i.test(inside.error)) {
    // CI runners can own the workspace as a different user — allow-list it and retry.
    if (await git.addSafeDirectory()) {
      const retry = await git.insideWorkTree();
      isRepo = retry.ok && retry.value.trim() === 'true';
    }
  }
  if (!isRepo) {
    return fatalReport(opts, `not a git repository: ${opts.cwd}`, warnings);
  }
  const shallow = await git.isShallow();

  if (!(await git.revExists(opts.base))) {
    return fatalReport(
      opts,
      `base commit ${opts.base} not present in this clone${shallow ? ' (shallow checkout — set fetch-depth: 0)' : ''}`,
      warnings,
    );
  }
  if (!(await git.revExists(opts.head))) {
    return fatalReport(opts, `head commit ${opts.head} not present in this clone`, warnings);
  }

  // Compare from the merge-base: pr.base.sha moves forward as the base
  // branch advances, and diffing from it would attribute unrelated base
  // changes to this PR. Fail closed when it cannot be determined.
  const mb = await git.mergeBase(opts.base, opts.head);
  const mergeBase = mb.ok ? mb.value : null;
  if (!mergeBase) {
    return fatalReport(
      opts,
      `could not determine merge-base of ${opts.base.slice(0, 7)}..${opts.head.slice(0, 7)}${mb.ok ? '' : `: ${mb.error}`}${shallow ? ' (shallow checkout — set fetch-depth: 0)' : ''}`,
      warnings,
    );
  }
  if (mergeBase !== opts.base) {
    warnings.push(
      `base branch moved since this PR was cut; base-side comparison uses merge-base ${mergeBase.slice(0, 7)}`,
    );
  }

  // --- locate schema and migrations at BOTH revs: a PR can move them, and
  // base-side reads must resolve against the base tree, not head's layout. ---
  const schemaLocHead = await discoverSchema(git, opts.head, opts.schemaPath);
  const schemaLocBase = await discoverSchema(git, mergeBase, opts.schemaPath);
  const schemaPath = schemaLocHead.ok ? schemaLocHead.value.path : null;
  const schemaPathBase = schemaLocBase.ok ? schemaLocBase.value.path : null;
  if (!schemaLocHead.ok) warnings.push(schemaLocHead.error);
  if (schemaPath && schemaPathBase && schemaPath !== schemaPathBase) {
    warnings.push(`schema moved between base and head (${schemaPathBase} -> ${schemaPath})`);
  }

  const migrationsPath = await discoverMigrations(git, opts.head, opts.migrationsPath, schemaPath);
  const migrationsPathBase = await discoverMigrations(
    git,
    mergeBase,
    opts.migrationsPath,
    schemaPathBase,
  );
  if (!migrationsPath && opts.migrationsPath) {
    warnings.push(`configured migrations-path "${opts.migrationsPath}" not found at ${opts.head}`);
  }
  const historyPaths = [...new Set([migrationsPath, migrationsPathBase].filter((p): p is string => !!p))];
  if (migrationsPath && migrationsPathBase && migrationsPath !== migrationsPathBase) {
    warnings.push(
      `migrations directory moved between base and head (${migrationsPathBase} -> ${migrationsPath}); history searched under both`,
    );
  }

  // --- load schemas at both revs ---
  const loadAt = async (rev: string, path: string | null): Promise<Result<PhysicalSchema>> => {
    if (!path) return { ok: false, error: `no Prisma schema found at ${rev}` };
    const text = await loadSchemaText(git, rev, path);
    if (!text.ok) return text;
    const phys = await loadPhysicalSchema(text.value);
    if (phys.ok) warnings.push(...phys.value.warnings.map((w) => `schema at ${rev.slice(0, 7)}: ${w}`));
    return phys;
  };
  const baseSchema = await loadAt(mergeBase, schemaPathBase);
  const headSchema = await loadAt(opts.head, schemaPath);

  // --- find changed migration files ---
  const pathspec = migrationsPath ?? '';
  const changed = await git.diffFiles(mergeBase, opts.head, pathspec);
  if (!changed.ok) {
    return fatalReport(opts, `could not diff ${mergeBase}..${opts.head}: ${changed.error}`, warnings);
  }
  const isMigrationFile = (p: string): boolean => {
    if (!p.endsWith('.sql')) return false;
    if (historyPaths.length) return historyPaths.some((d) => p.startsWith(`${d}/`));
    return p === 'migration.sql' || p.endsWith('/migration.sql');
  };
  const migrationFiles = changed.value
    .filter((f) => !f.status.startsWith('D') && isMigrationFile(f.path))
    .map((f) => f.path)
    .sort();

  // --- parse changed migrations ---
  const migrations: ParsedMigration[] = [];
  for (const path of migrationFiles) {
    const name = migrationName(path);
    const text = await git.showFile(opts.head, path);
    if (!text.ok) {
      migrations.push({
        path,
        name,
        ops: {
          ok: false,
          parseError: `could not read file at head: ${text.error}`,
          drops: [],
          adds: [],
          creates: [],
          renamedColumns: new Map(),
          renamedTables: new Map(),
          dynamic: [],
          hasUpdate: false,
        },
      });
      continue;
    }
    migrations.push({ path, name, ops: await extractOps(text.value) });
  }

  // --- lazy history index ---
  let historyPromise: Promise<HistoryIndex> | null = null;
  const getHistory = () => {
    if (!historyPromise) historyPromise = buildHistoryIndex(git, mergeBase, historyPaths);
    return historyPromise;
  };

  const ctx: ClassifyContext = {
    base: mergeBase,
    head: opts.head,
    baseSchema,
    headSchema,
    getHistory,
    migrations,
    zeroDowntimeDeploys,
  };

  // --- classify ---
  const stats = emptyStats();
  stats.migrationsChanged = migrations.length;
  const reports: MigrationReport[] = [];
  for (const m of migrations) {
    const findings: Finding[] = [...dynamicFindings(m)];
    if (m.ops.ok) {
      for (const drop of m.ops.drops) {
        findings.push(await classifyDrop(drop, m, ctx));
      }
    }
    if (m.ops.drops.length > 0) stats.migrationsWithDrops++;
    if (m.ops.dynamic.length > 0 || !m.ops.ok) stats.migrationsWithDynamicSql++;
    for (const f of findings) {
      stats.operationsTotal++;
      stats.byVerdict[f.verdict as Verdict]++;
    }
    reports.push({ migration: m.name, findings });
  }

  return {
    tool: 'dropwise',
    reportVersion: REPORT_VERSION,
    mappingVersion: MAPPING_VERSION,
    base: opts.base,
    mergeBase,
    head: opts.head,
    schemaPath,
    migrationsPath,
    shallowHistory: shallow,
    zeroDowntimeDeploys,
    migrations: reports,
    stats,
    warnings,
  };
}
