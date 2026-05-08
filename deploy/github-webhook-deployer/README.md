# Background Agents deployer

Standalone webhook receiver and deploy queue for `PetsdeliNext/background-agents`.
It is intentionally separate from `background-agents.service`, so the process that
receives webhooks can keep running while the app is restarted.

## Public endpoints

- App/UI/API: `https://agents.petsdeli.de/`
- Deploy webhook: `https://agents.petsdeli.de/github-webhook`
- Runtime release info: authenticated `GET https://agents.petsdeli.de/health`

## Services and paths

| Purpose | Path/service |
| --- | --- |
| App service | `background-agents.service` |
| Webhook receiver | `background-agents-deployer.service` |
| Consolidated deploy worker | `background-agents-deploy-worker.service` |
| Deployer install | `/opt/background-agents-deployer` |
| Live release symlink | `/opt/background-agents-current` |
| Release dirs | `/opt/background-agents-releases/<sha>-<timestamp>` |
| Queue/state dir | `/var/lib/background-agents-deployer` |
| Logs | `/var/log/background-agents-deployer` |
| App runtime data/secrets | `/root/background-agents` |

`/api`, `/ui`, and `/app` are served from the same release through
`/opt/background-agents-current`. Runtime state, secrets, job data, repo caches,
and MicroVM images stay under `/root/background-agents` via the service working
directory and `.env`.

## Webhook flow

1. GitHub sends a `push` webhook to `/github-webhook`.
2. Caddy routes only that path to `background-agents-deployer.service` on
   `127.0.0.1:8790`.
3. `deployer.mjs` verifies `X-Hub-Signature-256` using
   `GITHUB_WEBHOOK_SECRET`.
4. It accepts only `push` events for `DEPLOY_REPO` and `DEPLOY_BRANCH`.
5. Every accepted/ignored/rejected webhook is appended to
   `/var/lib/background-agents-deployer/webhooks.jsonl`.
6. The latest accepted deploy request is atomically written to
   `/var/lib/background-agents-deployer/pending.json`.
7. `background-agents-deploy-worker.service` is started. If a worker is already
   active, `systemctl start` is a no-op.
8. The worker consumes `pending.json` into `current.json` and runs `deploy.sh`.
9. If more webhooks arrive while a deploy is running, they overwrite
   `pending.json`; when the current deploy finishes, the worker deploys only the
   newest pending SHA. Intermediate commits are intentionally skipped.
10. Duplicate pending deploys for the same SHA are dropped after a successful
    deploy.

Burst example:

```txt
push A starts deploy
push B arrives -> pending=B
push C arrives -> pending=C, B superseded
deploy A finishes
worker deploys C
worker exits
```

## Safe deploy behavior

`deploy.sh` does not mutate the live app directory while agents are running.

For each deploy it:

1. obtains a GitHub App installation token;
2. fetches `DEPLOY_BRANCH` into `/var/lib/background-agents-deployer/repo.git`;
3. creates a fresh release directory under `/opt/background-agents-releases`;
4. writes `.deploy.json` with repo/SHA/ref/delivery/releaseDir;
5. runs root `npm install --package-lock=false` and `npm run check`;
6. builds `/app` with `cd app && npm install --package-lock=false && npm run build`;
7. waits until authenticated `/health` reports `active: 0`;
8. atomically switches `/opt/background-agents-current` to the new release;
9. restarts only `background-agents.service`;
10. keeps the newest `KEEP_RELEASES` release directories.

If a newer SHA appears in `pending.json` before the restart point, the older
prepared deploy exits as superseded and the worker continues with the latest SHA.

## Configuration

Config is in `/etc/background-agents-deployer.env`. GitHub App credentials are
shared from `/root/background-agents/.env`.

Important keys:

```txt
DEPLOY_REPO=PetsdeliNext/background-agents
DEPLOY_BRANCH=main
GITHUB_WEBHOOK_SECRET=<secret configured in GitHub webhook>
RELEASES_DIR=/opt/background-agents-releases
CURRENT_LINK=/opt/background-agents-current
QUEUE_DIR=/var/lib/background-agents-deployer
DEPLOY_WAIT_FOR_IDLE=true
DEPLOY_DRAIN_TIMEOUT_SECONDS=14400
DEPLOY_DRAIN_POLL_SECONDS=30
KEEP_RELEASES=5
```

## GitHub webhook setup

Repository webhook settings should be:

```txt
Payload URL: https://agents.petsdeli.de/github-webhook
Content type: application/json
Secret: value of GITHUB_WEBHOOK_SECRET from /etc/background-agents-deployer.env
Events: push
```

The current GitHub App can read/write contents and PRs, but cannot create repo
webhooks through the GitHub API unless the app is granted **Repository webhooks:
read/write** and the installation is re-approved. Without that permission, the
webhook must be configured manually in GitHub App/repo settings.

## Validate a deploy

From the server:

```bash
TOKEN=$(grep ^AUTH_TOKEN= /root/background-agents/.env | cut -d= -f2-)

curl -fsS -H "authorization: Bearer $TOKEN" \
  http://127.0.0.1:8787/health | jq .release

readlink /opt/background-agents-current

git --git-dir=/var/lib/background-agents-deployer/repo.git \
  rev-parse refs/remotes/origin/main
```

The following should all match:

- `/health` field `release.deploy.sha`
- GitHub/fetched `refs/remotes/origin/main`
- the SHA prefix in `/opt/background-agents-current`

You can also verify the joined surfaces:

```bash
for path in /ui /ui/app.js /app /health; do
  curl -fsS -o /dev/null -w "$path %{http_code} %{content_type}\n" \
    -H "authorization: Bearer $TOKEN" "http://127.0.0.1:8787$path"
done
```

## Observe webhook/deploy state

```bash
systemctl status background-agents-deployer.service
systemctl status background-agents-deploy-worker.service
systemctl status background-agents.service

tail -f /var/lib/background-agents-deployer/webhooks.jsonl
tail -f /var/log/background-agents-deployer/worker-*.log
tail -f /var/log/background-agents-deployer/deploy-*.log

ls -l /var/lib/background-agents-deployer/{pending.json,current.json,last-success.json,last-failure.json} 2>/dev/null || true
```

Common webhook results in `webhooks.jsonl`:

- `accepted:true, queued:true` — valid deploy trigger queued.
- `accepted:false, reason:"bad_signature"` — webhook secret in GitHub does not
  match `GITHUB_WEBHOOK_SECRET`.
- `accepted:false, reason:"ignored_repo"` or `ignored_ref` — event reached the
  server but was not for the configured repo/branch.

## Rollback

Manual rollback is switching the symlink to an older release and restarting the
app:

```bash
ln -sfn /opt/background-agents-releases/<old-release> /opt/background-agents-current.next
mv -Tf /opt/background-agents-current.next /opt/background-agents-current
systemctl restart background-agents.service
```
