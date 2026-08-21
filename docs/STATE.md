# Project state

**This file is the single source of truth for what exists.** Read it before
starting work. Update it in the same commit as the change it describes. Do not
re-derive project state by inspecting the code — if this file is wrong, fix it
here rather than working around it.

It exists because state was previously re-derived every session, which produced
contradictory answers about what was built, repeated work that was already done,
and claims of completion that did not hold.

---

## At a glance

| | |
|---|---|
| Tests | 958 passing, 0 failing, across 45 files |
| Typecheck | clean |
| Backend | 81 TypeScript files, 35,927 lines |
| Application | 25 ES modules, 7,199 lines (plus a service worker) |
| API routes | 234 (13 of them the public site) |
| Event types | 175 Golden Thread (closed) · 177 communication events (closed) |
| Entity types | 111, all classified for access |
| Runtime dependencies | none — verified by booting with no `node_modules` present |
| Layout | `backend/` · `frontend/` · `shared/` · `deploy/` |

Run: `npm test`, `npm run typecheck`, `npm start` (landing at `/`, app at `/app`).

---

## What is built and verified

These are implemented, covered by tests, and exercised through the running
application. Do not rebuild them.

**The commercial rules, stated once.** Four rules and one guard, all in
`backend/src/config.ts` and `backend/src/billing/acu.ts`, with
`tests/economics.test.ts` holding them.

1. **No AI work without available ACUs.** `reserve()` is the only path to a
   provider and it throws `ACU_EXHAUSTED` before `adapter.execute()` is
   reached, so a refusal means no spend occurred. Money already held by a call
   in flight counts as unavailable, so two concurrent calls cannot spend the
   same credit. A customer's own monthly cap halts as firmly as an empty
   balance — a cap that only warned would be a budget nobody keeps.
2. **£1 buys 100 ACUs.** One ACU is one minor unit. Stated as its own value
   rather than assumed, because a currency with a different exponent would
   otherwise silently change what an ACU is worth.
3. **Provider cost is charged at 4×.** Revenue 4, cost 1.
4. **20% of every subscription payment is credited as AI allowance.** Credited
   at activation and again when each period is invoiced, once per period —
   invoices get corrected and reissued, and each reissue handing out another
   month of AI would be free money. Rounded down, because a fraction of an ACU
   cannot be spent.

The rule under all of them: **the company takes at least 100% profit on every
AI transaction** — it never keeps less than it paid the provider.
`minimumProfitPercent` states it, and the multiplier floor is *derived* from it
(`1 + pct/100 = 2×`) rather than configured beside it, so the rule and the
arithmetic cannot drift apart. At the 4× price the realised profit is 300%,
well clear of the floor.

The realised figure is reported rather than assumed: every wallet snapshot
carries `lifetimeProfitMinor` and `lifetimeProfitPercent`, so "are we hitting
the rule" is a read rather than an exercise somebody repeats by hand.

The volume bands were rebased from 3.0/2.7/2.5 to 4.0/3.6/3.3 when the headline
rate moved — leaving them would have made every large customer cheaper than the
headline by accident — and `effectiveMultiplier` clamps to the derived floor
whatever the table says. Even the deepest band leaves 230% profit, and a test
asserts every band clears the requirement.

The allocation rate is configuration, not a code path, so changing it is a
deployment change rather than an edit — but it has one default and that default
is 20%. It had been carrying two candidate values in a comment, which is not a
setting, it is an unmade decision sitting in the file that decides how much AI a
plan buys.

The allowance is published on the pricing page from the package definitions —
28,500 ACUs on Core Project, 66,000 on Professional Delivery, 195,000 on
Enterprise — because a plan that does not say how much AI it includes is one
the customer discovers the answer to when it stops.

**Durability. The ledger survives a restart.** It was an in-process array: for a
platform whose whole claim is an append-only, citable audit chain, that was not
a limitation but the product not existing between deploys.

The Golden Thread is already an append-only hash-chained log, so the journal is
that same log on disk — one JSON object per line, no second schema, no index.
Restoring is replaying, which the platform already did and already tested.

**Write-ahead, not write-behind.** The event is flushed *before* the ledger
mutates anything; if the write fails, `commit()` throws and no state changed.
That ordering is why it is not a `subscribe()` projection — subscribers run
after the commit and their failures are deliberately swallowed, which is right
for a projection and exactly wrong for durability. `commit()` stays synchronous
because it is called from several hundred places and making it async would be a
rewrite of the domain layer to buy nothing.

**Restore verifies rather than trusts.** Every chain hash is recomputed from its
predecessor and every state hash from the applied patch, so an altered journal
is refused and the process does not start — which is correct, because a platform
that boots on a broken chain will be asked to prove something from it later. A
torn final line is a crash mid-append, not corruption: that event was never
acknowledged, so it is dropped and reported. An unparseable line *anywhere else*
refuses to load.

**Two defects found by actually restarting a process, neither visible in
tests.** The first: replay reported `363 events restored into 293 entities` and
then answered "No user with that email address" to every sign-in. Tenants,
users, subscriptions and wallets live in the platform's own maps, not the chain
— so the record came back complete, verified and orphaned. `Platform.rehydrate()`
projects them back from the entities the ledger already holds.

The second is about money. The ACU wallet is a fold over its entries, and those
entries are deliberately **not** Golden Thread events — spend is its own
double-entry ledger by a settled decision. Restoring the chain without them
would have replayed the top-ups and forgotten the debits, so every wallet came
back richer than it should be and the platform gave away AI it had already paid
a provider for. Wallet entries are journalled beside the ledger with an `.acu`
suffix, the balance is folded from them rather than stored, and `#record` now
writes before it moves the balance so a failed write leaves neither. Holds are
deliberately not restored: a hold belongs to an AI call that died with the
process, and reinstating it reserves money against work that will never run.

Verified end to end across a genuine process restart: 363 events into 293
entities, 11 users, sign-in works, the balance comes back at exactly 499,912
minor with 588 billed, the project created before the stop is present, and the
chain replays `VERIFIED` with zero failures.

**Deployment.** One container, one process, one port, one volume, on a managed
platform. `deploy/Dockerfile` is a single stage because there is nothing to
compile; `npm ci --omit=dev` runs only to keep the empty runtime dependency set
provable. `tini` is PID 1 because Node as PID 1 ignores `SIGTERM` by default,
which would skip the graceful shutdown and make every deploy look like a crash.
The health check probes `/readyz` rather than `/healthz`, because a container
marked ready during a journal replay answers "no such project" for projects that
exist. `docs/RUNBOOK.md` carries build, release, rollback, restart, backup,
restore and secrets, and states plainly what this topology does not have —
horizontal scale is impossible while one process owns the journal file.

Verified by running the service exactly as the image does — production
environment, no `node_modules` present at all — which is also the strongest
available check that the zero-dependency decision still holds. The image itself
was **not** built here: this environment has the Docker CLI but no daemon. CI
builds it and boots it on every push.

That run found one more defect: **HEAD returned 404 on every path**, including
`/healthz`. Uptime monitors, load balancers and link checkers probe with HEAD,
and a platform whose health probe defaults to it would have read a healthy
service as a permanent outage. HEAD now routes as GET.

**Public registration, and every account type.** `POST /v1/signup` is the only
endpoint where an unauthenticated stranger creates state, so it is written on
the assumption the caller is hostile until an address is proved.

A registration is **not** an account: a pending record with a hashed token
against it, and no tenancy, no seat and no billing record until somebody proves
they own the address. Creating the tenant first and marking it unverified would
let anybody create unlimited tenancies by typing addresses they do not own, and
every one would land in the billing tables.

Registering an address that already exists returns a **byte-identical** receipt
to registering a new one. A public endpoint that distinguishes the two tells an
attacker which of a leaked address list are customers. The address owner is
warned either way — a verification link, or a note that an account already
exists — which is the only way to warn the real owner without answering the
attacker's question. Tokens are stored as an HMAC and compared in constant
time, and a spent token is deleted so a link cannot be replayed.

**Verifying returns an account, never a session.** The person then signs in
through `/v1/auth/login` and MFA like any other client. Returning a token here
would have rebuilt the console-session hole through a different door, which is
why the public-surface invariant covers it.

Account types are published from `PACKAGES` rather than typed into the page.
`ENTERPRISE` is marked **not self-serve** rather than hidden — hiding it would
make the pricing page a lie about what the product offers — and the route
schema refuses it, because a package provisioned with an agreement should not
be reachable from a form. An unlimited allowance stays `null` and is rendered
as "Unlimited"; zero would read as "none".

**The public site: twelve pages and a landing page.** Server-rendered, unlike
the console. These are read by people deciding whether to trust the product, by
crawlers and by link previews — all of which see markup, not the script that
would have produced it. Nothing loads from another origin: no stock imagery, no
font CDN, no analytics tag. Every visual is CSS or inline SVG, so the first
paint cannot be blocked and the reader is not watched.

Every figure on the site is read from the product — route count, both event
catalogues, package definitions. A landing page is the easiest place for a
number to drift into fiction because nobody tests prose, so these are not
prose. The blog carries the real engineering notes from this work, including
the defects; the contact page has no form, because a form posting into a queue
nobody wired up is worse than an address.

Two defects found by loading the pages in a real browser, neither of which any
markup test would have caught:

- **Every marketing page rendered unstyled.** `sendHtml` served one CSP —
  `default-src 'none'` — written for the self-contained unsubscribe page, so
  the stylesheet, the favicon and the script were all blocked. There are two
  policies now: the unsubscribe page keeps the tight one, and the site gets
  `style-src 'self'; script-src 'self'` with **no** `unsafe-inline` — the
  mobile-menu handler moved to `/site.js` precisely so none is needed. The
  landing page was also writing its own headers with no CSP at all and now goes
  through the same helper.
- **The primary call to action had invisible text.** `.prose a` at specificity
  (0,1,1) beat `.btn` at (0,1,0), so the button rendered orange-on-orange.

**Communication Event Architecture.** One engine, **177 events across 15
categories**, fanning out over email, in-app, SMS, push and WhatsApp.
`backend/src/notifications/catalogue.ts` is a closed catalogue for the same
reason the Golden Thread's is: a notification firable from anywhere with an
arbitrary string is one nobody can audit, suppress or translate. Channels are a
property of the event, so a caller may narrow the routing and can never widen
it — no code path can quietly start sending SMS.

It is **not** the Golden Thread catalogue and shares nothing but a shape.
`eventTypes.ts` records what happened to a project and is evidence; this records
what the platform told somebody, and is a delivery obligation. Conflating them
would put marketing into a legal record and statutory notices into a mailing
list.

**Twenty-seven notices are mandatory and ignore preferences by construction.**
Account locked, password changed by another party, payment failed, compliance
breach, data deletion. `allows()` answers `true` for them before it reads
anything the recipient has said, and it *says* `MANDATORY` rather than merely
behaving that way — a screen that cannot tell "allowed because they want it"
from "allowed because they cannot refuse it" will render a live mute control for
a notice that ignores it. A mandatory email also carries no unsubscribe link and
states why, because an unsubscribe that cannot work is worse than none.

**Nothing reports a delivery it did not make.** Email is `SENT` only when a
server accepted it. Email with no relay configured, and SMS, push and WhatsApp
which have no provider at all, come back `RECORDED` — dispatched, not
transmitted — which the console shows as "logged". A muted channel is
`SUPPRESSED` and recorded rather than dropped, so "why did they not get it" has
an answer instead of an absence. WhatsApp is declared, carries zero events and
has no carrier; the test asserts the zero so the day something routes there,
somebody has to confirm a carrier exists.

Verified end to end against the running gateway: with billing muted on email,
`invoice.paid` came back `SUPPRESSED` and `invoice.overdue` was still delivered.

Building it found a **cross-tenant leak in the read path**. All tenancies share
the reserved `platform-notifications` chain — that is what makes it a platform
chain — so the deliveries feed, which read it by project id, returned every
other customer's notification history including the addresses in it. Reads are
scoped by tenant now. The capability area was wrong too:
`PLATFORM_ADMINISTRATION` is the operator's area, so the tenant administrator
who actually needs their own delivery log was locked out of it while the
operator was not. It is `ENTERPRISE_STRUCTURE`, and `tenantContext` already bars
operators from customer delivery data.

**The unauthenticated console login, closed.** `POST /v1/console/session` was
`public: true` with no production gate. It seeded a demonstration project and
returned a working access token for `pm@meridian.example` to any anonymous
caller — a PM identity, no credential, no MFA, to anyone who could reach the
origin. Demonstrated against a running server before it was closed: the token
authenticated subsequent requests and was stopped only by the role check on the
particular command tried next.

Its sibling `/v1/console/identities` already carried the gate, which is what
made this the dangerous kind of hole — the pattern looked handled. Nothing in
the frontend called the route at all; the console signs in through
`/v1/auth/login` and `/v1/auth/mfa/verify` like any other client.

Writing the test found a second problem. `config.env` is a snapshot taken at
module load, so a production gate reading it could not be exercised in-process
at all — the gate was correct in a real deployment and unverifiable everywhere
else, including the two that already existed. `isProduction()` reads the
environment fresh; the three request-time gates use it, and the boot-time
configuration warnings keep the snapshot. Verified both ways: in-process, and
against a server actually started with `NODE_ENV=production`, where both demo
routes answer 403 and the MFA challenge code is withheld.

The invariant is now stated rather than implied: **no public route may return
an access token in production**, with the two that complete an authentication
exempted by name, so a new public route handing out a token has to be added to
that list deliberately.

**Three deployables, one repository.** `backend/` is the service, `frontend/` is
the browser application, `shared/` is the vocabulary both read. They were always
separate — the frontend never imported a backend module and never could, because
one is TypeScript run by Node and the other is ES modules run by a browser — but
the layout said `src/` and `web/`, which reads as "the code" and "the website"
rather than as two things that ship independently.

The frontend is a **sibling** of the backend, not a subdirectory of it. That one
process serves both from one origin is a deployment choice, held in a single
constant in `backend/src/api/gateway.ts`; putting the frontend behind a CDN
later is a deployment change, not a rewrite.

Two tests were holding a path relative to the working directory rather than to
themselves — the catalogue invariant scanned `'src'` and the static-asset suite
resolved `'../web'`. Both passed only because `npm test` happened to run from
the repository root, and both broke on the move. They are anchored to their own
module now, so they answer the same way from any cwd, which is what a CI step
with its own working directory needs.

**Golden Thread.** Append-only hash-chained ledger. Canonical serialisation,
SHA-256, constrained RFC 6902 patches ordered remove→add→replace, closed event
catalogue, evidence requirements, AI-authorship rules. Deterministic replay with
per-event verification and a project state root hash. Tamper is detected.

**Seven engines with real arithmetic.** CPM forward/backward pass with float and
PERT probability. Earned value with three EAC scenarios. CVR with margin
erosion. S-curve cashflow. Deterministic bid scoring with penalty flags. Risk
expected value and P80 contingency. Delay attribution with concurrency. Statutory
payment cycle dates. Reliability-adjusted maintenance forecasting.

**Payment cycle, end to end.** Application → certification → payment notice →
settlement. The applicant cannot certify; the payer posts the payment. Refuses
over-certification, double certification and overpayment. Withheld sums carry a
reason.

**The Construction Act.** The statute that decides who gets paid what, and it
does not turn on who was right about the work. If the payer gives no payment
notice and no pay less notice, the sum applied for becomes the notified sum and
is payable in full however optimistic the application was. `constructionAct.ts`
computes that position rather than describing it: which notice established the
notified sum, what a missed or invalid one has already cost in money, whether
the right to suspend is open, and what has to be served next.

Building it found the hole. `PAY_LESS_NOTICE_ISSUED` was in the catalogue and
`noticePosition` read the records, but **no command could emit one** — the
platform told a payer the notice was overdue and gave them no way to give it,
which left "pay in full" as the only advice it could ever offer. The command now
exists and enforces the two requirements that decide whether a notice is worth
anything: it must state the sum considered due **and the basis of calculation**,
because a bare figure has repeatedly been held insufficient, and it cannot exceed
the notified sum, because a notice paying more is not a pay less notice. A late
notice is still recorded, and recorded as ineffective — refusing to write it
would destroy the evidence of what was said and when.

Two boundaries are deliberate. **Statutory periods are counted in days, not
business days**, because the Act says days and a court reads days, so the
deadline never moves; the UK bank holiday calendar (computed, including Easter,
the weekend substitution rules and the three jurisdictions' different days)
answers the separate question of *service*, and the position reports a serve-by
date labelled as what it is. And **no rate is invented**: statutory interest runs
at base rate plus 8%, the base rate is a fact about the outside world this
platform is not connected to, so the entitlement is stated and the amount is not.

Contract terms are assessed against the Act with the distinction that matters —
a term the Act makes **void** is replaced by the Scheme whether anybody noticed
or not, so a contractor who priced for a payment period the Act strikes out has
priced for a cost he does not carry; a term that is merely **onerous** is lawful
and stays his problem. The morning briefing carries the crystallised exposure,
because nobody can serve last month's notice.

**Statutory adjudication, s.108.** The twenty-eight-day dispute procedure every
UK construction contract must contain, and which the Scheme supplies where the
contract does not. The timetable is what is held, because both ends of it are
fatal in different directions and neither is about the merits: seven days from
the notice to secure an appointment and serve the referral, twenty-eight from
referral to a decision. Miss the first and the appointment is liable to be a
nullity; miss the second and the decision is, and the parties are back where
they started having paid the fees.

Extension mechanics are precise because they are relied on late: fourteen days
on the referring party's consent alone, longer only by both parties, and consent
given before the referral is no consent under s.108(2)(e). A decision reached in
time binds *until* the dispute is finally determined — temporarily binding is
still binding. s.108A holds a Tolent clause ineffective, which is worth saying
plainly because the fear of that clause is what keeps disputes unreferred. A
late referral and an out-of-time decision are recorded rather than refused;
refusing the record leaves a party with nothing in front of them at the moment
they decide whether to pay against it.

Not to be confused with tender adjudication, which is the commercial decision
closing a bid evaluation. They share a word and nothing else, and the code says
so where the two meet.

**s.116 and short periods.** The exception to "the statute counts days": a
period of **less than seven days** excludes Christmas Day, Good Friday and bank
holidays — but not weekends. It turns on the length of the period rather than on
which period it is, which is what made it easy to miss, and the Scheme's
five-day payment notice period falls inside it. The platform was adding five
calendar days, which produces a deadline earlier than the statute allows and
would have told a payee they were entitled to the notified sum while the payer
was still in time. `reckonPeriod` is now the only place a statutory period is
decided. Its exclusion set is deliberately wider than the business-day calendar:
s.116(3) counts Saturdays, so Boxing Day falling on one has to be excluded
explicitly or the deadline comes out a day early.

**Lineage over the ledger.** `GET /v1/projects/:id/lineage/:refType/:refId`
answers what caused a record and what was built on it, by walking the event log.
No graph store — that would be a second copy of a relationship the ledger
already records, and the two would disagree the first time either was rebuilt.

Edges carry how they were established: `EVIDENCE` and `AI_INPUT` were declared
by an event and name it, `SAME_COMMAND` shares a correlation id, `REFERENCE` was
read out of a record's state and carries the field that produced it. They are
not equally strong and are not presented as though they were.

Access is applied at every node, not at the entry point — the walk crosses
capability areas by its nature. An unreadable record returns as a shell: type
and edge, nothing else. Reference edges are derived only from state the caller
may read, or the shape of the graph would leak it. Two limits are reported
rather than applied quietly: depth (and the walk checks whether anything lies
beyond the ceiling rather than assuming it), and a command touching more than
eight records, which is treated as a batch — a take-off creating forty bill
items made all forty siblings of each other and produced 5,736 links on the
first run.

**The specification, read for what it requires.** `SPECIFICATION_INGESTED` and
`SPEC_CLAUSE_EXTRACTED` were in the catalogue with nothing able to emit them.
The specification decides whether work is acceptable and nobody reads it until
there is an argument; the clauses that cost money are not the ones describing a
material — those get priced — but the ones imposing a step before or during the
work: a sample to be approved, a test to be passed, a hold point nobody may
build through.

Classification is deterministic, from the words the clause uses, so the same
text gives the same answer twice and anybody can see why a clause was read as it
was. Order matters — a clause saying both "inspected" and "shall not be covered"
is a hold point, and reading it as a test loses the fact that work stops. The
imperative counts as mandatory, because NBS-style specifications write
obligations as instructions and treating *Submit the mix design* as advisory
would let most of a specification through as optional.

The join is the point. `specificationCoverage` matches verification clauses
against ITP acceptance criteria — the field the plan template already asks for —
and reports what has no inspection stage against it. That gap is invisible to
both sides: the quality manager reads the ITP, the engineer reads the
specification, and it exists only between the two. Where an acceptance criterion
is written as prose the report says uncovered rather than guessing, and the bare
clause number only matches where the criterion names no other section —
specifications number 3.4 in every section they have, and matching on the number
alone reported a dozen sections as covered by one plan.

Reads supplied text, on the same terms as contract clause extraction. OCR is not
built and a scanned specification cannot be read here; the record says
`source: 'SUPPLIED_TEXT'` so nobody relying on it has to guess.

**Master pricing — tender stage six.** Both routes converge and the sum that
goes out is assembled. `assignScheduleRoute` had said "both routes converge
again at master pricing" since it was written, and nothing did.

Which figure counts is decided by the route, never by which number is larger or
more recent: a package sent to the market is carried at what a supplier agreed
to do the work for, even where an in-house estimate exists — that estimate was
the budget the enquiry was measured against, and carrying it would put a price
in the bid nobody has agreed to.

The arithmetic is trivial and the findings are the point. Scope priced by
nobody — routed to the market with nothing awarded, or never routed at all — is
the expensive one: it is invisible in a spreadsheet that sums what is there, it
goes out at zero, and it is built at the contractor's cost. Provisional sums
inside an awarded price are separated from firm price without being double
counted. Exclusions are listed as items to confirm rather than checked, because
checking whether an exclusion is priced elsewhere means reading two documents
and the platform has read neither. Where both routes produced a number the gap
is reported and not resolved, because which one goes in the bid is a commercial
decision.

A package with no pricing schedule at all is included, which a consolidation
reading only schedules would miss entirely.

**PDF, written by hand.** The format an adjudicator, an insurer or a court asks
for, and the one the exporter could not produce. "Print the web page" is not an
answer when the document carries a content hash: a browser's print pipeline
re-flows the content, so what was hashed and what was printed are not the same
artefact.

`backend/src/export/pdf.ts` writes the file directly — objects, content streams, and the
byte-offset cross-reference table that is the only part a reader is strict
about. Text uses the standard 14 fonts, which every reader has and none of which
need embedding; that is what makes it possible with no dependency, and it is
also why Adobe's published AFM widths are present as data. Without real widths
lines break in the wrong place and text runs off the page, and an approximation
is not good enough for a document going to a court.

Headings, paragraphs, key-value pairs, lists and tables lay out on A4. Pages
break where the content runs out of room and table headers repeat across the
break. Every page carries the client's name, the document reference, the page
number against the total and the content hash — a page separated from an
evidence bundle should still say what it belongs to. Em dashes, curly quotes and
currency symbols are mapped to WinAnsi rather than mangled; a character with no
representation becomes a visible question mark rather than being dropped
silently, because a sentence that reads correctly and says something different
is worse.

`POST /v1/projects/:id/exports/report.pdf` returns the file itself under the
document's own reference, through a `binary` route flag — base64 in a JSON
envelope is not a file a browser saves with the right name. Building it found
that the report was putting **raw minor units** in front of an adjudicator:
"1793000000" reads as a hundred times the truth to anybody who does not know the
convention. Money is now formatted in the project's own currency, not the
platform default.

What this does not do is typeset. No hyphenation, no kerning, no widow control,
no vector graphics. That is stated rather than implied.

**Registers that close.** Clashes, site observations and the scope breakdown
could previously only grow. Clash closeout records how, and for a model revision
which discipline moved — that is who bears the rework, and it is what nobody can
establish six months later. Dismissing a critical clash as a detection artefact
costs an explanation proportionate to what is being waved through; closing on
site is recorded as leaving the model describing something that was not built.
Site walk observations are deterministic and free, deliberately separate from
safety observations, and refuse an action with no owner and no date. Work
packages can be typed in rather than only generated, and carry their origin: a
generated package is a proposal, a typed one is a decision.

**Governance changes are recorded, and billing is authorised.** Two holes of
the kind that only shows up when somebody looks.

A person's roles were whatever they were created with, forever — the only way to
change them was to suspend the identity and issue another, losing the link
between the person and everything they had already authored. `assignRoles`
changes them under three separation-of-duties rules: nobody changes their own
(self-elevation is the first thing an insider tries), a delivery identity never
receives an operator role, and a reason is required because an auditor asks
about a role change a year later when nobody remembers. Seats are re-priced on
the change, so a move the tier cannot carry is refused and the identity keeps
what it had.

The billing routes enforced **nothing**. The matrix had the answer
(`BILLING_ACU`, update reserved to the enterprise administrator and the asset
owner), the console asked it before drawing the buttons, and the API never did:
any authenticated identity in a tenant could top the wallet up, move the AI
spend caps or issue an invoice. All five routes now authorise, and the console
gate on "issue invoice" was corrected upward to match the server rather than the
other way round.

Moving a spend cap is recorded under `ACU_CAPS_SET`, against the person who
moved it, with the previous ceiling and a required reason. A cap is a governance
decision rather than an accounting fact, so it belongs on the thread; spend
itself stays in the ACU ledger alone, because two answers to "what was spent"
is worse than one.

**Access control.** Three account layers, RBAC, OAuth2-style scopes, ABAC, in a
fixed fail-closed order. Tenant isolation. Lifecycle phase gating on writes.
Data-sensitivity redaction. Regulator read-only with export. Supplier
confinement. Separation of duties enforced, not advised. Every entity type
declares its capability area and sensitivity, and the audit feed withholds the
patch for records the caller cannot read while keeping the envelope.

Proven over real HTTP rather than by calling handlers: `tests/api.test.ts`
stands the gateway up on a socket and pins the public-route list, the
operator/delivery separation, the tenant filter on the generic entity read, and
the problem+json contract. A route becoming public by accident is a one-word
edit, so the list is asserted rather than trusted.

**Gateway observability.** Monotonic counters (`requests_total`,
`auth_failures_total`, `authz_denies_total`, `rate_limited_total`,
`validation_reject_total`), a fixed-bucket latency histogram per route, and a
security audit stream separate from the request log. Counters are held in
`backend/src/api/telemetry.ts` and are never derived from the bounded log buffer — the
metrics that preceded them were, and so fell as traffic rose, which is the one
direction a request counter must never move. Latency groups by route pattern,
not path, so an id does not fragment a series. Every request record carries the
mandatory fields: route, outcome, authentication result, authorisation decision,
rate-limit key and remaining budget, correlation and trace ids. Audit events
record reason categories only — no token, no credential, no policy attribute
value — and remote addresses are truncated to /24 or /48, enough to see one
source hammering a login and not enough to be a record of who was where.
Published at `/v1/admin/logs` and `/v1/admin/security`, platform-admin only.

**ACU economics.** Route → reserve → execute → persist → debit. Prepaid only,
hard caps, alerts, per-engine attribution. No provider call on an empty wallet;
no charge without a ledger write. `tests/ai.test.ts` proves each of those with a
stub provider that counts its own calls: failover, the empty-wallet refusal
before the request goes out, and a released hold when the provider throws.

**Cost shown before the action runs.** The commercial model states one rule
about the interface — *no AI action runs without showing its estimated ACU cost
first* — and the platform now keeps it. `POST /v1/ai/quote` takes the request
the browser is about to send (`{method, path}`) and answers what it would cost.
Nothing is written, no provider is contacted, and the caller is authorised for
AI execution on that project first, so nobody is shown the price of something
they would then be refused.

The estimate is **measured, not modelled**. The real charge scales with the
payload an engine assembles, and that payload does not exist until the command
runs — twelve of the twenty-two AI commands register evidence before they reach
a provider, so there is no dry run that leaves nothing behind. Instead
`ACUWallet.observedRawCosts(engine, taskType)` reads what this account has
actually settled for that action and the quote reports the median at today's
multiplier, with the observed range. Raw costs are kept and repriced rather than
billed amounts reused, because the volume incentive moves the multiplier.

Where an action has never run on the account there is nothing to measure, and
the quote says so: basis `FLOOR`, which the console words as the provider's
floor rather than a prediction. Presenting a floor as a forecast would be the
exact deception the rule exists to prevent.

Quotability is declared on the route (`ai: { engine, taskType, capability }`),
next to the handler that calls the engine, so the browser needs no vocabulary of
its own and a new AI route without a declaration is caught by
`tests/quote.test.ts`. A refusal comes back as facts as well as prose
(`blockedBy: 'BALANCE' | 'CAP'`, `capBreach`), so the console can say "this
would take this month's AI budget past its £50.00 cap" instead of repeating a
log line written in minor units.

In the console: `confirmCost()` for the six AI buttons that post directly, and
`aiCost: true` on the three command panels that reach a provider — the panel
holds its submit shut until the price is on screen. `POST /v1/ai/quote` is the
first route marked `readOnly`, so it answers 200 rather than 201; a POST that
creates nothing has no resource to point at.

**Localisation, and the minor-unit bug underneath it.** *Money is in minor units
everywhere* is a settled decision and a correct one. What was missing is that a
minor unit is not always a hundredth: a yen has none and a dinar has three. The
platform divided by 100 in five places, so a JPY figure would have displayed a
hundred times too small — an order of magnitude, not a rounding difference, and
it would have reached a client before anybody noticed. For a platform aimed at
governments, DFIs and global EPCs that is a defect rather than a limitation.

`backend/src/domain/locale.ts` is the single place the platform knows how to count
money. An unknown currency is refused rather than defaulted to two digits,
because the silent default is exactly how the figure goes wrong. Formatting uses
the runtime's own `Intl` data, so a French reader gets a comma decimal and a
space separator without a dependency or a symbol table — there were four copies
of a three-entry table that called every other currency a dollar, and they are
one function now.

Language comes from `Accept-Language`, resolved and validated at the gateway
rather than in a handler: the header is client-supplied and reaches a formatter
that would throw on a bad tag. Geolocation is deliberately not used — it asks
where somebody is standing to answer what language they read, and is wrong for
every expatriate engineer on a project.

**A project's money stays in the project's currency.** A JCT contract in
sterling is not a dollar contract, and converting it for display would invent
precision the record does not have; only the platform's own USD-priced charges
are ever converted. **And no exchange rate is invented**: a rate is used where
one has been supplied, and its source and date travel with the result. An
inverse is the same fact read backwards and is used; a cross-rate through a
third currency is not, because two rates struck at different moments multiplied
together is a number nobody published. Where no rate is held the figure appears
in its own currency with the reason.

Tax rules are held per jurisdiction for **display** — what a figure is labelled
and what an invoice must say — not to compute a liability, which turns on
registration and place of supply. The UK domestic reverse charge shows nothing
collected and says why, including the part that bites: the tax is not received,
so it is not cash the business holds until its return. Where a jurisdiction has
no national rate to publish, as with US sales tax, none is published.

**Commercial packaging.** Eight role-priced seats, three packages, three ACU
bundles. The operator and the regulator consume no seat.

**What a trial does not include.** The commercial line is the whole product
minus the thing you would take to a client: a trial governs, records and
computes, and no document leaves. That was specified and unenforced — every
export succeeded regardless of package.

The gate is a property of the package rather than a rule in the exporter, so
there is one place to read what a plan includes, and it is checked at the top of
each export *and* again where the document is built. The early check makes the
message useful — a trial account asking for a report is told it is not on the
plan rather than that the project was not found or a logo needs configuring
first — and the later one means a new export method inherits the gate without
anybody remembering to add it. A tenancy with no subscription on record is
refused: a failed lookup must not open the gate.

Two roles are exempt, and the second is the one that matters. The platform
operator is not a customer and has no package to be limited by. And a
**regulator's** export is an access the asset owner is obliged to provide —
refusing it because the contractor has not paid would be the platform enforcing
a commercial term against a statutory right, which is not a trade-off it gets to
make.

The interface treats it as a plan limit rather than a fault, because "export
failed" sends somebody to their administrator to fix a permission that is
working correctly. The billing screen states what the package covers, which it
did not before — refusing on plan grounds with no screen saying what the plan
includes is a dead end.

**Application.** Nineteen screens against live endpoints, including Autopilot — the queue where a person approves or declines what the agents propose. Role-aware navigation
resolved from the API's permission matrix and phase gates, so the interface
refuses for the reason the platform would. Command surfaces on field, cost,
design, programme, change and handover. Daily site diary. Canonical enum
dropdowns. Evidence hashed with SHA-256 in the browser. Denials are shown as
denials, never as empty records.

**The catalogue is checked against what the platform can do.** An event type in
the closed catalogue with nothing able to emit it is a specific and dangerous
hole: it reads as capability from every direction — the catalogue lists it,
entity access classifies it, the control standard can require evidence of it —
and no command in the platform can ever produce one. It had been found by hand
three times: a snag that could be raised and never closed, a pay less notice the
platform called overdue while offering no way to give one, and a daily diary the
control standard demanded of every project and reported missing forever.

Finding it a fourth time by hand is not a plan, so `tests/catalogue.test.ts`
scans every source file for what is actually emitted and fails on any event that
is neither emitted nor named in a list with the reason it is not. It found
twenty-three. Three were real capability and are now built; the rest are named
with their reason, and every line of that list is a debt. The test also fails on
a stale excuse — an entry claiming something is missing when it is not — because
a list that overstates the gaps stops being read.

**The daily site diary.** The record delay and disruption claims are decided on,
and the one the control standard called "the contemporaneous record no delay
claim survives without" while having no way to write it.

Three rules, each because the diary is evidence rather than administration. It
**cannot be dated ahead** — a record of what happened, written before it happens,
is a plan wearing a diary's clothes. It **states when it was written**, and marks
an entry made days later as what it is, because a diary compiled from memory
three weeks on carries a fraction of the weight and every adjudicator asks; a
platform that presented one as contemporaneous would be handing over a weaker
exhibit than its owner believed. And **weather is required even when it was
fine**, because weather is the commonest ground for an extension of time and a
diary with weather only on the bad days proves nothing about the good ones.

A second entry for the same day is refused unless it names the entry it replaces
and why. Supersession is derived from that reference rather than stamped on the
original: the superseded entry stays readable in full, because somebody may have
acted on it. `diaryPosition` reads the register as an exhibit rather than a list
— the working days with no entry and the entries written long after the fact,
which are the two things the other side looks for first and neither of which is
visible reading it a day at a time. Weekends are not counted as gaps.

**The obligations calendar.** Two kinds of contractual obligation, and the
distinction decides how each is managed. A **reactive** one has no date until
something happens — a compensation event occurs and a notice period starts
running — and is lost by not noticing. A **dated** one exists from the day the
contract is signed: insurance renewal, bond expiry, the end of the defects
liability period, retention release. Nothing triggers it and nobody is watching
for it, which is exactly why it gets missed.

The platform held the first kind and not the second. It could tell you a notice
was late; it could not tell you the bond expired last month. Obligations could
also only be created by clause extraction, so the list of what a contract
requires was whatever a model happened to find in the text.

Dates are **derived from terms already recorded** rather than asked for again —
the defects liability period ends a known number of months after a known
completion date, and retention releases in two halves around it, the second long
after everybody has left the job. Deriving is not inventing: every derived entry
names the contract term behind it, and where a term was never recorded no entry
appears. A recurring obligation rolls forward to its next occurrence and says so,
rather than sitting overdue forever or implying the earlier ones were met.

The two lists are kept apart, because one mixing "renew the policy by March" with
"serve within 14 days of an event that has not happened" is unusable. Time bars
are read from the delay events themselves, which record whether a notice was
served, and only where the event carried an entitlement — a contractor-risk
delay has no notice worth serving, and reporting it as a missed one is crying
wolf. A missed time bar is marked **lost**, distinct from a late renewal that can
still be put right; without that distinction the recoverable items absorb the
attention.

**Do the records agree?** Every module in the platform is individually correct
and none of them looks at the others, which is where the expensive mistakes
live. The programme computes a duration, the contract records a completion date,
the estimate prices a scope and the field record measures progress — and a
programme that finishes after the contract date is liquidated damages, a number
computable from two facts already on record, that nobody sees because the
planner is reading a critical path and the commercial manager is reading a
contract.

Six checks: contract against programme (priced in damages at the contractual
rate, **capped where the contract caps it**, because the exposure is what is
payable rather than the arithmetic before the cap applies), slippage the network
was never told about, schedule against progress, estimate against contract sum,
duplicate activity codes, and commitments against budget.

Three rules keep it from becoming noise. **Every finding carries the money or
the days** — "programme inconsistent with contract" is a shrug, "143 days past
the contract date, £35,750 in damages" is a decision. **Every finding names both
records it came from**, so it can be checked rather than believed. And **a check
that cannot run is reported as not run**, never as passed: a project with no
contract has not passed the contract check, it has not taken it.

The report reads only, because a disagreement between two records is a question
for a person rather than a fact to write down. Where the reader has no
commercial clearance the disagreements still show and the figures do not — the
same decision the audit feed makes, keeping the envelope and withholding the
content, because a safety lead should know the programme is past its contract
date and has no business knowing what it costs.

On the seeded project it finds 44 days of delay that has already happened and
was never fed back into the network: five activities finished late, so nothing
flags them as overrunning, and the programme still holds their original
durations.

**Monte Carlo completion, and the two errors it corrects.** The platform
published a P80 duration computed the textbook way — sum the variance of the
activities on the deterministic critical path, read the normal quantile — and
that method is wrong in two directions, both from treating "the critical path"
as a single fixed chain.

It **understates** where a near-critical path can overtake: the path is only
critical for the durations you assumed, and finishing by a date needs every path
to make it. It **overstates** where several paths are critical at once, summing
the variance of activities that run alongside each other as though they ran in
series — the demonstration being that adding a duplicate parallel path leaves
the project finishing on the same day while moving the published figure by a
fortnight. A forecast that shifts when the schedule did not is not a forecast.

The simulation resamples every activity and recomputes the critical path from
scratch each run. Two decisions are deliberate: the generator is **seeded from
the project id**, because an unreproducible forecast cannot be checked against
the platform that produced it, and durations are sampled from a **triangular**
distribution, which claims no more than three numbers from a planner support.

The difference is **reported rather than swapped in**, and split into its
causes rather than blamed on one: how much is skew — the analytic figure centres
on the sum of *most likely* durations while a right-skewed estimate expects more
than its mode — and how much is everything else. On the seeded project the
analytic P80 is 43 days optimistic, about 20 of them skew. Naming merge bias as
the cause on a serial chain would have been a guess dressed as an explanation.

It also produces the output PERT cannot: the **criticality index**, the share of
runs in which each activity was critical. An activity with float today and a
high index is a risk the deterministic path never shows.

Building it found a defect in shared code. `calculateCPM` marked an activity
critical on `totalFloat <= 0`, an exact float comparison — and float is a
difference of sums, so on non-integer durations a genuinely critical activity
comes out at 3e-14 and silently drops off the path. Integer programmes were
unaffected, which is why it had never shown; a 2.5-day activity is ordinary, and
the simulation samples fractional durations by design. Compared against a
tolerance now.

**Lookahead planning and Percent Plan Complete.** `LOOKAHEAD_PUBLISHED` and
`CONSTRAINT_RAISED` both had nothing emitting them, which meant the delay-risk
model read open constraints from a log nothing could write to and always found
zero. It had been reporting a risk driver it could never observe.

This is Last Planner rather than a rolling bar chart, and the difference is the
promise: a lookahead lists what *could* be done, a commitment is a named person
saying they *will* do a specific thing by a specific date. **Work that is still
constrained cannot be committed to** — promising blocked work is the commonest
reason PPC collapses — though it can and should sit in the lookahead, which is
what a lookahead is for. A commitment with no name against it is refused as a
wish.

PPC gives no partial credit: a promise 90% done counts as not kept, because a
measure that gave credit would report a comfortable number for a team that
finishes nothing. Reasons for non-completion come from a fixed list, since free
text produces a hundred variants of "waiting on the designer" and the entire
value is being able to count them — the reason that recurs is the one worth
fixing, and no single week shows it. The trend weights by promises rather than
averaging weekly percentages, so a week with two commitments does not count as
much as a week with thirty. A project with no reviewed week reports no PPC
rather than 0%, which would read as a team keeping no promises rather than one
that has not started.

Two events were added to the catalogue to close it honestly: `CONSTRAINT_CLOSED`,
because a log that can only grow is a list and the time taken to clear one is
the measure that matters, and `LOOKAHEAD_REVIEWED`, because the reason a promise
broke cannot be derived from progress — a task at 60% and a task nobody started
both fail, for different reasons leading to different fixes.

**The variation control matrix.** One change, both sides of it. Change is where
money leaves a construction contract quietly, and it leaves in exactly two
directions: a subcontractor's claim the business will pay and never charged on,
and a price agreed with the client before anybody knew what the packages would
cost — which reads as a win on the day and as an unexplained margin drop at
final account. Neither is visible from either register alone.

Two more dead events closed getting there. `VARIATION_VALUED` had nothing
emitting it because the instruction carried a figure and everybody treated that
as the valuation; they are different acts, usually months apart, and the gap
between them is where a main contractor finds out what its subcontractors
actually charged. `CHANGE_REQUEST_REJECTED` had nothing emitting it either, so a
change could be submitted, assessed and simply left — and at final account every
undecided line is argued as though it were live.

**An upstream valuation is refused while the downstream cost it names is
uncaptured.** If the change names affected subcontract packages and not one has
priced it, agreeing with the client means agreeing without knowing your own
cost, and the guess is always low because the claim has not arrived yet. Once
agreed there is no route back. A change naming no subcontracts is self-delivered
and valued without objection.

The two sides are matched on **the change, never on the package**. Two changes
can hit one subcontract — a wall-thickness variation and a dewatering claim are
not each other's downstream cost — and matching loosely would report a
reconciliation that never happened. A false all-clear is worse than a false
alarm, because nobody rechecks it.

Instructing a variation now closes its change request, which it did not: the
request stayed `ASSESSED` forever, so a change could be instructed and then
refused, and the register could not tell an open position from a decided one.

**Answering an RFI, and rescoring a risk.** Two more registers that could only be
added to. An RFI could be raised from a drawing markup and never closed, so the
register could not show which questions held the job up — the exhibit a
design-delay claim is built from. The answer now records the drawing revision it
was given against, alongside the revision the question was asked on, because
answering against a revision the site no longer holds is how an answer becomes a
dispute and it is invisible unless both ends are on the record.

A risk could be registered and never revised. That is not cosmetic: the P80
contingency in every tender and every cost report is computed from these scores,
so a register frozen at the day it was written prices the job against risks as
they were understood before anybody had been on site — precise-looking and
stale. A rescore requires the reason, because a score that moves without one is
an opinion, and the whole value of a register is being able to ask later why the
exposure moved the month before the tender went in.

**Agent runtime — autopilot with a human gate.** Twelve agents across four
divisions, each with a mandate naming what it may read, what it may propose in,
and which roles may decide. The divisions are the answer to "who is watching
what": *market intelligence* (what work is out there), *bid engine* (should we
chase it, at what price, can we fund it), *delivery engine* (are the jobs we
have going wrong, and how early can we tell), and *supply chain* (can we still
buy what we sell). Eight of them are one per engine. They run over materialised
state, raise findings that name the records they were read from, and propose the
command they want run. Then they stop.

Three rules hold the runtime: an agent never writes project state; an agent
cannot propose outside its mandate, checked by the runtime rather than by the
agent; and an agent cannot decide. Approval needs both the capability the
command exercises *and* standing as a nominated approver — reading is not
authorising. The event catalogue refuses an AI actor authoring an approval, so
the guard holds even if the runtime one were bypassed. Approved commands run as
the approving human through the same engine path any manual command takes. A
rejection needs a reason and stays in the record. Repeat findings are suppressed
rather than raised again.

The four watchers added for the front end — radar, pipeline, supply chain and
HSEQ — are observation-only, because none of them can fix what they see. The
radar notices a shortlisted opportunity running out of days, and a requirement
that disqualified the business more than once in a single run. The pipeline
notices an opportunity scored and left, which is worse than one never looked at
because the qualifying is already paid for. Supply chain watches prequalification
and framework expiry, the quiet failure found out on the day an enquiry was
needed. HSEQ watches the duties that are law rather than preference — an
unapproved Construction Phase Plan, an unanswered RIDDOR question, a lapsed
competency — and raises them as urgent whatever else is on the list.

**The morning briefing.** The only screen that answers a question no other one
asks: *what should I do today?* Everything else answers a question about one
subject; a person running a contracting business has a morning and a list of
things that will cost money if nobody touches them. It reads across the whole
tenant, states figures rather than moods, orders by urgency then by value, gives
every action a record it can be checked against, and says plainly when there is
nothing to do.

There is no model anywhere in that path — the one screen somebody acts on before
coffee is arithmetic. Where the platform does not hold a number it stays silent
rather than reporting a confident zero: the payment cycle holds statutory dates
rather than applied sums, so the briefing gives the date and no figure. Building
it caught four fields being read under names the engines do not write — a delay
forecast reading zero on a project forecasting fifty days, and £1.4m of margin
erosion invisible because the cost report holds it as a percentage.

**Weekly newsletter.** A role-targeted issue about what the platform does,
composed from the real feature set and linking only to screens that exist — a
test fails if a link resolves to no page. Consent is a ledger record rather than
a flag, so what a person decided and through which route survives. Unsubscribe
links are HMAC-signed, work without signing in, and are refused when forged; the
GET only ever shows the confirmation, so a mail scanner prefetching links cannot
unsubscribe anybody. One-click unsubscribe (RFC 8058) is honoured.

Campaigns are keyed by ISO week, so a scheduler firing twice, a restart inside
the send window and an operator pressing the button all resolve to one issue.
Delivery is recorded per recipient with what actually happened: a message
composed but not transmitted is `RECORDED`, never `SENT`. SMTP is spoken
directly over `node:net`/`node:tls` — verified in the suite against a real
socket, including STARTTLS refusal and dot-stuffing.

**Installable application with a launch screen.** Web app manifest, generated
icon set (standard and maskable), twelve exactly-sized iOS launch images, and an
in-document splash that paints before `app.js` parses so the handover from the
operating system's own launch screen is invisible. One background colour is
asserted across the manifest, the `theme-color` meta and the CSS, because a
mismatch shows as a flash.

The service worker exists to make the application installable, which is what
makes a launch screen appear at all. **It never touches `/v1/`** — caching an
authorised response would put one identity's project data outside the platform's
access control and serve it to whoever opens the app on that device next.
Offline field work is the sync protocol's job, not a cache's. Shell only,
network-first for navigation, verified by test and in a browser.

Regenerate the assets with `node tools/icons.mjs` after any brand change. The
PNG encoder is in that file: `node:zlib` is built in, so it was shorter than the
argument for a dependency.

**One platform, sole trader to multi-billion.** The same operating system runs a
sole trader fitting a £3,000 bathroom and a joint venture delivering a £2bn
programme. That is not a matter of hiding features — it is a matter of no
threshold in the platform being an absolute money figure, because an absolute
threshold is always wrong at one end.

`backend/src/lifecycle/scale.ts` is the single place the platform decides how big
something is: five project bands from under £25k to over £250m, six organisation
bands from a sole trader under £250k to a Tier 1 over £500m, and the
proportionality rules that follow. Everything else derives from it. The
organisation bands used to start at "under £5m", which treated a £40k business
as a rounding error; they now start where the real users do.

Three things scale from it. **The control standard** marks each of its 36 items
with the smallest project it is proportionate on — a £3,000 repair is measured
against 6 items and a £2bn programme against all 36, and an item below the line
is `NOT_PROPORTIONATE` rather than missing. **The cost model** marks each of its
20 heads the same way, so a bathroom is not told it has omitted commissioning
and temporary works; 13 heads simply do not apply, and the one real omission is
not buried under them. **Quote counts and supplier scrutiny** follow the size of
what is being bought: one quote for a skip, three for a package that matters.

The part that only a ratio can express is the last one. A £400k package is
routine for a £30m contractor and a bet-the-company decision for a £600k one —
same package, different conversation about payment terms and bonding — so
scrutiny rises with exposure to turnover regardless of the absolute figure.
Exposure is annualised where the duration is known, because a £2bn programme
over five years is £400m a year rather than 222% of one year's revenue.

A project whose value nobody recorded is measured against the whole standard.
Quietly excusing items on a job that might be enormous is the more dangerous
failure.

**The corporate project control standard.** Every project runs through the same
four stages — preconstruction, mobilisation, delivery, completion — and the same
36 items, evaluated continuously against the ledger rather than only at a phase
transition. This is deliberately not the phase gate: a gate is a small hard stop
enforced fail-closed on the write path, and this is the wider question of what a
project should have in place right now given where it is. A project can legally
reach handover having kept no site diary; it should not be able to do so
quietly. The standard cross-references which of its items a gate really enforces
rather than restating the rule, so `phases.ts` remains the only thing enforcing.

Four statuses, and the distinctions between them are the whole design. An item
**not yet due** is not a failure — a project in design is not failing for having
no site diary. An item the platform **cannot evidence** is reported as
`NOT_TRACKED` with the reason, never as present and never as missing: claiming
it is satisfied would be a lie, and calling it missing would blame the project
for the platform's gap. Completeness is measured over what is due *and*
trackable, so the figure means something. Six items are currently untracked and
named as such: surveys, procurement schedule, site setup, project insurance,
technical submittals and final account.

`estateControl` runs the same standard over every project at once, which is the
reason for having one standard at all. A project manager can see their own gaps;
only this view shows that the same item is missing on most of the estate, which
is a statement about how the business runs jobs rather than about one job.

**Corporate memory.** Lessons are captured on the project that produced them and
read across the whole business, because a lesson only pays for itself on a
different job. Two rules keep the register from becoming what lessons-learned
workshops usually produce: a lesson must carry a recommendation somebody on the
next job could act on — "communication could have been better" is refused — and
it must name what it cost in money or days. The library reports what recurs
*across projects*, since one job getting ground conditions wrong is bad luck and
the same category on four jobs is a business problem no project team was ever in
a position to see. A library drawing on a single project says so rather than
presenting one job's experience as corporate knowledge.

**The contractor's delivery chain.** Business development → estimating →
preconstruction → contract → project management → commercial → HSEQ →
subcontract procurement → programme → quality → handover, walked end to end by
`tests/chain.test.ts`.

*Business development* was entirely absent — the platform began at a project
that already existed. Opportunities are now registered, scored, and decided by a
person. A converted project carries its opportunity id, so a variation argued
about in year three traces back to the decision to chase the job at all.

**Tender radar.** The value is not in finding more opportunities — it is in not
reading the ones that were never winnable, which is where most of a small
contractor's bid time goes. Notices are screened against a recorded company
profile: turnover, net assets, working capital, regions, sectors, CPV codes,
value band, insurance limits, accreditations, verified references, self-delivered
trades, target margin and spare delivery capacity.

Mandatory requirements fail outright rather than costing points, because a
turnover threshold or a missing accreditation makes an opportunity unwinnable
however attractive it is. **The radar never asserts a capability the profile
does not record**, and an unverified reference is never counted as one — that
is the claim a bid gets disqualified for. Where there is a real route round a
gap it says so: partner the package and offer named personnel experience where
the ITT permits, or ask whether the buyer accepts an equivalent accreditation.

It does not score. There is one scoring model, and a radar with its own would be
a second opinion that quietly disagrees, so it produces *suggested* factor
scores from evidence and hands them to `qualify()`. Two factors a portal notice
cannot answer — client attractiveness and cash-flow risk — are left neutral for
a person rather than guessed. The margin target moves with the competition
against the company's own band rather than being invented.

The batch run keeps every assessment, not just the shortlist, because "why did
we not bid that one" is asked months later. It also names the requirement that
keeps disqualifying the business: failing the same accreditation on four notices
is a decision about the company, not about any one bid, and only the batch view
can see it. Nothing is registered as an opportunity automatically — the radar
decides what is worth reading, a person decides what is worth chasing.

**The bid/no-bid algorithm.** Ten factors weighted to 100 — relevant experience
15, client attractiveness 10, contract size 10, geography 10, supply-chain
capacity 10, competition 10, margin opportunity 15, cash-flow risk 10, strategic
value 5, win probability 5 — each scored 1–5, against published thresholds:
**below 55 no bid, 55–70 director review, above 70 bid**. The rule lives in one
constant and is served to the interface, so there is no second copy to disagree
with it.

Three things make it work rather than merely exist. Every factor carries an
explicit anchor for what 5 means and what 1 means, because two of the ten are
named as risks and a scorer reading "cash-flow risk: 5" as "very risky" inverts
the algorithm on the factors where being wrong costs most. The scale runs 20 to
100, not 0 to 100 — ten factors at 1/5 still return a fifth of every weight, and
a threshold set as though it could reach zero would never fire. And a single
factor at 1/5 holds the job at a director's desk however well the average
scored: a weighted average hides one catastrophic factor behind nine comfortable
ones, and a trade with nobody on the register is a fact rather than a deduction.

Supply-chain capacity is the one factor the platform can answer from evidence
instead of memory: `supplyChainEvidence` reads the register for the trades the
job needs and reports how many are covered three-deep. It suggests and does not
set — the register knows the count, not whether those firms want the job.

**Refusing bad work is measured, not just permitted.** An algorithm nobody
declines against is a form, so `bidDiscipline` reports the no-bid rate as the
headline figure, names every decision taken against the score with who took it
and how it turned out, and — the part that matters most — reports each band
against actual outcomes. If jobs above 70 do not convert better than jobs pushed
through from the review band, the weights are wrong, and an algorithm nobody
checks against outcomes is a slower way of having the same opinion. A pipeline
where nothing has been refused is told so in those terms.

*Estimating* priced eight heads and derived preliminaries from a percentage of
works. It now prices **twenty**: direct works, subcontract, materials, plant,
preliminaries, site management, temporary works, insurance, design,
professional fees, testing, commissioning, waste, logistics, health and safety,
quality, contingency, inflation, overhead and profit.

The heads are not the point — the basis each one is priced on is. Time-related
costs take a weekly rate and a duration, so a programme that moves re-prices the
tender; as a percentage of works they do not, and eight weeks of overrun is
eight weeks of unrecovered site staff. The percentage survives as a benchmark
output, never as an input, and `repriceEstimate` answers what the tender becomes
on a different programme without writing anything, because a what-if is not a
commercial position. Contingency is drawn from the quantified risk register at
P80 rather than being a round number. Inflation is taken to the mid-point of
exposed spend after the base date and never applied to a firm-price subcontract
sum. Insurance is a percentage of the value it actually insures, so it is
computed after risk and inflation, not alongside the fees. Overhead is on cost
and profit is on cost plus overhead.

A head with nothing against it comes back as an **omission**, not as zero — a
tender with nothing priced against waste is not a job with no waste in it. It
must be priced or excluded in writing, and the exclusion becomes tender wording.

**The ITT analyst.** Two outputs, and the second is the one that saves money.
The compliance matrix is ordinary: every requirement with an owner, the evidence
it needs, whether the platform can already prove it, and when it is due. Small
contractors lose bids they priced correctly because one certificate was missing
from the upload, and an owner against every line is the cheapest fix there is. A
requirement the platform cannot probe is `UNKNOWN` rather than a gap — marking
it a gap would bury the real ones under everything nobody automated.

The commercial terms are the half that decides whether the job is worth winning,
and each is assessed against this business rather than transcribed. Liquidated
damages are set against the margin, not reported as a rate. A performance bond
is bonding capacity taken from the next bid as well as this one. Retention is
cash the business funds, not a discount. Three terms end companies and none are
visible in the price: **fitness for purpose**, which almost every professional
indemnity policy excludes, so the obligation sits uninsured; **uncapped
liquidated damages** on a programme the contractor does not control; and a
**parent company guarantee** demanded of a business with no parent, which is a
bar to entry rather than a term to negotiate.

**The cost intelligence database.** It does not invent prices — it organises the
ones the business has already paid, quoted or been quoted, and reports what they
actually say, including when they do not say enough.

It is a projection rather than a store: every rate is read from records already
committed, so nothing is entered twice and nothing can drift. A rate cannot
exist here that was not part of a commercial position somebody signed off.

**A package price is never converted into a unit rate.** A subcontract covers
dozens of measured items and there is no honest way to apportion it back to a
rate per cubic metre; doing so is how a cost database fills with numbers that
look precise and mean nothing. Unit rates come from estimate lines, package
outturns from the market, and the two are kept apart.

Every figure carries what is behind it — the count, the spread and the age of
the newest observation — and confidence is stated rather than implied. A single
observation is called a data point, not a benchmark. Benchmarking an estimate
excludes that estimate's own lines from the median it is compared against;
without that a line is measured against its own reflection and the benchmark
agrees with everything. And the output only accumulation can give: how far this
contractor's estimates sit from what the market returns, which is a fact about
the business rather than about construction.

**Never bid without a cash model.** A contract can cover its cost, carry a
healthy margin, and still take more working capital than the business has — and
the estimate, which is a statement about cost, will not say so. The peak funding
requirement is a different question from the margin and it is the one that
closes companies.

The cost profile is read from the priced estimate rather than typed again, so
the cash model cannot drift from the price, and the heads are regrouped by *how
each is paid*: labour weekly whatever the client does, materials on supplier
terms with a deposit in front, packages on subcontract terms. That mismatch
against the certificate cycle is the funding requirement. Retention is modelled
as cash withheld and returned in two halves — the second long after the defects
period — rather than as a deduction from the price. VAT flows in the direction
it actually flows: under the domestic reverse charge there is no VAT on the sale
to fund the job, while input VAT is still paid out and reclaimed at the return,
which made construction working capital materially harder.

The output is a weekly series, the peak and the week it falls, and a verdict
against available working capital — fundable, tight (over 80% of the cash
committed, which is a bet rather than a plan) or unfundable. Refusing is only
half an answer, so each remedy is priced rather than listed: what an advance
payment, shorter certification, lower retention or longer subcontract terms
would actually be worth, best first.

*The automatic tender response* prices a client enquiry, drafts the
qualifications, exclusions, tender queries and covering letter, and computes
whether the bid is fit to submit. The division of labour is the platform's usual
one: every number comes from the cost model and the model only writes the words.
It refuses to call a bid submittable while a cost head is unpriced, while the
enquiry itself is missing something a bidder needs to price against, or while
the build-up carries no profit — and a gap in the enquiry becomes a question to
the client rather than an assumption the contractor silently absorbs.

*Quality* had three catalogue events and no command able to emit any of them: a
snag could be raised and never closed. There is now an inspection and test plan
with enforced hold points — the platform refuses to release work past a stage
the ITP says must stop — inspections that raise a non-conformance in the same
breath as a failure, and NCR closure with a disposition somebody owns.

*HSEQ* could not record that anyone had been hurt. Incidents now escalate on
category, the RIDDOR question must be answered either way, and training carries
an expiry, because a lapsed competency reads the same as one nobody held.

*The supply chain register* collects Companies House identity, VAT, UTR and CIS
status, insurance, H&S and quality accreditation, RAMS capability, competence
cards, training, references, financial standing, geographic coverage, turnover,
package capacity, day rates, labour availability and plant — and classifies each
firm **Strategic / Approved / Conditional / Do Not Use**.

Three things make it more than a form. **Scrutiny is proportionate**: a £15k
package asks for identity, insurance, tax status and safety, and nothing else;
a £900k package asks for three years of turnover, net assets, a credit
reference and a reviewed RAMS sample. Demanding audited accounts from a
two-person firm for a small package is not diligence, it is an obstacle that
pushes good small firms away. **Strategic is earned on delivery** — three
completed packages with no dispute and 85%+ on time — because anybody can
assemble a good-looking pack. And **bars, missing information and conditions
are reported separately**: "we have not seen your accounts" is a different
conversation from "your insurance has expired".

The rules that bite: a lapsed employers' liability policy, a dissolved company
or an unresolved HSE prohibition notice is a bar, not a deduction; a package
worth more than 40% of last year's turnover raises a condition, because one
job should not be a firm's survival; an unverified reference is a claim; and a
day rate quoted over a year ago is re-confirmed rather than trusted.

*Subcontract procurement* could send an enquiry to anybody at all —
`invitedSupplierIds` was free text. It now runs off a prequalified register of
80+ trades. An expired employers' liability policy is a bar rather than a
deduction; life-safety trades require third-party accreditation; approval
expires; suspension is immediate; and nobody is invited beyond their assessed
package capacity. The enquiry is refused whole rather than quietly dropping the
ineligible, because an RFQ that went to four of the six you selected produces a
comparison you cannot trust.

*Framework agreements* turn the register into standing relationships. The size
is arithmetic rather than a round number: the trades the business actually buys
given what it builds, times enough firms per trade to run a three-quote enquiry
and survive one dropping out, times a concurrency demand — no subcontractor can
hold packages on twenty of your sites at once — divided by the overlap between
trades a real register has, and capped at the relationships a business that size
can genuinely maintain. A £12m residential and refurbishment contractor lands on
70 firms; a £3m fit-out business on 30; a Tier 1 on the low hundreds. The
composition is deliberate too: local SMEs, accredited specialists and large
contractors do different jobs on a framework.

Admission uses the same prequalification gate as an enquiry, because a framework
place is worth more than one package and must not be the weaker route in.
Call-off applies the framework's own rule — rotation orders by fewest awards
then least value, a direct award above the lot's ceiling escalates to a
competition automatically, and a member suspended or lapsed drops out of the
call-off without being expelled. The position report names what is wrong rather
than scoring it: lots too thin to produce a competitive enquiry, a firm above
the concentration limit, members admitted and never used, and how long is left
before re-tendering has to start.

**CDM 2015 and the Principal Contractor's duties.** Twelve document types —
Construction Phase Plan, RAMS, COSHH, temporary works, lifting, working at
height, fire, emergency arrangements, environmental controls, work equipment,
induction, toolbox talk — each declaring the sections it is not valid without.

Drafts are composed from real project state: the description, the significant
risks and the site conditions come from the ledger, which is what makes a
document project-specific rather than a template with a name merged in. A
section the platform cannot fill truthfully is **named as a gap, never
invented** — a fabricated control measure is worse than a blank one, because
somebody will read it and believe it.

The duties are enforced as gates rather than described:

- No construction-phase work, and no induction, without an **approved**
  Construction Phase Plan.
- No approval while a required section is unfilled.
- The signing role is fixed per document type: a lifting plan is signed by the
  constructor, not the safety adviser.
- An agent may draft; **the catalogue refuses an AI actor authoring any safety
  approval.** `RAMS_APPROVED` previously permitted one — a method statement
  signed by a model is not a competent person's signature, and that is now
  closed.

The Principal Contractor position reports **named breaches rather than a
percentage**: a score invites somebody to report 87% compliant, a list of
failures does not.

**Offline field sync.** Device timestamps preserved, operation-id idempotency,
deterministic conflict resolution, monotonic cursors, governance actions refused
from devices.

**Branded exports.** Refuse without branding. Audience-based redaction. Recorded
as Golden Thread events. A document stamped "commercial detail withheld" is now
tested to contain no figures anywhere — including the risk table, which used to
carry priced exposure into a redacted copy.

**Sector, on a taxonomy the engines can use.** The nine ONS
construction-output categories — Residential, Commercial, Industrial,
Transport, Utilities, Energy, FM, RMI, Professional — declared once in
`shared/vocabulary.js`. It replaced `BUILDING | INFRASTRUCTURE | SPECIALISED`,
three values that could not carry a distinction the platform is repeatedly
asked to make: sector selects templates, weights risk, picks the contract form
and keys the cost library, and a water treatment works and a residential block
behaved identically under one label.

The picker the browser renders and the enum the route schema validates against
are **the same bytes**, not two lists that agree. `CONTRACT_FORM` is surfaced
from the claims engine's own `ContractSuite` for the same reason — a picker
offering a form the engine has no clauses for would produce notices against
clauses that do not exist.

Records written under the old vocabulary keep their codes, because the ledger is
append-only and that is the correct behaviour. `LEGACY_SECTOR` translates them
on read. It is not a migration to be run and deleted; it is how a seven-year
statutory record stays legible after the vocabulary that produced it was
replaced.

**Both HTML responses carry the policy layer.** The application shell used to
write its own response head, which made it the one page on the server with no
content-security-policy, no frame refusal and no `nosniff`. A console whose
buttons certify payments and approve baselines must not be framable. Found by
reading the headers of a running server, not by a test — no test asked. Inbound
`x-trace-id` is now validated before it is echoed back and written into every
log line; a value carrying a header separator used to turn the request into a
500 from `writeHead`.

---

## What is partial

Implemented in a form that works, with a stated part missing. The missing part is
named so it is not mistaken for finished.

| Area | Built | Missing |
|---|---|---|
| Take-off | Governs, evidences and prices measured items, traced to sheet and revision | Quantities are supplied by the caller, not read from a drawing |
| Drawing register | Title-block structuring from supplied text, supersession, markup→RFI | OCR from the image |
| Model ingestion | Records the model, hash, discipline, LOD, element count as a governed event | IFC parsing, geometry hash, model diffing |
| Digital twin | Reconciles observed against expected element status | Observations are structured input, not derived from imagery |
| Evidence capture | Real SHA-256 over the real file, recorded against the event | No object store for the file itself |
| Clause extraction | From supplied text | OCR and table extraction |
| 4D scheduling | Twin states link to task ids | No visualisation |
| Newsletter delivery | SMTP submission verified against a socket, per-recipient outcomes recorded | No bounce processing or suppression list; DKIM belongs at the relay, where the key should live |

---

## What is not built

Specified in the source documents, deliberately absent, and **not to be claimed
as present**. Most of it is perception and ingestion infrastructure — real ML and
parsing work, not wiring.

- **File ingestion pipeline** — presigned upload, virus scan, MIME validation, ML
  file classifier with confidence, OCR, table extraction, vector embedding,
  `FILE_EXTRACTED`
- **Vision pipeline** — progress estimation, PPE compliance, equipment
  recognition, defect detection, `PROGRESS_EXTRACTED_FROM_IMAGES`
- **Audio and communication intelligence** — transcription, commitment and
  deadline extraction, `COMMITMENT_REGISTERED`, `DEADLINE_TRACKED`
- **Guided project creation form** with canonical enums (projects are created
  through the API)
- **Deployment topology** — Terraform, Kong, MSK, RDS, S3
- **Native Android and iOS clients** — the sync protocol and `ANDROID`/`IOS`
  event sources are built and tested server-side
- **External data feeds** — commodity pricing, weather, credit reference
- **Postgres, RLS and horizontal scale** — the ledger is durable now (an
  append-only journal on a volume, verified on restore), but one process owns
  the file. Two containers writing to one volume would interleave events and
  break the chain, so scaling out needs the Postgres design rather than another
  replica. Point-in-time recovery is limited to the backup interval, and there
  is no automatic failover
- **Log shipping, metrics store and alerting** — structured JSON goes to stdout
  and counters are exposed; nothing collects them

---

## Decisions already made — do not revisit

Re-opening these is what caused churn before.

1. **No property-deal marketplace.** Revenue engines, Buy Box, Funding Box and
   DEAL EQUITY belong to a different product. Explicitly excluded by the user.
2. **Zero runtime dependencies.** Node 22 native type stripping. Dev
   dependencies are `typescript` and `@types/node` only.
3. **No frontend framework and no build step.** Plain ES modules, tagged-template
   HTML escaping by default.
4. **The package, not the seat sum, is charged.** Legacy tiers remain and map to
   packages so existing contracts resolve.
5. **Money is in minor units everywhere.** No floating point in the billing
   path. One ACU is one minor unit, so £1 buys 100 ACUs. Provider cost is
   charged at 4x. **The company takes at least 100% profit on every AI
   transaction** — the multiplier floor is derived from that rule, not
   configured beside it. 20% of every subscription payment is credited as AI
   allowance. No AI work runs without available ACUs.

   The 4x is confirmed and deliberate. Several specification documents state
   3x; the instruction given directly, and reaffirmed when queried, is 4x. It
   is one value, `ACU_MARKUP_MULTIPLIER`, and every test fixture derives its
   arithmetic from it, so the suite follows whichever number is set.
6. **The interface never holds a rule the API does not publish.** Permission
   matrix and phase gates are fetched, not duplicated.
7. **A denial is displayed as a denial.** Never as zero, never as empty.
8. **No agent acts unattended.** Every mandate caps at `PROPOSE`. The `ACT`
   level exists in the model but granting it to an agent is a product decision
   that must be made explicitly; a test fails if one grants it to itself.
9. **Screenshots are gitignored.** Regenerate with
   `node tools/walk.mjs "<role>" "" shots` (`WALK_BASE` overrides the origin).
10. **The newsletter carries no project data.** It is role-targeted, not
    data-personalised. An email leaves the platform's access controls behind
    the moment it is sent, so it contains capability descriptions and links —
    never figures, never commercial or safety content.
11. **The newsletter sender is off by default.** `NEWSLETTER_ENABLED=false`
    everywhere until an operator arms it in one environment deliberately.

---

## Working notes

- The seeded demo project sits in the **Operations** phase, so field-execution
  and tender writes are correctly phase-gated. This is not a bug; commands show
  as locked with that reason.
- `tender.analyseReturns` had no route and was therefore unreachable over HTTP —
  a working engine command with no way to call it, found while tagging every AI
  route for quoting. It is now `POST /v1/projects/:projectId/tender/returns`.
  The same sweep found that a project id supplied in the quote body was never
  validated against the tenant, because nothing else in that handler reads the
  project; it now requires the project to exist and to be the caller's, and
  answers "no such project" either way rather than distinguishing the two.
- One server instance is enough. `PORT=8123 node backend/src/main.ts`. Seed with
  `POST /v1/console/identities`. Restarting reseeds and changes all ids.
- The browser tools need `playwright-core`, which is deliberately **not** a
  project dependency — dev dependencies are TypeScript and `@types/node` only.
  Both tools now say so and print the install line rather than failing with a
  module-not-found stack.
- The go-to-market plan lives in `docs/go-to-market/`, generated by
  `tools/gtm/`. It quotes the platform's own pricing, so it is kept in the
  repository rather than beside it.
- A project id that does not exist, and one belonging to another tenancy, both
  answer `200` with an empty list on the generic entity read. That is
  deliberate: a `404` for unknown and a `403` for forbidden would together tell
  a caller which project ids exist. Tested, so nobody "fixes" it.
- `tools/walk.mjs` verifies every page renders for a role. `tools/inputs.mjs`
  counts command surfaces per page.
- `tools/walk.mjs` used to take ~30s per page: `locator.textContent()` auto-waits
  and only rejects at the 30s default, so probing for an error notice that was
  legitimately absent cost the full timeout on every healthy page. It reads
  through `count()` now. A full walk is well under a minute.
- The newsletter's weekly timer polls hourly rather than computing a delay, so
  a restart cannot skip a send. Week-keyed campaigns make the polling safe.
- With no `SMTP_HOST`, the Newsletter screen states plainly that nothing is
  being transmitted. That is the configured state in development, not a fault.
