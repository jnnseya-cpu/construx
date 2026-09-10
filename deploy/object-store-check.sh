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

exec node "$HERE/../backend/src/cli/objectstore.ts"
