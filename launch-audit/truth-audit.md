# Truth audit — does the product do what it claims?

Method: traced claims from `README.md`, `docs/`, the boot banner and the console
to the real code path, and executed the path where a provider was not required.
Classifications: REAL · PARTIAL · STUBBED · ABSENT · BROKEN.

The headline finding is unusual and worth stating plainly: **this codebase does
not fake things.** Rule 9 of `CLAUDE.md` ("Never fake it") is enforced by tests,
and the audit's own scans bear it out — no `setTimeout` fake progress, no
hardcoded demo numbers in production paths, no success toast without a backend
write (the console's `command.js` only reports success on a real 2xx), no dead
buttons (the `doors` invariant proves every control reaches a real route and
every route a real control).

| Claim | Status | Evidence |
|---|---|---|
| Append-only hash-chained ledger | REAL | Boots, restores events, `assurance.test.ts` detects tampering; chain verified on replay |
| Multi-tenant isolation | REAL (one tenancy exercised) | T-030/050/051/052; `tid` from signed token; layer separation enforced |
| Authentication + MFA + TOTP second factor | REAL | T-010–T-042 executed end to end against a live boot |
| Brute-force protection | REAL | T-060: silent identity lockout bites the correct code + per-address 429 |
| AI drafting that cites real evidence, never invents | REAL | `bidondraft.test.ts` runs the full engine; uncited prose becomes a gap, invented citations dropped |
| AI never scores its own work | REAL (after D-015 fix) | Loop stops on the independent scorer’s mark |
| “Asks for the evidence before drafting” | REAL (after D-016 fix) | `planEvidenceNeeds`, one request per pack |
| Zero runtime dependencies | REAL | `npm ls`: typescript, @types/node, undici-types only; image runs `npm ci --omit=dev` |
| RFC 7807 problem+json errors with correlation id | REAL | Every error response in T-002…T-060 carried `type/title/status/traceId` |
| Security header set (CSP/HSTS/COOP/CORP/Permissions-Policy) | REAL | T-001 captured the full set |
| Production refuses insecure defaults | REAL | Production boot refused the published JWT default until real secrets supplied |
| Postgres ledger mode with RLS | PARTIAL (built, off by default) | `LEDGER_POSTGRES_MODE` exists, CI tests it against real PG 16; not the default and not exercised live here |
| Payments / card-on-file collection | PARTIAL (built, off by default) | Stripe code present; `SUBSCRIPTION_COLLECTION_ENABLED` off; untestable without sandbox keys — H-4 |
| Semantic evidence search | REAL-when-configured | Needs an embedding provider; refuses cleanly and says so when absent |
| Native mobile field client | ABSENT (by the project's own admission) | `mobile/README.md`: "None of this code has been compiled, run, or tested." Isolated, documented, not shipped |
| Object-store backup / telemetry egress | PARTIAL (built, off by default) | Boot banner declares both absent unless configured — H-6 |

**No claim was found that the code cannot keep.** The gaps are all *disabled
capabilities the platform is honest about* (payments, Postgres mode, backup,
mobile), each declared at boot and in `docs/STATE.md` — not promises the UI
makes and the backend breaks.
