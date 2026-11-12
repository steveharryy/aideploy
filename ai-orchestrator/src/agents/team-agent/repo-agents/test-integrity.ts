import type { FileChange } from '../../../models/types.js';

/**
 * Test-integrity guard (design rule 7: "tests may never be disabled").
 *
 * Deterministically blocks a change set that:
 *  - deletes a test file,
 *  - reduces the number of test cases in a test file,
 *  - adds skip / focus markers (.skip, .only, xit, xdescribe, @Disabled, pytest skip ...).
 *
 * Runs before any file is written, so a violation leaves the repo untouched.
 */

const TEST_FILE_PATTERNS = [
  /(^|\/)(tests?|__tests__|specs?|e2e)\//i,
  /\.(test|spec|e2e)\.[cm]?[jt]sx?$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /_test\.(py|go)$/i,
  /Tests?\.(java|kt|cs)$/
];

/** Markers that disable or narrow a test suite. */
const DISABLE_MARKERS: Array<{ label: string; re: RegExp }> = [
  { label: '.skip', re: /\b(it|test|describe|context|suite)\.skip\s*\(/g },
  { label: '.only', re: /\b(it|test|describe|context|suite)\.only\s*\(/g },
  { label: '.todo', re: /\b(it|test)\.todo\s*\(/g },
  { label: 'xit/xtest/xdescribe', re: /\b(xit|xtest|xdescribe|xcontext)\s*\(/g },
  { label: 'fit/fdescribe', re: /\b(fit|fdescribe)\s*\(/g },
  { label: '@Disabled/@Ignore', re: /@(Disabled|Ignore)\b/g },
  { label: 'pytest skip', re: /pytest\.mark\.(skip|skipif|xfail)\b|pytest\.skip\s*\(/g },
  { label: 't.Skip', re: /\bt\.Skip(Now|f)?\s*\(/g }
];

/** Test-case declarations (it(, test(, def test_, func TestX, @Test). */
const TEST_CASE_RE = /\b(?:it|test)\s*\(|^\s*(?:async\s+)?def\s+test_|^\s*func\s+Test[A-Z_]|@Test\b/gm;

export function isTestFile(filePath: string): boolean {
  const p = filePath.replace(/\\/g, '/');
  return TEST_FILE_PATTERNS.some((re) => re.test(p));
}

function count(re: RegExp, text: string): number {
  return (text.match(new RegExp(re.source, re.flags)) || []).length;
}

/** Strips line and block comments so commented-out tests don't count as tests. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/^\s*#.*$/gm, '');
}

export function countTestCases(code: string): number {
  return count(TEST_CASE_RE, stripComments(code));
}

/**
 * Returns a list of violations (empty = OK).
 * @param readOriginal returns the current content of a repo-relative file, or undefined if it doesn't exist.
 */
export async function checkTestIntegrity(
  changes: FileChange[],
  readOriginal: (relPath: string) => Promise<string | undefined>
): Promise<string[]> {
  const violations: string[] = [];

  for (const change of changes) {
    if (!isTestFile(change.path)) continue;
    const before = await readOriginal(change.path);

    if (change.action === 'delete') {
      if (before !== undefined) violations.push(`${change.path}: deleting an existing test file is not allowed`);
      continue;
    }

    const after = change.content ?? '';
    const beforeCode = stripComments(before ?? '');
    const afterCode = stripComments(after);

    for (const marker of DISABLE_MARKERS) {
      const added = count(marker.re, afterCode) - count(marker.re, beforeCode);
      if (added > 0) violations.push(`${change.path}: adds ${added} "${marker.label}" marker(s) that disable or narrow tests`);
    }

    if (before !== undefined) {
      const lost = countTestCases(before) - countTestCases(after);
      if (lost > 0) violations.push(`${change.path}: removes or comments out ${lost} existing test case(s)`);
    }
  }

  return violations;
}
