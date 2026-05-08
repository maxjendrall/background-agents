# Background Agents deployer

Separate webhook receiver for deploying `background-agents` from a GitHub App-accessible repo.

Flow:

1. GitHub `push` webhook to `/github-webhook`.
2. Caddy routes only that path to `background-agents-deployer.service` on `127.0.0.1:8790`.
3. Deployer verifies `X-Hub-Signature-256`, accepts only `push` to `DEPLOY_BRANCH`/`DEPLOY_REPO`.
4. Every accepted webhook is appended to `/var/lib/background-agents-deployer/webhooks.jsonl`.
5. The latest accepted deploy request is written atomically to `/var/lib/background-agents-deployer/pending.json`.
6. `background-agents-deploy-worker.service` is started. If a worker is already active, `systemctl start` is a no-op.
7. The worker consumes only the latest pending deploy. If more webhooks arrive during a deploy, they overwrite `pending.json`; after the current deploy finishes, the worker deploys that newest pending SHA once.
8. Deploy script obtains a GitHub App installation token, fetches the repo, resets the worktree, runs install/check, then restarts `background-agents.service`.

This consolidates bursts of commits: it does not deploy every intermediate SHA, only the currently running SHA plus the latest pending trigger.

Config is in `/etc/background-agents-deployer.env`; GitHub App settings can be reused from `/root/background-agents/.env`.
