import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { buildRepo, type BuiltRepo } from './helpers';
import { FIXTURES } from './fixtures';
import { analyzeRepo } from '../src/analyze';
import { renderComment } from '../src/comment';
import { afterAll } from 'vitest';

const SAFE_WORD = /\bsafe\b/i;
const SRC_DIR = path.join(__dirname, '..', 'src');

const repos: BuiltRepo[] = [];
afterAll(() => {
  for (const r of repos) r.cleanup();
});

describe('verdict language guard', () => {
  it('no source file produces "safe" as a verdict or claim', () => {
    for (const f of readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(path.join(SRC_DIR, f), 'utf8');
      expect(SAFE_WORD.test(src), `${f} must not use the word "safe"`).toBe(false);
    }
  });

  it('rendered comments never contain the word "safe"', async () => {
    for (const fx of FIXTURES) {
      if (fx.expectFatal) continue;
      const repo = buildRepo(fx.commits);
      repos.push(repo);
      const report = await analyzeRepo({
        cwd: repo.dir,
        base: repo.commits[fx.baseIndex],
        head: repo.commits[fx.headIndex],
      });
      const comment = renderComment(report);
      expect(SAFE_WORD.test(comment), `comment for ${fx.id} must not contain "safe"`).toBe(false);
      // JSON output is also part of the output surface
      expect(SAFE_WORD.test(JSON.stringify(report))).toBe(false);
    }
  });
});
