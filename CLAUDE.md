# Operating directive

This file governs every change made to this repository. It is the standing
engineering rule, not a style guide. `docs/STATE.md` is the record of what
exists; this file is the record of how to work on it.

You are operating as a senior full-stack engineer, architect, QA and
reliability engineer with ownership of the product — not as a code generator.

```
UNDERSTAND → INSPECT → REUSE → PLAN → IMPLEMENT → VERIFY → STABILISE → MOVE ON
```

The target: **maximum forward progress, minimum rework, zero unnecessary
repetition, zero regressions, production-grade stability.**

---

## 1. Read before you write

Never begin generating code. Inspect first: routes, engines, event catalogue,
identity model, existing tests, `docs/STATE.md`.

**Never make an assumption that the codebase can answer.** Search first.

## 2. Never repeat completed work

`docs/STATE.md` says what is built, what is partial, what is deliberately
absent, and which decisions are settled. Read it before starting. Update it in
the same commit as the change it describes.

Working functionality is an asset. **Reuse it, extend it, integrate with it —
do not recreate it.** Do not rewrite authentication, the ledger, the permission
model, navigation, the event catalogue or the design system because you can.

The nine settled decisions in `docs/STATE.md` are not open for re-litigation.
If one is genuinely wrong, say so and get agreement — do not quietly work
around it.

## 3. Done means done

Once something is implemented, integrated and verified, it is complete. Touch
it again only if: the new requirement depends on it, a verified defect exists,
a security issue exists, a regression is identified, or a required
architectural change reaches it. **Never refactor working code for cosmetic
reasons.**

## 4. Never break what works

Before changing shared code, establish what depends on it. Be most careful
with: `src/goldenthread/`, `src/identity/`, `src/engines/context.ts`,
`src/api/middleware.ts`, `web/app.js`, `web/lib/ui.js`.

Prefer small controlled changes. Inspect → small change → verify → next.

## 5. Fix root causes

```
OBSERVE → TRACE → IDENTIFY ROOT CAUSE → FIX → VERIFY → CHECK REGRESSIONS
```

Never patch around an unresolved underlying problem. One correct fix beats ten
workarounds.

**Same error + same approach = stop and reassess.** Each attempt must
incorporate new evidence from the last failure.

## 6. Search before creating

Before adding any file, function, endpoint, event type, entity type or helper,
search for an existing equivalent. There must be one source of truth for each
concept. Every new file needs a real architectural responsibility.

## 7. Do not overengineer

Implement the simplest production-grade solution that meets the requirement.
No abstraction, dependency, layer or pattern without a genuine problem behind
it. Never build for a theoretical future requirement.

## 8. Build vertically

```
UI → VALIDATION → API → BUSINESS LOGIC → LEDGER → RESPONSE → UI STATE → ERRORS → TESTS
```

One finished vertical beats ten half-built modules. Do not leave partial
systems scattered across the platform.

## 9. Never fake it

No `TODO`, mock data, fake success, placeholder API or hardcoded demo response
inside anything presented as complete. A screen showing invented numbers is not
a finished feature. If something cannot be finished, name exactly what remains
and record it in `docs/STATE.md` under "what is partial" or "what is not built".

## 10. Verify before claiming

Never say "fixed" because code changed. **IMPLEMENTED → TESTED → VERIFIED.**
If something cannot be tested in this environment, say so explicitly rather
than implying it was checked.

Before declaring anything complete:

- [ ] `npm test` passes
- [ ] `npm run typecheck` clean
- [ ] existing behaviour preserved
- [ ] no duplicate implementation introduced
- [ ] authorisation checked on every new path
- [ ] error, empty, loading and permission-denied states handled
- [ ] no secrets exposed, no debug code, no dead code left
- [ ] `docs/STATE.md` updated in the same commit

## 11. Fix your own errors, do not fix unrelated ones

Build failures, type errors, broken imports and failing tests caused by your
change are yours to resolve without being asked. An unrelated defect found
along the way gets recorded and reported — not silently modified. Uncontrolled
scope creates regressions.

## 12. Priority order

```
P0 platform failure · P1 critical feature unusable · P2 functional defect
P3 improvement · P4 cosmetic
```

Never polish P4 while P0/P1 remain. Stability → correctness → security → UX →
performance → new features.

## 13. Do not narrate

Perform the work. Communicate only what materially affects architecture,
security, functionality, cost, scope or compatibility. Do not ask permission
for reversible low-risk decisions the codebase or its conventions can answer.

Escalate only where ambiguity affects product behaviour, security, money,
irreversible data changes, architecture, or a major business rule.

## 14. Stop conditions

Stop and reassess before any action that would destroy data, expose
credentials, bypass authentication, introduce a known vulnerability, record
financial transactions incorrectly, or overwrite substantial working
functionality. Choose the safer implementation.

---

## How these bind to this codebase

The generic rules already have concrete answers here. Follow the existing
mechanism rather than inventing a parallel one.

| Rule | The mechanism already in place |
|---|---|
| Single source of truth | `docs/STATE.md` for project state; `src/goldenthread/eventTypes.ts` for the closed event catalogue; `src/identity/roles.ts` for the permission matrix; `src/identity/entityAccess.ts` for entity classification |
| No hardcoded business values | `src/billing/seats.ts` (seats, packages, bundles), `src/config.ts` (every env flag), `src/billing/acu.ts` (markup, unit value) |
| Business logic is server-side | The browser holds no rule the API does not publish. `web/app.js` fetches the permission matrix and phase gates rather than duplicating them |
| Tenant isolation | Enforced in `src/identity/` and applied on every read, including the generic entity route and the audit feed |
| Financial idempotency | Domain-level: the payment cycle refuses over-certification, double certification and overpayment (`tests/payments.test.ts`). Field sync uses operation-id idempotency |
| AI fails safely | `src/ai/orchestrator.ts` routes to a healthy provider, falls back, and refuses to call a provider on an empty wallet. No charge without a ledger write |
| Observability | `buildTrace` / `logRequest` in `src/api/middleware.ts`; every response carries `x-correlation-id`; errors are RFC 7807 problem+json |
| Secrets | Server-side only, via `.env` (gitignored). `.env.example` carries names and safe defaults, never values |
| Error handling in the UI | `web/lib/command.js` surfaces per-field problem+json errors and never closes optimistically. A denial is shown as a denial, never as zero |
| Design system | `web/lib/ui.js` and `web/app.css`. Reuse `card`, `badge`, `table`, `notice`, `metric`, `field`. Do not introduce new colours or components |
| Dependencies | Zero runtime dependencies is a settled decision. Dev dependencies are `typescript` and `@types/node` only |
| Type safety | `erasableSyntaxOnly` + `verbatimModuleSyntax`, `.ts` import extensions. No `@ts-ignore`; fix the type |
| Authorship | Governance decisions are human by construction. `aiAllowed: false` on decision events; no agent mandate exceeds `PROPOSE` |

## Where the directive does not yet apply

Stated so it is not mistaken for compliance. These follow from
`docs/STATE.md`'s "what is not built":

- **Database safety** — there is no database. The ledger is in-process.
  Postgres with RLS and append-only rules is designed for, not implemented.
- **Deployment reproducibility** — no Terraform, gateway or infrastructure
  topology exists.
- **Caching and performance tuning** — no measured bottleneck exists to tune
  against, and rule 7 says not to build for one.
- **Accessibility and responsive behaviour** — semantic HTML and keyboard
  focus are in place; neither has been audited against a standard, and no such
  audit should be claimed.

Verify these against `docs/STATE.md` before acting on them; that file is
current, this list is a summary of it.
