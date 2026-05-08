#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/root/background-agents}"
DEPLOY_ENV="${DEPLOY_ENV:-/etc/background-agents-deployer.env}"
APP_ENV="${APP_ENV:-$APP_DIR/.env}"
LOG_DIR="${LOG_DIR:-/var/log/background-agents-deployer}"
QUEUE_DIR="${QUEUE_DIR:-/var/lib/background-agents-deployer}"
LOCK_FILE="${LOCK_FILE:-/run/background-agents-deploy.lock}"
APP_SERVICE="${APP_SERVICE:-background-agents.service}"
NODE_BIN="${NODE_BIN:-/root/.nvm/versions/node/v24.14.1/bin/node}"
NPM_BIN="${NPM_BIN:-/root/.nvm/versions/node/v24.14.1/bin/npm}"
BRANCH="${DEPLOY_BRANCH:-main}"
RELEASES_DIR="${RELEASES_DIR:-/opt/background-agents-releases}"
CURRENT_LINK="${CURRENT_LINK:-/opt/background-agents-current}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
DRAIN_TIMEOUT_SECONDS="${DEPLOY_DRAIN_TIMEOUT_SECONDS:-14400}"
DRAIN_POLL_SECONDS="${DEPLOY_DRAIN_POLL_SECONDS:-30}"
WAIT_FOR_IDLE="${DEPLOY_WAIT_FOR_IDLE:-true}"
export HOME="${HOME:-/root}"

REPO="${1:-${DEPLOY_REPO:-}}"
SHA="${2:-}"
REF="${3:-refs/heads/$BRANCH}"
DELIVERY="${4:-}"

mkdir -p "$LOG_DIR" "$QUEUE_DIR" "$RELEASES_DIR"
LOG_FILE="$LOG_DIR/deploy-$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:12}.log"
exec > >(tee -a "$LOG_FILE") 2>&1

if [[ -f "$APP_ENV" ]]; then set -a; # shellcheck disable=SC1090
  source "$APP_ENV"; set +a; fi
if [[ -f "$DEPLOY_ENV" ]]; then set -a; # shellcheck disable=SC1090
  source "$DEPLOY_ENV"; set +a; fi

APP_DIR="${APP_DIR:-/root/background-agents}"
APP_SERVICE="${APP_SERVICE:-background-agents.service}"
NODE_BIN="${NODE_BIN:-/root/.nvm/versions/node/v24.14.1/bin/node}"
NPM_BIN="${NPM_BIN:-/root/.nvm/versions/node/v24.14.1/bin/npm}"
BRANCH="${DEPLOY_BRANCH:-$BRANCH}"
REPO="${REPO:-${DEPLOY_REPO:-}}"
RELEASES_DIR="${RELEASES_DIR:-/opt/background-agents-releases}"
CURRENT_LINK="${CURRENT_LINK:-/opt/background-agents-current}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
DRAIN_TIMEOUT_SECONDS="${DEPLOY_DRAIN_TIMEOUT_SECONDS:-$DRAIN_TIMEOUT_SECONDS}"
DRAIN_POLL_SECONDS="${DEPLOY_DRAIN_POLL_SECONDS:-$DRAIN_POLL_SECONDS}"
WAIT_FOR_IDLE="${DEPLOY_WAIT_FOR_IDLE:-$WAIT_FOR_IDLE}"
export PATH="$(dirname "$NODE_BIN"):$PATH"

if [[ -z "$REPO" || -z "$SHA" ]]; then
  echo "usage: deploy.sh <owner/repo> <sha> [ref] [delivery]"
  exit 2
fi
if [[ -n "${DEPLOY_REPO:-}" && "$REPO" != "$DEPLOY_REPO" ]]; then
  echo "refusing repo $REPO; DEPLOY_REPO=$DEPLOY_REPO"
  exit 0
fi
if [[ "$REF" != "refs/heads/$BRANCH" ]]; then
  echo "ignoring ref $REF; expected refs/heads/$BRANCH"
  exit 0
fi

exec 9>"$LOCK_FILE"
flock 9

pending_sha() {
  local pending="$QUEUE_DIR/pending.json"
  [[ -s "$pending" ]] || return 1
  "$NODE_BIN" -e 'const fs=require("fs"); const p=process.argv[1]; const j=JSON.parse(fs.readFileSync(p,"utf8")); process.stdout.write(String(j.sha||""));' "$pending"
}

exit_if_superseded() {
  local psha=""
  psha="$(pending_sha 2>/dev/null || true)"
  if [[ -n "$psha" && "$psha" != "$SHA" ]]; then
    echo "[$(date -Is)] deploy superseded by pending sha=$psha; skipping $SHA"
    exit 75
  fi
}

health_json() {
  local url="http://127.0.0.1:${PORT:-8787}/health"
  if [[ -n "${AUTH_TOKEN:-}" ]]; then
    curl -fsS -m 5 -H "authorization: Bearer $AUTH_TOKEN" "$url"
  else
    curl -fsS -m 5 "$url"
  fi
}

active_jobs() {
  local body
  body="$(health_json 2>/dev/null || true)"
  if [[ -z "$body" ]]; then echo 0; return; fi
  printf '%s' "$body" | "$NODE_BIN" -e 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{try{const j=JSON.parse(s); process.stdout.write(String(Number(j.active||0)));}catch{process.stdout.write("0")}})'
}

wait_for_idle() {
  if [[ "$WAIT_FOR_IDLE" != "true" && "$WAIT_FOR_IDLE" != "1" && "$WAIT_FOR_IDLE" != "yes" ]]; then
    echo "[$(date -Is)] idle drain disabled"
    return 0
  fi
  local deadline=$(( $(date +%s) + DRAIN_TIMEOUT_SECONDS ))
  while true; do
    exit_if_superseded
    local active
    active="$(active_jobs)"
    if [[ "$active" == "0" ]]; then
      echo "[$(date -Is)] app idle; safe to restart"
      return 0
    fi
    if (( $(date +%s) >= deadline )); then
      echo "[$(date -Is)] timed out waiting for idle active=$active after ${DRAIN_TIMEOUT_SECONDS}s"
      exit 70
    fi
    echo "[$(date -Is)] waiting for active jobs to finish before restart active=$active"
    sleep "$DRAIN_POLL_SECONDS"
  done
}

cleanup_releases() {
  find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
    | sort -rn \
    | awk -v keep="$KEEP_RELEASES" 'NR>keep {print $2}' \
    | xargs -r rm -rf
}

echo "[$(date -Is)] deploy start repo=$REPO sha=$SHA ref=$REF delivery=$DELIVERY"

TOKEN="$($NODE_BIN /opt/background-agents-deployer/github-app-token.mjs)"
AUTH="$(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)"
REMOTE_URL="https://github.com/${REPO}.git"
CACHE_REPO="$QUEUE_DIR/repo.git"

if [[ ! -d "$CACHE_REPO" ]]; then
  git init --bare "$CACHE_REPO"
fi
git --git-dir="$CACHE_REPO" remote set-url origin "$REMOTE_URL" 2>/dev/null || git --git-dir="$CACHE_REPO" remote add origin "$REMOTE_URL"
git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $AUTH" --git-dir="$CACHE_REPO" fetch --prune origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"
TARGET="$(git --git-dir="$CACHE_REPO" rev-parse "refs/remotes/origin/${BRANCH}")"
if [[ "$TARGET" != "$SHA" ]]; then
  echo "warning: webhook sha $SHA differs from fetched ${BRANCH} head $TARGET; deploying fetched head"
  SHA="$TARGET"
fi

exit_if_superseded

RELEASE_DIR="$RELEASES_DIR/${TARGET:0:12}-$(date -u +%Y%m%dT%H%M%SZ)"
git clone --no-checkout "$CACHE_REPO" "$RELEASE_DIR"
git -C "$RELEASE_DIR" checkout --detach "$TARGET"
git -C "$RELEASE_DIR" remote set-url origin "$REMOTE_URL" || true
"$NODE_BIN" -e 'const fs=require("fs"); const [path,repo,sha,ref,branch,delivery,releaseDir]=process.argv.slice(1); fs.writeFileSync(path, JSON.stringify({repo,sha,ref,branch,delivery,deployedAt:new Date().toISOString(),releaseDir}, null, 2)+"\n");' \
  "$RELEASE_DIR/.deploy.json" "$REPO" "$TARGET" "$REF" "$BRANCH" "$DELIVERY" "$RELEASE_DIR"

(
  cd "$RELEASE_DIR"
  "$NPM_BIN" install --package-lock=false
  "$NPM_BIN" run check
)

exit_if_superseded
wait_for_idle
exit_if_superseded

ln -sfn "$RELEASE_DIR" "$CURRENT_LINK.next"
mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"

systemctl daemon-reload
systemctl restart "$APP_SERVICE"
systemctl is-active --quiet "$APP_SERVICE"
cleanup_releases

echo "[$(date -Is)] deploy ok repo=$REPO target=$TARGET release=$RELEASE_DIR log=$LOG_FILE"
