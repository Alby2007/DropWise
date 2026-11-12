# dropwise

A GitHub Action that reviews pull requests containing destructive Postgres
migrations in Prisma projects. For each `DROP COLUMN` or `DROP TABLE` it
compares the Prisma schema at the base commit with the schema at the PR head,
searches git history, and posts one explanatory, **non-blocking** PR comment
saying what the evidence shows and what to do next.

dropwise does not replace Squawk or pgfence — those tools detect destructive
SQL. dropwise answers the follow-up question: is this drop a one-step removal
of something the previous app version may still use, or a later cleanup of
something already gone from the schema?

## Principles

- **Never claims safe.** Source and migration history cannot prove what is
  deployed in production. No output uses "safe" as a verdict (enforced by
  test).
- **Fails closed.** Shallow history, a failed git command, an unparsable
  schema, or dynamic SQL produce `UNKNOWN` with the reason stated — an
  operational failure never becomes a reassuring conclusion.
- **Says what the evidence is.** Every verdict names its evidence, e.g.
  "Prisma schema diff against base commit abc1234".
- **Non-blocking.** The Action comments; it does not fail the check.

## Verdicts

| Verdict | Meaning |
| --- | --- |
| `SAME_PR_REMOVAL` | Field/model is in the base schema and removed in this PR. Potential rolling-deployment hazard. |
| `PRIOR_SCHEMA_REMOVAL` | Absent from the base schema but declared earlier in git history. Candidate contract step; deployment status unverified. |
| `NO_PRIOR_SCHEMA_EVIDENCE` | No declaration found in successfully searched history, or added and dropped within this PR. Not proof it never reached production. |
| `DESTRUCTIVE_REPLACEMENT` | Dropped and re-added in the same migration with no preceding data copy. Potential data loss. |
| `UNKNOWN` | Insufficient or unreliable evidence. Always includes a reason and a manual-review prompt. |

The add → copy → drop → rename **swap pattern** is reported as `UNKNOWN`
("swap pattern; renames not yet supported"), not `DESTRUCTIVE_REPLACEMENT` —
it is not data loss.

## Usage

```yaml
# .github/workflows/dropwise.yml
name: dropwise
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  rollout-risk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0            # required — history search needs full history
      - uses: <owner>/dropwise@v0.1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
```

### Inputs

| Input | Default | Description |
| --- | --- | --- |
| `token` | `github.token` | Token used to post the PR comment. |
| `schema-path` | auto | Prisma schema file or multi-file schema directory. Auto-discovered (`prisma/schema.prisma`, `prisma/schema/`). |
| `migrations-path` | auto | Migrations directory; defaults to `migrations/` next to the schema. |
| `zero-downtime-deploys` | `'true'` | Set `'false'` if deploys are atomic (no overlapping versions). Verdicts are unchanged; recommended actions note the lower rolling-deployment hazard. |
| `squawk-report` | `''` | Optional path to a Squawk JSON report; findings are passed through. dropwise does not depend on Squawk. |
| `json-output` | `dropwise-report.json` | Where the machine-readable report is written. |
| `comment` | `'true'` | Set `'false'` to skip posting the PR comment. |

If the checkout is shallow (`fetch-depth: 1`, the actions/checkout default),
history-dependent verdicts return `UNKNOWN` with the reason stated.

## Example comment

> #### DROP COLUMN `users.legacy_name` — SAME_PR_REMOVAL
>
> **Same-PR schema removal.** The column is removed from the Prisma schema
> and the database in this pull request. Older application versions may
> still reference it during a rolling deployment.
>
> **Recommended action:** deploy code that no longer uses the column first.
> Once that version has fully rolled out, drop the column in a separate
> deployment.
>
> **Evidence:** Prisma schema diff against base commit abc1234 and head
> schema.

## How it works

1. Finds `migration.sql` files changed between the PR base and head.
2. Parses each with libpg-query (the real Postgres parser — not regexes) and
   extracts `DROP COLUMN` / `DROP TABLE` operations. Statements inside `DO`
   blocks, functions, or procedures are reported `UNKNOWN`.
3. Loads the Prisma schema at base and head via Prisma's own DMMF parser
   (`@prisma/internals` v6 and v7 — v6 first since it covers the installed
   base, v7 as fallback for the new url-less datasource). Single-file and
   multi-file schemas supported.
4. Maps physical names: `@map`/`@@map`, relation fields (not columns),
   implicit many-to-many join tables (`_RelName`). Conventions are versioned
   (`MAPPING_VERSION` in `src/prisma.ts`).
5. Classifies each operation; when a target is absent from the base schema,
   searches full git history for the migration that added it.
6. Posts one comment per PR (updated in place) and writes a JSON report.

## Scope

**In:** PostgreSQL + Prisma only; `DROP COLUMN`/`DROP TABLE`; single and
multi-file schemas; `@map`/`@@map`, enums, implicit join tables; full-history
search; one non-blocking comment; JSON output.

**Out:** other ORMs, renames (reported UNKNOWN), query-level analysis,
runtime checks, blocking mode, dashboards, telemetry, network calls,
non-Postgres databases.

## Development

```bash
npm install
npm test            # vitest — regression fixtures + fail-closed + "safe" scan
npm run typecheck   # tsc --noEmit
npm run coverage    # fixture coverage: operations / migrations / per-fixture
npm run build       # ncc bundle -> dist/ (committed for the action)
```

### Back-test reproduction

`scripts/backtest.ts` replays `backtest_results.csv` against real clones and
compares verdicts after the §4 renaming. Current result: **183/187 = 97.9%**
agreement (target ≥ 95%); the four diffs are the intentional swap-pattern
divergence (see `backtest_notes.md`).

```bash
mkdir -p .backtest/repos
git clone --filter=blob:none --no-checkout https://github.com/documenso/documenso .backtest/repos/documenso
git clone --filter=blob:none --no-checkout https://github.com/formbricks/formbricks .backtest/repos/formbricks
git clone --filter=blob:none --no-checkout https://github.com/langfuse/langfuse .backtest/repos/langfuse
git clone --filter=blob:none --no-checkout https://github.com/hoppscotch/hoppscotch .backtest/repos/hoppscotch
git clone --filter=blob:none --no-checkout https://github.com/triggerdotdev/trigger.dev .backtest/repos/trigger.dev
npx tsx scripts/backtest.ts --write-notes
```

### Tests

Fixtures in `test/fixtures.ts` model the real commits from the design
back-test (Documenso, Formbricks, Langfuse, Hoppscotch, Trigger.dev) as small
synthetic git repos — the suite is fast and clones nothing. Adversarial
fixtures cover shallow checkout, git failures, renamed models, unparsable
schemas, squashed migration history, and ambiguous implicit relations: the
expected outcome is the correct evidence-backed verdict or `UNKNOWN` with a
reason — an invented reassuring answer is a failure.

`test/no-safe.test.ts` scans all source and rendered output and fails if
"safe" appears as a verdict.

## Repository layout

- `src/git.ts` — fail-closed git helpers (every call returns `Result`)
- `src/sql.ts` — libpg-query → typed operations per migration
- `src/prisma.ts` — DMMF → physical schema (mapping conventions, versioned)
- `src/discover.ts` — schema/migrations discovery
- `src/history.ts` — git-history index of added columns/created tables
- `src/classify.ts` — verdicts, evidence, recommendations
- `src/analyze.ts` — orchestrator → `Report` (JSON model)
- `src/comment.ts` — PR comment renderer
- `src/index.ts` — GitHub Action entry

## License

Apache-2.0 — see [LICENSE](LICENSE).
