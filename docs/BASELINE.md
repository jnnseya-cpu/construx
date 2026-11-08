# Stability baseline — the locked state

This file is the record of what the platform contains at the point it was locked,
so that a later change which **silently drops** something — a route, an event
type, a role, a discipline, a whole feature — can be caught against a number
rather than discovered in production. It is the human-readable half of the lock;
the enforcing half is `backend/tests/baseline.test.ts`, which fails the gate if
any of these catalogues comes back smaller than its floor.

Nothing here is a ceiling. The platform is expected to grow, and growth never
breaks the lock — only a shrink does, and only a shrink that nobody recorded.

## Locked at

- **Content commit:** `8fdfd42` — *Brand the Excel export: cover, logo, brand colour and document properties*
- **Lock commit (canonical reference):** `1365c5b` — this file and `baseline.test.ts`, committed on top of the content.
- **Branch:** `claude/ai-agent-construction-os-999410`
- **Date:** 2026-11-08
- **Gate:** `npm test` green (8169), `npm run typecheck` clean, working tree clean and pushed.

The immutable reference is the **commit SHA `1365c5b`** — pushed and permanent;
diff any later state against it to see exactly what changed. A convenience tag
`baseline-2026-11-08` points at the same commit locally; this cloud session's git
proxy accepts branch pushes but not tag refs, so the tag may need pushing from a
normal clone:

```
git fetch origin && git tag -a baseline-2026-11-08 1365c5b -m "Locked baseline" && git push origin baseline-2026-11-08
```

## Inventory floors

These are the numbers `baseline.test.ts` enforces (`>=`, so additions pass and
only drops fail):

| Catalogue | Floor | Source of truth |
|---|---:|---|
| API routes | 1362 | `backend/src/api/routes.ts` (`ROUTES`) |
| Golden Thread event types | 878 | `backend/src/goldenthread/eventTypes.ts` (`EVENT_TYPES`) |
| Identity roles | 22 | `backend/src/identity/roles.ts` (`ALL_ROLES`) |
| Construction disciplines | 19 | `backend/src/ai/expertise.ts` (`DISCIPLINES`) |
| RIBA stages | 0–7 (exact) | `backend/src/ai/expertise.ts` (`RIBA_STAGE_NUMBERS`) |

Reference counts, not enforced (for noticing drift):

| Thing | Count |
|---|---:|
| Automated tests | 8169 |
| Test files | 398 |
| Backend `.ts` source files | 382 |
| Frontend pages | 62 |
| Navigation entries | 66 |

## What is locked and present

- **The chartered-expert framing** across every AI reasoning surface — 19 disciplines,
  each a named UK-chartered professional, with the no-fabrication / propose-not-decide
  discipline and the professional work-quality bar in every briefing.
- **The RIBA 0–7 lifecycle model**, composed into the discipline briefings.
- **An AI expert behind every platform role** (`ROLE_EXPERTISE` covers every role).
- **The verify-and-improve loops** — clarification review, stage-gate chair, feasibility
  brief, risk register review, and the production independent loop on the claims assessment.
- **The chartered risk manager and change manager** agents.
- **The risk-review button** on the Risk & Safety screen.
- **Fully branded exports** — PDF, Word **and** Excel each carry the mark, the brand
  colour and the issuer in the file's properties. TEXT is unformatted by design;
  PowerPoint is not produced by any stage.

## How the lock holds

1. **Behaviour** is guarded by the full suite (8169 tests): a feature that stops working
   breaks its own test.
2. **Inventory** is guarded by `baseline.test.ts`: a feature deleted whole — which takes
   its test with it and so breaks nothing else — shrinks a catalogue below its floor and
   fails here instead.
3. **The exact bytes** are fixed by the tag `baseline-2026-11-08`: an immutable reference
   anyone can diff against to see precisely what changed.

## Changing the baseline on purpose

A floor is lowered only for a **deliberate, recorded** removal: edit the number in
`baseline.test.ts`, update the table above, and say in the commit why the thing was
removed. A floor lowered to make a surprised test pass is the bug the lock exists to
catch — investigate the drop instead.
