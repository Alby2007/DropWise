import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildRepo, shallowClone, schema, mig, gitIn, type BuiltRepo } from './helpers';
import { FIXTURES } from './fixtures';
import { analyzeRepo } from '../src/analyze';
import { renderComment } from '../src/comment';
import type { Finding, Verdict } from '../src/types';

const repos: BuiltRepo[] = [];
function track<T extends BuiltRepo>(r: T): T {
  repos.push(r);
  return r;
}
import { afterAll } from 'vitest';
afterAll(() => {
  for (const r of repos) r.cleanup();
});

function verdictsOf(findings: Finding[]): Verdict[] {
  return findings.map((f) => f.verdict).sort();
}

describe('regression fixtures (real-commit cases)', () => {
  for (const fx of FIXTURES) {
    it(`${fx.id}: ${fx.description}`, async () => {
      const repo = track(buildRepo(fx.commits));
      const report = await analyzeRepo({
        cwd: repo.dir,
        base: repo.commits[fx.baseIndex],
        head: repo.commits[fx.headIndex],
      });

      if (fx.expectFatal) {
        expect(report.fatal).toBeTruthy();
        return;
      }
      expect(report.fatal).toBeUndefined();

      const findings = report.migrations.flatMap((m) => m.findings);
      expect(verdictsOf(findings)).toEqual([...fx.expected].sort());

      for (const f of findings) {
        if (f.verdict === 'UNKNOWN') {
          expect(f.reason, 'UNKNOWN findings must name a reason').toBeTruthy();
          if (fx.expectReasonIncludes) {
            expect((f.reason! + ' ' + f.summary).toLowerCase()).toContain(
              fx.expectReasonIncludes.toLowerCase(),
            );
          }
        } else {
          expect(f.evidence.length, `${f.verdict} must name its evidence`).toBeGreaterThan(0);
        }
      }

      // comment renders without crashing
      const comment = renderComment(report);
      expect(comment).toContain('Migration rollout-risk report');
    });
  }
});

describe('fail-closed behaviour', () => {
  it('shallow clone with missing base -> fatal report', async () => {
    const repo = track(
      buildRepo([
        { files: { 'prisma/schema.prisma': schema('model T {\n  id Int @id\n}'), ...mig('m1', 'SELECT 1;') } },
        { files: mig('m2', 'ALTER TABLE "T" DROP COLUMN "x";') },
      ]),
    );
    const clone = track(shallowClone(repo, 1));
    const report = await analyzeRepo({
      cwd: clone.dir,
      base: repo.commits[0],
      head: repo.commits[1],
    });
    expect(report.fatal).toBeTruthy();
    expect(report.fatal).toMatch(/not present|shallow/i);
  });

  it('shallow clone with base present -> history-dependent verdicts are UNKNOWN', async () => {
    const repo = track(
      buildRepo([
        {
          files: {
            'prisma/schema.prisma': schema('model Doc {\n  id Int @id\n  token String\n}'),
            ...mig('20240101_init', 'CREATE TABLE "Doc" ("id" SERIAL PRIMARY KEY, "token" TEXT NOT NULL);'),
          },
        },
        {
          files: {
            'prisma/schema.prisma': schema('model Doc {\n  id Int @id\n}'),
          },
        },
        {
          files: mig('20240103_drop', 'ALTER TABLE "Doc" DROP COLUMN "token";'),
        },
      ]),
    );
    const clone = track(shallowClone(repo, 2));
    const report = await analyzeRepo({
      cwd: clone.dir,
      base: repo.commits[1],
      head: repo.commits[2],
    });
    expect(report.fatal).toBeUndefined();
    const findings = report.migrations.flatMap((m) => m.findings);
    // evidence exists in full history (PRIOR) but shallow clone must not guess
    expect(verdictsOf(findings)).toEqual(['UNKNOWN']);
    expect(findings[0].reason).toMatch(/shallow/i);
  });

  it('not a git repository -> fatal report', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dropwise-norepo-'));
    try {
      const report = await analyzeRepo({ cwd: dir, base: 'a', head: 'b' });
      expect(report.fatal).toBe('not a git repository: ' + dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('merge-base comparison', () => {
  it('base branch changes after the PR was cut do not count as PR changes', async () => {
    // C0 (main): schema has legacy column. Feature branch drops it.
    // Main then removes the field AND adds an unrelated `name` column.
    // pr.base.sha = M1; the real PR base is merge-base C0.
    const repo = track(
      buildRepo([
        {
          files: {
            'prisma/schema.prisma': schema(
              'model Doc {\n  id Int @id\n  legacy String\n  email String\n}',
            ),
            ...mig(
              '20240101_init',
              'CREATE TABLE "Doc" ("id" SERIAL PRIMARY KEY, "legacy" TEXT, "email" TEXT);',
            ),
          },
        },
      ]),
    );
    const c0 = repo.commits[0];

    gitIn(repo.dir, ['checkout', '-b', 'feature']);
    writeFileSync(
      path.join(repo.dir, 'prisma/schema.prisma'),
      schema('model Doc {\n  id Int @id\n  email String\n}'),
    );
    mkdirSync(path.join(repo.dir, 'prisma/migrations/20240102_drop_legacy'), { recursive: true });
    writeFileSync(
      path.join(repo.dir, 'prisma/migrations/20240102_drop_legacy/migration.sql'),
      'ALTER TABLE "Doc" DROP COLUMN "legacy";',
    );
    gitIn(repo.dir, ['add', '-A']);
    gitIn(repo.dir, ['commit', '-m', 'drop legacy']);
    const f1 = gitIn(repo.dir, ['rev-parse', 'HEAD']).trim();

    gitIn(repo.dir, ['checkout', 'main']);
    writeFileSync(
      path.join(repo.dir, 'prisma/schema.prisma'),
      schema('model Doc {\n  id Int @id\n  email String\n  name String\n}'),
    );
    mkdirSync(path.join(repo.dir, 'prisma/migrations/20240103_main_changes'), { recursive: true });
    writeFileSync(
      path.join(repo.dir, 'prisma/migrations/20240103_main_changes/migration.sql'),
      'ALTER TABLE "Doc" ADD COLUMN "name" TEXT;',
    );
    gitIn(repo.dir, ['add', '-A']);
    gitIn(repo.dir, ['commit', '-m', 'main moves: drop legacy field, add name']);
    const m1 = gitIn(repo.dir, ['rev-parse', 'HEAD']).trim();

    const report = await analyzeRepo({ cwd: repo.dir, base: m1, head: f1 });
    expect(report.fatal).toBeUndefined();
    expect(report.mergeBase).toBe(c0);
    expect(
      report.warnings.some((w) => w.includes('merge-base')),
      'should note the base moved',
    ).toBe(true);

    // only the PR's own migration is analysed — not main's add_name migration
    expect(report.migrations.map((m) => m.migration)).toEqual(['20240102_drop_legacy']);
    const findings = report.migrations.flatMap((m) => m.findings);
    expect(findings.map((f) => f.operation.column)).toEqual(['legacy']);
    // relative to the merge-base the field IS removed by this PR; with a
    // two-dot diff it would wrongly appear absent-from-base (PRIOR_*).
    expect(verdictsOf(findings)).toEqual(['SAME_PR_REMOVAL']);
  });
});

describe('zero-downtime-deploys setting', () => {
  it('changes recommended action wording, not the verdict', async () => {
    const commits = [
      {
        files: {
          'prisma/schema.prisma': schema('model User {\n  id Int @id\n  imageUrl String?\n}'),
          ...mig('m1', 'CREATE TABLE "User" ("id" SERIAL PRIMARY KEY, "imageUrl" TEXT);'),
        },
      },
      {
        files: {
          'prisma/schema.prisma': schema('model User {\n  id Int @id\n}'),
          ...mig('m2', 'ALTER TABLE "User" DROP COLUMN "imageUrl";'),
        },
      },
    ];
    const r1 = track(buildRepo(commits));
    const on = await analyzeRepo({
      cwd: r1.dir,
      base: r1.commits[0],
      head: r1.commits[1],
      zeroDowntimeDeploys: true,
    });
    const r2 = track(buildRepo(commits));
    const off = await analyzeRepo({
      cwd: r2.dir,
      base: r2.commits[0],
      head: r2.commits[1],
      zeroDowntimeDeploys: false,
    });
    expect(on.migrations[0].findings[0].verdict).toBe('SAME_PR_REMOVAL');
    expect(off.migrations[0].findings[0].verdict).toBe('SAME_PR_REMOVAL');
    expect(off.migrations[0].findings[0].recommendation).toContain('zero-downtime-deploys is off');
    expect(on.migrations[0].findings[0].recommendation).not.toContain('zero-downtime-deploys is off');
  });
});
