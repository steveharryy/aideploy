/**
 * Which tests failed, read from a jest or vitest run's console output.
 *
 * Used for the workflow rule "a test that already fails on the base branch is not blocking": the
 * baseline's failing tests are recorded, and a later run only blocks on tests NOT in that list.
 *
 * Returns undefined when the failing tests cannot be identified (unknown runner, crash before any
 * test ran, output cut off). Callers must then treat the run as a real failure (fail closed).
 */
export function failingTests(output: string): string[] | undefined {
  const text = stripAnsi(output);
  const lines = text.split('\n');
  const found = new Set<string>();
  const isVitest = /^\s*Test Files\s+/m.test(text) || /\bvitest\b/i.test(text);
  const isJest = /^\s*Test Suites:\s+/m.test(text);

  if (isVitest) {
    for (const raw of lines) {
      // " FAIL  src/a.test.ts > suite > name"  (a test)   |   " FAIL  src/a.test.ts [ src/a.test.ts ]" (file failed to load)
      const m = /^\s*FAIL\s+(\S+)(.*)$/.exec(raw);
      if (!m) continue;
      const rest = m[2].trim();
      if (rest.startsWith('>')) found.add(`${m[1]} > ${clean(rest.slice(1))}`);
      else found.add(`file: ${m[1]}`);
    }
  }
  if (isJest) {
    let lastFailFile = '';
    for (const raw of lines) {
      const fail = /^\s*FAIL\s+(\S+)/.exec(raw);
      if (fail) {
        lastFailFile = fail[1];
        continue;
      }
      // "  ● Suite › test name"
      const bullet = /^\s*●\s+(.+)$/.exec(raw);
      if (!bullet) continue;
      const name = clean(bullet[1]);
      if (/^Test suite failed to run$/i.test(name)) found.add(`file: ${lastFailFile || '?'}`);
      else if (!/^Console$/i.test(name)) found.add(`${lastFailFile ? `${lastFailFile} > ` : ''}${name}`);
    }
  }
  return found.size > 0 ? [...found].sort() : undefined;
}

/**
 * Failures in `output` that are not in `known`. undefined = cannot tell (treat as a real failure).
 * An empty array means every failing test was already failing before the change.
 */
export function newFailures(output: string, known: Iterable<string>): string[] | undefined {
  const now = failingTests(output);
  if (!now) return undefined;
  const before = new Set(known);
  return now.filter((t) => !before.has(t));
}

function clean(s: string): string {
  return s
    .replace(/\s+\(\d+(\.\d+)?\s*m?s\)\s*$/, '') // "(12 ms)"
    .replace(/\s+\d+(\.\d+)?m?s\s*$/, '') // "12ms"
    .replace(/\s+/g, ' ')
    .trim();
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}
