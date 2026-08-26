#!/bin/sh
set -eu

# Deploy whatever is on the tracked branch, and put it back if it does not boot.
#
# Runs on the host from a systemd timer. It pulls rather than being pushed to,
# which is the whole security argument for this shape: nothing needs an inbound
# port, and no machine outside this one holds a credential that can reach the
# Docker socket. A GitHub Actions deploy would mean storing an SSH key with
# root-equivalent access to a VPS that also hosts two other people's live sites,
# and anybody who could push to the repository — or compromise a third-party
# action — would have it. The trade is latency: a push is live within the timer
# interval rather than instantly.
#
# ---------------------------------------------------------------- what it does
#
#   fetch -> nothing new? exit quietly
#          -> back up the journal
#          -> pull, build, up
#          -> wait for /readyz
#          -> ready? done.  not ready? put the previous commit back and rebuild.
#
# ------------------------------------------------------------ the rollback rule
#
# `docs/RUNBOOK.md` states the constraint this is written around: **the journal
# is forward-compatible and not backward-compatible.** An older image replaying
# a journal that contains an event type it does not know refuses to start — the
# closed catalogue doing its job. A rollback is therefore only safe while the
# new image has written nothing.
#
# That is exactly the window this rolls back in. Replay happens before the
# service is ready and appends nothing, so a container that never reached
# `/readyz` never wrote an event. Once it is ready it may write, and from that
# moment this script stops: a later failure is a human decision with the runbook
# open and a backup to hand, not something to automate at 3am.
#
# ------------------------------------------------------------- what it does not
#
# It does not check that CI was green. Nothing here can — the repository is
# private and this host holds no GitHub credential, deliberately. The boot check
# catches anything that stops the container starting; a change that boots fine
# and breaks a page will deploy. That is the same exposure as a manual deploy,
# arriving sooner.

# ------------------------------------------------------------------- settings

# Overridable so this is not the only file that has to change to move branches
# or relocate the checkout. Defaults match the documented deployment.
APP_DIR="${CONSTRUX_APP_DIR:-/srv/construx/app}"
BRANCH="${CONSTRUX_DEPLOY_BRANCH:-claude/ai-agent-construction-os-999410}"
BACKUP_DIR="${CONSTRUX_BACKUP_DIR:-/srv/construx/backups}"
# Two checks, because they fail for different reasons and want different
# answers.
#
# The container's own port proves the application booted. The public URL proves
# a request from the internet actually reaches it — which is a different claim,
# and the one that was going untested. A deploy that recreates the container
# also recreates its attachment to the reverse proxy's network; if that
# attachment does not take, the container is healthy, `/readyz` answers on
# localhost, every check passes, and the site returns 502 to everybody. That
# happened, and nothing in this script noticed.
#
# The local port is read from the same variable the compose file publishes on,
# so the two cannot drift. It previously hard-coded 8080 while the deployment
# published 8090, which meant this check had been passing by never being
# reached rather than by succeeding.
HOST_PORT="${CONSTRUX_HOST_PORT:-8080}"
LOCAL_HEALTH_URL="${CONSTRUX_HEALTH_URL:-http://127.0.0.1:${HOST_PORT}/readyz}"
# Derived from the origin the platform already knows it serves, so there is no
# second place to update when the domain changes. Empty disables the public
# check rather than failing it — a deployment behind a VPN or with no public
# name is a real thing, and inventing a URL for it would fail every deploy.
PUBLIC_HEALTH_URL="${CONSTRUX_PUBLIC_HEALTH_URL:-}"
if [ -z "$PUBLIC_HEALTH_URL" ] && [ -f "$APP_DIR/.env" ]; then
  PUBLIC_BASE="$(sed -n 's/^[[:space:]]*PUBLIC_BASE_URL[[:space:]]*=[[:space:]]*//p' "$APP_DIR/.env" | head -1 | tr -d '\r')"
  case "$PUBLIC_BASE" in
    https://*|http://*) PUBLIC_HEALTH_URL="${PUBLIC_BASE%/}/readyz" ;;
  esac
fi
# Generous: a cold start replays the whole journal before answering, and that
# grows with the record. Too short a wait would roll back a healthy deploy.
READY_TIMEOUT="${CONSTRUX_READY_TIMEOUT:-180}"

COMPOSE="docker compose -f deploy/compose.yaml -f deploy/compose.edge.yaml --env-file .env"

log() {
  # Unbuffered and timestamped. journalctl captures stdout, and a deploy log
  # with no clock in it is useless the morning after.
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) autodeploy: $*"
}

# One at a time. The timer fires on a schedule and a build takes minutes; two
# overlapping runs would fight over the working tree and the container name.
# `-n` fails immediately rather than queueing, because a queued deploy is a
# deploy of whatever is current by the time it runs, which is the next run's job.
LOCK="${CONSTRUX_LOCK:-/var/lock/construx-deploy.lock}"
if [ "${CONSTRUX_LOCKED:-}" != "1" ]; then
  CONSTRUX_LOCKED=1
  export CONSTRUX_LOCKED
  exec flock -n "$LOCK" "$0" "$@"
fi

cd "$APP_DIR"

# ----------------------------------------------------------------- is there work

# Only the tracked branch. `fetch` and then compare, rather than `pull`, so that
# discovering there is nothing to do costs one network call and touches nothing.
git fetch --quiet origin "$BRANCH"

CURRENT="$(git rev-parse HEAD)"
TARGET="$(git rev-parse "origin/$BRANCH")"
SHORT_CURRENT="$(echo "$CURRENT" | cut -c1-7)"
SHORT_TARGET="$(echo "$TARGET" | cut -c1-7)"

if [ "$CURRENT" = "$TARGET" ]; then
  # Silent on purpose. This runs every minute; a line per check would bury the
  # deploys that matter under a thousand that did not happen.
  exit 0
fi

log "deploying $SHORT_TARGET (from $SHORT_CURRENT)"

# ------------------------------------------------------------------- back up first

# Before anything is replaced, because the reason to have it is that the next
# step went wrong. Append-only files, so a copy taken from the running container
# is consistent without stopping it — see the backup section of the runbook.
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
if docker exec construx sh -c 'cat /data/ledger.jsonl' > "$BACKUP_DIR/ledger-$STAMP.jsonl" 2>/dev/null; then
  docker exec construx sh -c 'cat /data/ledger.jsonl.acu' > "$BACKUP_DIR/acu-$STAMP.jsonl" 2>/dev/null || true
  log "journal backed up to $BACKUP_DIR/ledger-$STAMP.jsonl"
else
  # A first deploy, or a container that is already down. Neither is a reason to
  # refuse to deploy — there is nothing to lose in either case — but it is a
  # reason to say so rather than to leave a missing backup unexplained.
  rm -f "$BACKUP_DIR/ledger-$STAMP.jsonl"
  log "no running container to back up; continuing"
fi

# --------------------------------------------------------------------- deploy

# `--ff-only`: this checkout is a deployment, not a place work happens. A
# divergent local commit means somebody edited files on the server, and the
# right answer is to stop and say so rather than to merge or to discard it.
if ! git merge --ff-only --quiet "origin/$BRANCH"; then
  log "FAILED: the checkout has diverged from origin/$BRANCH — not deploying"
  log "        somebody has committed on the server. Resolve by hand."
  exit 1
fi

deploy() {
  $COMPOSE up -d --build
}

# Poll one URL until it answers, or give up.
#
# Polls rather than sleeping a fixed time: a fast boot should not wait, and a
# slow one should not be declared dead.
poll() {
  url="$1"
  budget="$2"
  i=0
  while [ "$i" -lt "$budget" ]; do
    if curl -fsS --max-time 5 "$url" > /dev/null 2>&1; then
      return 0
    fi
    i=$((i + 2))
    sleep 2
  done
  return 1
}

ready() {
  poll "$LOCAL_HEALTH_URL" "$READY_TIMEOUT"
}

# Is the site actually reachable from outside?
#
# Short budget: the application is already answering locally by this point, so
# this is asking whether the proxy has a route to it, and a route either exists
# or does not. Waiting three minutes for one would only delay the report.
reachable() {
  [ -z "$PUBLIC_HEALTH_URL" ] && return 0
  poll "$PUBLIC_HEALTH_URL" 30
}

if deploy && ready; then
  if reachable; then
    log "live on $SHORT_TARGET"
    exit 0
  fi

  # The application is up and the front door is not. Rolling the code back
  # cannot fix that — the previous commit would be just as unreachable — so it
  # is deliberately not attempted. What is attempted is the one repair that
  # matches the cause: re-attaching the container to the proxy's network, which
  # is the step a recreate can silently lose.
  log "WARNING: $SHORT_TARGET is healthy on $LOCAL_HEALTH_URL but $PUBLIC_HEALTH_URL does not answer"
  log "         the application booted; the reverse proxy cannot reach it"

  EDGE_NETWORK="${CONSTRUX_EDGE_NETWORK:-construx-edge}"
  if docker network connect "$EDGE_NETWORK" construx 2>/dev/null; then
    log "         re-attached construx to $EDGE_NETWORK; rechecking"
    if reachable; then
      log "live on $SHORT_TARGET (the edge attachment had been lost and was restored)"
      exit 0
    fi
  fi

  log "         Check that the proxy is on that network too:"
  log "           docker network inspect $EDGE_NETWORK --format '{{range .Containers}}{{.Name}} {{end}}'"
  log "         It must list the proxy as well as construx. Attach it with:"
  log "           docker network connect $EDGE_NETWORK <proxy-container>"
  # Non-zero: the deploy did not result in a working site, whatever the
  # container says about itself. The code is left deployed because it is not
  # what is broken.
  exit 3
fi

# ------------------------------------------------------------------- roll back

# Only reachable while the new image has written nothing — see the rollback rule
# above. Past this point the previous image can replay the same journal it could
# before, so putting it back is safe.
log "FAILED: the new build did not become ready within ${READY_TIMEOUT}s"
docker logs --tail 60 construx 2>&1 | sed 's/^/    /' || true

log "rolling back to $SHORT_CURRENT"
git reset --hard --quiet "$CURRENT"

if deploy && ready; then
  log "rolled back; the site is up on the previous commit"
  # Non-zero: the deploy failed. A timer unit that exits 0 here would show as a
  # successful run in `systemctl list-timers`, and the one thing this must not
  # do is report a failed deploy as a clean one.
  exit 1
fi

log "CRITICAL: the rollback did not come up either. The site is down."
log "          docs/RUNBOOK.md — Rollback. The backup is $BACKUP_DIR/ledger-$STAMP.jsonl"
exit 2
