# background-agents

Background coding-agent service for long-running Pi/AgentOS jobs. It accepts HTTP/Jira triggers, stores durable job/event state on disk, runs isolated AgentOS workspaces with native host tools, and exposes both a classic `/ui` dashboard and a React `/app` chat UI.

## Quick start

```bash
cp .env.example .env
npm install
npm start
```

Open:

- `http://127.0.0.1:8787/app` — React chat UI for jobs, tool calls, and follow-ups
- `http://127.0.0.1:8787/ui` — legacy/simple overview UI

All protected routes require `Authorization: Bearer <AUTH_TOKEN>` when `AUTH_TOKEN` is set.

## High-level architecture

```mermaid
flowchart TD
  User[User / Browser / Jira] --> Hono[Hono HTTP server]
  Hono --> Auth[Auth + CORS]
  Hono --> Routes[API routes + extension routes]
  Hono --> StaticUI["/ui + /app static assets"]

  Routes --> Store[JobStore\nfile-backed job.json + events.jsonl]
  Routes --> Runner[JobRunner\nqueue + cancellation + concurrency]
  Runner --> Sink[JobEventSink\ncompact text/thinking/tool streams]
  Sink --> Store

  Runner --> Runtime[PiRuntime]
  Runtime --> BootGate[AgentOS boot gate\nAGENT_BOOT_CONCURRENCY]
  BootGate --> AgentOS[AgentOS VM / VFS]
  AgentOS --> Pi[Pi coding agent\nGPT model + thinking level]

  Pi --> NativeTools[Pi native tools\nread/bash/edit/write/grep]
  Pi --> HostTools[Host toolkits\nJira/GitHub/Git/Figma/Contentful/etc.]
  HostTools --> Jira[Jira API]
  HostTools --> GitHub[GitHub App/API]
  HostTools --> Figma[Figma API]
  HostTools --> Contentful[Contentful staging only]
  HostTools --> FS[Host artifacts/worktrees]

  Store --> SSE[SSE event stream]
  SSE --> App["/app React chat UI"]
  Store --> JobsAPI[Jobs API]
  JobsAPI --> App
```

### Request/job flow

1. A user, Jira webhook, or agent tool creates/enqueues a job.
2. `JobStore` persists `job.json` and appends durable events to `events.jsonl`.
3. `JobRunner` starts jobs up to `MAX_CONCURRENCY`; cancellation now cancels queued or running jobs and disposes live sessions.
4. `PiRuntime` prepares an isolated workspace and serializes session boot with `AGENT_BOOT_CONCURRENCY` so AgentOS startup does not stampede.
5. AgentOS mounts per-job worktrees/artifact directories and launches Pi with model/thinking settings.
6. Tool/text/thinking events pass through `JobEventSink`, which batches token streams and drops noisy partial tool-argument deltas before storing/streaming.
7. `/app` loads compacted history from `/api/jobs/:id?events=1` and then follows incremental SSE updates from `/api/jobs/:id/events?after=<lastEventId>`.

## Jira ticket pipelines

This is the end-to-end path for ticket-triggered work, including the places where prompt fragments are added and where native tool calls flow.

```mermaid
flowchart TD
  subgraph Ingress["Trigger paths"]
    Webhook["Jira webhook<br/>POST /api/jira/webhook"] --> Match{"Mention, status, or label match?"}
    Match -->|No| Ignored["Ignored<br/>or dry-run response"]
    Match -->|Yes| Buffer["Per-issue debounce buffer<br/>5 second window"]
    Buffer --> Flush["flushWebhook(issueKey)"]
    Manual["Manual Jira trigger<br/>POST /api/jira/trigger"]
    JobFollow["Existing ticket follow-up<br/>POST /api/jobs/:id/prompt"]
    RunIssue["Generic run with issueKey<br/>POST /api/run"]
    ChildTool["Agent tool call<br/>start_jira_agent"]
  end

  subgraph Prompting["Prompt assembly"]
    Flush --> Build["buildPrompt(config, body, events)"]
    Manual --> Build
    Build --> IssueKey["Resolve issue key"]
    IssueKey --> Fetch["Fetch Jira issue<br/>and recent comments"]
    Fetch --> Markdown["Convert Jira ADF<br/>to Markdown"]
    Markdown --> Happened["Add What just happened<br/>from trigger summaries"]
    Happened --> Extra["Add prompt or instructions<br/>as Additional instructions"]
    Extra --> Context["Add issue context<br/>and comment history"]
    Context --> Rules["Add Jira rules<br/>one final jira_add_comment<br/>native Git and GitHub tools"]
    JobFollow --> FollowPrompt["Caller follow-up prompt"]
    RunIssue --> RunPrompt["Caller prompt"]
    ChildTool --> ChildPrompt["Child Jira prompt<br/>independent agent<br/>parent instructions<br/>required workflow"]
  end

  subgraph Queueing["Store and queue"]
    Rules --> Existing{"Existing non-cancelled<br/>issue job?"}
    Existing -->|Running webhook| Pending["follow_up.pending<br/>retry after current run"]
    Pending --> Buffer
    Existing -->|Reusable job| Update["store.update<br/>status queued plus prompt"]
    Existing -->|New job| Create["store.create<br/>kind jira plus issueKey"]
    FollowPrompt --> Update
    RunPrompt --> Create
    ChildPrompt --> Create
    Update --> Policy["JobStore withJiraCommentPolicy<br/>for any issueKey job"]
    Create --> Policy
    Policy --> Enqueue["runner.enqueue"]
  end

  subgraph Runtime["Execution destination"]
    Enqueue --> Runner["JobRunner<br/>MAX_CONCURRENCY"]
    Runner --> Start["job.started"]
    Start --> PiRuntime["PiRuntime.run"]
    PiRuntime --> Session{"Live Pi session?"}
    Session -->|Yes| Reuse["Send follow-up<br/>followUp or steer mode"]
    Session -->|No| Boot["Boot AgentOS<br/>AGENT_BOOT_CONCURRENCY gate"]
    Boot --> Workspace["Clone or mount repos<br/>mount sessions and artifacts"]
    Workspace --> Extensions["Install Pi extensions<br/>Jira, Git, GitHub, Figma,<br/>Contentful, agents, MicroVM"]
    Reuse --> Agent["Pi coding agent"]
    Extensions --> Agent
  end

  subgraph Tools["Tool calls, events, and completion"]
    Agent --> NativeTools["Native coding tools<br/>read, edit, bash, grep,<br/>list_directory, find_files"]
    Agent --> ApiTools["Native API or host tools<br/>jira, git, GitHub, Figma,<br/>Contentful, view, vm_bash,<br/>start_jira_agent"]
    NativeTools --> ToolEvents["tool_start<br/>input snapshot<br/>completed or failed result"]
    ApiTools --> ToolEvents
    ToolEvents --> Sink["JobEventSink<br/>drops partial tool args<br/>batches text and thinking"]
    Sink --> Events["events.jsonl<br/>SSE to /app"]
    Agent --> Final{"Final Jira comment recorded?"}
    Final -->|Yes| Complete["job.completed"]
    Final -->|No and auto-continue enabled| Continue["Continuation prompt<br/>missing_final_jira_comment"]
    Continue --> Enqueue
    Final -->|No and limit exhausted| Interrupted["job.interrupted"]
    Complete --> JiraDone["Jira updated by jira_add_comment<br/>or optional autoComment fallback"]
  end
```

Prompt fragments by entry point:

| Entry point | Prompt fragments added before the job runs |
| --- | --- |
| `POST /api/jira/webhook` | Debounced matching webhook events become **What just happened** bullets, then issue context, recent comment history, Jira rules, and the final Jira comment policy. |
| `POST /api/jira/trigger` | Same `buildPrompt` path as webhooks, but from one request body rather than the debounce buffer. |
| `POST /api/jobs/:id/prompt` | Uses the caller's follow-up text; if the job has an `issueKey`, `withJiraCommentPolicy` is appended. |
| `POST /api/run` with `issueKey` | Uses the caller's prompt; `JobStore.create` appends `withJiraCommentPolicy`. |
| `start_jira_agent` tool | Builds an independent child-agent prompt with parent instructions, required Jira workflow, and the final Jira comment policy. |

For ticket jobs, tool-call noise is intentionally reduced before it reaches the UI: partial JSON argument deltas are dropped, one stable input snapshot is kept, and terminal tool results are stored/streamed.

## Runtime model and sessions

- Default model is configured by `AGENT_MODEL` and `AGENT_THINKING`.
- Live default in production has been `openai-codex/gpt-5.5` with `xhigh` thinking.
- AgentOS sessions are persisted under:

```txt
.data/workspaces/<jobId>/.pi-sessions
```

Session behavior:

- A live job/follow-up reuses the in-memory AgentOS/Pi session.
- Completed jobs followed up after restart can use context-resume, injecting previous output into a fresh AgentOS session to avoid stale resume hangs.
- On server startup, jobs left `running`/`queued` are recovered to `queued` and re-enqueued.
- Running cancellation disposes the live runtime session, releases runner/boot slots, and prevents late AgentOS completions from overwriting `cancelled`.

## Prompt construction

### Regular `/api/run`

The prompt is passed through mostly as provided, with the global agent system prompt added by `src/agents/default.mjs`.

### Jira webhook / `/api/jira/trigger`

`extensions/jira/index.mjs` builds a richer prompt:

1. Identifies the Jira issue key from the webhook/request.
2. Fetches the latest issue and recent comments through `JiraClient`.
3. Converts Jira ADF descriptions/comments to Markdown.
4. Prepends a **What just happened** block describing the trigger event.
5. Adds issue context and recent comment history.
6. Adds Jira-specific rules.

Current Jira behavior:

- Webhooks only auto-trigger on explicit `@agent` mention by default.
- Status/label triggers are disabled unless configured explicitly.
- Status triggers, if enabled, only match actual status-change changelog entries, not ordinary comments while an issue happens to be in that status.
- Agents are instructed to use `jira_add_comment` **only once at the end of the turn**.
- If the trigger is only the agent's own prior Jira comment and contains no new external feedback, the agent should not comment again.
- If code changes are made, agents should use native `git_commit`, `git_push`, and `gh_pr_create`/`gh_pr_comment` before the final Jira comment.

### Jira service-account auth

Preferred production Jira auth is a dedicated Jira Cloud service account with a
scoped API token, so comments and transitions are authored by the bot account
rather than by a human OAuth user.

Configure:

```txt
JIRA_AUTH_MODE=scoped-token
JIRA_CLOUD_ID=<site cloudId>
JIRA_SERVICE_ACCOUNT_EMAIL=<optional service account email>
JIRA_SERVICE_ACCOUNT_TOKEN=<scoped API token>
```

Scoped API tokens must call Atlassian's API gateway:
`https://api.atlassian.com/ex/jira/{cloudId}/...`; they do not work against
`https://your-site.atlassian.net/...`. The app uses bearer-token auth for this
mode. Keep `JIRA_BASE_URL` for human-facing links/config compatibility if
needed, but API calls in `scoped-token` mode use `JIRA_CLOUD_ID`.

The token and service account need both scopes and Jira project permissions. At
minimum, grant read/write Jira work scopes for issue/comment access. Board/JQL
tools additionally need scopes such as `read:board-scope:jira-software`,
`read:project:jira`, `read:filter:jira`, and `read:jql:jira` plus matching Jira
project/board permissions.

### Child-agent fan-out

The `agents` extension provides:

- `start_jira_agent({ issueKey, instructions? })` — starts an independent child agent for a Jira ticket. Only `issueKey` is required.
- `start_agent({ instructions, title? })` — starts a generic independent child agent.

These tools are fire-and-forget: the parent receives a child job id/URL but cannot retrieve child results.

## Frontend overview

### `/app`

`app/` is a Vite + React UI using AI/chat elements.

Key pieces:

- `app/src/App.tsx` — shell, routing via hash, job/health polling.
- `app/src/components/Sidebar.tsx` — job list and health/config surface.
- `app/src/components/ChatView.tsx` — job history load, SSE stream, follow-up input.
- `app/src/lib/chat.ts` — reduces compact agent events into chat messages.
- `app/src/components/ChatTurn.tsx` — renders user/assistant/system turns.
- `app/src/components/tool-renderers/*` — specialized renderers for Jira, Git/GitHub, images, diffs, terminals, JSON, etc.

Performance details:

- Server-side event compaction avoids replaying token-level tool JSON deltas.
- `/app` avoids double replay by opening SSE with `after=<lastEventId>` after loading initial history.
- Conversation resize scrolling is instant during streaming to prevent flicker.

### `/ui`

`ui/` is the older lightweight dashboard. It remains useful for a quick overview and compatibility.

## Extensions

Extensions live under `extensions/` and may provide HTTP routes, AgentOS host toolkits, or both.

```js
{
  id: "name",
  description: "...",
  routes(app, { config, store, runner }) {},
  toolkits({ config, job, processes, store, runner, runtime }) { return []; },
}
```

### `jira`

Files: `extensions/jira/*`, `src/runtime/pi-jira-extension.mjs`

- Webhook/OAuth/JQL routes.
- Tools: `jira_get_issue`, `jira_get_comments`, `jira_search`, `jira_count`, `jira_board_jql`, `jira_board_count`, `jira_list_attachments`, `jira_download_attachment`, `jira_add_comment`, `jira_list_transitions`, `jira_transition_issue`.
- Converts Jira ADF rich text to Markdown.
- Supports attachments/artifacts.
- Comments are native API calls, not CLI shims.

### `github`

Files: `extensions/github/*`, `src/runtime/pi-github-extension.mjs`

- GitHub App integration and installation-token refresh.
- Repository access and PR tooling.
- Tools include repo listing, PR creation, and PR comments.

### `git`

Files: `extensions/git/*`, `src/runtime/pi-git-extension.mjs`

- Host-side git operations against per-job worktrees.
- Tools: `git_status`, `git_diff`, `git_commit`, `git_push`, `git_log`.
- Agents should use these for commits/pushes instead of shelling out to fragile git commands inside AgentOS.

### `repo`

Files: `extensions/repo/*`, `extensions/github/repo-cache.mjs`

- Maintains bare repository caches and per-job worktrees under `.data/`.
- Agent branches are named `pt-ai-<last4 job id chars>` (for example `pt-ai-d938`), with no `/` in the branch name.
- Mounts configured repos into `/home/user/workspace/repos/<owner>__<repo>` inside AgentOS.

### `env`

Files: `extensions/env/*`

- Host process tools for command execution and long-running processes.
- Useful for dev servers, but agents are instructed to prefer native tools for inspection and avoid fragile shell pipelines.

### `browser`

Files: `extensions/browser/*`

- Browser fetch/screenshot tools for UI verification and page inspection.

### `microvm`

Files: `extensions/microvm/*`, `src/runtime/pi-microvm-extension.mjs`

- Adds explicit Gondolin MicroVM tools: `vm_bash`, `vm_read`, `vm_write`, `vm_edit`.
- Each job gets a lazy per-job Linux MicroVM with its workspace mounted at `/workspace`.
- Use `vm_bash` for builds/tests and tooling that needs real Linux binaries: `node`, `npm`, `yarn`, `agent-browser`, Chromium, etc.
- Git/Jira/GitHub/Figma/Contentful stay as host-native tools; MicroVMs are for isolated execution/validation, not secrets.
- Build the dependency image with `npm run microvm:build-image -- --force`, then prepare the reusable base snapshot with `npm run microvm:prepare -- --force`; later job VMs resume from `MICROVM_SNAPSHOT_PATH`.

### `figma`

Files: `extensions/figma/*`, `src/runtime/pi-figma-extension.mjs`

- Host-side Figma inspection/export to avoid sandbox payload limits.
- Tools include file/node inspection, node search, components/styles/comments/images, and high-resolution asset export.
- Large payloads/assets are saved to per-job artifact directories.

### `contentful`

Files: `extensions/contentful/*`, `src/runtime/pi-contentful-extension.mjs`

- Read-only Contentful inspection tools.
- Hard-restricted to the configured `staging` environment.
- No production/master path escape is allowed.
- Tools include typed content-type/entry inspection plus a scoped HTTP GET escape hatch.

### `files`

Files: `src/runtime/pi-files-extension.mjs`

- Reliable native filesystem tools inside AgentOS: `list_directory`, `find_files`.
- Used to avoid shell/glob/brush failures.

### `view`

Files: `extensions/view/*`, `src/runtime/pi-view-extension.mjs`

- `view_image(path)` delegates to a host-side binary reader and returns image attachments so agents/users can inspect PNG/JPG/etc. instead of reading binary files as text.
- This avoids AgentOS binary-file corruption for PNG/JPG attachments and artifacts.

### `agents`

Files: `extensions/agents/*`, `src/runtime/pi-agents-extension.mjs`

- Lets agents fan out work to other agents.
- `start_jira_agent` is the preferred tool for ticket batches.
- `start_agent` is for generic non-Jira work.
- Fire-and-forget by design.

## Deployment and release validation

Production deploys are handled by the standalone deployer in
`deploy/github-webhook-deployer/`, not by the app process itself.

High-level behavior:

- GitHub `push` webhooks go to `https://agents.petsdeli.de/github-webhook`.
- The webhook receiver verifies `X-Hub-Signature-256` and queues only pushes to
  `DEPLOY_REPO`/`DEPLOY_BRANCH`.
- Rapid pushes are consolidated through `/var/lib/background-agents-deployer/pending.json`:
  while one deploy runs, only the newest pending SHA is kept.
- A deploy builds a fresh release under `/opt/background-agents-releases`, runs
  checks, builds `/app`, waits for `/health.active === 0`, then atomically
  switches `/opt/background-agents-current` and restarts `background-agents.service`.
- `/api`, `/ui`, and `/app` are all served from the same current release.
- Runtime data/secrets/jobs/repo-cache/MicroVM images remain under
  `/root/background-agents`.

Validate the running version:

```bash
TOKEN=$(grep ^AUTH_TOKEN= /root/background-agents/.env | cut -d= -f2-)
curl -fsS -H "authorization: Bearer $TOKEN" http://127.0.0.1:8787/health | jq .release
readlink /opt/background-agents-current
git --git-dir=/var/lib/background-agents-deployer/repo.git rev-parse refs/remotes/origin/main
```

The `release.deploy.sha`, fetched GitHub `main` SHA, and release symlink prefix
should match. Full deployer docs, webhook setup, troubleshooting, and rollback
steps are in [`deploy/github-webhook-deployer/README.md`](deploy/github-webhook-deployer/README.md).

## API summary

```txt
GET  /health
GET  /api/config
PUT  /api/config/model
GET  /api/jobs
GET  /api/jobs/:id
GET  /api/jobs/:id/events
POST /api/jobs/:id/prompt
POST /api/jobs/:id/cancel
POST /api/jobs/:id/reset
POST /api/run
POST /api/jira/trigger
POST /api/jira/webhook
GET  /api/jira/search
POST /api/jira/search
GET  /api/microvm/status
POST /api/microvm/prepare
```

## Important configuration

```txt
AGENT_MODEL=openai-codex/gpt-5.5
AGENT_THINKING=xhigh
MAX_CONCURRENCY=10
AGENT_BOOT_CONCURRENCY=10
AGENT_BOOT_TIMEOUT_MS=45000
AGENT_BOOT_RETRIES=3
AGENT_AUTO_CONTINUE_LIMIT=0
AGENT_SPAWN_LIMIT=25

JIRA_TRIGGER_MENTION=@agent
JIRA_TRIGGER_STATUSES=
JIRA_TRIGGER_LABELS=
JIRA_AUTH_MODE=scoped-token
JIRA_CLOUD_ID=
JIRA_SERVICE_ACCOUNT_TOKEN=

CONTENTFUL_ENVIRONMENT=staging

MICROVM_ENABLED=false
MICROVM_IMAGE_PATH=.data/microvm/node-browser-image
MICROVM_SNAPSHOT_PATH=.data/microvm/base-node-browser.qcow2
MICROVM_MEMORY=1536M
MICROVM_CPUS=2
MICROVM_MAX_ACTIVE=2
```

Operational notes:

- `AGENT_BOOT_TIMEOUT_MS` and `AGENT_BOOT_RETRIES` prevent AgentOS startup from holding queue slots forever; stalled boots are disposed/requeued automatically.
- Jira agents are prompted to add one final `jira_add_comment` at the end of the turn. `AGENT_AUTO_CONTINUE_LIMIT` is disabled by default (`0`); set it above zero only if you explicitly want automatic recovery attempts for missing final comments.
- Raise `MAX_CONCURRENCY` only if the server has enough memory/CPU and jobs are mostly I/O bound.
- Add swap on small servers if many agents may build/test at the same time.
- Enable MicroVMs with `MICROVM_ENABLED=true`, install QEMU on the host, run `npm run microvm:build-image -- --force` once to build the node/npm/yarn/Chromium image, then run `npm run microvm:prepare -- --force` to create the reusable snapshot.
- Large historical event logs can be compacted with:

```bash
npm run events:compact
```

## Development workflow

For repository-changing agent work, the intended flow is:

1. Inspect code with native `read`, `list_directory`, `find_files`, grep/Jira/Figma/Contentful tools.
2. Make minimal edits.
3. Review with `git_diff` / `git_status`.
4. Commit with `git_commit`.
5. Push with `git_push`.
6. Open or update a GitHub PR with `gh_pr_create` / `gh_pr_comment`.
7. For Jira jobs, add one final Jira comment with PR, changes, tests, and blockers.

Credentials stay in the server process. Agents receive native host tools, not raw long-lived tokens.
