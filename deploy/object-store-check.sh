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

# Read into this shell's environment only. The file is never rewritten, never
# echoed and never copied; `set -a` exports what the check needs and `set +a`
# stops as soon as the file is read.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

exec node "$HERE/../backend/src/cli/objectstore.ts"
