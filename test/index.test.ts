import { describe, it, expect, vi, afterAll } from 'vitest';
import { buildRepo, schema, mig, type BuiltRepo } from './helpers';

// Mutable state read lazily by the mocked modules.
const state = {
  pr: undefined as { number: number; base: { sha: string }; head: { sha: string } } | undefined,
  commentError: null as Error | null,
};

const coreMock = {
  getInput: vi.fn((name: string) => (name === 'token' ? 'test-token' : '')),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  summary: { addRaw: vi.fn().mockReturnThis(), write: vi.fn(async () => undefined) },
};
vi.mock('@actions/core', () => coreMock);

vi.mock('@actions/github', () => ({
  context: {
    payload: {
      get pull_request() {
        return state.pr;
      },
    },
    repo: { owner: 'o', repo: 'r' },
  },
  getOctokit: () => ({
    rest: {
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async () => {
          throw state.commentError;
        },
        updateComment: async () => {
          throw state.commentError;
        },
      },
    },
  }),
}));

const repos: BuiltRepo[] = [];
afterAll(() => {
  for (const r of repos) r.cleanup();
});

describe('action entrypoint (fork / read-only token)', () => {
  it('comment API 403 does not fail the job; report still lands in the job summary', async () => {
    const repo = buildRepo([
      {
        files: {
          'prisma/schema.prisma': schema('model Doc {\n  id Int @id\n  legacy String\n}'),
          ...mig('20240101_init', 'CREATE TABLE "Doc" ("id" SERIAL PRIMARY KEY, "legacy" TEXT);'),
        },
      },
      {
        files: {
          'prisma/schema.prisma': schema('model Doc {\n  id Int @id\n}'),
          ...mig('20240102_drop', 'ALTER TABLE "Doc" DROP COLUMN "legacy";'),
        },
      },
    ]);
    repos.push(repo);

    const prevEnv = { ...process.env };
    process.env.GITHUB_WORKSPACE = repo.dir;
    state.pr = {
      number: 1,
      base: { sha: repo.commits[0] },
      head: { sha: repo.commits[1] },
    };
    state.commentError = new Error('Resource not accessible by integration');

    try {
      const { run } = await import('../src/index');
      await run();
    } finally {
      process.env = prevEnv;
    }

    // job must not fail — the report is degraded to the summary, not lost
    expect(coreMock.setFailed).not.toHaveBeenCalled();
    expect(coreMock.summary.write).toHaveBeenCalledTimes(1);
    expect(coreMock.summary.addRaw).toHaveBeenCalledWith(
      expect.stringContaining('Migration rollout-risk report'),
    );
    expect(
      coreMock.warning.mock.calls.some((c) => /could not post PR comment/.test(String(c[0]))),
    ).toBe(true);
  });
});
