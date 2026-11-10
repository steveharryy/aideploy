import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RepoTestResult, TestCheckResult, TestingResult } from '../../models/types.js';

const execAsync = promisify(exec);

export interface TestingAgentConfig {
  repositoriesRoot?: string;
  customTestRunner?: (repoId: string, repoPath: string) => Promise<RepoTestResult>;
}

export interface ITestingAgent {
  runTests(affectedRepos: string[]): Promise<TestingResult>;
}

export class TestingAgent implements ITestingAgent {
  private repositoriesRoot: string;
  private customTestRunner?: (repoId: string, repoPath: string) => Promise<RepoTestResult>;

  constructor(config: TestingAgentConfig = {}) {
    this.repositoriesRoot = config.repositoriesRoot || path.resolve(process.cwd(), 'repositories');
    this.customTestRunner = config.customTestRunner;
  }

  async runTests(affectedRepos: string[]): Promise<TestingResult> {
    if (!affectedRepos || affectedRepos.length === 0) {
      return {
        overallSuccess: true,
        repoResults: [],
        summary: 'No repositories required testing.'
      };
    }

    const repoResults: RepoTestResult[] = [];

    for (const repoId of affectedRepos) {
      const repoPath = path.resolve(this.repositoriesRoot, repoId);

      if (this.customTestRunner) {
        const customResult = await this.customTestRunner(repoId, repoPath);
        repoResults.push(customResult);
        continue;
      }

      const repoResult = await this.testRepository(repoId, repoPath);
      repoResults.push(repoResult);
    }

    const overallSuccess = repoResults.length > 0 && repoResults.every((r) => r.success);
    const passedCount = repoResults.filter((r) => r.success).length;
    const summary = `${passedCount}/${repoResults.length} repositories passed deterministic testing.`;

    return {
      overallSuccess,
      repoResults,
      summary
    };
  }

  private async testRepository(repoId: string, repoPath: string): Promise<RepoTestResult> {
    const checks: TestCheckResult[] = [];

    // 1. Directory Existence Check
    try {
      await fs.access(repoPath);
      checks.push({
        name: 'directory-exists',
        passed: true,
        output: `Repository directory exists at ${repoPath}`
      });
    } catch {
      return {
        repoId,
        success: false,
        checks: [
          {
            name: 'directory-exists',
            passed: false,
            error: `Repository directory does not exist at ${repoPath}`
          }
        ],
        summary: `Repository ${repoId} directory not found.`
      };
    }

    // 2. Check for package.json and determine test command
    const packageJsonPath = path.join(repoPath, 'package.json');
    let hasTestScript = false;

    try {
      const pkgContent = await fs.readFile(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(pkgContent);
      if (pkg.scripts && pkg.scripts.test) {
        hasTestScript = true;
      }
    } catch {
      // package.json might not exist or have no scripts
    }

    // 3. Run test command or standalone test script if available
    const testJsPath = path.join(repoPath, 'tests', 'test.js');
    let testJsExists = false;
    try {
      await fs.access(testJsPath);
      testJsExists = true;
    } catch {
      // no tests/test.js
    }

    if (hasTestScript) {
      const start = Date.now();
      try {
        // Execute npm test or configured script inside repo directory
        const { stdout, stderr } = await execAsync('npm test', {
          cwd: repoPath
        });
        checks.push({
          name: 'npm-test',
          passed: true,
          output: (stdout + '\n' + stderr).trim(),
          durationMs: Date.now() - start
        });
      } catch (err: unknown) {
        const execErr = err as { stdout?: string; stderr?: string; message?: string };
        checks.push({
          name: 'npm-test',
          passed: false,
          output: execErr.stdout,
          error: (execErr.stderr || execErr.message || 'Unknown test execution error').trim(),
          durationMs: Date.now() - start
        });
      }
    } else if (testJsExists) {
      const start = Date.now();
      try {
        const { stdout, stderr } = await execAsync('node tests/test.js', {
          cwd: repoPath
        });
        checks.push({
          name: 'standalone-test-suite',
          passed: true,
          output: (stdout + '\n' + stderr).trim(),
          durationMs: Date.now() - start
        });
      } catch (err: unknown) {
        const execErr = err as { stdout?: string; stderr?: string; message?: string };
        checks.push({
          name: 'standalone-test-suite',
          passed: false,
          output: execErr.stdout,
          error: (execErr.stderr || execErr.message || 'Test script failed').trim(),
          durationMs: Date.now() - start
        });
      }
    } else {
      // Fallback deterministic syntax and sanity checks
      const sanityCheck = await this.runSanityChecks(repoPath);
      checks.push(...sanityCheck);
    }

    const success = checks.every((c) => c.passed);

    return {
      repoId,
      success,
      checks,
      summary: success
        ? `All deterministic tests passed for ${repoId}.`
        : `Tests failed for ${repoId}. Check details for error output.`
    };
  }

  private async runSanityChecks(repoPath: string): Promise<TestCheckResult[]> {
    const results: TestCheckResult[] = [];
    try {
      const srcDir = path.join(repoPath, 'src');
      const files = await fs.readdir(srcDir);
      results.push({
        name: 'src-files-check',
        passed: files.length > 0,
        output: `Found ${files.length} source file(s) in src directory.`
      });
    } catch (err: unknown) {
      results.push({
        name: 'src-files-check',
        passed: false,
        error: `Failed to inspect src directory: ${err instanceof Error ? err.message : String(err)}`
      });
    }
    return results;
  }
}
