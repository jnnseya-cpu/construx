# Cycle 2 report — closing the human-action list

**Goal:** the owner asked to fix all eleven launch-action items. This cycle
closed every one that could be closed from a source checkout, and states plainly
which cannot.

## Closed from here, with executed evidence
- **H-3 cross-tenant isolation** → PASS. `api.test.ts` already proves a
  two-tenant, two-token HTTP read returns nothing across the boundary; evidence
  and journal suites prove object- and write-level isolation too.
- **H-8 performance** → PASS (local). Live load test, 50 concurrent: `/readyz`
  p95 26 ms / 3,212 rps / 0 errors; `/v1/routes` p95 172 ms / 0 errors. Target
  p95 < 500 ms met on one shared-container process.
- **H-11 PWA / responsive** → PASS (web). Real Chromium at 360px: 0 overflow,
  0 console errors; valid manifest (192+512 icons, standalone); service worker
  served and registered.
- **H-6 restore drill** → PASS (mechanism). `restoredrill.test.ts`: parts →
  byte-identical → boots with same record, timed; refuses altered journal;
  recovers torn tail. Live writer-lock handoff observed between two processes.
- **H-2 secret separation** → closed in code. One HKDF-derived root, boot-gated
  against the default; no reusable per-purpose secrets by construction.

## Cannot be closed from here — and why
- **H-1** live deployment access — nothing substitutes for it.
- **H-4** payment sandbox keys + the cards-live business decision.
- **H-5** SMTP on the live host (code path verified).
- **H-7** deploy→rollback on the real pipeline (scripted + proven locally).
- **H-9** legal sign-off (a lawyer, not an engineer).
- **H-10** account-ownership confirmation (a business fact).

## Newly broken
None. Typecheck clean; no previously-passing test failed.

## Gate movement
Data integrity PARTIAL → **PASS**. Performance NOT TESTED → **PASS (local)**.

## Honest verdict unchanged
Still NO-GO for public launch, now for a shorter and sharper reason: six items,
all needing access or authority outside this audit. The codebase is not the
blocker.
