# Coding Agent (points 4–9)

The coding agent turns **one approved work item** into a **tested, self-checked, reviewed change in one repo**.
Every AI step is followed by **deterministic gates** (plain code, no AI) that decide pass or fail.
Pushing, PRs and Jenkins (points 10–12) are not part of this stage yet.

Code: `src/agents/coding/` · Adapter: `src/providers/coding-agent-provider.ts` · CLI: `src/code.ts` · Tests: `tests/coding-agent.test.ts`

---

## Hand-off from the planning agent: the work item

One JSON object per repo. Schema: [`schemas/work-item.schema.json`](../schemas/work-item.schema.json) ·
Example: [`examples/work-item.example.json`](../examples/work-item.example.json)

| Field | Required | Notes |
| :--- | :--- | :--- |
| `ticket`, `workItemId`, `repo`, `title`, `summary` | yes | `repo` must exist in `catalog/repos.yaml` |
| `acceptanceCriteria[]` | yes | `{ id: "AC1", text }`, ids unique |
| `testPlan[]` | yes | `{ ac, name, description }`; **every AC needs ≥ 1 test**; `name` contains the AC id, e.g. `test_AC1_tied_ranks_split_evenly` |
| `plannedFiles[]` | no | expected scope; edits outside need a reason |
| `contract` | no | shared API/message contract; never changed by the coding agent |
| `assumptions[]`, `clarifications[]` | no | clarifications = answers to earlier questions (re-runs) |

```bash
npm run code -- --validate my-work-item.json      # check a planning-agent output against the contract
```

**Two ways to hand over:**
1. **File:** `npm run code -- --work-item W1.json [--apply]`.
2. **In the pipeline:** put the work items on the task as `task.metadata.workItems = [...]`. The coding agent picks the one whose `repo` matches.
   Until the planning agent exists, a work item is derived from the Jira ticket and the approved change plan (`workItemFromTask`).

---

## What happens (and what the code enforces)

| Point | Claude Code does | Gate (code, no AI) |
| :--- | :--- | :--- |
| setup | – | Repo copied to a **sandbox**. Setup steps run. **Existing tests must pass** (baseline), otherwise → `escalated` |
| **4 Tests first** | Reads CLAUDE.md/AGENTS.md + existing tests; writes tests per `testPlan` | Non-test edits are **reverted**. Existing tests can't be weakened. **Every AC id appears in a test name**. Suite must now **FAIL** (red) |
| **5 Implement** | Minimal change following the contract | Phase-4 tests are **locked**: edits are restored |
| **6 Local checks** | Fixes what it's shown | **The pipeline itself runs** every verify command from `repos.yaml` (setup → typecheck/lint → test → build); a failing command's trimmed log goes back to the agent |
| **7 Scope check** | Gives reasons for out-of-plan edits | Test integrity · **secret scan** · **debug leftovers** (console.log, print, debugger) · out-of-plan files need a reason · no empty change · every AC still has a test |
| **8 Ask when stuck** | Returns `blocked` + questions instead of guessing | At most **3** questions, prefixed `[repo]` → status `needs_input`, nothing applied |
| **9 Reviewer** | **Separate agent, fresh context, read-only**; sees the work item + diff + check results (never the coder's reasoning) | `blocker`/`major` findings or an AC judged not met → fix round; `minor` doesn't block |

- **One iteration budget** for all fix rounds (default **3**, `CODING_MAX_ITERATIONS`). When it runs out → `failed` with the open issues. There is no endless loop.
- **One continuous coder session** (`--session-id` then `--resume`), so the agent keeps context from tests to implementation to fixes.
- **Tools:** read/edit/search plus Bash limited to the repo's verify commands; no web; no MCP connectors; no secrets in its environment.
- Plan doesn't match reality (wrong repo, missing code, another repo needed) → `escalated`; it never improvises.

## Result

Saved to `.jobs/<ticket>/coding-<repo>.json`:

```json
{
  "ticket": "PAY-101", "workItem": "W1", "repo": "repo-a",
  "status": "ready_for_pr",
  "acceptanceCriteria": [{ "id": "AC1", "status": "met", "evidence": ["tests/health.test.js › test_AC1_health_reports_up"] }],
  "testsFirst": { "baselinePassed": true, "files": ["tests/health.test.js"], "failedBeforeChange": true },
  "checks": [{ "name": "setup", "passed": true }, { "name": "test", "passed": true }],
  "scope": { "changedFiles": ["src/server.ts", "tests/health.test.js"], "outOfPlan": [], "secrets": [], "debugLeftovers": [], "revertedFiles": [] },
  "review": { "verdict": "approve", "rounds": 1, "findings": [] },
  "iterationsUsed": 0, "maxIterations": 3,
  "questions": [], "assumptionsMade": [], "openIssues": []
}
```

`status`: `ready_for_pr` · `needs_input` (see `questions`) · `escalated` (see `escalation`) · `failed` (see `openIssues`; the sandbox is kept for inspection).

## Running it

```bash
npm run code -- --work-item examples/work-item.example.json          # sandbox only: report + proposed changes, repo untouched
npm run code -- --work-item examples/work-item.example.json --apply  # also apply through the Repo Agent guards
npm start -- T2-547                                                  # full pipeline: plan → approve → coding agent → pipeline verify
```

`AI_PROVIDER=coding-agent` is the default. Every agent uses **Claude Code** (your login) for now; later switch to the Claude API.

## Not in this stage
Point 10 (commit/push/PR), 11 (Jenkins QA build + fix loop) and 12 (report to the orchestrator, beyond the JSON above) are next.
