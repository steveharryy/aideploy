# ai-orchestrator: developer guide

How the pipeline works, how to set it up and how to use it from Jira is in the [main README](../README.md). This page covers the code.

## Layout

```text
ai-orchestrator/
├── config/
│   ├── pipeline.yaml          limits, kill switch, intake rules, Jira fields, prompt version
│   └── components.yaml        Jira component or label → repos, product, risk floor
├── catalog/repos.yaml         repos the pipeline may touch (path, base branch, verify commands)
├── prompts/planning-v2.md     planning agent instructions (versioned; v1 kept for history)
├── src/
│   ├── index.ts               CLI: --plan, --watch, --webhook, --sessions, --status; wiring
│   ├── automation/
│   │   ├── watcher.ts         label-driven flow: plan → questions / send back / plan for review → coding
│   │   └── webhook-server.ts  POST /webhooks/jira, secret check, dedupe, one-at-a-time queue
│   ├── agents/
│   │   ├── intake/intake.ts   checks before any AI call
│   │   ├── planning/
│   │   │   ├── planning-agent.ts  runs Claude Code with only our tools; collects the result
│   │   │   ├── tools.ts           the 5 tools and their guards
│   │   │   ├── mcp-server.ts      serves the tools to Claude Code (local, per run)
│   │   │   ├── plan-rules.ts      normalise, decision rule, validation, risk floor, coding brief
│   │   │   ├── render-adf.ts      formatted Jira comments (plan, questions, missing info)
│   │   │   ├── render.ts          plain-text versions (terminal and fallback)
│   │   │   └── types.ts           plan, checklist and edge-case types
│   │   ├── deduplication/, impact-analysis/, team-agent/, testing/   coding phase (from the POC)
│   ├── catalog/               service catalog and component map loaders
│   ├── config/                pipeline.yaml loader and validation
│   ├── integrations/          Jira and Bitbucket REST clients
│   ├── jobs/                  session store (phases), job store, locks
│   ├── providers/             AI providers: claude-code, claude, handoff, mock
│   └── workspace/             git worktree per ticket
├── tests/                     vitest suites; tests/fixtures/sample-catalog.yaml for the demo repos
└── repositories/              sample repos repo-a/b/c, used only by tests, QA and --demo
```

## Tests

```bash
npm test            # 218 tests, no network, no Jira, no Claude
npm run typecheck
```

`tests/planner-tools.test.ts` starts the real MCP tool server over stdio. Everything else uses fakes for Jira, Bitbucket and Claude.

## Adding a repo

1. Clone it into `.repos/<name>` on its base branch.
2. Add it to `catalog/repos.yaml`: `id`, `name`, `purpose`, `path: ../.repos/<name>`, `baseBranch`, `bitbucket`, `keywords`, `verify` (start with the install step).
3. Map its Jira components or area labels in `config/components.yaml`, with a `risk_floor` (`high` for money).
4. Run `npm test`: a test checks that both config files load and agree with the catalog.

## Changing the planning prompt

Add `prompts/planning-v3.md`, set `prompt_version: planning-v3` in `config/pipeline.yaml`, and run the same set of test tickets with `npm start -- --plan <key>` before and after. Every plan records the prompt version it was made with.
