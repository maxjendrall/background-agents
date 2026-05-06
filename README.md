# background-agents

Background coding agent server. Triggers jobs via HTTP, runs Pi through Agent OS, exposes a web UI and SSE event streams.

## Setup

```bash
cp .env.example .env
npm install
npm start
```

Open `http://127.0.0.1:8787/ui` for the overview.

## API

```
POST /api/run                    Start an agent job
POST /api/jira/trigger           Start from Jira issue key
POST /api/jira/webhook           Jira webhook endpoint
GET  /api/jobs                   List jobs
GET  /api/jobs/:id               Job detail
GET  /api/jobs/:id/events        SSE event stream
POST /api/jobs/:id/cancel        Cancel job
GET  /health                     Server status
```

All `/api/*` routes require `Authorization: Bearer <AUTH_TOKEN>` if `AUTH_TOKEN` is set.

## Extensions

Extensions live in `extensions/`. Each exports a function returning:

```js
{
  id: "name",
  routes(app, { config, store, runner }) {},
  toolkits({ config, job, processes }) { return []; },
}
```

Included:

- `jira` - issue tools and trigger routes
- `github` - repo discovery and PR tools
- `repo` - bare cache, worktrees, diff, commit, push
- `env` - run commands and manage dev servers
- `browser` - fetch pages and take screenshots

## Architecture

```
HTTP trigger
  -> Hono server (auth, routes, SSE, static UI)
  -> JobStore (file-backed jobs + event streams)
  -> JobRunner (concurrency queue)
  -> PiRuntime (Agent OS VM, Pi session, host toolkits)
```

Credentials stay in the server process. The agent receives host tools, not raw tokens.
