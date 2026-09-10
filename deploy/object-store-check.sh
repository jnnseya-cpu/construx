#!/usr/bin/env bash
#
# Prove the object store in this .env before anything depends on it.
#
# Writes one small object under BACKUP_PREFIX/.preflight/, reads it back,
# compares the bytes, finds it in a listing, deletes it, and confirms it is
# gone. Nothing else in the bucket is read, listed or touched, and no secret is
# printed.
#
#   ./deploy/object-store-check.sh                       # .env here
#   ./deploy/object-store-check.sh /srv/construx/app/.env
#
# Run it after pasting the five OBJECT_STORE_* values and BEFORE restarting the
# service. The alternative is a restart, a screen, and — if the secret is wrong
# — finding out from the alarm that exists for a lost volume, six hours later.
#
# Exit codes: 0 the store will hold the record, 1 a step failed and is named.

set -euo pipefail

ENV_FILE="${1:-.env}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "No $ENV_FILE here."
  echo "On the deployment this is /srv/construx/app/.env — check the path before creating one,"
  echo "because a second .env in the wrong directory looks like it worked and changes nothing."
  exit 1
fi

# Read the file. Never source it.
#
# `.env` is not a shell script and must not be run as one. This one holds
# SIGNING_PRIVATE_KEY_PEM, whose value is a PEM block spanning several lines,
# and `. .env` stopped on it with "PRIVATE: command not found" — a check that
# fails on a deployment because of a key it never uses. Sourcing is worse than
# broken here: a value containing a backtick or `$(...)` would be *executed*,
# as root, from a file whose whole purpose is to hold secrets.
#
# So: parse, exactly as `config.ts` parses it. Trim the line, split on the first
# `=`, accept the key only if it is a plain identifier, and take the rest
# literally. A PEM's continuation lines match nothing and are skipped, which is
# what the application does with them too. Nothing is evaluated, nothing is
# rewritten, and nothing is echoed.
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"

  [ -z "$line" ] && continue
  case "$line" in '#'*) continue ;; esac
  case "$line" in *=*) ;; *) continue ;; esac

  key="${line%%=*}"
  key="${key%"${key##*[![:space:]]}"}"
  case "$key" in
    ''|*[!A-Za-z0-9_]*) continue ;;
    [0-9]*) continue ;;
  esac

  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"

  export "$key=$value"
done < "$ENV_FILE"

# Run it where a Node that understands TypeScript actually is.
#
# The platform is `.ts` with no build step — `CMD ["node", "backend/src/main.ts"]`
# — and the image pins the version that strips types. The host does not have to:
# this deployment's host carries Node 20, which answered
# `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"`, so a check that
# assumed the host could run the code failed on the first machine that mattered.
#
# The version is not asserted, it is tried. A probe file settles it in a way
# that cannot rot as Node's flags change, and the fallback is the container that
# is already running the exact code this is checking.
probe_dir="$(mktemp -d)"
trap 'rm -rf "$probe_dir"' EXIT
printf 'const ok: string = "ok";\nprocess.stdout.write(ok);\n' > "$probe_dir/probe.ts"

if command -v node >/dev/null 2>&1 && node "$probe_dir/probe.ts" >/dev/null 2>&1; then
  exec node "$HERE/../backend/src/cli/objectstore.ts"
fi

# The values the preflight reads, and nothing else. Passed explicitly rather
# than inherited, because the container is running the *old* environment: the
# whole point is to test what is in the file now, before a restart makes it the
# container's. A key absent from the file is passed empty, which `config.ts`
# treats as unset — so the exec reflects the file exactly rather than falling
# back to whatever the running process happens to hold.
#
# These land in the argv of `docker exec`, which is readable by root on this
# host through `ps`. That is the same root who can read `.env`, so it grants
# nothing new; it is said here so the choice is visible rather than assumed.
CONTAINER="${CONSTRUX_CONTAINER:-construx}"
PASSED=(
  OBJECT_STORE_ENDPOINT OBJECT_STORE_REGION OBJECT_STORE_BUCKET
  OBJECT_STORE_ACCESS_KEY_ID OBJECT_STORE_SECRET_ACCESS_KEY
  OBJECT_STORE_PATH_STYLE OBJECT_STORE_TIMEOUT_MS
  BACKUP_PREFIX BACKUP_INTERVAL_MINUTES BACKUP_KEEP
)

if command -v docker >/dev/null 2>&1 &&
   [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]; then
  echo "This host's node cannot run TypeScript, so the check runs inside $CONTAINER,"
  echo "against the values in $ENV_FILE rather than the ones that container booted with."
  echo
  args=()
  for key in "${PASSED[@]}"; do
    args+=( -e "$key=${!key-}" )
  done
  exec docker exec "${args[@]}" "$CONTAINER" node /srv/backend/src/cli/objectstore.ts
fi

echo "Nowhere to run the check."
echo
echo "The platform runs TypeScript directly, so this needs either a Node that strips types"
echo "(the image pins one) or the running container to borrow. This host's node is"
echo "$(node --version 2>/dev/null || echo 'not installed'), and the container '$CONTAINER' is not running."
echo
echo "Start the service and run this again, or set CONSTRUX_CONTAINER to the right name."
exit 1
