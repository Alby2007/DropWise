/**
 * Held-out validation: run dropwise on destructive migrations from Prisma
 * repos NOT in the back-test five. Dumps one JSON report per migration to
 * .backtest/heldout/<repo>/<commit>.json for hand review — the non
 * SAME_PR_REMOVAL verdicts are the ones worth checking by hand.
 *
 * Usage: npx tsx scripts/heldout.ts [--limit 15] [--repo ghostfolio,dub]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { analyzeRepo } from '../src/analyze';
import { extractOps } from '../src/sql';
import type { Verdict } from '../src/types';

const REPOS_DIR = path.join(__dirname, '..', '.backtest', 'repos');
const OUT_DIR = path.join(__dirname, '..', '.backtest', 'heldout');

const REPOS: { name: string; url: string; schemaCandidates: string[] }[] = [
  {
    name: 'ghostfolio',
    url: 'https://github.com/ghostfolio/ghostfolio',
    schemaCandidates: ['prisma/schema.prisma', 'prisma/schema'],
  },
  {
    name: 'papermark',
    url: 'https://github.com/mfts/papermark',
    schemaCandidates: ['prisma/schema.prisma', 'prisma/schema'],
  },
  {
    name: 'typebot',
    url: 'https://github.com/baptisteArno/typebot.io',
    schemaCandidates: [
      'packages/prisma/postgresql/schema.prisma',
      'packages/prisma/schema.prisma',
      'apps/builder/prisma/schema.prisma',
      'prisma/schema.prisma',
    ],
  },
  {
    name: 'linkwarden',
    url: 'https://github.com/linkwarden/linkwarden',
    schemaCandidates: ['prisma/schema.prisma', 'prisma/schema', 'apps/web/prisma/schema.prisma'],
  },
];

function gitSh(repoDir: string, args: string[], input?: string): string {
  return execFileSync('git', ['-C', repoDir, ...args], {
    input,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : def;
}

function isMigrationSql(p: string): boolean {
  const parts = p.split('/');
  return p.endsWith('.sql') && parts.some((s) => s.startsWith('migration'));
}

/** Migrations roots = any `.../migrations` directory in HEAD's tree listing
 *  (local in a blobless clone). */
function migrationsRoots(repoDir: string): string[] {
  const paths = gitSh(repoDir, ['ls-tree', '-r', '--name-only', 'HEAD']);
  const roots = new Set<string>();
  for (const p of paths.split('\n')) {
    const parts = p.trim().split('/');
    const i = parts.findIndex((s) => s === 'migrations');
    if (i >= 0 && parts.length > i + 1) roots.add(parts.slice(0, i + 1).join('/'));
  }
  return [...roots];
}

/** Batched blob fetch so blobless clones do one round trip instead of one
 *  per-file `git show`. Phase A: every .sql under the migrations roots. */
function prefetchSql(repoDir: string, roots: string[]): void {
  const shas = new Set<string>();
  for (const root of roots) {
    let objects: string;
    try {
      objects = gitSh(repoDir, ['rev-list', '--objects', '--all', '--', root]);
    } catch {
      continue;
    }
    for (const line of objects.split('\n')) {
      const [sha, p] = line.split(' ');
      if (p && p.endsWith('.sql')) shas.add(sha);
    }
  }
  if (shas.size) gitSh(repoDir, ['cat-file', '--batch'], [...shas].join('\n') + '\n');
}

/** Phase B: .prisma schema blobs at the revisions we will analyze. */
function prefetchSchemas(repoDir: string, revs: string[], candidates: string[]): void {
  const shas = new Set<string>();
  for (const rev of revs) {
    for (const c of candidates) {
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
  if (shas.size) gitSh(repoDir, ['cat-file', '--batch'], [...shas].join('\n') + '\n');
}

async function main(): Promise<void> {
  const limit = parseInt(arg('--limit', '15'), 10);
  const only = arg('--repo', '').split(',').filter(Boolean);
  const repos = only.length ? REPOS.filter((r) => only.includes(r.name)) : REPOS;

  for (const repo of repos) {
    const dir = path.join(REPOS_DIR, repo.name);
    if (!existsSync(dir)) {
      console.log(`cloning ${repo.url} (blobless) ...`);
      execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', repo.url, dir], {
        stdio: 'inherit',
      });
    }

    const roots = migrationsRoots(dir);
    console.log(`  migrations roots: ${roots.join(', ') || '(none found)'}`);
    if (roots.length === 0) continue;
    prefetchSql(dir, roots);
    console.log('  prefetched migration .sql blobs');

    // commits that added a *migration*.sql file, newest first
    const log = gitSh(dir, ['log', '--all', '--diff-filter=A', '--format=%H', '--name-only']);
    const candidates: { commit: string; file: string }[] = [];
    let cur = '';
    for (const line of log.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (/^[0-9a-f]{40}$/.test(t)) {
        cur = t;
      } else if (cur && isMigrationSql(t)) {
        candidates.push({ commit: cur, file: t });
      }
    }

    // keep the newest `limit` commits that actually contain DROP ops
    const picked: { commit: string; files: string[] }[] = [];
    const seenCommit = new Set<string>();
    for (const c of candidates) {
      if (seenCommit.has(c.commit)) {
        picked.find((p) => p.commit === c.commit)?.files.push(c.file);
        continue;
      }
      let sql: string;
      try {
        sql = gitSh(dir, ['show', `${c.commit}:${c.file}`]);
      } catch {
        continue;
      }
      const ops = await extractOps(sql);
      if (ops.drops.length === 0) continue;
      seenCommit.add(c.commit);
      picked.push({ commit: c.commit, files: [c.file] });
      if (picked.length >= limit) break;
    }

    console.log(`${repo.name}: ${candidates.length} migrations scanned, ${picked.length} with drops selected`);

    const outDir = path.join(OUT_DIR, repo.name);
    mkdirSync(outDir, { recursive: true });
    const dist = new Map<Verdict, number>();
    const reviewList: string[] = [];

    // roots may differ from HEAD's for commits that predate a restructure —
    // prefetch under the union so analysis stays local.
    const fileRoots = [
      ...new Set(
        picked.map((p) => {
          const parts = p.files[0].split('/');
          const i = parts.lastIndexOf('migrations');
          return i >= 0 ? parts.slice(0, i + 1).join('/') : parts.slice(0, -1).join('/');
        }),
      ),
    ];
    prefetchSql(dir, fileRoots.filter((r) => !roots.includes(r)));

    // schema lives next to the migrations dir in every layout we support;
    // derive candidates like packages/prisma/schema.prisma automatically.
    const derived = [...roots, ...fileRoots].map(
      (r) => `${r.split('/').slice(0, -1).join('/')}/schema.prisma`,
    );
    const schemaCandidates = [...repo.schemaCandidates, ...derived];

    const revs = picked.flatMap((p) => [p.commit, `${p.commit}^1`]);
    prefetchSchemas(dir, revs, schemaCandidates);
    console.log('  prefetched schema blobs');

    for (const p of picked) {
      // schema path probe at this commit
      let schemaPath: string | undefined;
      for (const c of schemaCandidates) {
        try {
          gitSh(dir, ['cat-file', '-e', `${p.commit}:${c}`]);
          schemaPath = c;
          break;
        } catch {
          /* try next */
        }
      }
      // root = the ".../migrations" dir this file lives under (handles both
      // nested `.../migrations/<id>/migration.sql` and flat layouts, and
      // directories that moved across history)
      const parts = p.files[0].split('/');
      const i = parts.lastIndexOf('migrations');
      const root = i >= 0 ? parts.slice(0, i + 1).join('/') : parts.slice(0, -1).join('/');
      const report = await analyzeRepo({
        cwd: dir,
        base: `${p.commit}^1`,
        head: p.commit,
        migrationsPath: root,
        schemaPath,
      });
      writeFileSync(
        path.join(outDir, `${p.commit.slice(0, 8)}.json`),
        JSON.stringify(report, null, 2),
      );
      for (const m of report.migrations) {
        for (const f of m.findings) {
          dist.set(f.verdict, (dist.get(f.verdict) ?? 0) + 1);
          if (f.verdict !== 'SAME_PR_REMOVAL') {
            reviewList.push(
              `  ${repo.name}@${p.commit.slice(0, 8)} ${f.operation.kind} ${f.operation.table}${f.operation.column ? '.' + f.operation.column : ''} -> ${f.verdict} (${(f.reason ?? f.evidence[0] ?? '').slice(0, 90)})`,
            );
          }
        }
      }
      if (report.fatal) reviewList.push(`  ${repo.name}@${p.commit.slice(0, 8)} FATAL: ${report.fatal}`);
    }

    console.log(`  verdicts: ${JSON.stringify(Object.fromEntries(dist))}`);
    if (reviewList.length) {
      console.log('  needs hand review:');
      for (const l of reviewList) console.log(l);
    }
    console.log(`  reports -> ${outDir}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
