# Launch audit and GO/NO-GO verdict

An adversarial audit: every claim below was tested by attacking the running
platform, not by reading the code that implements it. Where an attack was
repelled it is recorded as **held** with the response it produced. Where it was
not, or where a control does not exist, it is recorded as a **gap** with what it
would take to close.

Nothing here is graded on effort. A control that exists and is off by default is
a control that is off.

---

## Verdict

> ## Controlled pilot: **GO**
> ## General availability: **NO-GO**

The product is not the risk. The **deployment** is.

Every correctness, authorisation, isolation and financial control tested held,
including the ones that are easy to get wrong and expensive to get wrong. What
is missing is not a feature: it is that the record currently lives in one
process's memory with a durable journal beside it, and that the two protections
which have to be switched on by an operator — evidence encryption and TLS
termination — are switched off in the shipped configuration, correctly, because
the platform will not invent a key or claim a certificate it has not got.

A pilot on named projects with a named operator watching it is a responsible
next step and would generate the only evidence that matters, which is a customer
using it. Selling it to a queue of customers before the storage layer is
Postgres and before the deployment topology exists would be selling a promise the
operations story cannot keep.

---

## What was attacked, and what happened

Sixteen attacks against a running server. Each ran against the seeded
demonstration tenancy with real sessions.

### Authentication — 7 attacks, 7 held

| Attack | Response | Verdict |
|---|---|---|
| Anonymous `GET /v1/projects` | 401 | held |
| Anonymous `GET /v1/admin/commercial` | 401 | held |
| Anonymous `GET /v1/changes` | 401 | held |
| Anonymous `GET /v1/admin/data-protection` | 401 | held |
| Anonymous `GET /v1/billing/wallet` | 401 | held |
| Forged JWT with an invented signature | 401 | held |
| `alg=none` JWT, the classic bypass | 401 | held |

### Tenant isolation — 2 attacks, 2 held

The first was flagged as a breach by the probe and disproved on inspection,
which is worth recording because it is exactly the kind of finding an audit
gets wrong in the direction that flatters it — and, run the other way, the kind
that produces a false alarm.

| Attack | Response | Verdict |
|---|---|---|
| Read another tenancy's project with a token carrying a forged tenancy claim | **200, `events: 0`** | held |
| The change feed under a forged tenancy claim | 200, zero entries | held |

The 200 is deliberate and is not a leak: the tenancy filter is applied in the
ledger, so the caller receives an empty set rather than a 403 confirming the
project exists. Reporting the status code alone would have called this a breach;
reading the body shows the isolation holding exactly as designed.

Note also what this attack required: the platform's own signing secret. An
attacker who has that has everything. The realistic version of this attack — a
legitimate user of tenancy B naming a project belonging to tenancy A — is
covered by the same filter and by `identity.test.ts`.

### Authorisation and consent — 2 attacks, 2 held

| Attack | Response | Verdict |
|---|---|---|
| A site manager reads the tenancy's commercial position | 403 `ACCESS_DENIED` | held |
| A quantity surveyor consents, on the company's behalf, to share its figures with competitors | 403 `ACCESS_DENIED` | held |

### Money — 2 attacks, 2 held

| Attack | Response | Verdict |
|---|---|---|
| Settle the same settlement twice | 409 `SETTLEMENT_ALREADY_SETTLED` | held |
| Run a £20,000,000 transaction to see what it is charged | **£750.00** — the cap | held |

The second is the one worth dwelling on. An uncapped percentage on construction
payments is the failure that loses a customer silently and permanently: they run
one large certificate through, meet a five-figure fee for a bank transfer, and
leave. The cap makes the fee a charge for a service rather than a share of the
customer's contract value.

### Abuse and disclosure — 2 attacks, 2 held

| Attack | Response | Verdict |
|---|---|---|
| 400 rapid login attempts against different addresses | 429 before exhaustion | held |
| Verify a document with an invented verification code | `verified: false`, no issuer, no date, no title | held |

The verification refusal is the one an attacker learns least from: a mistyped
code, an invented tenancy and an altered document all produce the same sentence,
so nothing grades an attempt.

### Deployment posture as shipped — 2 findings, both gaps

| Check | Shipped state | Verdict |
|---|---|---|
| `EVIDENCE_MASTER_KEY` | **not configured** | gap |
| TLS termination | `http://localhost:8080`, `NOT_DECLARED`, 2 findings | gap by design |

Both are correct behaviour and both are open. The platform will not generate a
key at boot — a deployment whose evidence becomes unreadable on restart is worse
than an unencrypted one — and it will not claim a certificate it has not been
given. `GET /v1/admin/data-protection` reports the tenancy's standing as **WEAK**
in this state rather than reporting "encryption: on", which is the right
behaviour and is also the finding.

**Until an operator sets both, a stolen volume is a readable archive of every
customer's site photographs, signed instructions and scanned contracts.**

---

## What is genuinely not built

Taken from `docs/STATE.md`'s own register rather than rediscovered, because that
register is maintained and a second list would drift from it.

| Absent | Consequence for launch |
|---|---|
| **Postgres as the live store** | The ledger is in-process with a durable journal beside it. The schema and the zero-dependency client are both verified against a real Postgres 16 (19 checks and 18 checks), so this is wiring rather than design — but it is wiring nobody has done, and a single process holding the record is a single point of failure for the whole customer base. **This is the blocking item.** |
| **Deployment topology** | No Terraform, no gateway, no managed database, no object store provisioned. There is a Dockerfile, health probes, a CI workflow and a runbook. Going live is currently a manual act somebody performs and nobody can reproduce. |
| **Horizontal scale, run** | Every piece exists; none has been run at scale. No load test, no measured bottleneck, no capacity figure. Nothing here should be sold against a concurrency number. |
| **OCR and semantic embeddings** | Ingestion reports `NEEDS_OCR` and the perception pipeline refuses where no multimodal provider is configured. Semantic search returns a stated refusal. All three are honest and all three are absent capability. |
| **Native mobile clients** | The installed PWA covers the field case, without background sync while closed and without camera or location beyond what the browser grants. |
| **External data feeds** | Commodity pricing, weather, credit reference. Statutory interest states the entitlement and not the amount, because base rate is a fact about the outside world this platform is not connected to. |
| **Customer references** | Not a technical gap and the largest commercial one. Construction is the most reference-driven industry there is. |

---

## What is unusually strong, stated plainly

An audit that only lists faults is as useless as one that only lists features.

- **The invariant suites do real work.** Building the last four items produced
  four name collisions and route duplications, and the invariants caught every
  one before it shipped — including `Settlement` meaning two different things
  and a route path already owned by another subject. One entity type carrying
  two concepts is how a permission written for one ends up granting the other.
- **Mutation testing found defects the tests did not.** Across the last three
  items: verification tag separators that were invisible NUL bytes (any
  normalising tool would have turned every genuine document into a reported
  forgery), disclosed detail not pinned to the matching record, a benchmark
  dominance check that an all-negative cohort walked straight through, and a
  change-feed cursor that would have silently dropped every event committed in
  the same millisecond.
- **The refusals are real and tested.** No double certification. No approval of
  a Construction Phase Plan with gaps. No signature in a name that is not
  competent — six CDM documents sit complete and unsigned rather than carrying a
  forged approver. No AI spend on an empty wallet. No agent above `PROPOSE`.
- **Accessibility was measured, not asserted.** WCAG 2.2 AA run against the
  rendered console with per-layer compositing; the first pass reported fifteen
  failures of which nine were the script's own arithmetic, and changing a token
  on that measurement would have made the product worse while appearing to make
  it accessible.

---

## Conditions on the pilot

Each is a precondition, not an aspiration. A pilot that starts without them is
the general-availability launch this audit says no to, with fewer people
watching.

1. **Set `EVIDENCE_MASTER_KEY` from a secret manager**, not from a file on the
   evidence volume. Until it is set, the at-rest control does nothing.
2. **Terminate TLS in front of the process and set `TLS_TERMINATION` to match.**
   Then `PUBLIC_BASE_URL` to the https address, HSTS to at least 180 days, and
   `COOKIES_SECURE=true`.
3. **Move the ledger to Postgres before the second customer.** One process
   holding one customer's record is a risk somebody can watch. Holding several
   customers' records is a risk nobody can.
4. **Name the operator on call**, and agree what a customer is told when the
   process restarts.
5. **Cap the pilot at projects the customer could reconstruct.** Not because the
   record is untrustworthy — the chain verifies — but because no deployment has
   yet survived an incident, and the first one should not be somebody's
   adjudication evidence.
6. **Agree in writing what the pilot is measuring.** A pilot with no success
   condition becomes a free subscription nobody can end.

---

## What would move the verdict to GO for general availability

- Postgres live, with the append-only rules and row-level security the schema
  already carries, and a restore rehearsed rather than documented.
- A deployment somebody can reproduce from a repository rather than perform.
- One load test against a stated concurrency target, and a capacity figure that
  came from it.
- Two customers live for a quarter without an incident that lost a record.
- The at-rest and in-flight postures both reporting **ADEQUATE** in the
  customer's own console rather than in a runbook.

Five of those are weeks of work. The sixth is a quarter of calendar time and
cannot be compressed, which is the real reason this is a pilot rather than a
launch.

---

*Method: 16 attacks against a running server; 5,303 automated tests; mutation
testing across every module built in the last four items. Every figure in this
document came from a command that was run, and the one finding that was
initially graded as a breach is recorded above along with why it was not.*
