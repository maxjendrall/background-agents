#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/root/background-agents}"
DEPLOY_ENV="${DEPLOY_ENV:-/etc/background-agents-deployer.env}"
APP_ENV="${APP_ENV:-$APP_DIR/.env}"
LOG_DIR="${LOG_DIR:-/var/log/background-agents-deployer}"
QUEUE_DIR="${QUEUE_DIR:-/var/lib/background-agents-deployer}"
WORKER_LOCK_FILE="${WORKER_LOCK_FILE:-/run/background-agents-deploy-worker.lock}"
DEPLOY_SCRIPT="${DEPLOY_SCRIPT:-/opt/background-agents-deployer/deploy.sh}"
NODE_BIN="${NODE_BIN:-/root/.nvm/versions/node/v24.14.1/bin/node}"
IDLE_GRACE_SECONDS="${DEPLOY_IDLE_GRACE_SECONDS:-5}"

export HOME="${HOME:-/root}"

if [[ -f "$APP_ENV" ]]; then set -a; # shellcheck disable=SC1090
  source "$APP_ENV"; set +a; fi
if [[ -f "$DEPLOY_ENV" ]]; then set -a; # shellcheck disable=SC1090
  source "$DEPLOY_ENV"; set +a; fi

mkdir -p "$LOG_DIR" "$QUEUE_DIR"
LOG_FILE="$LOG_DIR/worker-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$LOG_FILE") 2>&1

exec 8>"$WORKER_LOCK_FILE"
if ! flock -n 8; then
  echo "[$(date -Is)] another deploy worker is active; exiting"
  exit 0
fi

PENDING="$QUEUE_DIR/pending.json"
CURRENT="$QUEUE_DIR/current.json"
LAST_SUCCESS="$QUEUE_DIR/last-success.json"
LAST_FAILURE="$QUEUE_DIR/last-failure.json"

read_json_field() {
  local file="$1" field="$2"
  "$NODE_BIN" -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(j[process.argv[2]] ?? ""));' "$file" "$field"
}

echo "[$(date -Is)] deploy worker start log=$LOG_FILE"
last_exit=0

while true; do
  if [[ ! -s "$PENDING" ]]; then
    sleep "$IDLE_GRACE_SECONDS"
    if [[ ! -s "$PENDING" ]]; then
      echo "[$(date -Is)] no pending deploy; worker exit status=$last_exit"
      exit "$last_exit"
    fi
  fi

  if ! mv "$PENDING" "$CURRENT" 2>/dev/null; then
    continue
  fi

  REPO="$(read_json_field "$CURRENT" repo)"
  SHA="$(read_json_field "$CURRENT" sha)"
  REF="$(read_json_field "$CURRENT" ref)"
  DELIVERY="$(read_json_field "$CURRENT" delivery)"

  echo "[$(date -Is)] consuming deploy repo=$REPO sha=$SHA ref=$REF delivery=$DELIVERY"
  if "$DEPLOY_SCRIPT" "$REPO" "$SHA" "$REF" "$DELIVERY"; then
    cp "$CURRENT" "$LAST_SUCCESS"
    rm -f "$LAST_FAILURE"
    last_exit=0
    echo "[$(date -Is)] deploy succeeded sha=$SHA"
  else
    code=$?
    cp "$CURRENT" "$LAST_FAILURE"
    last_exit="$code"
    echo "[$(date -Is)] deploy failed sha=$SHA exit=$code"
    if [[ ! -s "$PENDING" ]]; then
      echo "[$(date -Is)] no newer pending deploy after failure; worker exit status=$code"
      exit "$code"
    fi
    echo "[$(date -Is)] newer pending deploy exists; continuing"
  fi

done
