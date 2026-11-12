import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RepoTestResult, TestCheckResult, TestingResult } from '../../models/types.js';
import type { VerifyCommand } from '../../catalog/service-catalog.js';

const execAsync = promisify(exec);

export interface TestingAgentConfig {
  repositoriesRoot?: string;
  /** Explicit repo locations (e.g. from the service catalog); overrides repositoriesRoot/<id>. */
  repoPaths?: Record<string, string>;
  /** Verify contract per repo (e.g. from the service catalog). */
  verifyCommands?: (repoId: string) => VerifyCommand[];
  customTestRunner?: (repoId: string, repoPath: string) => Promise<RepoTestResult>;
}

export interface ITestingAgent {
  /** @param workdirs optional per-run locations (e.g. a ticket's git worktree) that override configured paths. */
  runTests(affectedRepos: string[], workdirs?: Record<string, string>): Promise<TestingResult>;
}

/**
 * TestingAgent
 *
 * Runs each affected repo's verify contract, in this order of preference:
 *   1. verify commands from the service catalog (all must pass),
 *   2. `make verify` if the repo's Makefile has a verify target,
 *   3. `npm test` / tests/test.js / basic sanity check (original behaviour).
 */
export class TestingAgent implements ITestingAgent {
  private repositoriesRoot: string;
  private repoPaths: Record<string, string>;
  private verifyCommands?: (repoId: string) => VerifyCommand[];
  private customTestRunner?: (repoId: string, repoPath: string) => Promise<RepoTestResult>;

  constructor(config: TestingAgentConfig = {}) {
    this.repositoriesRoot = config.repositoriesRoot || path.resolve(process.cwd(), 'repositories');
    this.repoPaths = config.repoPaths || {};
    this.verifyCommands = config.verifyCommands;
    this.customTestRunner = config.customTestRunner;
  }

  async runTests(affectedRepos: string[], workdirs: Record<string, string> = {}): Promise<TestingResult> {
    if (!affectedRepos || affectedRepos.length === 0) {
      return {
        overallSuccess: true,
        repoResults: [],
        summary: 'No repositories required testing.'
      };
    }

    const repoResults: RepoTestResult[] = [];

    for (const repoId of affectedRepos) {
      const repoPath =
        workdirs[repoId] || this.repoPaths[repoId] || path.resolve(this.repositoriesRoot, repoId);

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

    // 2a. Verify contract from the service catalog: every command must pass.
    const contract = this.verifyCommands?.(repoId) || [];
    if (contract.length > 0) {
      for (const cmd of contract) {
        checks.push(await this.runCheck(`verify:${cmd.name}`, cmd.run, repoPath, (cmd.timeoutSec ?? 600) * 1000));
        if (!checks[checks.length - 1].passed) break; // stop at the first failing step
      }
      return this.summarize(repoId, checks);
    }

    // 2b. `make verify` if the repo exposes it.
    if (await this.hasMakeTarget(repoPath, 'verify')) {
      checks.push(await this.runCheck('make-verify', 'make verify', repoPath, 600_000));
      return this.summarize(repoId, checks);
    }

    // 2c. Fallback (original behaviour): package.json test script, tests/test.js, sanity check.
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

  private async runCheck(name: string, command: string, cwd: string, timeoutMs: number): Promise<TestCheckResult> {
    const start = Date.now();
    try {
      const { stdout, stderr } = await execAsync(command, { cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
      return { name, passed: true, output: (stdout + '\n' + stderr).trim(), durationMs: Date.now() - start };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
      return {
        name,
        passed: false,
        output: e.stdout,
        error: (e.killed ? `Timed out after ${timeoutMs / 1000}s. ` : '') + (e.stderr || e.message || 'Command failed').trim(),
        durationMs: Date.now() - start
      };
    }
  }

  private async hasMakeTarget(repoPath: string, target: string): Promise<boolean> {
    try {
      const makefile = await fs.readFile(path.join(repoPath, 'Makefile'), 'utf-8');
      return new RegExp(`^${target}\\s*:`, 'm').test(makefile);
    } catch {
      return false;
    }
  }

  private summarize(repoId: string, checks: TestCheckResult[]): RepoTestResult {
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
