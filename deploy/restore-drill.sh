#!/usr/bin/env bash
# Prove a backup can be restored, without touching the live deployment.
#
# A backup nobody has restored is a hope. This takes one backup set from the
# directory `deploy/autodeploy.sh` writes, copies it onto a throwaway volume,
# boots a second container from the same image against that volume on a port
# of its own, waits for `/readyz`, reads the boot banner for how many events
# were replayed, and then removes everything it made. The live container, its
# volume and its port are not touched at any point.
#
#   deploy/restore-drill.sh                 # the newest backup set
#   deploy/restore-drill.sh 20260906T031500Z  # a named set
#
# Exit 0 means the set restores and the record replays intact. Anything else
# is the finding — a torn set, a chain that refuses to load, an image that no
# longer reads the format — and it is far better found here than on the day.
#
# Settings, overridable like the deploy script's:
#   CONSTRUX_BACKUP_DIR   where the sets are           (default /srv/construx/backups)
#   CONSTRUX_IMAGE        the image to boot            (default: the live container's)
#   CONSTRUX_DRILL_PORT   the host port for the drill  (default 18080)
#   CONSTRUX_DRILL_WAIT   seconds to wait for /readyz  (default 300)
#
# This script needs Docker on the host. It was written against the compose
# deployment in this directory and has not been run in the build sandbox,
# which has no Docker; run it on the deployment host, and the first run is
# the drill.

set -euo pipefail

BACKUP_DIR="${CONSTRUX_BACKUP_DIR:-/srv/construx/backups}"
# The image the live container runs, unless told otherwise: the compose file
# builds it without naming it, so the running container is the one place the
# name is known.
IMAGE="${CONSTRUX_IMAGE:-$(docker inspect construx --format '{{.Config.Image}}' 2>/dev/null || true)}"
PORT="${CONSTRUX_DRILL_PORT:-18080}"
WAIT="${CONSTRUX_DRILL_WAIT:-300}"
NAME="construx-restore-drill"
VOLUME="construx-restore-drill-data"

log() { printf '[restore-drill %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

if [ -z "$IMAGE" ]; then
  log "no image to boot: the live container is not running and CONSTRUX_IMAGE is unset"
  exit 2
fi

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ------------------------------------------------------------ pick the set
if [ $# -ge 1 ]; then
  STAMP="$1"
else
  NEWEST="$(ls -1t "$BACKUP_DIR"/ledger-*.jsonl 2>/dev/null | head -n 1 || true)"
  if [ -z "$NEWEST" ]; then
    log "no backup set in $BACKUP_DIR; nothing to drill"
    exit 2
  fi
  STAMP="${NEWEST##*/ledger-}"; STAMP="${STAMP%.jsonl}"
fi
LEDGER="$BACKUP_DIR/ledger-$STAMP.jsonl"
if [ ! -s "$LEDGER" ]; then
  log "no journal in the set $STAMP ($LEDGER missing or empty)"
  exit 2
fi
LINES="$(wc -l < "$LEDGER" | tr -d ' ')"
log "set $STAMP: $LINES journal line(s)"

# ------------------------------------------------------------ stage the volume
cleanup
docker volume create "$VOLUME" >/dev/null
STAGE="$(mktemp -d)"
cp "$LEDGER" "$STAGE/ledger.jsonl"
for SIDE in acu views revoked; do
  [ -f "$BACKUP_DIR/$SIDE-$STAMP.jsonl" ] && cp "$BACKUP_DIR/$SIDE-$STAMP.jsonl" "$STAGE/ledger.jsonl.$SIDE"
done
if [ -f "$BACKUP_DIR/files-$STAMP.tar" ]; then
  tar xf "$BACKUP_DIR/files-$STAMP.tar" -C "$STAGE"
fi
# A one-shot container copies the staged files onto the volume; the drill
# container then owns them exactly as the live one owns its own.
docker run --rm -v "$VOLUME:/data" -v "$STAGE:/stage:ro" alpine:3 sh -c 'cp -a /stage/. /data/ && chown -R 1000:1000 /data' >/dev/null
rm -rf "$STAGE"

# ------------------------------------------------------------ boot against it
# The two variables the process refuses to boot without in production, set to
# throwaway values: the drill signs no real session and its secret dies with
# the volume. Nothing that sends mail, bills, posts or calls a provider is on.
docker run -d --name "$NAME" \
  -p "127.0.0.1:$PORT:8080" \
  -v "$VOLUME:/data" \
  -e NODE_ENV=production \
  -e PORT=8080 \
  -e LEDGER_JOURNAL_PATH=/data/ledger.jsonl \
  -e EVIDENCE_STORE_PATH=/data/evidence \
  -e SITE_MEDIA_PATH=/data/site-media \
  -e GATEWAY_JWT_SECRET="drill-$(date +%s)-$RANDOM-not-a-real-secret" \
  -e PLATFORM_OPERATOR_EMAIL=drill@localhost \
  -e PUBLIC_BASE_URL="http://127.0.0.1:$PORT" \
  -e AI_MODE=local \
  -e DEMO_TENANCY_ENABLED=false \
  -e SUBSCRIPTION_COLLECTION_ENABLED=false \
  -e NEWSLETTER_ENABLED=false \
  -e MARKETING_RELEASE_ENABLED=false \
  -e OPS_WATCH_ENABLED=false \
  -e CHAIN_ASSURANCE_ENABLED=false \
  -e AUTO_REPAIR_ENABLED=false \
  "$IMAGE" >/dev/null
log "booting $IMAGE against the restored volume on 127.0.0.1:$PORT"

DEADLINE=$(( $(date +%s) + WAIT ))
until curl -fsS "http://127.0.0.1:$PORT/readyz" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    log "FAILED: /readyz did not answer within ${WAIT}s. Last log lines:"
    docker logs --tail=40 "$NAME" 2>&1 | sed 's/^/    /'
    exit 1
  fi
  if ! docker ps -q -f "name=^${NAME}$" | grep -q .; then
    log "FAILED: the container exited during replay. Last log lines:"
    docker logs --tail=40 "$NAME" 2>&1 | sed 's/^/    /'
    exit 1
  fi
  sleep 2
done

# ------------------------------------------------------------ read the result
READY="$(curl -fsS "http://127.0.0.1:$PORT/readyz")"
REPLAYED="$(docker logs "$NAME" 2>&1 | grep -oE '[0-9]+ events? restored' | head -n 1 || true)"
log "ready: $READY"
if [ -n "$REPLAYED" ]; then
  log "boot banner: $REPLAYED from the set"
else
  log "boot banner did not state a replay count; read the logs:"
  docker logs --tail=20 "$NAME" 2>&1 | sed 's/^/    /'
fi
log "OK: set $STAMP restores and replays. Everything the drill made is being removed."
exit 0
