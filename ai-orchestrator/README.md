# AI Development Orchestrator (Local POC)

A modular, test-driven local AI development orchestrator built with Node.js and TypeScript. It coordinates a pipeline of specialized agents to analyze, deduplicate, plan, implement, and deterministically test software engineering tasks across multiple repositories.

---

## Architecture Overview

The system decouples high-level coordination from low-level repository modifications and coding models. The overall workflow follows a single-direction pipeline with early exit checks:

```
Input Task (e.g. PAY-101)
    │
    ▼
[Impact Analysis Agent]   ──► Determines affected repositories, modules, files
    │
    ▼
[Deduplication Agent]     ──► Halts pipeline if task is duplicate/already implemented
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
[Structured Result]       ──► OrchestratorResult with status, diffs, & logs
```

---

## Agent Responsibilities

| Agent / Component | Responsibility |
| :--- | :--- |
| **Orchestrator** | Owns and controls the end-to-end execution workflow. Dispatches tasks across agents, passes structured typed contexts, enforces error boundaries, and produces the final execution summary. |
| **Impact Analysis Agent** | Analyzes the incoming task specifications and acceptance criteria to identify impacted repositories, modules, and target files with confidence scores and reasoning. |
| **Deduplication Agent** | Guards the pipeline against redundant work. Compares the task against completed/in-progress tasks using ID matching and semantic keyword overlap. |
| **Team Agent** | Coordinates repository-level execution. Generates a dependency graph, schedules independent repositories concurrently via `Promise.all`, and executes dependent repositories sequentially. |
| **Repo Agent** | Strictly bound to a single repository (`repoId`, `repoPath`). Gathers existing source files, prepares a focused prompt context for the AI model, and safely writes the returned code changes to disk. |
| **AI Provider Abstraction** | Decouples the reasoning engine from the orchestration logic. Allows swapping between local offline mocks and cloud models without altering agent logic. |
| **Testing Agent** | Executes deterministic tests (e.g., repository `npm test` suites, syntax verification, contract tests) post-modification. Does not rely on LLM claims that code works. |

---

## Project Structure

```
ai-orchestrator/
├── src/
│   ├── index.ts                           # Entry point and CLI runner
│   │
│   ├── orchestrator/
│   │   └── orchestrator.ts                # Main workflow coordinator
│   │
│   ├── agents/
│   │   ├── impact-analysis/
│   │   │   └── agent.ts                   # Analyzes task impact on repos
│   │   ├── deduplication/
│   │   │   └── agent.ts                   # Task duplication & overlap detection
│   │   ├── testing/
│   │   │   └── agent.ts                   # Deterministic test runner
│   │   └── team-agent/
│   │       ├── team-agent.ts              # Multi-repo coordinator (parallel/sequential)
│   │       └── repo-agents/
│   │           ├── base-repo-agent.ts     # Reusable base logic for repo agents
│   │           ├── repo-agent-a/
│   │           │   └── agent.ts           # RepoAgentA (Payment Service)
│   │           ├── repo-agent-b/
│   │           │   └── agent.ts           # RepoAgentB (Order Service)
│   │           └── repo-agent-c/
│   │               └── agent.ts           # RepoAgentC (Notification Service)
│   │
│   ├── providers/
│   │   ├── ai-provider.ts                 # AIProvider interface and MockAIProvider
│   │   └── claude-provider.ts             # Anthropic Claude API provider
│   │
│   └── models/
│       └── types.ts                       # Typed domain models, options, and results
│
├── repositories/
│   ├── repo-a/                            # Payment Service sample repo (with test suite)
│   │   ├── package.json
│   │   ├── src/server.ts
│   │   └── tests/test.js
│   ├── repo-b/                            # Order Service sample repo (with test suite)
│   │   ├── package.json
│   │   ├── src/index.ts
│   │   └── tests/test.js
│   └── repo-c/                            # Notification Service sample repo (with test suite)
│       ├── package.json
│       ├── src/index.ts
│       └── tests/test.js
│
├── tests/
│   └── orchestrator.test.ts               # Complete Vitest test suite (11 tests)
│
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

---

## How AI Providers Work

### 1. `MockAIProvider` (Default)
- **Zero API keys required**: Runs completely offline.
- **Transparent and deterministic**: Generates realistic code changes based on the task description and acceptance criteria (e.g., implementing `GET /health` with `status: 'UP'` for `PAY-101`).
- Accurately reports its provider name as `'mock'` so audit trails reflect that mock reasoning was used.

### 2. `ClaudeProvider`
- Behind the same `AIProvider` interface:
  ```typescript
  export interface AIProvider {
    readonly name: string;
    generateChanges(options: AIProviderGenerateOptions): Promise<AIProviderResponse>;
  }
  ```
- Uses native `fetch` against the Anthropic Messages API (`claude-3-5-sonnet-20241022`).
- Asks Claude to output structured JSON matching the `FileChange[]` schema:
  ```json
  {
    "reasoning": "Implemented GET /health returning status UP",
    "fileChanges": [
      {
        "path": "src/server.ts",
        "action": "modify",
        "content": "..."
      }
    ]
  }
  ```
- Configured via environment variables:
  ```bash
  AI_PROVIDER=claude
  ANTHROPIC_API_KEY=sk-ant-api03-...
  ANTHROPIC_MODEL=claude-3-5-sonnet-20241022
  ```

---

## Execution Flow & Demo

When running `npm start`, the demo executes two scenarios:

### Scenario 1: New Task (`PAY-101`)
```
[ORCHESTRATOR]
Task received: PAY-101 - Add health endpoint

[IMPACT ANALYSIS]
Analyzing affected repositories...
Identified 1 affected repo(s): repo-a (Confidence: 95%)

[DEDUPLICATION]
Checking for duplicate/overlapping work...
Task status: NEW (No duplicate or overlapping work found in task history.)

[TEAM AGENT]
Coordinating work across repositories: repo-a

[MOCK]
Generating implementation...

[TESTING]
Running tests on modified repositories...

[RESULT]
Success
```

### Scenario 2: Duplicate Task Submission
```
[ORCHESTRATOR]
Task received: PAY-101 - Add health endpoint

[IMPACT ANALYSIS]
Analyzing affected repositories...

[DEDUPLICATION]
Checking for duplicate/overlapping work...
Task flagged as DUPLICATE of PAY-101. Halting pipeline.
Reason: Task with ID PAY-101 has already been processed (status: COMPLETED).

[RESULT]
Failed: Task is duplicate
```

---

## How to Run the Local POC

### Prerequisites
- Node.js 18+ (tested on Node.js v20)
- npm

### Installation & Run

1. Navigate to the project directory:
   ```bash
   cd ai-orchestrator
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

### Available Commands

| Command | Purpose |
| :--- | :--- |
| `npm start` | Runs the main CLI demo (Scenario 1 new task + Scenario 2 duplicate detection). |
| `npm run qa` | Runs the automated QA suite across 6 sample tickets (single repo, parallel multi-repo, dependent sequential, deduplication). |
| `npm run clean` | Revokes all generated code and resets repositories and `.task-history.json` to baseline. |
| `npm test` | Runs the complete 12-test Vitest test suite. |
| `npm run typecheck` | Runs TypeScript compiler checks (`tsc --noEmit`). |

---

## How to Add Another Repo Agent

Every repository is managed by an instance of `RepoAgent`. To add a new repository:

1. **Create the repository directory**:
   ```bash
   mkdir -p repositories/repo-c/src
   mkdir -p repositories/repo-c/tests
   ```

2. **Add a package descriptor and deterministic test**:
   - `repositories/repo-c/package.json` with `"scripts": { "test": "node tests/test.js" }`
   - `repositories/repo-c/tests/test.js` validating the repository invariants.

3. **Register impact rules in `ImpactAnalysisAgent`**:
   Add keyword routing to `customRules`:
   ```typescript
   {
     keywords: ['notification', 'email', 'sms', 'repo-c'],
     repositories: ['repo-c'],
     modules: ['notification-service']
   }
   ```

4. **Define dependencies (optional)**:
   In `TeamAgentConfig`, if `repo-c` depends on `repo-a`, pass:
   ```typescript
   dependencies: {
     'repo-c': ['repo-a']
   }
   ```
   Independent repositories automatically execute in parallel; dependent repositories will wait until upstream repositories complete successfully.

---

## Future Architecture Extensions

Because each component adheres to an explicit interface, future integrations can be slotted in without rewriting orchestration logic:

1. **Jira Integration**: Swap or extend `TaskInput` ingestion by querying the Jira REST API for issues transitioned to "Ready for Dev".
2. **Bitbucket / Git Provider**: Wrap `RepoAgent` with git branch management (`git checkout -b feature/PAY-101`) and automated pull request creation.
3. **Jenkins / CI Agent**: In `TestingAgent`, trigger a remote Jenkins job via webhook or webhook polling in addition to local deterministic test suites.
4. **Postman / Newman Agent**: Add an integration test stage in `TestingAgent` running automated Newman collections against a local ephemeral container.
5. **Telemetry & SigNoz**: Instrument the orchestrator lifecycle using OpenTelemetry spans around each agent step, emitting traces to a SigNoz collector.

