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
  #
  # A key that appears twice is resolved differently depending on who reads the
  # file: `config.ts` keeps the FIRST occurrence and ignores every later one,
  # while a container runtime given the same file as an env file may keep the
  # last. So a second line for a key that is already present is at best
  # ambiguous and at worst a change that looks like it worked and did nothing.
  # The advice is the one that is right under either reader: edit the line that
  # is already there.
  local how="append it"
  if present "$key"; then
    how="EDIT the existing blank line rather than appending a second"
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
echo "Fit to hold a paying customer"
# The two the System Control screen calls blocking, said here as well so the
# answer is the same before a deploy as after one. A screen nobody has opened
# yet is not a check.
report critical EVIDENCE_MASTER_KEY      "evidence stored in the clear — a stolen volume or a backup copy is a readable archive of every customer's photographs, signed instructions and scanned contracts"
# An operator who has read the consequence and written down that they are
# running without an off-host copy is reported as having decided, not as having
# a gap. The risk is restated either way — the acceptance changes who is being
# asked a question, not what is true.
if is_set BACKUP_OFFHOST_ACCEPTED; then
  echo "  noted    OBJECT_STORE_*                   running without an off-host backup is recorded as accepted in BACKUP_OFFHOST_ACCEPTED."
  echo "           The record still exists on this host only, and a lost volume is still a lost company."
else
  report critical OBJECT_STORE_ENDPOINT    "no off-host backup — the record exists on this host only, and a lost volume is a lost company"
  report critical OBJECT_STORE_BUCKET      "no off-host backup — the endpoint alone ships nothing"
fi
report optional TRUSTED_PROXY_CIDRS      "rate limits key on the socket address; behind a proxy that is one bucket for the whole internet, login included"

# Set is not the same as right, and this script cannot tell the difference: it
# reads the file and reaches nothing. A wrong secret reads as configured here,
# turns Off-host backup green on System Control, and is then discovered when the
# first set is missed — which is to say, discovered from the alarm that exists
# for a lost volume.
if is_set OBJECT_STORE_ENDPOINT && is_set OBJECT_STORE_BUCKET; then
  echo
  echo "  An object store is set. Nothing here can tell whether the credentials work — this"
  echo "  script reads the file and reaches nothing. Prove them before restarting the service:"
  echo "      ./deploy/object-store-check.sh $ENV_FILE"
  echo "  It writes one object, reads it back, lists it, deletes it, and names the step that failed."
fi

# Not a missing value: a value that is wrong for a deployment holding real
# records. Neither `report` nor `is_set` can say this — the setting is present
# and true, which both of them read as configured.
#
# **Absent now counts as off.** It did not always: `config.ts` defaulted this to
# true, so a file with no line for it ran a public sandbox exactly as a file
# saying `true` did, and the first version of this check tested for a literal
# `=true` and said nothing at all on the one live deployment it was written for.
# The default is off now, so absence is the safe state and only an explicit
# truth opens it. This warns on that truth, because it is worth seeing on a
# deployment carrying real customers even when somebody chose it.
if grep -qE "^[[:space:]]*DEMO_TENANCY_ENABLED[[:space:]]*=[[:space:]]*(true|1)[[:space:]]*$" "$ENV_FILE"; then
  echo "  WARNING  DEMO_TENANCY_ENABLED is on — fourteen fictional identities are seeded"
  echo "           into the record, and any anonymous visitor can sign in as one of them"
  echo "           and spend the demonstration wallet. Right for a public sandbox, wrong"
  echo "           beside real customer records. Remove the line to close it."
  missing_critical=$((missing_critical + 1))
fi

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

# A secret that is present, plausible and wrong.
#
# Every check above asks whether a value is there. These ask what shape it is,
# because the two commonest webhook mistakes both leave a value that passes
# `is_set` and fails every signature: the API key pasted into the signing-secret
# variable, and a value that carried the quotes it was copied with into the
# file. Both produce STRIPE_SIGNATURE_INVALID on every delivery, hours after
# this script said the rail was configured.
#
# The value is read to measure it and is never printed. Stripe's own prefixes
# are what make this checkable at all: `whsec_` for a signing secret, `sk_` for
# an API key.
value_of() {
  grep -E "^[[:space:]]*$1[[:space:]]*=" "$ENV_FILE" | head -1 | cut -d= -f2-
}

shape_check() {
  local key="$1" prefix="$2" raw trimmed
  is_set "$key" || return 0
  raw="$(value_of "$key")"
  trimmed="$(printf '%s' "$raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

  if [[ "$trimmed" == \"*\" || "$trimmed" == \'*\' ]]; then
    echo "  WARNING  $key is wrapped in quotes — they become part of the secret and every signature fails"
    missing_critical=$((missing_critical + 1))
    # Unwrapped for the remaining checks, so a quoted-but-otherwise-correct
    # secret raises the one warning that is true of it rather than three.
    trimmed="${trimmed:1:${#trimmed}-2}"
  fi
  if [[ -n "$prefix" && "$trimmed" != "$prefix"* ]]; then
    echo "  WARNING  $key does not begin ${prefix} — an API key pasted into the signing-secret variable looks exactly like this"
    missing_critical=$((missing_critical + 1))
  fi
  if [[ ${#trimmed} -lt 16 ]]; then
    echo "  WARNING  $key is only ${#trimmed} characters — a truncated paste"
    missing_critical=$((missing_critical + 1))
  fi
}

shape_check STRIPE_WEBHOOK_SECRET whsec_
shape_check STRIPE_SECRET_KEY sk_
# No prefix asserted: KODA publishes none, and inventing one would report a
# correct secret as broken.
shape_check KODA_WEBHOOK_SECRET ""

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
