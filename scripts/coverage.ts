/**
 * Coverage report: runs every fixture through analyzeRepo and reports
 * operation coverage, migration coverage, and a per-fixture summary —
 * three different measures, reported separately as required.
 *
 * Usage: npx tsx scripts/coverage.ts
 */
import { buildRepo } from '../test/helpers';
import { FIXTURES } from '../test/fixtures';
import { analyzeRepo } from '../src/analyze';
import type { Verdict } from '../src/types';

async function main() {
  let opsTotal = 0;
  let opsUnknown = 0;
  let migsTotal = 0;
  let migsCovered = 0;
  const perFixture: string[] = [];

  for (const fx of FIXTURES) {
    const repo = buildRepo(fx.commits);
    try {
      const report = await analyzeRepo({
        cwd: repo.dir,
        base: repo.commits[fx.baseIndex],
        head: repo.commits[fx.headIndex],
      });
      const findings = report.migrations.flatMap((m) => m.findings);
      const unknown = findings.filter((f) => f.verdict === 'UNKNOWN').length;
      opsTotal += findings.length;
      opsUnknown += unknown;
      migsTotal += report.stats.migrationsChanged;
      migsCovered += report.migrations.filter((m) => m.findings.length > 0).length;

      const actual = findings.map((f) => f.verdict).sort();
      const ok = JSON.stringify(actual) === JSON.stringify([...fx.expected].sort());
      const counts = findings.reduce<Record<string, number>>((acc, f) => {
        acc[f.verdict as Verdict] = (acc[f.verdict as Verdict] ?? 0) + 1;
        return acc;
      }, {});
      perFixture.push(
        `  ${ok ? 'PASS' : 'DIFF'}  ${fx.id.padEnd(28)} ${JSON.stringify(counts)}` +
          (ok ? '' : `  expected ${JSON.stringify(fx.expected)}`),
      );
    } finally {
      repo.cleanup();
    }
  }

  console.log('== Operation coverage ==');
  console.log(`  ${opsTotal} operations, ${opsTotal - opsUnknown} with a non-UNKNOWN verdict, ${opsUnknown} UNKNOWN`);
  console.log('');
  console.log('== Migration coverage ==');
  console.log(`  ${migsTotal} migrations changed, ${migsCovered} produced findings`);
  console.log('');
  console.log('== Per-fixture summary ==');
  for (const line of perFixture) console.log(line);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
