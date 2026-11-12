import type { Verdict } from '../src/types';
import { schema, mig, type CommitSpec } from './helpers';

export interface FixtureCase {
  id: string;
  description: string;
  /** e.g. "trigger.dev @ 70bca82d84" — the real-world case this is modelled on */
  source: string;
  commits: CommitSpec[];
  /** index into commits for base and head */
  baseIndex: number;
  headIndex: number;
  /** expected multiset of verdicts across all findings (excluding dynamic findings
   *  unless included here) */
  expected: Verdict[];
  /** expected 'detail' for UNKNOWN findings, checked loosely */
  expectReasonIncludes?: string;
  expectFatal?: boolean;
}

const T_RUN = `model TaskRun {
  id    String        @id
  name  String
  tags  TaskRunTag[]
}

model TaskRunTag {
  id        String    @id
  label     String
  taskRuns  TaskRun[]
}`;

const T_RUN_NOREL = `model TaskRun {
  id    String        @id
  name  String
}

model TaskRunTag {
  id        String    @id
  label     String
}`;

export const FIXTURES: FixtureCase[] = [
  {
    id: 'implicit-join-table',
    description: 'Implicit m-n join table removed together with its relation',
    source: 'trigger.dev @ 70bca82d84 (_TaskRunToTaskRunTag)',
    commits: [
      {
        message: 'add taskrun/tag with implicit m-n',
        files: {
          'prisma/schema.prisma': schema(T_RUN),
          ...mig('20240101_init', `CREATE TABLE "TaskRun" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL);
CREATE TABLE "TaskRunTag" ("id" TEXT PRIMARY KEY, "label" TEXT NOT NULL);
CREATE TABLE "_TaskRunToTaskRunTag" ("A" TEXT NOT NULL, "B" TEXT NOT NULL);`),
        },
      },
      {
        message: 'remove relation and join table',
        files: {
          'prisma/schema.prisma': schema(T_RUN_NOREL),
          ...mig('20240102_drop_rel', `DROP TABLE "_TaskRunToTaskRunTag";`),
        },
      },
    ],
    baseIndex: 0,
    headIndex: 1,
    expected: ['SAME_PR_REMOVAL'],
  },

  {
    id: 'prior-schema-removal',
    description: 'Column absent from base schema but added by an earlier migration',
    source: 'documenso @ 32633f96d2 (Recipient.templateToken)',
    commits: [
      {
        message: 'add recipient with templateToken',
        files: {
          'prisma/schema.prisma': schema(`model Recipient {
  id            Int     @id
  templateToken String
}`),
          ...mig('20240101_init', `CREATE TABLE "Recipient" ("id" SERIAL PRIMARY KEY, "templateToken" TEXT NOT NULL);`),
        },
      },
      {
        message: 'remove templateToken from schema (deferred drop)',
        files: {
          'prisma/schema.prisma': schema(`model Recipient {
  id Int @id
}`),
        },
      },
      {
        message: 'drop the column',
        files: mig('20240103_drop_token', `ALTER TABLE "Recipient" DROP COLUMN "templateToken";`),
      },
    ],
    baseIndex: 1,
    headIndex: 2,
    expected: ['PRIOR_SCHEMA_REMOVAL'],
  },

  {
    id: 'multi-file-schema',
    description: 'Multi-file Prisma schema; two columns dropped in one migration',
    source: 'formbricks @ 24aea52d07 (Survey.variables, hiddenFields)',
    commits: [
      {
        message: 'add multi-file schema',
        files: {
          'prisma/schema/schema.prisma': schema(`model User {
  id Int @id
}`),
          'prisma/schema/survey.prisma': `model Survey {
  id            Int      @id
  variables     Json
  hiddenFields  Json
}`,
          ...mig('20240101_init', `CREATE TABLE "User" ("id" SERIAL PRIMARY KEY);
CREATE TABLE "Survey" ("id" SERIAL PRIMARY KEY, "variables" JSONB, "hiddenFields" JSONB);`),
        },
      },
      {
        message: 'drop survey fields',
        files: {
          'prisma/schema/survey.prisma': `model Survey {
  id Int @id
}`,
          ...mig('20240102_drop_fields', `ALTER TABLE "Survey" DROP COLUMN "variables", DROP COLUMN "hiddenFields";`),
        },
      },
    ],
    baseIndex: 0,
    headIndex: 1,
    expected: ['SAME_PR_REMOVAL', 'SAME_PR_REMOVAL'],
  },

  {
    id: 'do-block',
    description: 'Dynamic SQL inside a DO block cannot be analysed',
    source: 'trigger.dev @ f4780d746f; formbricks @ 1b9d91f1e8',
    commits: [
      {
        message: 'add table',
        files: {
          'prisma/schema.prisma': schema(`model Thing {
  id   Int    @id
  data String
}`),
          ...mig('20240101_init', `CREATE TABLE "Thing" ("id" SERIAL PRIMARY KEY, "data" TEXT NOT NULL);`),
        },
      },
      {
        message: 'conditional drop via DO block',
        files: mig('20240102_do', `DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Thing' AND column_name = 'data') THEN
    ALTER TABLE "Thing" DROP COLUMN "data";
  END IF;
END $$;`),
      },
    ],
    baseIndex: 0,
    headIndex: 1,
    expected: ['UNKNOWN'],
    expectReasonIncludes: 'dynamic SQL',
  },

  {
    id: 'drop-and-readd',
    description: 'Column dropped and re-added in a single ALTER statement',
    source: 'langfuse @ d8d2a3c00c (project_memberships.role)',
    commits: [
      {
        message: 'add membership with role',
        files: {
          'prisma/schema.prisma': schema(`model Membership {
  id   Int    @id
  role String
}`),
          ...mig('20240101_init', `CREATE TABLE "project_memberships" ("id" SERIAL PRIMARY KEY, "role" TEXT);`),
        },
      },
      {
        message: 'change role type via drop and re-add',
        files: mig('20240102_role', `ALTER TABLE "project_memberships" DROP COLUMN "role", ADD COLUMN "role" VARCHAR(50);`),
      },
    ],
    baseIndex: 0,
    headIndex: 1,
    expected: ['DESTRUCTIVE_REPLACEMENT'],
  },

  {
    id: 'swap-pattern',
    description: 'Add, copy, drop, rename swap is not data loss — report UNKNOWN',
    source: 'langfuse @ c92e9984f1 (prompts.prompt)',
    commits: [
      {
        message: 'add prompts.prompt',
        files: {
          'prisma/schema.prisma': schema(`model Prompt {
  id     Int    @id
  prompt String
}`),
          ...mig('20240101_init', `CREATE TABLE "prompts" ("id" SERIAL PRIMARY KEY, "prompt" TEXT NOT NULL);`),
        },
      },
      {
        message: 'swap prompt column',
        files: mig('20240102_swap', `ALTER TABLE "prompts" ADD COLUMN "prompt_new" TEXT;
UPDATE "prompts" SET "prompt_new" = "prompt";
ALTER TABLE "prompts" DROP COLUMN "prompt";
ALTER TABLE "prompts" RENAME COLUMN "prompt_new" TO "prompt";`),
      },
    ],
    baseIndex: 0,
    headIndex: 1,
    expected: ['UNKNOWN'],
    expectReasonIncludes: 'swap',
  },

  {
    id: 'add-drop-same-migration',
    description: 'Column added then dropped inside one migration',
    source: 'documenso @ e6dc237a (OrganisationGroup.temp_team_id)',
    commits: [
      {
        message: 'base state',
        files: {
          'prisma/schema.prisma': schema(`model OrganisationGroup {
  id Int @id
}`),
          ...mig('20240101_init', `CREATE TABLE "OrganisationGroup" ("id" SERIAL PRIMARY KEY);`),
        },
      },
      {
        message: 'scaffold column then drop it',
        files: mig('20240102_temp', `ALTER TABLE "OrganisationGroup" ADD COLUMN "temp_team_id" INT;
ALTER TABLE "OrganisationGroup" DROP COLUMN "temp_team_id";`),
      },
    ],
    baseIndex: 0,
    headIndex: 1,
    expected: ['NO_PRIOR_SCHEMA_EVIDENCE'],
  },

  {
    id: 'map-physical-name',
    description: 'Field @map to a different physical column name',
    source: 'langfuse @ 39855914b5 (dataset_items.sys_id)',
    commits: [
      {
        message: 'add dataset_items.sys_id',
        files: {
          'prisma/schema.prisma': schema(`model DatasetItem {
  id     Int    @id
  sysId  String @map("sys_id")
  @@map("dataset_items")
}`),
          ...mig('20240101_init', `CREATE TABLE "dataset_items" ("id" SERIAL PRIMARY KEY, "sys_id" TEXT NOT NULL);`),
        },
      },
      {
        message: 'remove sysId field and drop column',
        files: {
          'prisma/schema.prisma': schema(`model DatasetItem {
  id Int @id
  @@map("dataset_items")
}`),
          ...mig('20240102_drop', `ALTER TABLE "dataset_items" DROP COLUMN "sys_id";`),
        },
      },
    ],
    baseIndex: 0,
    headIndex: 1,
    expected: ['SAME_PR_REMOVAL'],
  },

  {
    id: 'plain-same-pr',
    description: 'Plain same-PR removal of a scalar column',
    source: 'formbricks @ 41d60c8a02 (User.imageUrl)',
    commits: [
      {
        message: 'add user with imageUrl',
        files: {
          'prisma/schema.prisma': schema(`model User {
  id       Int     @id
  imageUrl String?
}`),
          ...mig('20240101_init', `CREATE TABLE "User" ("id" SERIAL PRIMARY KEY, "imageUrl" TEXT);`),
        },
      },
      {
        message: 'remove imageUrl',
        files: {
          'prisma/schema.prisma': schema(`model User {
  id Int @id
}`),
          ...mig('20240102_drop', `ALTER TABLE "User" DROP COLUMN "imageUrl";`),
        },
      },
    ],
    baseIndex: 0,
    headIndex: 1,
    expected: ['SAME_PR_REMOVAL'],
  },

  {
    id: 'prior-removal-session',
    description: 'Already removed from schema earlier; drop lands now',
    source: 'documenso @ 5d86e84217 (Session.expires)',
    commits: [
      {
        message: 'add session.expires',
        files: {
          'prisma/schema.prisma': schema(`model Session {
  id      Int    @id
  expires String
}`),
          ...mig('20240101_init', `CREATE TABLE "Session" ("id" SERIAL PRIMARY KEY, "expires" TEXT NOT NULL);`),
        },
      },
      {
        message: 'remove expires from schema',
        files: {
          'prisma/schema.prisma': schema(`model Session {
  id Int @id
}`),
        },
      },
      {
        message: 'drop expires',
        files: mig('20240103_drop', `ALTER TABLE "Session" DROP COLUMN "expires";`),
      },
    ],
    baseIndex: 1,
    headIndex: 2,
    expected: ['PRIOR_SCHEMA_REMOVAL'],
  },

  {
    id: 'never-existed-at-base',
    description: 'Column added and dropped within one PR (different migrations)',
    source: 'trigger.dev @ e97704d904 (TaskRun.firstAttemptStartedAt)',
    commits: [
      {
        message: 'base state',
        files: {
          'prisma/schema.prisma': schema(`model TaskRun {
  id Int @id
}`),
          ...mig('20240101_init', `CREATE TABLE "TaskRun" ("id" SERIAL PRIMARY KEY);`),
        },
      },
      {
        message: 'add then drop in separate migrations, same PR',
        files: {
          ...mig('20240102_add', `ALTER TABLE "TaskRun" ADD COLUMN "firstAttemptStartedAt" TIMESTAMP;`),
          ...mig('20240103_drop', `ALTER TABLE "TaskRun" DROP COLUMN "firstAttemptStartedAt";`),
        },
      },
    ],
    baseIndex: 0,
    headIndex: 1,
    expected: ['NO_PRIOR_SCHEMA_EVIDENCE'],
  },

  // ---------- bonus evidence-backed cases ----------

  {
    id: 'drop-table-same-pr',
    description: 'Model removed and its table dropped in the same PR',
    source: 'generic',
    commits: [
      {
        files: {
          'prisma/schema.prisma': schema(`model Old {
  id   Int    @id
  name String
}`),
          ...mig('20240101_init', `CREATE TABLE "Old" ("id" SERIAL PRIMARY KEY, "name" TEXT NOT NULL);`),
        },
      },
      {
        files: {
          'prisma/schema.prisma': schema(`model Keep {
  id Int @id
}`),
          ...mig('20240102_drop', `DROP TABLE "Old";`),
        },
      },
    ],
    baseIndex: 0,
    headIndex: 1,
    expected: ['SAME_PR_REMOVAL'],
  },

  {
    id: 'no-evidence-anywhere',
    description: 'Column declared nowhere — base schema, this PR, or history',
    source: 'generic',
    commits: [
      {
        files: {
          'prisma/schema.prisma': schema(`model T {
  id Int @id
}`),
          ...mig('20240101_init', `CREATE TABLE "T" ("id" SERIAL PRIMARY KEY);`),
        },
      },
      {
        files: mig('20240102_drop', `ALTER TABLE "T" DROP COLUMN "phantom";`),
      },
    ],
    baseIndex: 0,
    headIndex: 1,
    expected: ['NO_PRIOR_SCHEMA_EVIDENCE'],
  },

  // ---------- adversarial fixtures ----------

  {
    id: 'adv-renamed-model',
    description: 'Model renamed without @@map; drop lands on the new name',
    source: 'adversarial',
    commits: [
      {
        files: {
          'prisma/schema.prisma': schema(`model User {
  id Int @id
  x  String
}`),
          ...mig('20240101_init', `CREATE TABLE "User" ("id" SERIAL PRIMARY KEY, "x" TEXT NOT NULL);`),
        },
      },
      {
        files: {
          'prisma/schema.prisma': schema(`model Account {
  id Int @id
}`),
          ...mig('20240102_rename', `ALTER TABLE "User" RENAME TO "Account";
ALTER TABLE "Account" DROP COLUMN "x";`),
        },
      },
    ],
    baseIndex: 0,
    headIndex: 1,
    expected: ['UNKNOWN'],
    expectReasonIncludes: 'rename',
  },

  {
    id: 'adv-unparsable-schema',
    description: 'Schema file cannot be parsed — fail closed',
    source: 'adversarial',
    commits: [
      {
        files: {
          'prisma/schema.prisma': `this is not a prisma schema {{{`,
          ...mig('20240101_init', `CREATE TABLE "T" ("id" SERIAL PRIMARY KEY);`),
        },
      },
      {
        files: mig('20240102_drop', `ALTER TABLE "T" DROP COLUMN "x";`),
      },
    ],
    baseIndex: 0,
    headIndex: 1,
    expected: ['UNKNOWN'],
    expectReasonIncludes: 'base',
  },

  {
    id: 'adv-squashed-history',
    description: 'Migrations squashed into a baseline; earlier add-evidence still in git',
    source: 'adversarial',
    commits: [
      {
        message: 'original migrations',
        files: {
          'prisma/schema.prisma': schema(`model Doc {
  id    Int    @id
  token String
}`),
          ...mig('20240101_init', `CREATE TABLE "Doc" ("id" SERIAL PRIMARY KEY, "token" TEXT NOT NULL);`),
        },
      },
      {
        message: 'remove token from schema',
        files: {
          'prisma/schema.prisma': schema(`model Doc {
  id Int @id
}`),
        },
      },
      {
        message: 'squash migrations into baseline',
        files: {
          'prisma/migrations/20240101_init/migration.sql': null,
          ...mig('20240103_baseline', `CREATE TABLE "Doc" ("id" SERIAL PRIMARY KEY);`),
        },
      },
      {
        message: 'drop token',
        files: mig('20240104_drop', `ALTER TABLE "Doc" DROP COLUMN "token";`),
      },
    ],
    baseIndex: 2,
    headIndex: 3,
    expected: ['PRIOR_SCHEMA_REMOVAL'], // original add commit is still in history
  },

  {
    id: 'adv-ambiguous-implicit',
    description: 'Join table dropped while its relation still exists at head',
    source: 'adversarial',
    commits: [
      {
        files: {
          'prisma/schema.prisma': schema(T_RUN),
          ...mig('20240101_init', `CREATE TABLE "TaskRun" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL);
CREATE TABLE "TaskRunTag" ("id" TEXT PRIMARY KEY, "label" TEXT NOT NULL);
CREATE TABLE "_TaskRunToTaskRunTag" ("A" TEXT NOT NULL, "B" TEXT NOT NULL);`),
        },
      },
      {
        files: mig('20240102_drop_join', `DROP TABLE "_TaskRunToTaskRunTag";`),
      },
    ],
    baseIndex: 0,
    headIndex: 1,
    expected: ['UNKNOWN'], // schema and migration disagree
  },

  {
    id: 'adv-unparsable-migration',
    description: 'Migration SQL cannot be parsed — fail closed',
    source: 'adversarial',
    commits: [
      {
        files: {
          'prisma/schema.prisma': schema(`model T {
  id Int @id
}`),
          ...mig('20240101_init', `CREATE TABLE "T" ("id" SERIAL PRIMARY KEY);`),
        },
      },
      {
        files: mig('20240102_bad', `ALTERRR TABLE "T" DROP COLUMN "x";;;`),
      },
    ],
    baseIndex: 0,
    headIndex: 1,
    expected: ['UNKNOWN'],
    expectReasonIncludes: 'parsed',
  },
];
