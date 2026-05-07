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
  Hono --> StaticUI[/ui + /app static assets]

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
  SSE --> App[/app React chat UI]
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
- Mounts configured repos into `/home/user/workspace/repos/<owner>__<repo>` inside AgentOS.

### `env`

Files: `extensions/env/*`

- Host process tools for command execution and long-running processes.
- Useful for dev servers, but agents are instructed to prefer native tools for inspection and avoid fragile shell pipelines.

### `browser`

Files: `extensions/browser/*`

- Browser fetch/screenshot tools for UI verification and page inspection.

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

Files: `src/runtime/pi-view-extension.mjs`

- `view_image(path)` returns image attachments so agents/users can inspect PNG/JPG/etc. instead of reading binary files as text.

### `agents`

Files: `extensions/agents/*`, `src/runtime/pi-agents-extension.mjs`

- Lets agents fan out work to other agents.
- `start_jira_agent` is the preferred tool for ticket batches.
- `start_agent` is for generic non-Jira work.
- Fire-and-forget by design.

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
```

## Important configuration

```txt
AGENT_MODEL=openai-codex/gpt-5.5
AGENT_THINKING=xhigh
MAX_CONCURRENCY=3
AGENT_BOOT_CONCURRENCY=1
AGENT_BOOT_TIMEOUT_MS=120000
AGENT_SPAWN_LIMIT=25

JIRA_TRIGGER_MENTION=@agent
JIRA_TRIGGER_STATUSES=
JIRA_TRIGGER_LABELS=

CONTENTFUL_ENVIRONMENT=staging
```

Operational notes:

- Keep `AGENT_BOOT_CONCURRENCY` low; AgentOS boot is the fragile/expensive phase.
- Raise `MAX_CONCURRENCY` only if the server has enough memory/CPU and jobs are mostly I/O bound.
- Add swap on small servers if many agents may build/test at the same time.
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
