import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the orchestrator's own tests. Never collect tests from repositories/ —
    // those belong to the target repos (some hit live UAT APIs) and run via their verify contract.
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'repositories/**', '.worktrees/**', '.handoff/**']
  }
});
