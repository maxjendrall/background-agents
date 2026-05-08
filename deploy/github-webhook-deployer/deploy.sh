#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/root/background-agents}"
DEPLOY_ENV="${DEPLOY_ENV:-/etc/background-agents-deployer.env}"
APP_ENV="${APP_ENV:-$APP_DIR/.env}"
LOG_DIR="${LOG_DIR:-/var/log/background-agents-deployer}"
LOCK_FILE="${LOCK_FILE:-/run/background-agents-deploy.lock}"
APP_SERVICE="${APP_SERVICE:-background-agents.service}"
NODE_BIN="${NODE_BIN:-/root/.nvm/versions/node/v24.14.1/bin/node}"
NPM_BIN="${NPM_BIN:-/root/.nvm/versions/node/v24.14.1/bin/npm}"
BRANCH="${DEPLOY_BRANCH:-main}"
export HOME="${HOME:-/root}"

REPO="${1:-${DEPLOY_REPO:-}}"
SHA="${2:-}"
REF="${3:-refs/heads/$BRANCH}"
DELIVERY="${4:-}"

mkdir -p "$LOG_DIR"
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

echo "[$(date -Is)] deploy start repo=$REPO sha=$SHA ref=$REF delivery=$DELIVERY"
cd "$APP_DIR"
git config --global --add safe.directory "$APP_DIR" || true

TOKEN="$($NODE_BIN /opt/background-agents-deployer/github-app-token.mjs)"
AUTH="$(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)"
REMOTE_URL="https://github.com/${REPO}.git"

git remote set-url origin "$REMOTE_URL" || git remote add origin "$REMOTE_URL"
git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $AUTH" fetch --prune origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"
TARGET="$(git rev-parse "refs/remotes/origin/${BRANCH}")"
if [[ "$TARGET" != "$SHA" ]]; then
  echo "warning: webhook sha $SHA differs from fetched ${BRANCH} head $TARGET; deploying fetched head"
fi

git reset --hard "$TARGET"
git clean -fd

"$NPM_BIN" install --package-lock=false
"$NPM_BIN" run check

systemctl daemon-reload
systemctl restart "$APP_SERVICE"
systemctl is-active --quiet "$APP_SERVICE"

echo "[$(date -Is)] deploy ok repo=$REPO target=$TARGET log=$LOG_FILE"
