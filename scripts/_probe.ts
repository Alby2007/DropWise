import { analyzeRepo } from '../src/analyze';

async function main(): Promise<void> {
  const [base, head, mig] = [process.argv[2], process.argv[3], process.argv[4]];
  const r = await analyzeRepo({
    cwd: '.backtest/repos/linkwarden',
    base,
    head,
    migrationsPath: mig,
  });
  console.log(
    JSON.stringify(
      {
        fatal: r.fatal,
        warnings: r.warnings,
        schemaPath: r.schemaPath,
        migrationsPath: r.migrationsPath,
        verdicts: r.stats.byVerdict,
        findings: r.migrations.flatMap((m) =>
          m.findings.map((f) => ({ v: f.verdict, e: f.evidence[0], r: f.reason })),
        ),
      },
      null,
      1,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
