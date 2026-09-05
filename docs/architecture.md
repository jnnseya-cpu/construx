# Architecture

## The shape of the system

```
      Web console          Android              iOS
           │                  │                  │
           └──────────── API Gateway ────────────┘
                      (stateless, single ingress)
                              │
              trace → rate limit → authenticate
              → validate → RBAC → scopes → ABAC
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
   Domain commands      Seven AI engines      Audit & replay
        │                     │                     │
        └──────────┬──────────┴──────────┬──────────┘
                   │                     │
          Golden Thread ledger    AI orchestrator
          (append-only, chained)         │
                   │              ACU wallet ── provider adapters
                   │                     │
              Projections          reasoning / perception
```

Everything narrows to one point: the ledger. There is no second way to change
state, which is what makes the audit trail complete by construction rather than
by discipline.

## Why the ledger derives the patch

A caller submits the state it wants. The ledger diffs that against current
state, orders the resulting operations, applies them, and re-derives the
after-state from the patch rather than trusting the submitted object.

That last step matters. If the patch and the caller's intent disagree — because
the diff dropped something, or an array was reordered — the divergence surfaces
at commit time, when it can be rejected, rather than at replay time years later
when the record is being relied on in a dispute.

## Why hashing strips fields

Two systems holding the same project must compute the same hash. If `updatedAt`
were hashed, re-saving an unchanged record would produce a different hash and
every downstream comparison would be noise. So audit metadata, cached
calculations and UI-only keys are removed before hashing, and array order is
preserved because in construction the order of a pour sequence *is* the state.

## Why the chain hash exists

Per-entity `beforeHash`/`afterHash` proves an entity's history is internally
consistent. It does not prove that an event was not *removed*. Deleting an
event and its successor's `beforeHash` leaves a chain that still validates
entity by entity.

So each event also hashes over its predecessor's chain hash. Removing,
inserting or reordering any event breaks every chain hash after it, and replay
reports `FAILED_CHAIN` at the exact point of the break.

## Why AI never writes state directly

Engines pass structured payloads to a provider and receive structured output.
That output is never committed as-is. The engine combines it with its own
deterministic maths and produces the state to write. Three consequences:

- **The critical path is arithmetic.** Two runs on the same network produce the
  same programme. A model cannot quietly change a completion date.
- **Attribution is honest.** AI-authored events carry an `AI` actor, the
  provider, the model class and the ACU cost. Liability follows attribution.
- **Prose is never state.** A model's narrative is attached to a record as
  commentary. It is not hashed as the record's meaning.

## Why billing is sequenced the way it is

```
route → reserve → execute → persist → debit
```

Reserving first means a tenant without credit never triggers a provider call —
the platform cannot spend money it will not recover. Debiting last means a
failed persistence leaves the customer uncharged. The hold sits between the two
so a concurrent call cannot spend the same balance twice.

The one asymmetry: if an execution overruns its estimate, the charge is capped
at the amount reserved. The platform absorbs the difference rather than issuing
a bill the customer was never shown.

## Why access control is ordered

```
authenticate → RBAC → scopes → ABAC → decision
```

Each stage is cheaper than the next and rejects more traffic. RBAC asks whether
the role could ever do this; scopes ask whether this token was granted the
capability; ABAC asks whether it is allowed *here*, in this tenant, this
project, this lifecycle phase, against data of this sensitivity.

Every stage fails closed. A missing attribute, an evaluation error and an
explicit deny all produce the same answer, because a permission system that
guesses when it is unsure is not a permission system.

## Why separation of duties is enforced, not advised

The QS authors the estimate and runs the bid evaluation, and cannot approve the
budget baseline or the award. The PM approves the adjudication. The Owner
approves the cost baseline and accepts handover. Safety approves RAMS and
cannot see contract liability provisions.

These are not configuration defaults. They are in the permission matrix, and the
seeded demo had to be rewritten to satisfy them — which is the point: the system
refused to let one role do the whole lifecycle.

## Why the generic entity read is classified

`GET /v1/projects/:id/entities/:refType` can return any record in the system.
Enforcing only tenant isolation there would have made every capability boundary
elsewhere decorative: a safety manager barred from the estimate could simply
read `entities/Estimate` instead.

Each entity type therefore declares its capability area and data sensitivity in
one map, and the read is evaluated against the same ABAC call the typed
endpoints use. An unmapped type is refused rather than served, so a new entity
has to say where it belongs before it can leave the system.

A `REDACT` verdict is a refusal on this endpoint. There is no useful partial
view of a list of commercial records, and returning empty shells would still
disclose how many exist.

The same rule applies to the audit trail, which would otherwise be the way
round every capability boundary in the system: the raw event feed used to
return each event's full JSON patch, so a regulator refused `entities/CVR`
could read the same margins out of the CVR's `diff`. An audit trail has two
jobs and they separate cleanly — proving the record is complete and untampered
needs the envelope (actor, time, event type, hashes, chain), while reading what
changed needs the patch, and the patch is entity content. Events the caller
cannot read keep their envelope and lose their `diff`.

The interface distinguishes "withheld" from "empty". A denial recorded during a
render is stated at the top of the screen with its reason, because on a
construction record "you may not see this" and "there is nothing here" are
different answers.

## Why the operator layer is a different product

A platform operator signs into the same application and gets a different one:
tenancy, subscription tier, seat usage and prepaid credit — and no project, no
package, no daily log. That is not the navigation hiding things. `projectContext`
refuses an operator token outright, and ABAC denies every delivery capability
area independently of the permission matrix, so removing the matrix entry would
not open the door.

The reverse holds too: no customer account, including the enterprise admin,
reaches platform administration.

The cost of this is that operator support cannot look at a customer's data to
help them. That is the intended trade — an operator who can read a project can
be compelled to.

## Why the interface mirrors enforcement instead of restating it

Every navigation entry declares the capability area it reads, and the sidebar
resolves that against the permission matrix fetched from the live API. A screen
the current role cannot open is shown locked with the reason rather than hidden,
because a user needs to know a capability exists and who to ask for it.

Nothing in the interface is the control. Deleting the lock would reveal the
entry and the request behind it would still be denied — the API is where access
is decided, and the interface is a rendering of that decision.

## Why phase gates read from state

A gate that is a flag someone sets is a gate someone forgets. Each phase's exit
criteria are predicates over materialised entities: an approved programme
baseline exists, an estimate is frozen, a contract is executed, commissioning
results are accepted. `evaluatePhaseGate()` counts what actually satisfies each
predicate, so the gate cannot be asserted — only met.

Backwards transitions are allowed, because projects genuinely do re-tender or
re-enter design, but they are recorded as regressions with a justification.

## Why offline sync resolves conflicts the way it does

Field capture is additive most of the time: two operatives logging observations
never conflict. Conflicts arise on shared mutable state, and the rules are
ordered by consequence:

1. **A safety stop always wins.** A routine progress update that happened to be
   made later must not lift a stop.
2. **Progress is monotonic.** A device offline at 40% cannot pull back a later,
   higher figure recorded by someone else.
3. **Role priority.** A more senior decision stands.
4. **Last write.** Only once none of the above applies.

Losing changes are still reported to the operative and recorded in the sync
result. Nothing is silently discarded.

## Where uncertainty is made visible

The platform separates what it computed from what it inferred, and says which
is which:

- Machine-measured quantities carry a confidence score to the estimate line.
- A CVR built from partial inputs reports low completeness, and says so.
- An EVM snapshot reports what share of tasks are actually measured.
- A claim with thin evidence is scored down, and the reasons are listed.
- AI-classified safety observations are flagged as requiring human review.
- Extracted contract clauses are flagged as requiring legal review.
- The copilot says the record is empty rather than answering from general
  construction knowledge.

The alternative — presenting an inferred number with the same confidence as a
computed one — is how a forecast-driven system loses the trust it needs.

## Extension points

| To add | Implement | Nothing else changes |
|---|---|---|
| A new AI provider | `AIProviderAdapter` | Engines never import a vendor SDK |
| A new event type | Add to `EVENT_TYPES` | Ledger, replay and audit pick it up |
| A new engine | A module using `runAI()` | ACU enforcement and attribution are automatic |
| A new role | Add to `PERMISSION_MATRIX` | Scopes derive from the matrix |
| A new export | An `ExportService` method | Branding, hashing and recording are applied |
| Persistence | Done: `goldenthread/journal.ts` is the write-ahead log on the volume and `goldenthread/pgstore.ts` ships every commit to Postgres behind it (`LEDGER_POSTGRES_MODE=mirror` beside the journal, `primary` to boot from the database, `follower` for a read-only standby that applies what the primary ships) | The ledger's interface was already append-only; nothing in the domain layer changed |

## Deployment shape this is written for

The application is a single stateless Node process today, but it is written to
sit behind the specified topology without restructuring: the gateway holds no
session state so it scales horizontally; the ledger publishes to subscribers so
an event bus can be attached; media is referenced by hash and URI rather than
embedded so object storage slots in; and configuration is entirely
environment-driven so secrets come from a manager rather than the repository.
