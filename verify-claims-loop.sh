#!/usr/bin/env bash
#
# verify-claims-loop.sh — live verification of the independent claims loop.
#
# The change-entitlement assessment (claims.ts, impact_assessment) runs an
# independent verify-and-improve loop ONLY against a real reasoning provider
# (AI_MODE other than "local"). The test suite runs the local stand-in, so it
# can prove the local path is unchanged but cannot exercise the production loop.
# This script does that live: it raises a change request, assesses its impact,
# and checks that the one assessment fired THREE AI calls (draft -> independent
# critique -> validated final), not one — while still making exactly one
# IMPACT_ASSESSED ledger write.
#
#   PASS      3 impact_assessment* executions appear, 1 ImpactAssessment write
#   SINGLE    1 execution — AI_MODE=local, or no reasoning provider is running
#   ANOMALY   anything else (notably >1 write — the loop must never touch the
#             ledger more than once)
#
# ---------------------------------------------------------------------------
# Usage
#   CONSTRUX_BASE=https://your-box.example.com \
#   CONSTRUX_PROJECT=<projectId> \
#   CONSTRUX_TOKEN=<bearer access token> \
#     ./verify-claims-loop.sh
#
# Getting a token: sign in to the app, open the browser console and read it from
#   JSON.parse(localStorage['construx.session']).accessToken
# The account must be able to assess a change (CHANGE_VARIATION execute) and read
# AI executions (AI_EXECUTION read) — a Project Manager seat has both.
#
# Staging / demo convenience: instead of CONSTRUX_TOKEN you may set
#   CONSTRUX_EMAIL=<account email>
# and the script will sign in automatically — but only where the deployment
# returns the one-time code in the login response (non-production, or a published
# demonstration account). A real production login sends the code by email and
# this path will tell you to use CONSTRUX_TOKEN instead.
#
# Optional:
#   COST_MINOR   cost impact in minor units  (default 4200000 = £42,000.00)
#   DAYS         time impact in days         (default 10)
# ---------------------------------------------------------------------------

set -euo pipefail

# --- preconditions ---------------------------------------------------------
command -v curl >/dev/null || { echo "ERROR: curl is required." >&2; exit 2; }
command -v jq   >/dev/null || { echo "ERROR: jq is required (brew/apt install jq)." >&2; exit 2; }

BASE="${CONSTRUX_BASE:-}"
PROJECT="${CONSTRUX_PROJECT:-}"
TOKEN="${CONSTRUX_TOKEN:-}"
EMAIL="${CONSTRUX_EMAIL:-}"
COST_MINOR="${COST_MINOR:-4200000}"
DAYS="${DAYS:-10}"

[ -n "$BASE" ]    || { echo "ERROR: set CONSTRUX_BASE (e.g. https://your-box.example.com)." >&2; exit 2; }
[ -n "$PROJECT" ] || { echo "ERROR: set CONSTRUX_PROJECT (the projectId)." >&2; exit 2; }
BASE="${BASE%/}"   # strip a trailing slash

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# req METHOD PATH [json-body]  -> body on stdout; sets HTTP in global REPLY_CODE
# Fails (non-zero) on a >=400 status, printing the problem+json detail.
ACTOR=""
req() {
  local method="$1" path="$2" data="${3:-}"
  local -a args=(-sS -X "$method" -o "$TMP/body" -w '%{http_code}'
                 -H 'Accept: application/json')
  [ -n "$TOKEN" ] && args+=(-H "Authorization: Bearer $TOKEN")
  if [ -n "$data" ]; then args+=(-H 'Content-Type: application/json' -d "$data"); fi
  REPLY_CODE="$(curl "${args[@]}" "$BASE$path")"
  cat "$TMP/body"
  if [ "${REPLY_CODE:0:1}" = "4" ] || [ "${REPLY_CODE:0:1}" = "5" ]; then
    echo >&2
    echo "ERROR: $method $path -> HTTP $REPLY_CODE" >&2
    jq -r '.detail // .title // .message // .' "$TMP/body" 2>/dev/null | sed 's/^/  /' >&2 || true
    return 1
  fi
}

echo "== CONSTRUX claims-loop live verification =="
echo "   base:    $BASE"
echo "   project: $PROJECT"
echo

# --- 1. resolve a bearer token --------------------------------------------
if [ -z "$TOKEN" ]; then
  [ -n "$EMAIL" ] || { echo "ERROR: set CONSTRUX_TOKEN, or CONSTRUX_EMAIL for staging/demo auto-login." >&2; exit 2; }
  echo "-- signing in as $EMAIL (staging/demo path) --"
  login="$(req POST /v1/auth/login "$(jq -nc --arg e "$EMAIL" '{email:$e}')")" || exit 1
  ACTOR="$(echo "$login"   | jq -r '.actorId // empty')"
  CHALLENGE="$(echo "$login" | jq -r '.challengeId // empty')"
  CODE="$(echo "$login"    | jq -r '.devCode // .demoCode // empty')"
  if [ -z "$CODE" ]; then
    echo "ERROR: the login response carried no one-time code — this is a production, non-demo" >&2
    echo "       deployment, so the code was emailed. Get a token from the browser instead:" >&2
    echo "       JSON.parse(localStorage['construx.session']).accessToken  ->  CONSTRUX_TOKEN" >&2
    exit 1
  fi
  verify="$(req POST /v1/auth/mfa/verify \
    "$(jq -nc --arg a "$ACTOR" --arg c "$CHALLENGE" --arg k "$CODE" '{actorId:$a,challengeId:$c,code:$k}')")" || exit 1
  if [ "$(echo "$verify" | jq -r '.secondFactorRequired // false')" = "true" ]; then
    echo "ERROR: this account has a second factor enrolled; the script cannot complete it." >&2
    echo "       Sign in in the browser and supply CONSTRUX_TOKEN instead." >&2
    exit 1
  fi
  TOKEN="$(echo "$verify" | jq -r '.accessToken // empty')"
  [ -n "$TOKEN" ] || { echo "ERROR: no accessToken in the verify response." >&2; exit 1; }
  echo "   signed in, actor $ACTOR"
  echo
fi

# --- 2. best-effort AI-mode check (operator only) --------------------------
echo "-- AI mode --"
if probe="$(req POST /v1/admin/ai/probe '{}' 2>/dev/null)"; then
  MODE="$(echo "$probe" | jq -r '.mode // "unknown"')"
  echo "   mode: $MODE"
  echo "$probe" | jq -r '.providers[]? | "   provider: \(.capability // .name) healthy=\(.healthy)"' 2>/dev/null || true
  if [ "$MODE" = "local" ]; then
    echo "   NOTE: mode is \"local\" — the loop will be skipped by design; expect SINGLE below."
  fi
else
  echo "   (could not read mode — needs the platform-operator seat; continuing)"
fi
echo

# count impact_assessment* executions currently materialised on the project
LOOP_TASKS='["impact_assessment","impact_assessment_draft","impact_assessment_critique"]'
count_execs() {
  req GET "/v1/projects/$PROJECT/entities/AIExecution" \
    | jq --argjson t "$LOOP_TASKS" '[.entities[]? | select(.state.taskType as $x | $t | index($x))] | length'
}
count_assessments() {
  req GET "/v1/projects/$PROJECT/entities/ImpactAssessment" | jq '[.entities[]?] | length'
}

echo "-- baseline --"
BEFORE_EXECS="$(count_execs)"       || exit 1
BEFORE_WRITES="$(count_assessments)" || exit 1
echo "   impact_assessment* executions so far: $BEFORE_EXECS"
echo "   ImpactAssessment writes so far:       $BEFORE_WRITES"
echo

# --- 3. raise a change request --------------------------------------------
echo "-- raising a change request --"
CR_BODY="$(jq -nc '{
  description: "Verification change: ground conditions east of grid C require a supplementary GI before piling.",
  origin: "SITE_CONDITION",
  noticeType: "CCI",
  reason: "Live verification of the independent claims-assessment loop.",
  impactedPackageIds: [],
  affectedSubcontractIds: [],
  supportingEvidenceHash: "verify-claims-loop"
}')"
cr="$(req POST "/v1/projects/$PROJECT/changes" "$CR_BODY")" || exit 1
CRID="$(echo "$cr" | jq -r '.changeRequestId')"
echo "   changeRequestId: $CRID  ($(echo "$cr" | jq -r '.reference // "?"'))"
echo

# --- 4. assess its impact (the call under test) ----------------------------
echo "-- assessing impact (this fires the loop in production) --"
AS_BODY="$(jq -nc --argjson cost "$COST_MINOR" --argjson days "$DAYS" --arg by "${ACTOR:-verify-claims-loop}" '{
  costImpactMinor: $cost,
  timeImpactDays: $days,
  assessedBy: $by,
  affectedSubcontractIds: [],
  notes: "Live verification run."
}')"
as="$(req POST "/v1/projects/$PROJECT/changes/$CRID/impact" "$AS_BODY")" || exit 1
ASID="$(echo "$as" | jq -r '.assessmentId')"
ACU="$(echo "$as" | jq -r '.acuConsumed')"
echo "   assessmentId: $ASID"
echo "   acuConsumed:  $ACU   (reflects ~3 calls in production, ~1 locally)"
echo

# --- 5. measure ------------------------------------------------------------
AFTER_EXECS="$(count_execs)"        || exit 1
AFTER_WRITES="$(count_assessments)" || exit 1
DELTA_EXECS=$(( AFTER_EXECS - BEFORE_EXECS ))
DELTA_WRITES=$(( AFTER_WRITES - BEFORE_WRITES ))

echo "-- result --"
echo "   AI executions added by this assessment: $DELTA_EXECS"
echo "   ImpactAssessment writes added:          $DELTA_WRITES"

# Which taskTypes actually appeared, for the record.
req GET "/v1/projects/$PROJECT/entities/AIExecution" \
  | jq -r --argjson t "$LOOP_TASKS" '
      [.entities[]? | select(.state.taskType as $x | $t | index($x))]
      | sort_by(.state.endedAt // "") | reverse | .[:3]
      | .[] | "     \(.state.taskType)  acu=\(.state.acuConsumed)  standardOutput=\((.state.standardOutput|type)!="null")"' \
  2>/dev/null || true
echo

# --- 6. verdict ------------------------------------------------------------
if [ "$DELTA_WRITES" -ne 1 ]; then
  echo "ANOMALY: expected exactly 1 ImpactAssessment write, saw $DELTA_WRITES."
  echo "         The independent loop must never write to the ledger more than once."
  exit 1
fi

case "$DELTA_EXECS" in
  3)
    echo "PASS: the independent loop ran — draft, independent critique, and validated final,"
    echo "      with one ledger write. The final impact_assessment execution carries the"
    echo "      standardOutput (the validated answer); the draft and critique are advisory."
    ;;
  1)
    echo "SINGLE: one call only — the single-call self-critique path. Either AI_MODE=local,"
    echo "        or no reasoning provider is running. Confirm mode above, then re-run on a"
    echo "        deployment with AI_MODE=production and a healthy reasoning provider."
    exit 3
    ;;
  *)
    echo "ANOMALY: expected 3 (production) or 1 (local) new executions, saw $DELTA_EXECS."
    echo "         Re-run on a quiet project with no concurrent change assessments."
    exit 1
    ;;
esac
