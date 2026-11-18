import { describe, it, expect } from 'vitest';
import { failingTests, newFailures } from '../src/util/test-failures.js';
import { TestingAgent } from '../src/agents/testing/agent.js';

describe('failingTests: which tests failed, from jest / vitest output', () => {
  it('jest: "●" entries, with the file from the FAIL line; suite crashes become file entries', () => {
    const out = [
      'FAIL src/__tests__/payments.test.ts',
      '  ● PaymentsController › rejects a missing user (12 ms)',
      '  ● PaymentsController › maps the status',
      'FAIL src/__tests__/broken.test.ts',
      '  ● Test suite failed to run',
      'PASS src/__tests__/ok.test.ts',
      'Test Suites: 2 failed, 1 passed, 3 total'
    ].join('\n');
    expect(failingTests(out)).toEqual([
      'file: src/__tests__/broken.test.ts',
      'src/__tests__/payments.test.ts > PaymentsController › maps the status',
      'src/__tests__/payments.test.ts > PaymentsController › rejects a missing user'
    ]);
  });

  it('vitest: FAIL lines with " > " are tests; without, the file failed to load; ANSI and timings stripped', () => {
    const out = ['\u001b[31m FAIL \u001b[39m src/a.test.ts > suite > does x 5ms', ' FAIL  src/b.test.ts [ src/b.test.ts ]', ' Test Files  2 failed (2)'].join('\n');
    expect(failingTests(out)).toEqual(['file: src/b.test.ts', 'src/a.test.ts > suite > does x']);
  });

  it('unknown output → undefined (callers fail closed)', () => {
    expect(failingTests('Segmentation fault')).toBeUndefined();
    expect(newFailures('npm ERR! missing script: test', ['x'])).toBeUndefined();
  });

  it('newFailures: only tests not failing before', () => {
    const out = ' FAIL  a.test.ts > old\n FAIL  a.test.ts > new\n Test Files  1 failed (1)';
    expect(newFailures(out, ['a.test.ts > old'])).toEqual(['a.test.ts > new']);
    expect(newFailures(out, ['a.test.ts > old', 'a.test.ts > new'])).toEqual([]);
  });
});

describe('TestingAgent re-test honours pre-existing failures', () => {
  const failing = (lines: string[]) =>
    `printf '%s\\n' ${[...lines, ' Test Files  1 failed (1)'].map((l) => `'${l}'`).join(' ')}; exit 1`;
  const agent = (cmd: string, known?: string[]) =>
    new TestingAgent({ repoPaths: { r: process.cwd() }, verifyCommands: () => [{ name: 'test', run: cmd }], knownFailures: () => known });

  it('only known failures → passes, and says so', async () => {
    const res = await agent(failing([' FAIL  a.test.ts > old']), ['a.test.ts > old']).runTests(['r']);
    expect(res.overallSuccess).toBe(true);
    expect(res.repoResults[0].checks.at(-1)?.output).toMatch(/already failed on the base branch/);
  });

  it('a new failure → fails, naming it', async () => {
    const res = await agent(failing([' FAIL  a.test.ts > old', ' FAIL  a.test.ts > new']), ['a.test.ts > old']).runTests(['r']);
    expect(res.overallSuccess).toBe(false);
    expect(res.repoResults[0].checks.at(-1)?.error).toMatch(/New failures caused by the change: a.test.ts > new/);
  });

  it('no known failures → any failure blocks (unchanged behaviour)', async () => {
    const res = await agent(failing([' FAIL  a.test.ts > old'])).runTests(['r']);
    expect(res.overallSuccess).toBe(false);
  });
});
