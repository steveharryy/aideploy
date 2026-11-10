# AI Development Orchestrator

A modular, test-driven local AI development orchestrator built with Node.js and TypeScript. It coordinates a pipeline of specialized agents to analyze, deduplicate, plan, implement, and deterministically test software engineering tasks across multiple repositories.

---

## Architecture Overview

The system decouples high-level coordination from low-level repository modifications and coding models. The overall workflow follows a single-direction pipeline with early exit guards:

```text
Input Task (e.g. PAY-101)
    │
    ▼
[Impact Analysis Agent]   ──► Scopes affected repositories, modules, and target files
    │
    ▼
[Deduplication Agent]     ──► Halts pipeline early if task is duplicate/already implemented
    │
    ▼
[Team Agent]              ──► Analyzes dependencies and coordinates Repo Agent(s)
    │
    ├─── Repo Agent (repo-a)  ──► Inspects repo, builds context, invokes AI
    ├─── Repo Agent (repo-b)  ──► Executes in parallel (or sequential if dependent)
    │
    ▼
[AI Provider Abstraction] ──► MockAIProvider (default offline) or ClaudeProvider
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
| **AI Provider Abstraction** | Decouples the reasoning engine from orchestration logic. Allows swapping between local offline mocks and cloud LLMs (Claude, Gemini) without changing agent code. |
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
    │   │   ├── ai-provider.ts             # AIProvider interface and MockAIProvider
    │   │   └── claude-provider.ts         # Anthropic Claude API provider
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
    │   └── orchestrator.test.ts           # 12 automated pipeline tests (npm test)
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
Executes an automated end-to-end QA harness across **6 diverse scenarios**:
1. **Single Repo Task (`PAY-101`)**: Updates Payment Service (`repo-a`).
2. **Single Repo Task (`ORD-201`)**: Updates Order Service (`repo-b`).
3. **Single Repo Task (`NOTIF-301`)**: Updates Notification Service (`repo-c`).
4. **Parallel Multi-Repo (`CROSS-401`)**: Executes changes in `repo-a`, `repo-b`, and `repo-c` concurrently via `Promise.all`.
5. **Dependent Sequential Multi-Repo (`DEP-501`)**: Enforces dependency ordering where `repo-b` waits for `repo-a` before running.
6. **Deduplication Guard**: Verifies that re-submitting a completed ticket stops execution.

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
Runs the complete **12-test Vitest suite** testing every agent boundary, concurrency constraint, and error condition:
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

### 2. `ClaudeProvider` (Anthropic Claude 3.5 Sonnet)
To use real Claude intelligence, copy `.env.example` to `.env` and add your key:
```bash
cp .env.example .env
```
In `.env`:
```env
AI_PROVIDER=claude
ANTHROPIC_API_KEY=sk-ant-api03-xxxx...
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022
```

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

