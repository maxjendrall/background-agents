# Background Agents deployer

Separate webhook receiver for deploying `background-agents` from a GitHub App-accessible repo.

Flow:

1. GitHub `push` webhook to `/github-webhook`.
2. Caddy routes only that path to `background-agents-deployer.service` on `127.0.0.1:8790`.
3. Deployer verifies `X-Hub-Signature-256`, accepts only `push` to `DEPLOY_BRANCH`.
4. It starts `/opt/background-agents-deployer/deploy.sh` via `systemd-run`.
5. Deploy script obtains a GitHub App installation token, fetches the repo, resets the worktree, runs `npm ci && npm run check`, then restarts `background-agents.service`.

Config is in `/etc/background-agents-deployer.env`; GitHub App settings can be reused from `/root/background-agents/.env`.
