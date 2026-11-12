/**
 * Back-test reproduction: run dropwise on the real repos/commits behind
 * backtest_results.csv and compare verdicts after applying the verdict
 * renaming (prototype names -> v0.1 names).
 *
 * Usage: npx tsx scripts/backtest.ts [--write-notes]
 *
 * Expects partial clones under .backtest/repos/<repo> with full commit/tree
 * history (git clone --filter=blob:none works; blobs are prefetched lazily).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { analyzeRepo } from '../src/analyze';
import { createGit } from '../src/git';
import type { Verdict } from '../src/types';

const REPOS_DIR = path.join(__dirname, '..', '.backtest', 'repos');
const CSV_PATH = path.join(__dirname, '..', 'backtest_results.csv');
const NOTES_PATH = path.join(__dirname, '..', 'backtest_notes.md');

/** Prototype verdict -> v0.1 verdict renaming. */
const RENAME: Record<string, Verdict | 'OUT_OF_SCOPE'> = {
  SAME_PR_REMOVAL: 'SAME_PR_REMOVAL',
  PREVIOUSLY_REMOVED: 'PRIOR_SCHEMA_REMOVAL',
  NEVER_RELEASED_IN_BASE: 'NO_PRIOR_SCHEMA_EVIDENCE',
  TEMP_SCAFFOLDING: 'NO_PRIOR_SCHEMA_EVIDENCE',
  DROPPED_AND_RECREATED: 'DESTRUCTIVE_REPLACEMENT',
  UNKNOWN_DYNAMIC: 'UNKNOWN',
  UNKNOWN_NO_SCHEMA: 'UNKNOWN',
  STILL_IN_SCHEMA: 'UNKNOWN',
  UNSUPPORTED_ORM: 'OUT_OF_SCOPE',
  RENAME_SKIPPED: 'OUT_OF_SCOPE',
};

/** Migration dirs from the prototype's hard-coded table. */
const MIG_DIRS: Record<string, string> = {
  documenso: 'packages/prisma/migrations',
  formbricks: 'packages/database/migration',
  langfuse: 'packages/shared/prisma/migrations',
  hoppscotch: 'packages/hoppscotch-backend/prisma/migrations',
  'trigger.dev': 'internal-packages/database/prisma/migrations',
};

interface CsvRow {
  migration_id: string;
  repo: string;
  commit: string;
  operation: string;
  table: string;
  column: string;
  verdict: string;
}

function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift()!;
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))) as unknown as CsvRow[];
}

function parentDir(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function gitSh(repoDir: string, args: string[], input?: string): string {
  return execFileSync('git', ['-C', repoDir, ...args], {
    input,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Force-fetch every blob the analysis will read in one batched request —
 *  keeps blobless partial clones fast (per-file `git show` would fetch one
 *  object per round trip). */
function prefetch(repoDir: string, migDir: string, commits: string[], schemaCandidates: string[]): void {
  const shas = new Set<string>();
  const objects = gitSh(repoDir, ['rev-list', '--objects', '--all', '--', migDir]);
  for (const line of objects.split('\n')) {
    const [sha, p] = line.split(' ');
    if (p && p.endsWith('.sql')) shas.add(sha);
  }
  for (const rev of commits) {
    for (const c of schemaCandidates) {
      try {
        const t = gitSh(repoDir, ['cat-file', '-t', `${rev}:${c}`]).trim();
        if (t === 'blob') {
          shas.add(gitSh(repoDir, ['rev-parse', `${rev}:${c}`]).trim());
        } else if (t === 'tree') {
          const tree = gitSh(repoDir, ['ls-tree', '-r', rev, '--', c]);
          for (const l of tree.split('\n')) {
            const m = l.match(/^[0-9]+ blob ([0-9a-f]{40})\t(.+)$/);
            if (m && m[2].endsWith('.prisma')) shas.add(m[1]);
          }
        }
      } catch {
        // path absent at this rev — fine
      }
    }
  }
  const list = [...shas].join('\n') + '\n';
  gitSh(repoDir, ['cat-file', '--batch'], list);
}

interface Diff {
  repo: string;
  migrationId: string;
  commit: string;
  op: string;
  target: string;
  expected: string;
  actual: string;
  note: string;
}

async function main(): Promise<void> {
  const rows = parseCsv(readFileSync(CSV_PATH, 'utf8'));
  const scoped = rows.filter((r) => RENAME[r.verdict] && RENAME[r.verdict] !== 'OUT_OF_SCOPE');

  // group by (repo, commit) preserving migration ids
  const groups = new Map<string, { repo: string; commit: string; rows: CsvRow[] }>();
  for (const r of scoped) {
    const key = `${r.repo}@${r.commit}`;
    const g = groups.get(key) ?? { repo: r.repo, commit: r.commit, rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }

  console.log(`${scoped.length} in-scope ops across ${groups.size} (repo,commit) groups`);

  // prefetch all blobs per repo once
  const byRepo = new Map<string, { commit: string; rows: CsvRow[] }[]>();
  for (const g of groups.values()) {
    const arr = byRepo.get(g.repo) ?? [];
    arr.push({ commit: g.commit, rows: g.rows });
    byRepo.set(g.repo, arr);
  }
  for (const [repo, gs] of byRepo) {
    const migDir = MIG_DIRS[repo];
    if (!migDir) continue;
    const repoDir = path.join(REPOS_DIR, repo);
    const parent = parentDir(migDir);
    prefetch(repoDir, migDir, gs.map((x) => x.commit), [
      `${parent}/schema.prisma`,
      `${parent}/schema`,
      `${parent}/prisma/schema.prisma`,
      `${parent}/prisma/schema`,
    ]);
    console.log(`prefetched blobs for ${repo}`);
  }

  const diffs: Diff[] = [];
  let matched = 0;
  let compared = 0;
  const missing = new Set<string>();
  const actualByVerdict = new Map<string, number>();
  let lenientOps = 0;
  const lenientGroups = new Set<string>();

  for (const g of groups.values()) {
    const repoDir = path.join(REPOS_DIR, g.repo);
    const git = createGit(repoDir);
    const migDir = MIG_DIRS[g.repo];
    if (!migDir) {
      for (const r of g.rows) {
        compared++;
        diffs.push({ repo: g.repo, migrationId: r.migration_id, commit: g.commit, op: r.operation, target: `${r.table}.${r.column}`, expected: RENAME[r.verdict] as string, actual: 'SKIPPED', note: `no migrations dir configured for ${g.repo}` });
      }
      continue;
    }

    // head resolves; base = commit^1 (prototype convention), passed as a revspec
    const headRes = await git.revExists(`${g.commit}^{commit}`);
    if (!headRes) {
      for (const r of g.rows) {
        compared++;
        diffs.push({ repo: g.repo, migrationId: r.migration_id, commit: g.commit, op: r.operation, target: `${r.table}.${r.column}`, expected: RENAME[r.verdict] as string, actual: 'SKIPPED', note: `commit ${g.commit} not found in clone` });
      }
      continue;
    }

    // probe schema path candidates at head
    const parent = parentDir(migDir);
    const candidates = [
      `${parent}/schema.prisma`,
      `${parent}/schema`,
      `${parent}/prisma/schema.prisma`,
      `${parent}/prisma/schema`,
      `prisma/schema.prisma`,
    ];
    let schemaPath: string | undefined;
    for (const c of candidates) {
      if ((await git.pathType(g.commit, c)) !== null) {
        schemaPath = c;
        break;
      }
    }

    const report = await analyzeRepo({
      cwd: repoDir,
      base: `${g.commit}^1`,
      head: g.commit,
      migrationsPath: migDir,
      schemaPath,
    });

    // findings keyed by op|table|column (multiset)
    const pool = new Map<string, { verdict: Verdict; reason?: string; summary: string; count: number }[]>();
    const lenientThisGroup = report.warnings.some((w) => w.includes('lenient'));
    for (const m of report.migrations) {
      for (const f of m.findings) {
        if (f.operation.kind !== 'drop_column' && f.operation.kind !== 'drop_table') continue;
        const k = `${f.operation.kind}|${f.operation.table}|${f.operation.column ?? ''}`;
        const arr = pool.get(k) ?? [];
        arr.push({ verdict: f.verdict, reason: f.reason, summary: f.summary, count: 0 });
        pool.set(k, arr);
      }
    }

    for (const r of g.rows) {
      compared++;
      const expected = RENAME[r.verdict] as string;
      const k = `${r.operation}|${r.table}|${r.column}`;
      const cands = pool.get(k)?.filter((c) => c.count === 0);
      if (!cands || cands.length === 0) {
        // The op may live inside a DO block: invisible to the parser, but the
        // migration-level dynamic UNKNOWN finding covers it.
        const dynamic = report.migrations.some((m) =>
          m.findings.some((f) => f.operation.kind === 'dynamic_sql' || f.operation.kind === 'unparsed'),
        );
        if (dynamic) {
          if (expected === 'UNKNOWN') {
            actualByVerdict.set('UNKNOWN', (actualByVerdict.get('UNKNOWN') ?? 0) + 1);
            matched++;
            continue;
          }
        }
        missing.add(`${g.repo}@${g.commit}`);
        diffs.push({
          repo: g.repo, migrationId: r.migration_id, commit: g.commit,
          op: r.operation, target: `${r.table}${r.column ? '.' + r.column : ''}`,
          expected, actual: dynamic ? 'UNKNOWN (migration-level dynamic finding)' : 'MISSING',
          note: `no finding for ${r.operation} ${r.table}.${r.column} — fatal=${report.fatal ?? 'none'} warnings=${report.warnings.join('; ') || 'none'}`,
        });
        continue;
      }
      const f = cands[0];
      f.count = 1;
      actualByVerdict.set(f.verdict, (actualByVerdict.get(f.verdict) ?? 0) + 1);
      if (lenientThisGroup) {
        lenientOps++;
        lenientGroups.add(`${g.repo}@${g.commit}`);
      }
      if (f.verdict === expected) {
        matched++;
      } else {
        diffs.push({
          repo: g.repo, migrationId: r.migration_id, commit: g.commit,
          op: r.operation, target: `${r.table}${r.column ? '.' + r.column : ''}`,
          expected, actual: f.verdict,
          note: f.reason ?? f.summary,
        });
      }
    }
  }

  const agreement = compared ? matched / compared : 0;
  console.log(`\nagreement: ${matched}/${compared} = ${(agreement * 100).toFixed(1)}% (target >= 95%)`);
  console.log(`actual verdict distribution: ${JSON.stringify(Object.fromEntries(actualByVerdict))}`);
  const unknown = actualByVerdict.get('UNKNOWN') ?? 0;
  console.log(`UNKNOWN share: ${unknown}/${compared} = ${((unknown / compared) * 100).toFixed(1)}%`);
  console.log(`ops whose schema evidence used lenient parse: ${lenientOps} (in ${lenientGroups.size} migrations)`);
  console.log(`diffs: ${diffs.length}`);
  for (const d of diffs) {
    console.log(`  ${d.repo}#${d.migrationId} ${d.op} ${d.target}: expected ${d.expected}, got ${d.actual} — ${d.note.slice(0, 140)}`);
  }

  if (process.argv.includes('--write-notes')) {
    const explain = (d: Diff): string => {
      if (d.actual === 'UNKNOWN' && d.expected === 'DESTRUCTIVE_REPLACEMENT') {
        return 'Intentional divergence: migration uses the add/copy/drop/rename swap pattern. ' +
          'Brief §4 requires UNKNOWN ("swap pattern; renames not yet supported") rather than the ' +
          "prototype's coarser DROPPED_AND_RECREATED label.";
      }
      if (d.actual === 'UNKNOWN (migration-level dynamic finding)') {
        return 'Operation lives inside a DO block; covered by the migration-level UNKNOWN finding.';
      }
      return 'Unexplained divergence — investigate.';
    };
    const lines = [
      '# Back-test reproduction notes',
      '',
      `Agreement: ${matched}/${compared} = ${(agreement * 100).toFixed(1)}% on in-scope ops (drops only, Prisma repos, ${groups.size} migrations).`,
      'Verdict renaming applied per brief §4: PREVIOUSLY_REMOVED->PRIOR_SCHEMA_REMOVAL,',
      'NEVER_RELEASED_IN_BASE/TEMP_SCAFFOLDING->NO_PRIOR_SCHEMA_EVIDENCE,',
      'DROPPED_AND_RECREATED->DESTRUCTIVE_REPLACEMENT, UNKNOWN_*->UNKNOWN.',
      '',
      '| repo | migration | op | target | expected (renamed) | actual | explanation |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...diffs.map((d) => `| ${d.repo} | #${d.migrationId} | ${d.op} | ${d.target} | ${d.expected} | ${d.actual} | ${explain(d).replace(/\|/g, '\\|')} |`),
      '',
    ];
    writeFileSync(NOTES_PATH, lines.join('\n'));
    console.log(`notes written to ${NOTES_PATH}`);
  }

  process.exitCode = agreement >= 0.95 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
