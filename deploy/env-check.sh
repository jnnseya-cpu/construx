#!/usr/bin/env bash
#
# What this deployment's .env is missing, and what it must never lose.
#
# Run it before and after editing .env. It reads the file, reports nothing about
# the values in it, and changes nothing.
#
#   ./deploy/env-check.sh            # report against .env in the working directory
#   ./deploy/env-check.sh /path/.env
#
# Why this exists rather than a paste-the-whole-file instruction: .env on a
# running deployment already holds secrets that cannot be regenerated without
# consequences. GATEWAY_JWT_SECRET signs every session. SIGNING_PRIVATE_KEY_PEM
# is the key every signature the platform has ever witnessed was made with —
# replace it and they all stop verifying, silently, with no error anywhere.
# Overwriting the file to add a Stripe key is a data-loss event wearing the
# clothes of a configuration change.
#
# Exit codes: 0 nothing critical missing, 1 something critical is missing.

set -euo pipefail

ENV_FILE="${1:-.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "No $ENV_FILE here."
  echo "On the deployment this is /srv/construx/app/.env — check the path before creating one,"
  echo "because a second .env in the wrong directory looks like it worked and changes nothing."
  exit 1
fi

# Set and non-empty. `KEY=` present but blank is not configured — it is a
# placeholder somebody meant to come back to, which is exactly the state this
# script exists to surface.
is_set() {
  grep -qE "^[[:space:]]*$1[[:space:]]*=[[:space:]]*[^[:space:]#]" "$ENV_FILE"
}

present() {
  grep -qE "^[[:space:]]*$1[[:space:]]*=" "$ENV_FILE"
}

missing_critical=0
missing_optional=0

report() {
  local level="$1" key="$2" consequence="$3"
  if is_set "$key"; then
    printf '  ok       %-32s\n' "$key"
    return
  fi

  # Absent and blank need different fixes, and getting it wrong is silent.
  # `config.ts` keeps the FIRST occurrence of a key and ignores every later
  # one, so appending a line for a key that is already present — blank or not —
  # changes nothing at all and looks exactly like a change that worked.
  local how="append it"
  if present "$key"; then
    how="EDIT the existing blank line — appending a second one is ignored"
  fi

  if [[ "$level" == "critical" ]]; then
    missing_critical=$((missing_critical + 1))
    printf '  MISSING  %-32s %s (%s)\n' "$key" "$consequence" "$how"
  else
    missing_optional=$((missing_optional + 1))
    printf '  unset    %-32s %s (%s)\n' "$key" "$consequence" "$how"
  fi
}

echo "Reading $ENV_FILE"
echo
echo "Data safety and authentication"
report critical NODE_ENV                 "not production — demonstration surfaces stay reachable"
report critical PUBLIC_BASE_URL          "email links have no origin to point at"
report critical LEDGER_JOURNAL_PATH      "THE LEDGER IS IN MEMORY — every record is lost on restart"
report critical GATEWAY_JWT_SECRET       "tokens signed with the published development default"
report critical EVIDENCE_STORE_PATH      "hashes recorded, files not held"
report critical SIGNING_PRIVATE_KEY_PEM  "every signing request is refused"

echo
echo "Registration — nobody can complete signup without these"
report critical SMTP_HOST                "verification emails are rendered and recorded, never sent"
report optional SMTP_USER                "unauthenticated submission; correct for some relays"
report optional SMTP_PASS                "unauthenticated submission; correct for some relays"
report critical NEWSLETTER_FROM_ADDRESS  "mail sends from a default that will fail SPF"

echo
echo "Payments — each rail refuses until both of its values are set"
report optional STRIPE_SECRET_KEY        "card checkout answers 503"
report optional STRIPE_WEBHOOK_SECRET    "card webhook refuses every delivery"
report optional KODA_SECRET_KEY          "mobile-money checkout answers 503"
report optional KODA_WEBHOOK_SECRET      "mobile-money webhook refuses every delivery"
report optional KODA_USD_PER_GBP         "defaults to 1.27 — set it to a rate you have chosen"

echo
echo "AI — no provider is called until AI_MODE leaves 'local'"
report optional AI_MODE                  "defaults to local: mock brains, no spend, no real output"
report optional OPENAI_API_KEY           "not in the failover chain"
report optional GEMINI_API_KEY           "not in the failover chain"
report optional ANTHROPIC_API_KEY        "not in the failover chain"

echo
echo "Half-configured pairs"
pair() {
  local a="$1" b="$2" what="$3"
  if is_set "$a" && ! is_set "$b"; then
    echo "  WARNING  $a is set but $b is not — $what"
    missing_critical=$((missing_critical + 1))
  elif is_set "$b" && ! is_set "$a"; then
    echo "  WARNING  $b is set but $a is not — $what"
    missing_critical=$((missing_critical + 1))
  fi
}
pair STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET "payments could be taken and never credited, so the rail stays off"
pair KODA_SECRET_KEY KODA_WEBHOOK_SECRET     "payments could be taken and never credited, so the rail stays off"

if is_set AI_MODE && [[ "$(grep -E '^[[:space:]]*AI_MODE[[:space:]]*=' "$ENV_FILE" | tail -1 | cut -d= -f2 | tr -d '[:space:]')" != "local" ]]; then
  if ! is_set OPENAI_API_KEY && ! is_set GEMINI_API_KEY && ! is_set ANTHROPIC_API_KEY; then
    echo "  WARNING  AI_MODE is not local but no provider key is set — every AI request will fail"
    missing_critical=$((missing_critical + 1))
  fi
fi

echo
echo "Duplicated keys"
# The trap this whole script exists to prevent somebody walking into. Appending
# `AI_MODE=production` under an existing `AI_MODE=local` is the natural way to
# make that change and it does nothing — the parser keeps the first line, so the
# file says production, the platform runs local, and nothing anywhere disagrees.
duplicates="$(grep -oE '^[[:space:]]*[A-Z_]+[[:space:]]*=' "$ENV_FILE" | tr -d ' =' | sort | uniq -d || true)"
if [[ -n "$duplicates" ]]; then
  while read -r key; do
    [[ -z "$key" ]] && continue
    first="$(grep -nE "^[[:space:]]*$key[[:space:]]*=" "$ENV_FILE" | head -1 | cut -d: -f1)"
    echo "  WARNING  $key appears more than once — line $first wins, the rest are ignored"
    missing_critical=$((missing_critical + 1))
  done <<< "$duplicates"
else
  echo "  ok       no key is declared twice"
fi

echo
if [[ $missing_critical -gt 0 ]]; then
  echo "$missing_critical critical, $missing_optional optional not set."
  echo "Append the missing keys — do not rewrite this file. It holds secrets that"
  echo "cannot be replaced without consequences: the JWT secret signs live sessions,"
  echo "and the signing key is what every signature ever witnessed was made with."
  exit 1
fi

echo "Nothing critical missing. $missing_optional optional not set."
echo "Restart, then read the boot log: the service prints a [config warning] line"
echo "for anything it can detect that this script cannot."
