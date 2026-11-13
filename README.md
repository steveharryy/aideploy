# AI Development Orchestrator

Turns a Jira ticket into a reviewed plan and, after a person approves it, into tested code on its own branch.

A person adds the label `ai-ready` to a Jira ticket. The pipeline checks the ticket, a planning agent reads the real code and writes a plan, and people answer its questions and approve the plan **in Jira comments**. Only after approval does a coding agent write tests and code on a branch `ai/<ticket>`. The pipeline re-runs the checks itself and opens a pull request. **Nothing is merged or deployed automatically.**

Built with Node.js 24 and TypeScript. The AI agents run on Claude Code.

---

## Contents

1. [How it works](#how-it-works)
2. [Setup](#setup)
3. [Running it](#running-it)
4. [Using it from Jira](#using-it-from-jira)
5. [Configuration](#configuration)
6. [Guardrails](#guardrails)
7. [Where state is kept](#where-state-is-kept)
8. [Operations](#operations)
9. [Development](#development)
10. [Not built yet](#not-built-yet)

---

## How it works

```text
Jira ticket + label ai-ready
   │
   ▼
Trigger ─── poller (every 2 min) or Jira webhook; one ticket at a time
   │
   ▼
Guards ──── kill switch · duplicate check · one run per ticket
   │
   ▼
Context ─── ticket, comments, parent, links, Confluence pages, similar tickets
   │
   ▼
Intake ──── plain code, no AI cost: description, issue type, size (+ product/component per project)
   │           fails → comment "what is missing", ticket assigned back to the reporter
   ▼
Planning agent ─── Claude Code with all built-in tools OFF, only 5 guarded tools:
   │                 jira_read · list_repos · search_code · read_file · submit_plan
   │                 reads the real repos (pipeline-owned clones on main)
   ▼
Decision (code, not the AI)
   ├─ expected behaviour or product/repo missing  → comment: what is missing   (needs_info)
   ├─ blocking gap or unclear edge case          → comment: questions A/B/C    (needs_input)
   ├─ invalid plan or error                      → comment: why                (needs_human)
   └─ all clear                                  → comment: formatted plan     (plan_review)
   │
   ▼
People in Jira ── answer in a comment + re-add ai-ready (loops back to Context)
   │               request changes: comment + ai-ready → plan v2, v3…
   │               approve: add label ai-approved
   ▼
Coding (after approval only) ── per repo, in plan order, on branch ai/<ticket> from main
   │   Claude Code in a sandbox copy: tests first (must fail) → code → verify
   │   pipeline checks: files stay in the repo, no test deleted/skipped; re-runs verify itself
   ▼
Commit on ai/<ticket> → push + Bitbucket PR (when configured) → PR link on Jira → a person merges
```

### The planning decision

The planning agent fills a 7-item readiness checklist (expected behaviour, current behaviour, product and repo, example, edge cases, scope, verification), recording each as found, missing or ambiguous and where it found it. It rates every gap: *if I guess wrong, does it change what users see, money or data?* No means **minor** (it states an assumption). Yes means **blocking** (it writes a question with options and a default). It also sweeps edge cases from the code, existing tests, past tickets, the business domain and generic cases (boundaries, nulls, concurrency, money rounding).

Code then decides, using the same rule every time:

```text
expected behaviour OR product/repo not found   → TOO VAGUE  (back to the reporter)
any blocking gap OR any unclear edge case      → QUESTIONS  (asked in a Jira comment)
otherwise                                       → READY      (plan posted; minor gaps listed as assumptions)
```

Before posting, code also validates the plan: every checklist item present, repos in the catalog and cloned, every acceptance criterion and test linked to a work item, no dependency cycles, and a shared contract when more than one repo changes. It raises risk for money topics, merges duplicate questions, turns a low-confidence repo choice into a question, and adds a warning when the chosen repo differs from the component map.

---

## Setup

Requirements: Node.js 22.12+ (24 recommended), git, access to the Bitbucket repos over SSH, a Jira Cloud account, and a Claude account logged in to Claude Code on the machine (`npx claude` once to log in).

```bash
cd ai-orchestrator
npm ci
cp .env.example .env        # fill in JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN (use a bot account)
```

Clone the repos the pipeline may work on into `ai-orchestrator/.repos/` (gitignored), on their base branch. These are the pipeline's own clones; developers' working copies are never used.

```bash
mkdir -p .repos && cd .repos
git clone --branch main git@ssh.bitbucket.org:rosstech/gb-event-api-service.git
# … one per repo listed in catalog/repos.yaml
git -C gb-event-api-service pull --ff-only   # refresh before planning
```

Then check:

```bash
npm run typecheck && npm test          # 205 tests, no network
npm start -- --plan T2-123             # plan one ticket: read-only, no Jira writes
```

---

## Running it

All commands work from the repo root or from `ai-orchestrator/`.

| Command | What it does |
|---|---|
| `npm run watch` | Poll Jira every 2 minutes and handle labelled tickets end to end |
| `npm run watch -- --once` | One polling cycle, then exit (for cron/Jenkins) |
| `npm run watch -- --dry-run` | Show what would happen: no Jira writes, no AI runs |
| `npm run webhook` | Receive Jira webhooks on `POST /webhooks/jira` (health: `GET /healthz`), with a JQL safety-net poll every 15 minutes |
| `npm start -- --plan T2-123` | Plan one ticket in the terminal. Read-only, nothing posted |
| `npm start -- T2-123` | Plan, approve in the terminal, then code (manual run) |
| `npm start -- --sessions` | Every ticket and its current phase |
| `npm start -- --status T2-123` | One ticket's phase history and job details |
| `npm start -- --unlock T2-123` | Remove a stuck lock (refused while a run is alive) |
| `npm start -- --demo --provider mock` | Offline demo on the sample repos |

Only one watcher or webhook server runs at a time (lock file in `.jobs/`).

### Webhook setup in Jira

Jira needs a public HTTPS URL for the server (for testing: `cloudflared tunnel --url http://localhost:8080`). Then either:

- **Jira Automation** (project admin): trigger *Field value changed: Labels*, condition JQL `labels in (ai-ready, ai-approved)`, action *Send web request* to `https://<host>/webhooks/jira`, header `X-Webhook-Secret: <JIRA_WEBHOOK_SECRET>`, body `{"issueKey": "{{issue.key}}"}`.
- **System webhook** (Jira admin): URL as above, *Secret* = `JIRA_WEBHOOK_SECRET`, event *Issue updated*, JQL filter on the labels.

The webhook only tells the pipeline which ticket to look at. The ticket is always re-read from Jira, so a forged request cannot change what runs.

---

## Using it from Jira

Only two labels exist, and people set both:

| Label | Meaning |
|---|---|
| `ai-ready` | Plan this ticket, or "I answered / updated it, plan again" |
| `ai-approved` | I approve the posted plan, implement it |

The pipeline removes a label once it has acted on it. Everything else happens in comments:

| You see on the ticket | What to do |
|---|---|
| **Questions** (yellow panel), options A/B/C with a default | Reply in a comment, e.g. `Q1: A, Q2: B` or in your own words, then add `ai-ready` again |
| **Not enough information** (red panel), ticket assigned to you | Add the listed details to the ticket or a comment, then add `ai-ready` again |
| **Change plan** (tables, risk, acceptance criteria, tests, edge cases) | Approve: add `ai-approved`. Request changes: comment them and add `ai-ready` (you get a revised plan). Reject: do nothing |
| **PR link** | Review and merge it like any other PR |
| **Stopped, a person needs to look** | Read the reason, fix it, re-add the label |

There is no Slack integration; Jira is the only channel.

---

## Configuration

| File | What it holds |
|---|---|
| `ai-orchestrator/.env` | Secrets and connections (see `.env.example`) |
| `ai-orchestrator/config/pipeline.yaml` | Kill switch, prompt version, planning limits, intake rules (default and per project), Jira field IDs, phase → Jira status mapping. Read fresh before every step, so changes apply without a restart |
| `ai-orchestrator/config/components.yaml` | Jira component **or label** → repos, product and `risk_floor`. The first thing used to pick repos |
| `ai-orchestrator/catalog/repos.yaml` | Every repo the pipeline may touch: path, base branch, Bitbucket slug, routing keywords, verify commands |
| `ai-orchestrator/prompts/planning-v2.md` | The planning agent's instructions, versioned in Git. Change it by adding `planning-v3.md` and setting `prompt_version` |

Current settings for **T2**: no Product or component required, issue types Story, Task and Bug, at most 3 story points. Moving tickets through Jira workflow statuses per phase is mapped in `pipeline.yaml` but **off** (`move_status: false`) until the mapping is agreed.

Repos in the catalog today (all on `main`): gb-homepage-api, gb-payments-api, gb-event-api, gb-onboarding-api, gb-backoffice-api, gb-bo-admin-fe, gamebull-web. `gb-webhook-api-service` is left out because its `main` has no code.

---

## Guardrails

**Entry**
- Only labelled tickets.
- Kill switch: `kill_switch: true` in `pipeline.yaml` or `AI_KILL_SWITCH=true`. A broken config counts as "on".
- One run per ticket; one watcher per machine.
- Webhook secret or HMAC check, duplicate deliveries dropped, project allowlist.

**Planning agent**
- Claude Code runs with every built-in tool switched off (no edit, shell or web).
- Its only tools are ours, each guarded in code:
  - `read_file`: stays inside the repo (no `../`, no symlink escape), at most 400 lines and 512 KB, refuses dependency folders and secret files (`.env*`, keys, credentials, `*.tfvars`, `*secret*`…).
  - `search_code`: at most 20 matches and 10 seconds.
  - `jira_read`: allowed projects only.
  - `submit_plan`: validated, with one retry.
- Limits per run: 80 tool calls, $5, 20 minutes.
- The Jira token reaches only our local tool server, never the agent's process. Per-run files are private and deleted afterwards.
- Ticket text, comments and code are treated as data; instructions inside them are ignored.

**Decisions**
- Code applies the decision rule and validation. The AI's own verdict is not used.
- Money topics (payouts, wallets, odds, withdrawals…) raise risk and make gaps blocking.
- Loop limits: 2 question rounds, 3 plan revisions, 2 retries for temporary AI failures (usage limit, timeout), then a person.

**People**
- Nothing is coded without `ai-approved`.
- The pipeline only comments, removes trigger labels and assigns too-vague tickets back to the reporter.

**Coding phase**
- Only the approved plan's repos and order.
- Separate git worktree on `ai/<ticket>`; the agent works in a sandbox copy without secrets.
- Changes outside the repo, or that delete, skip or weaken tests, are rejected.
- The pipeline re-runs verify itself.
- Only `ai/*` branches are pushed, never `main`; nothing is merged or deployed.
- At most 3 attempts.

---

## Where state is kept

Local files on the machine running the pipeline (gitignored):

| What | Where |
|---|---|
| Phase of each ticket, with history | `.jobs/<ticket>/session.json` |
| Questions asked and the round | `.jobs/<ticket>/questions.json` |
| Posted plan, version, approver; earlier versions | `.jobs/<ticket>/plan.json`, `plan.md`, `plan.v1.json` |
| Coding run: stages, branch, commit, PR | `.jobs/<ticket>/job.json` |
| Pipeline-owned repo clones | `ai-orchestrator/.repos/` |
| Coding worktrees | `ai-orchestrator/.worktrees/` |

Phases: `planning → needs_input / needs_info / plan_review → approved → coding → pr_open / done`, or `needs_human` when something fails. The session store sits behind an interface, so a database (for example DynamoDB) can replace the files later.

---

## Operations

- **Stop everything new:** set `kill_switch: true` in `config/pipeline.yaml` (applies at the next step, no restart).
- **See what is happening:** `npm start -- --sessions`, `npm start -- --status T2-123`, and the watcher's log lines.
- **A ticket is stuck:** check `--status`, read the latest Jira comment, `--unlock` if a lock remains after a crash, then re-add the label.
- **Cost:** a planning run costs about $0.20–$1.10 on our repos; the cap is $5 per run.
- **Rotate tokens** regularly. Use a bot account for Jira, not a personal one.

---

## Development

```bash
cd ai-orchestrator
npm run typecheck
npm test                 # vitest: unit, integration and a real MCP tool-server round trip; no network
npm run build            # compiles to dist/ (the tool server then runs without tsx)
npm run qa               # offline QA scenarios on the sample repos
```

See [ai-orchestrator/README.md](ai-orchestrator/README.md) for the code layout and how to add a repo.

---

## Not built yet

| Item | Needs |
|---|---|
| Coding phase run on the real repos | One approved test ticket, with a network-restricted sandbox |
| Bitbucket pull requests | `BITBUCKET_TOKEN` and `bitbucket` + `baseBranch` per repo (already in the catalog) |
| Jira status moves per phase | Agree the mapping in `pipeline.yaml`, then `move_status: true` |
| Reminders for unanswered questions (4 h / 24 h / 48 h) | Jira comments with @mentions |
| Shared database and several tickets at once | DynamoDB backend for the session store |
| Retries and timeouts on Jira API calls; recovery of tickets left mid-run after a crash | Planned before unattended production use |
