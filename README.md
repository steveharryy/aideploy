# AI Development Orchestrator

A modular, test-driven local AI development orchestrator built with Node.js and TypeScript. It coordinates a pipeline of specialized agents to analyze, deduplicate, plan, implement, and deterministically test software engineering tasks across multiple repositories.

---

## Architecture Overview

The system decouples high-level coordination from low-level repository modifications and coding models. The overall workflow follows a single-direction pipeline with early exit guards:

```text
Input Task (Jira ticket via API, or demo task e.g. PAY-101)
    │
    ▼
[Deduplication Agent]     ──► Halts pipeline early if task is duplicate/already implemented
    │
    ▼
[Impact Analysis Agent]   ──► Scopes affected repositories (whole-word rules + Jira labels/components)
    │                         No match ──► stops with NO_MATCHING_REPO (no code written)
    │
    ▼
[Team Agent]              ──► Analyzes dependencies and coordinates Repo Agent(s)
    │
    ├─── Repo Agent (repo-a)  ──► Inspects repo, builds context, invokes AI
    ├─── Repo Agent (repo-b)  ──► Executes in parallel (or sequential if dependent)
    │
    ▼
[AI Provider Abstraction] ──► MockAIProvider (offline, deterministic)
    │
    ▼
[Code Changes Applied]    ──► Safe file mutations scoped to repository boundaries
    │
    ▼
[Testing Agent]           ──► Runs deterministic tests (npm test / test suites)
    │
    ▼
[Structured Result]       ──► OrchestratorResult with status, diffs, and audit logs
```

---

## Agent Pipeline Responsibilities

| Agent / Component | Responsibility |
| :--- | :--- |
| **Orchestrator** | Owns and controls the execution lifecycle. Dispatches tasks across agents, passes typed contexts, enforces error boundaries, and produces the final execution summary. |
| **Impact Analysis Agent** | Analyzes task specifications and acceptance criteria to identify impacted repositories, modules, and target files with confidence scores and reasoning. |
| **Deduplication Agent** | Guards the pipeline against redundant work. Checks task history (`.task-history.json`) and verifies code presence on disk (allows re-running if code was deleted). |
| **Team Agent** | Coordinates multi-repo execution. Generates an execution plan, runs independent repositories in parallel via `Promise.all`, and executes dependent repositories sequentially. |
| **Repo Agent** | Strictly bound to a single repository (`repoId`, `repoPath`). Snapshots source files, invokes the AI provider, and writes file changes with path traversal protection. |
| **AI Provider Abstraction** | Decouples the reasoning engine from orchestration logic. Currently uses the offline mock; a real LLM can be added later behind the same interface without changing agent code. |
| **Testing Agent** | Executes deterministic tests (e.g., repository `npm test` suites, contract tests) post-modification. Never relies on LLM claims that code works. |

---

## Project Structure

```text
Orchestrator/
├── package.json                           # Root package proxying commands to ai-orchestrator
├── .gitignore                             # Ignores node_modules, .env, .task-history.json
├── README.md                              # Main documentation and run guide
│
└── ai-orchestrator/
    ├── src/
    │   ├── index.ts                       # Entry point and CLI runner (npm start)
    │   ├── qa-runner.ts                   # Automated QA test suite runner (npm run qa)
    │   ├── clean-repos.ts                 # Baseline reset script (npm run clean)
    │   │
    │   ├── orchestrator/
    │   │   └── orchestrator.ts            # Main workflow coordinator
    │   │
    │   ├── agents/
    │   │   ├── impact-analysis/agent.ts   # Scopes task impact across repositories
    │   │   ├── deduplication/agent.ts     # Task duplication & codebase verification
    │   │   ├── testing/agent.ts           # Deterministic test runner
    │   │   └── team-agent/
    │   │       ├── team-agent.ts          # Multi-repo coordinator (parallel/sequential)
    │   │       └── repo-agents/
    │   │           ├── base-repo-agent.ts # Base class for repository agents
    │   │           ├── repo-agent-a/      # Payment Service agent
    │   │           ├── repo-agent-b/      # Order Service agent
    │   │           └── repo-agent-c/      # Notification Service agent
    │   │
    │   ├── providers/
    │   │   └── ai-provider.ts             # AIProvider interface and MockAIProvider
    │   │
    │   └── models/
    │       └── types.ts                   # Domain models and TypeScript interfaces
    │
    ├── repositories/
    │   ├── repo-a/                        # Payment Service sample repo (with test suite)
    │   ├── repo-b/                        # Order Service sample repo (with test suite)
    │   └── repo-c/                        # Notification Service sample repo (with test suite)
    │
    ├── tests/
    │   └── orchestrator.test.ts           # 12 pipeline tests (+ regressions.test.ts, jira.test.ts)
    │
    ├── package.json
    ├── tsconfig.json
    └── .env.example                       # Environment configuration template
```

---

## Quick Start & Commands Guide

You can run all commands directly from the **root directory** (commands are automatically proxied to `ai-orchestrator`):

### 1. `npm start` — CLI Demonstration
Runs the two core demonstration scenarios specified in the requirements:
* **Scenario 1 (New Feature Task):** Takes ticket `PAY-101` (*"Add GET /health endpoint to the payment service"*), executes through the full pipeline, modifies `repo-a/src/server.ts`, runs repository tests, and marks the task completed.
* **Scenario 2 (Duplicate Task Guard):** Submits the identical `PAY-101` task again. The Deduplication Agent detects the duplicate, halts the pipeline early, and returns `DUPLICATE_SKIPPED` without wasting compute or AI tokens.

```bash
npm start
```

---

### 2. `npm run qa` — Automated QA Test Suite
Executes an automated end-to-end QA harness across **7 scenarios**, asserting the expected status and exact repos for each (exits 1 on any failure):
1. **Single Repo Task (`PAY-101`)**: Updates Payment Service (`repo-a`).
2. **Single Repo Task (`ORD-201`)**: Updates Order Service (`repo-b`).
3. **Single Repo Task (`NOTIF-301`)**: Updates Notification Service (`repo-c`).
4. **Parallel Multi-Repo (`CROSS-401`)**: Executes changes in `repo-a`, `repo-b`, and `repo-c` concurrently via `Promise.all`.
5. **Dependent Sequential Multi-Repo (`DEP-501`)**: Enforces dependency ordering where `repo-b` waits for `repo-a` before running.
6. **Deduplication Guard**: Verifies that re-submitting a completed ticket stops execution.
7. **No Matching Repo (`UNR-601`)**: An unroutable ticket stops with `NO_MATCHING_REPO` and no code is written.

```bash
npm run qa
```

---

### 3. `npm run clean` — Revoke All Changes & Reset to Baseline
Restores all 3 repositories back to their clean initial state and deletes `.task-history.json`. Use this anytime you want to clear out generated code and restart fresh:

```bash
npm run clean
```

---

### 4. `npm test` — Run Automated Pipeline Tests
Runs **83 Vitest tests** (against a temporary copy of `repositories/`, so the sample repos are never modified). The 12 core pipeline tests cover every agent boundary, concurrency constraint, and error condition:
* Complete end-to-end new task pipeline execution.
* Deduplication early-exit stopping behavior.
* Re-run allowance when code is deleted from disk.
* AI provider failure handling.
* Repository path not found handling.
* Deterministic test failure handling.
* Parallel execution verification for independent repositories.
* Sequential dependency order execution.
* TeamAgent coordinate exception resilience.
* TestingAgent spawn failure resilience.
* Dependent repository skipped status tracking when upstream fails.
* Multi-repo agent instantiation across `repo-a`, `repo-b`, and `repo-c`.

Plus:
* 4 offline unit tests for the Jira client (`tests/jira.test.ts`, Jira API faked — no token needed).
* 16 pilot-foundation tests (`tests/pilot.test.ts`): catalog, ticket lock, test-integrity guard, verify contract, and a real git repo end-to-end (branch, worktree, commit, main checkout untouched).
* 14 regression tests (`tests/regressions.test.ts`): whole-word routing, no repo-a fallback, dedup-before-impact, dependency chains/cycles, path-escape blocking, non-destructive mock.

```bash
npm test
```

---

### 5. `npm run typecheck` — TypeScript Compiler Check
Verifies complete type safety across the codebase using `tsc --noEmit`:

```bash
npm run typecheck
```

---

## AI Provider Configuration

The orchestrator supports pluggable AI providers via the `AIProvider` interface:

### 1. `MockAIProvider` (Default)
* **Zero API keys required**: Runs 100% offline.
* **Deterministic & fast (< 1ms)**: Automatically generates code for `PAY-101` (health endpoint) and feature tickets.
* Configured by default in `.env`:
  ```env
  AI_PROVIDER=mock
  ```

Any other AI can be added later by implementing the same `AIProvider` interface (`name` + `generateChanges()`); no agent code needs to change.

---

## Pipeline Foundations (catalog, job lock, branches, verify, test integrity)

These follow the "Jira → Verified Dev Deploy" design and are all **opt-in or backward compatible** — the sample repos behave exactly as before.

| Feature | Where | What it does |
| :--- | :--- | :--- |
| **Service catalog** | `ai-orchestrator/catalog/repos.yaml` | One file lists every repo: path, routing keywords, `dependsOn` (deploy order), `verify` commands, owner, dev URL, Jenkins job. Adding a repo needs no code change. If the file is missing, built-in defaults are used. |
| **Job state + ticket lock** | `.jobs/<TICKET>/job.json` + `lock` | Only one run per ticket at a time (a second run returns `LOCKED`). Every stage, branch, commit and error is recorded; earlier runs are kept in `history`. Stale locks from crashed runs are taken over automatically. |
| **Branch + worktree per ticket** | `.worktrees/<TICKET>/<repo>` | For a repo that is its own git repository, work happens on branch `ai/<ticket>` in a separate worktree — **your own checkout is never touched**. On success the changes are committed there (never pushed). On failure nothing is committed and the worktree is kept for inspection. Non-git folders (like the samples) are worked on in place. |
| **Verify contract** | `verify:` in `repos.yaml` | The Testing Agent runs the repo's verify commands in order (stops at the first failure). Fallbacks: `make verify` if the Makefile has it, then `npm test`. |
| **Test-integrity guard** | Repo Agent, before writing | Blocks any change that deletes a test file, removes/comments out test cases, or adds `.skip` / `.only` / `xit` / `@Disabled` / pytest skip markers. Nothing is written if it trips. |
| **Jira comments** | Jira client | Comments are fetched (read-only) and shown in `--dry-run`. |

```bash
npm start -- --status RT-123    # stages, branch, commit, earlier attempts
npm start -- --unlock RT-123    # remove a stuck lock (refuses if the run is still alive)
```

Cleanup after trying a ticket on a real repo: `git worktree remove .worktrees/<TICKET>/<repo>` and `git branch -D ai/<ticket>` (run inside that repo).

---

## Full Automation: Jira ticket → plan → approval → code → tests → PR

`npm run watch` polls Jira (default every 2 min) and drives labelled tickets end to end. **Labels are the only trigger.**

```
You add label  ai-ready
   → watcher: duplicate check → impact analysis → Claude Code drafts a change plan (read-only)
   → Jira comment with the plan + label ai-plan-pending          (nothing changed yet)
Tech lead adds label  ai-approved
   → Claude Code: tests first → code → verify; pipeline re-verifies (install / typecheck / test)
   → commit on ai/<ticket> → push → Bitbucket PR → Jira comment with PR link + label ai-pr-raised
Any failure → Jira comment with the reason + label ai-needs-human
```

| Command | What it does |
| :--- | :--- |
| `npm run watch` | Poll continuously (Ctrl+C stops after the current cycle) |
| `npm run watch -- --once` | One cycle and exit (for Jenkins/cron) |
| `npm run watch -- --dry-run` | Show what it would do: no Jira writes, no AI runs |

Guardrails: only labelled tickets; one watcher at a time; per-ticket lock; max 3 attempts; only `ai/*` branches are pushed; **nothing is merged or deployed automatically**. PRs need the repo to be a real git clone with `bitbucket` + `baseBranch` in `catalog/repos.yaml` and `BITBUCKET_TOKEN` set; otherwise the ticket is labelled `ai-done` and the comment says why no PR was opened. Settings: see `.env.example`.

---

## Jira Integration

Tickets can be pulled straight from Jira Cloud instead of the hard-coded demo task.

**Setup** (in `ai-orchestrator/.env`):
```env
JIRA_BASE_URL=https://your-site.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=...          # https://id.atlassian.com/manage-profile/security/api-tokens
# optional: custom field that stores acceptance criteria
JIRA_ACCEPTANCE_CRITERIA_FIELD=customfield_10042
```

**Usage** (from the repo root or `ai-orchestrator/`):
```bash
npm start -- --dry-run RT-123                 # fetch + show the parsed task, change nothing
npm start -- RT-123                           # run one ticket through the pipeline
npm start -- RT-123 RT-124                    # several tickets
npm start -- --jql "project = RT AND status = 'Ready for Dev'" --max 3
```

**How tickets map to tasks**
| Jira field | TaskInput |
| :--- | :--- |
| Issue key | `id` |
| Summary | `title` |
| Description (ADF → text) | `description` |
| "Acceptance Criteria" section of the description, or `JIRA_ACCEPTANCE_CRITERIA_FIELD` | `acceptanceCriteria[]` |
| Labels, components, status, priority, URL | `metadata` |

Labels and components are also used by the Impact Analysis Agent for routing — e.g. add the label `repo-b` (or component `payment`) to send a ticket to that repository.

The integration is **read-only**: it never comments on or transitions Jira issues.

---

## Pushing to GitHub

To push this repository to GitHub:

### Step 1: Create a new repository on GitHub
Go to [github.com/new](https://github.com/new) and create a new repository (e.g. `ai-orchestrator` or `ai-development-orchestrator`). Do not initialize with README or .gitignore since they are already present.

### Step 2: Initialize Git and Commit
In your terminal, run:

```bash
# 1. Initialize git in the root folder
git init

# 2. Stage all files (respecting .gitignore)
git add .

# 3. Create initial commit
git commit -m "feat: complete local AI development orchestrator POC"

# 4. Set main branch
git branch -M main

# 5. Link to your GitHub remote repository (replace with your repo URL)
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git

# 6. Push to GitHub
git push -u origin main
```

> **Note for macOS users**: If running `git` displays `xcode-select: note: No developer tools were found, requesting install`, click **Install** on the Apple prompt (or run `xcode-select --install` in terminal) to enable command-line Git. Alternatively, you can publish the repository directly using **GitHub Desktop** or the **Source Control** tab in VS Code.

