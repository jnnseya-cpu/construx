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
| Tests | 3,931 passing, 0 failing, 0 skipped, across 176 files · plus 18 against a live Postgres 16 |
| Typecheck | clean |
| Backend | 214 TypeScript files, 132,384 lines |
| Application | 70 ES modules, 26,634 lines (including a service worker) |
| API routes | 763 — 521 writes, 242 reads (26 of them public) |
| Event types | 518 Golden Thread (closed) · 180 communication events (closed) |
| Entity types | 241, all classified for access |
| Agents | 57 across 9 divisions — 48 deployed, 9 declared with what each is waiting on |
| Runtime dependencies | none — verified by booting with no `node_modules` present |
| Layout | `backend/` · `frontend/` · `shared/` · `deploy/` |

Run: `npm test`, `npm run typecheck`, `npm start` (landing at `/`, app at `/app`).

### The AI-OS blueprint

`docs/AI-OS.html` is the current, expanded blueprint for the platform as an AI
operating system: forensic review of what is measured above, the agent workforce
and its mandate ladder, the self-managing platform layer, the security command
centre, the data intelligence layer, the BitriPay payment gateway, the connector
ecosystem, the commercial model, schema, API surface and a phased roadmap.

Every claim in it carries a status — **Built** (runs and is tested), **Partial**
(the core runs and the gap is named), **Spec** (designed there, not implemented).
It adds; it removes nothing. Where it and this file disagree about what exists,
**this file wins** — it is the source of truth for state, the blueprint is the
source of intent.

`docs/ai-os-blueprint.md` is the earlier markdown draft of the same argument,
kept for its section-by-section reasoning. Its counts predate the work recorded
below; take figures from this file.

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
3. **Provider cost is charged at 5×.** Revenue 5, cost 1 — every £1 the
   platform spends with a provider produces £5.
4. **20% of every subscription payment is credited as AI allowance.** Credited
   at activation and again when each period is invoiced, once per period —
   invoices get corrected and reissued, and each reissue handing out another
   month of AI would be free money. Rounded down, because a fraction of an ACU
   cannot be spent.

The rule under all of them: **the company takes at least 100% profit on every
AI transaction** — 400%, which is the price: £1 of provider cost produces £5.
`minimumProfitPercent` states it, and the multiplier floor is *derived* from it
(`1 + pct/100 = 5×`) rather than configured beside it, so the rule and the
arithmetic cannot drift apart.

**The floor is set at the price, by decision.** The rule is that £1 of provider
cost produces £5 with no exceptions — no band, no bundle, no cap that could make
it less — so `minimumProfitPercent` is 400 and `minimumMultiplier()` is 5.

The consequence was raised before it was made and is recorded here rather than
left to be discovered. `settle` capped an execution that overran its estimate at
the amount reserved and disclosed, *unless* honouring the cap would sell below
the floor. With the floor at the price, `floor === billed` on every settlement,
so **the cap is inert**: a run that costs more than its estimate is charged for
what it cost, and the customer pays more than they were quoted.

That exposure is handled by disclosure rather than by a silent discount. An
overrun is named on the ledger entry — what was quoted, what it cost, what was
charged — carried into the invoice line, and visible in the operator's realised
multiplier. `billing.test.ts` and `economics.test.ts` both assert the note,
because with the cap gone it is the only thing standing between a customer and a
surprise.

The arithmetic in `settle` is left in its `max(min(billed, held), floor)` shape
rather than simplified to `billed`: the shape is what shows a cap exists and
what the floor does to it, and lowering the floor restores the cap without a
code change.

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

`docs/GOING-LIVE.md` is the one-time path the runbook assumes has already been
walked: choosing a host, pointing a domain, obtaining a certificate and creating
the first account. It exists because three things about this deployment are
routinely assumed to be otherwise. There is no separate front end to host — one
process serves the site, the console and the API from one origin. There is no
second instance — two containers on one volume interleave their writes and break
the chain. And a fresh deployment has nobody who can sign in, so the first
account comes through the public signup, which emails a confirmation link:
working SMTP is a prerequisite for having a user at all, not a feature to add
later.

It also answers the sizing question the topology invites, which turns on a fact
that surprises people: **a BIM model never lands on the volume.** `ingestModel`
records the file's hash, format, discipline, LOD and element count and an
optional `fileUri`, so a 1.5GB federated IFC costs a few hundred bytes and the
model stays in the common data environment that versions it. What fills a disk
is photographs — roughly 7GB per active project per month at capture size, about
1.8GB as actually stored now the console re-encodes them — so 100GB is about four
and a half years of one busy site, and it is evidence rather than models that
decides when the volume has to grow.

**A manual network attachment does not survive a deploy, and the symptom is a
502.** On a shared host the container reaches the existing proxy over a network
joined with `docker network connect`. That lasts exactly until the next
`compose up --build`: the container is recreated, the attachment is not part of
the compose definition, and the proxy answers 502 for a site that worked five
minutes earlier. `deploy/compose.edge.yaml` declares it instead — an external
network, because it belongs to the proxy that was on the host first and a
compose file claiming ownership could remove it on `down` while somebody else's
live site was still attached. `default` is listed alongside it explicitly: a
`networks:` key replaces the implicit default rather than adding to it, so
omitting it would silently cut the container off from its own project.

**The self-serve journey now has the two pages it was missing, and login has
stopped answering a question it was never asked.** The backend was built and
tested throughout; what did not exist was any way for a person to reach it. Both
gaps were found by trying to sign up on the live deployment and failing.

- **`/app/signup`** is a real form (`frontend/pages/signup.js`), reached without
  a session and drawn by `draw()` before the sign-in screen. The public site's
  pricing buttons have linked here since the pricing page was written; until now
  the shell drew sign-in instead, which asks for the credentials of the account
  the person is trying to create. Packages, currencies and jurisdictions come
  from `/v1/signup/account-types`, and `selfServe` decides what can be chosen —
  so a package that is sold rather than provisioned cannot be bought by editing
  the query string, and a price changed on the server changes here too. The
  receipt is shown in the endpoint's own words, because rewording it would leak
  what the endpoint is built not to say.
- **`GET /verify` and `POST /verify`** are the landing page the confirmation
  email has always pointed at. The GET renders a button and provisions nothing:
  the token is single-use, and corporate mail security fetches every link in an
  inbound message to scan it, so a GET that activated would be spent by a robot
  before its owner clicked. Both doors onto activation — this one and
  `POST /v1/signup/verify` — run the same `activateRegistration`. Failures are
  rendered as pages rather than problem+json, and name which of the four ways a
  link can fail happened, because each has a different next step.
- **`POST /v1/auth/login` no longer says whether an address has an account.** It
  answered `404 No user with that email address`, which made it an
  account-enumeration oracle on an unauthenticated endpoint: feed it a breach
  dump and it sorts the list into customers and strangers for free. Registration
  was written from the opposite premise — `identity/signup.ts` returns an
  identical receipt either way, precisely so nobody can ask — and login handed
  the answer to anyone. An unknown address now gets `decoyMfaResponse()`: the
  same shape, the same id format, nothing stored behind it, so the attempt fails
  with MFA_FAILED exactly as a wrong code on a real account does. No code is
  generated, so none can be guessed, and no mail is sent because there is nobody
  to send it to.

What this does not close: a decoy still costs less server time than a real
challenge, because a real one sends an email. That is a timing signal rather
than a status code, and narrowing it further would mean sending mail to nobody.

**Static assets revalidate rather than expiring.** `serveStatic` served modules
`public, max-age=300`, and that window cost a live deployment an afternoon:
`index.html` is `no-cache` and refetches, so a browser that had loaded the
console within five minutes of a deploy ran the **new** shell against the **old**
modules — a mixture that behaves like neither version, with nothing in the UI to
say so. The fixed sign-in screen was on the server and the browser kept drawing
the broken one, which reads as a failed deploy. Every asset now carries a weak
ETag over its content and `Cache-Control: no-cache`, which means "ask first", not
"do not store": the browser sends `If-None-Match` and gets a bodyless 304, so the
saving `max-age` was buying is kept and the window where a client can be silently
wrong is gone.

**A push to the tracked branch deploys itself.** `deploy/autodeploy.sh` runs on
the host from a systemd timer: fetch, and if the branch has moved, back up the
journal, fast-forward, build, bring it up and wait for `/readyz`. If the new
build never becomes ready it puts the previous commit back and rebuilds, then
exits non-zero so the unit shows as failed rather than reporting a rolled-back
deploy as a clean one.

It **pulls** rather than being pushed to, and that is the whole security
argument. No inbound port is opened and no machine outside the host holds a
credential that reaches the Docker socket. A GitHub Actions deploy would mean
storing an SSH key with root-equivalent access to a VPS that also hosts two
other people's live sites, available to anybody who can push to the repository
or compromise a third-party action. The cost is latency — a push is live within
a minute instead of instantly.

The rollback window is narrow on purpose, and the reason is the constraint in
`docs/RUNBOOK.md`: **the journal is forward-compatible and not
backward-compatible**, so an older image replaying a journal holding an event
type it does not know refuses to start. An automatic rollback is therefore only
safe while the new image has written nothing — which is exactly the window a
failed readiness check describes, because replay finishes before readiness and
appends no events. A failure *after* readiness is left to a person.

What it does not do: check that CI was green. It cannot — the repository is
private and the host holds no GitHub credential, deliberately. The boot check
catches anything that stops the container starting; a change that boots and
breaks a page will deploy, which is the same exposure as a manual deploy
arriving sooner.

**The installed application could never be updated.** The service worker's cache
key was the literal `construx-shell-v1`, and a browser installs a new worker
only when the bytes of `/sw.js` change. They never did, so the version never
changed, so `activate` never deleted anything: a device that installed the app
served the shell it downloaded that day, permanently. There was nothing to see —
the API stayed current underneath it, so no error, no warning, just a phone
running old JavaScript against the current platform. On a site, on the device
nobody can reach to clear.

`/sw.js` is now served through a route that substitutes a build id computed from
every file the browser can load (`backend/src/api/buildid.ts`; `frontend/shots/`
is excluded as 56MB of documentation nothing loads at runtime). Change a served
file and the id changes, the worker's bytes change, the browser installs it, and
`activate` deletes every cache that is not the new one. Change nothing and it is
byte-identical, so a redeploy of the same code does not evict a working cache.
The worker itself is `no-store`, because a cached worker is a device that cannot
be updated by any means.

Proven in a browser rather than reasoned about: install, change a stylesheet,
restart, relaunch — the old cache is deleted, the new one is present, and the
deployed CSS is what gets served. Before the change the last two failed and kept
failing.

**The wordmark is a link on every surface.** The public site header already had
one; the console sidebar, the sign-in screen, the signup form and the site footer
did not, so the one element a person expects to take them home did nothing on
four of five surfaces. Real anchors with real `href`s rather than click handlers,
so they can be middle-clicked and their destination seen before pressing.

**Nobody could sign in to a production deployment.** Found on the first real one,
minutes after it went live. Three things combined, and each looked innocent
alone.

The console offered *only* the demonstration identity picker — there was no
credential form at all. That picker reads `devCode` out of the login response,
which production deliberately withholds. And nothing ever **sent** the code: the
challenge was generated, held in memory, returned to nobody. `mfa.otp_code` had
been sitting in the notification catalogue since it was written, waiting for a
caller that did not exist.

So every credential could be correct and no human being could get in. The
visible symptom was the front door of a working platform reporting
*"Could not reach the platform: Demonstration identities are not available in
production"* — which reads as an outage and was the security gate working
exactly as designed. That is the worst kind of defect: two correct behaviours
producing an impossible state, with the error message pointing at neither.

Three fixes. `/v1/auth/login` sends the code through the ordinary notification
pipeline in production, so it is recorded, rendered and branded like every other
notice rather than becoming a second private mail path — email only, because the
catalogue also lists SMS and there is no SMS carrier in this build. The console
has a real two-step credential form, and the identity picker is now offered only
where the platform actually provides it: a refusal renders nothing rather than an
error, because on a real deployment that refusal is the expected answer.
`signInWithCredentials` establishes the session from the tenancy's own projects
rather than from `/v1/console/identities`, which is production-gated — the demo
path could not have established a session on a real deployment even holding a
valid token. A tenancy with no projects opens on the enterprise view, which is
where a project is created; that is a new account, not a broken one.

`backend/tests/signin.test.ts` runs in production mode against a fake SMTP
server and asserts the whole path: the code withheld from the response, sent to
the person, a token minted from it, that token authorising a real request, a
guessed code refused, and both demonstration routes still shut.

Also: the console wordmark rendered as "CONSTRU X". The flex container's
`gap: 11px` was applying *between* the text node and the `<span>` holding the
orange X, because they are two flex items — so the brand name had a gap in it
and could wrap mid-word. Wrapped in a single span.

**The SEO foundations, which were absent rather than weak.** Reported as "SEO
scores is not working". There is no SEO score in this platform and never was —
nothing named that exists anywhere in the codebase. What did turn up, on
searching for what a checker actually grades, were four real gaps:

- **No `robots.txt`.** Answered 404, which every audit tool reports as a fault.
- **No `sitemap.xml`.** The only pages a search engine would index are the ones
  something already links to from outside.
- **`twitter:card` promised `summary_large_image` with no image tag anywhere on
  the page.** Every share of every page rendered as a bare grey card — the worst
  of both, since the space is reserved and nothing fills it.
- **Canonical links were relative.** A canonical link is a statement about which
  URL is the real one, and a relative one resolves against whatever host served
  the page, which is exactly the ambiguity the tag exists to remove.

`backend/src/site/discovery.ts` derives both files from the same lists that
build the navigation and the route table, so a page cannot be published and left
out — the usual way a sitemap becomes a lie a search engine notices. `lastmod`
is claimed only for posts, because a sitemap that stamps today on everything
teaches a crawler the date means nothing. `/app`, `/v1/` and `/unsubscribe` are
disallowed; the last is the strongest of the three, since it is reached by a
signed token in an email and a crawler following one would unsubscribe a real
person.

Every page now carries an absolute canonical, `og:url`, `og:image` with
dimensions and alt text, and the matching Twitter tags. Posts additionally carry
`og:type: article`, `article:published_time` and `BlogPosting` structured data
with a publisher. The JSON-LD serialiser escapes `<` — a `</script>` inside a
JSON string would end the block early and hand the rest of the document to the
parser — and a test asserts it.

Verified against a running server with `PUBLIC_BASE_URL` set: eighteen checks
including both documents' content types, every sitemap URL absolute and https,
the console absent from it, valid parsed JSON-LD of the right type, and the
preview image actually resolving — a card pointing at a 404 is still a blank
card.

**Blog posts have addresses now, which is what "the view count isn't working"
turned out to mean.** There was no view count. There was also no post: `/blog`
rendered five engineering notes as cards with no links and no slugs, and **a
page with no URL cannot be counted by anything** — not a first-party counter,
not Google, not any tool that exists, because every one of them counts URLs.
Nothing was broken; nothing had been built.

Each post now has its own route, title, description, canonical link and body,
and the Google tag reports each as a distinct `page_path`. The bodies are
written from the work recorded in this file rather than invented — the pay less
notice with no command, the minor unit that is not always a hundredth, the
specification clause that was never in the specification, the hand-written PDF,
and the demonstration route that handed out a session.

They are registered separately from `SITE_PAGES`, because that list drives the
navigation and the footer and five engineering notes in a footer is not a
footer. One concrete route per post rather than a `:slug` pattern, which keeps
the "a page cannot be reached without existing" shape and lets an unknown slug
404 through the ordinary path.

Writing it forced a module split. `pages.ts` reads the route table to build the
developers page, so the route table reading the posts back through `pages.ts`
threw `Cannot access POST_PAGES before initialization` at import — a cycle, not
a typo. `backend/src/site/posts.ts` holds the data and imports nothing, which is
the same reason `SITE_PAGES` has always lived in `layout.ts`.

The public-surface tests failed on the five new routes, which is the guard
working: the API surface is listed by hand and marketing pages are derived, so
publishing a page is not a security edit. Posts are derived alongside them.

What is *not* built is a first-party counter. A public page view is a
measurement rather than a governed fact — the same reasoning that keeps storage
usage out of the ledger — and anonymous visitors must never be able to append to
a hash-chained record. If the numbers are ever wanted on the site itself, that
is a small counter file on the volume with bot filtering, deliberately not an
event.

**Marketing measurement: Meta Pixel and Google tag, on the public site only.**
`ANALYTICS_META_PIXEL_ID` and `ANALYTICS_GOOGLE_TAG_ID` in `backend/src/config.ts`,
both empty by default. With neither set the whole feature is inert — no script
served, no banner, and a content-security-policy character-for-character the one
that existed before it. That default matters: a tag that arms itself at boot
reports a developer's page views into a live ad account, which is the same
argument that keeps the newsletter sender off.

**The console is deliberately outside it, and a test proves it.** `/app` paths
carry tenant, project and entity identifiers, so a page view from inside the
console tells two advertising networks which projects a customer runs and how
fast they are moving. There is nothing to optimise there either — the conversion
was won at the door. `APP_SHELL` is a separate policy that the vendor hosts never
enter, `frontend/index.html` never loads the loader, and both are asserted
rather than assumed.

**Nothing loads before consent.** Both vendors set cookies that are not necessary
to provide the service, which under PECR means asking first rather than
reporting while the banner is still on screen. The banner is server-rendered and
`hidden` — one built by script never appears for the people most likely to care
— and both buttons are real. An event raised before the answer is *held* rather
than dropped, because somebody can click a package while the banner is up and
that is the step that matters most; it replays on accept and is discarded on
decline.

**The vendors' snippets are not used.** Both publish inline `<script>` blocks,
which here would mean `unsafe-inline` in `script-src` across every page — a real
protection traded for the convenience of pasting. `frontend/analytics.js` loads
them from this origin instead, and the markup carries only two identifiers on a
tag. Those identifiers are validated to the character sets the vendors actually
issue and dropped otherwise, rather than escaped: the honest answer to "this id
contains a quote" is that it is not an id.

Verified in a real browser against a running server with both ids set: fourteen
behaviours including nothing requested before a choice, an event held across the
banner, both vendors loading on accept, a decline remembered rather than
re-asked, zero policy violations, and the console loading no tracker *even with
consent granted*.

What this cannot do is stated rather than hidden: **a confirmed registration
cannot be attributed from the browser**, because confirmation happens inside the
console where no pixel runs. The click to the signup form is the last measurable
step. Closing that gap properly is server-to-server — Meta's Conversions API and
GA4's Measurement Protocol, fired from the same code that writes the activation
to the ledger, which is both more accurate than a browser and unaffected by ad
blockers. Not built.

**The domain is `construxvg.com`**, and the go-live document is written against
its real DNS rather than a placeholder. Three facts about that zone changed what
the steps say. Its nameservers are Hostinger's own parking pair, so the panel is
the right place to edit it. It already carries `A` and `AAAA` records pointing at
a parking page, which makes the cutover an edit rather than an addition — and
leaving the stale `AAAA` behind would send every visitor on a mobile connection
to the parking page while the site looked correct from a desk, which is the most
common way a cutover appears to half-work. And it already carries Hostinger `MX`
records and a matching SPF, which is why the recommendation for launch is to send
through that mailbox: it needs no new provider, no verification wait and no DNS
change at all.

That last point exposed a real trap. `NEWSLETTER_FROM_ADDRESS` is the from
address on **every** outbound email despite its name — `notifications/notify.ts`
uses it for the signup confirmation — and it defaults to `hello@construx.ai`,
which this deployment does not serve. Left alone, Hostinger would be asked to
send as a domain it does not carry, the confirmation would fail SPF at the
receiving end, and the symptom would not look like mail at all: it would look
like people registering and never appearing. `foreignSenderDomain` in
`config.ts` now compares the sender against the public origin and
`assertProductionSafety` warns at boot. It accepts a subdomain sender, because
that is how a transactional provider is normally set up and a warning people
learn to ignore is worse than no warning.

Writing it found `deploy/compose.yaml` setting neither `EVIDENCE_STORE_PATH` nor
`SIGNING_PRIVATE_KEY_PEM`, so following the shipped compose file produced a
deployment that recorded evidence hashes without holding the files and refused
every signature — both of which `assertProductionSafety` warns about at boot,
and neither of which anybody would have chosen. Both are now set, on the same
volume as the journal.

**A first real deployment found two more, and the second was the worse one.**
The compose file published `127.0.0.1:8080:8080` with the host side fixed, which
stops the container dead on any machine already running something on 8080 — and
the tempting fix, publishing on `0.0.0.0`, is the exact thing the comment beside
it warns against. The host side is now `${CONSTRUX_HOST_PORT:-8080}`: the port
inside the container never moves, the loopback binding never moves, and a
shared host is a variable rather than a patch.

The second was invisible. **Compose enumerated a dozen environment variables and
silently dropped the other thirty-eight**, so a deployment could set anything
`.env.example` documents, see no error, and get the built-in default. That
included `NEWSLETTER_FROM_ADDRESS` — the from address on every email, including
the signup confirmation, and the one the sender-domain check had just been
written to catch. The warning would fire correctly and the operator could not act
on it, because the variable had nowhere to go. It also swallowed
`ACU_MARKUP_MULTIPLIER`, `STORAGE_BLOCK_PRICE_MINOR` and
`FREE_TRIAL_GRANT_MINOR`: the commercial values this directive says must never be
hardcoded were, in the only environment that charges anybody.

The fix is `env_file`, not a longer list — `.dockerignore` excludes `.env` from
the image on purpose, so that is the only route it has. `environment:` now
carries only what belongs to the container rather than to the deployment: paths
inside the image, the port the process binds behind the published one, and the
`:?` guard on `GATEWAY_JWT_SECRET`. `backend/tests/deployment.test.ts` asserts
both directions — every documented variable stays settable, and every variable
compose fixes for itself is documented — and was checked by breaking the compose
file deliberately and watching it fail.

**And a VPS is rarely empty.** The one this was deployed to already ran two other
applications, with a proxy on 80 and 443 and a Node process on 8080. `GOING-LIVE`
now opens with the check for that and a co-existence path: move the host port,
add a site block to the proxy that is already there, skip the Caddy step
entirely. Stopping the incumbent proxy was never an option — it serves somebody
else's live site.

Verified by running the service exactly as the image does — production
environment, no `node_modules` present at all — which is also the strongest
available check that the zero-dependency decision still holds. The image itself
was **not** built here: this environment has the Docker CLI but no daemon. CI
builds it and boots it on every push.

That run found one more defect: **HEAD returned 404 on every path**, including
`/healthz`. Uptime monitors, load balancers and link checkers probe with HEAD,
and a platform whose health probe defaults to it would have read a healthy
service as a permanent outage. HEAD now routes as GET.

**Six ways to take money out of the platform, all closed.** A deliberate audit
of the money model rather than a defect report. Ordered by what an attacker
needed, and the first three needed nothing beyond an ordinary account.

1. **The top-up route was a mint.** `POST /v1/billing/top-up` credited the
   wallet with the `amountMinor` in the request body. No payment provider, no
   ceiling, callable by any tenant user holding `U` on `BILLING_ACU` — and the
   console shipped a button doing exactly that for £1,000 a press. Every ACU
   spent from that credit bought real provider compute with real money.

   Money now enters only against a receipt (`backend/src/billing/payments.ts`).
   A customer pressing "top up" records a `TopUpIntent`, which carries nothing;
   `Platform.creditFromPayment` is operator-only and is what a payment
   provider's webhook will call when one is wired, so a card settlement and a
   bank transfer leave the same record. **The payment reference is the
   idempotency key for money** — checked against every receipt ever recorded
   rather than a cache with a TTL, so a webhook firing twice credits once. A
   replay answers success, not an error, because a provider told its payment
   failed keeps retrying.

2. **The invoice route minted AI allowance.** Issuing an invoice credits that
   period's twenty per cent, and the route was tenant-callable with a
   client-supplied period. The wallet refuses a second allocation for the *same*
   period and nothing stopped a different one: a loop from 2020-01 to 2030-12
   minted 132 months of allowance. Issuing is now operator-only, the period must
   have happened and must not predate the subscription, and tenants read their
   position through a `GET` that allocates nothing.

3. **The idempotency cache leaked across tenancies.** It was keyed on the
   client-supplied header alone — no tenant, no actor, no route — and consulted
   *before* the handler, so it answered before any authorisation ran. Anybody
   replaying another caller's key received their cached response body. The
   console generates a UUID per request, which is why it never collided by
   accident. The key is now scoped to tenant, actor and route, and failures are
   no longer cached — a corrected retry under the same key would otherwise be
   served the old error for a day.

4. **Overruns were sold below cost.** `settle` capped the charge at the hold,
   and the hold is sized from an estimate that assumes output is a quarter of
   input. A request whose answer is much larger than its question — a short
   prompt against a schema demanding a long list — costs several times the
   estimate, and capping meant paying the provider more than the customer was
   charged. Repeatable by anybody who noticed. The cap now yields to the
   company's own profit floor: never below `minimumMultiplier` on the cost
   actually incurred, and the entry says so.

5. **Held storage was never billed.** Blocks could be bought and appeared on no
   invoice: real disk, recurring for as long as the data was kept, against no
   revenue. There is a `STORAGE` line now and it is in the payable total.

6. **AI was billed twice.** The wallet is prepaid — credit is bought before it
   is spent and an execution draws it down — and the invoice total was
   `subscription + aiUsage`, charging for that consumption again. Not a leak in
   the platform's favour: the kind of error that ends in chargebacks and an
   argument about every other figure on the page. AI usage stays on the invoice
   as a line, because a customer is entitled to see what their credit went on,
   and `aiUsageDrawnFromCredit` says why the lines exceed the total.

All six are exercised against a running server in `backend/tests/moneyleaks.test.ts`,
including the 132-period loop, which now refuses 132 times and credits nothing.

**What a tenancy may do when it stops paying.** `Subscription.status` carried
`ACTIVE | SUSPENDED | CANCELLED` and exactly one function read it —
`monthlySubscriptionCharge`, which returns zero when it is not ACTIVE. Every
other gate read `subscription.package`, which does not change when a
subscription ends. And nothing anywhere could *set* the status to either of the
two values meaning "stopped paying".

So a customer could stop paying and carry on: appending to the ledger, running
engines against a topped-up wallet, and buying more credit. Only the export gate
checked status, which made it worse rather than better — the same tenancy could
be refused a document and still write to the record it came from. Meanwhile the
platform kept carrying their storage and a thirty-year retention obligation.
That is not lost revenue; it is an unbounded permanent liability acquired at the
moment somebody stops paying.

`backend/src/billing/entitlement.ts` is now the single answer to what a tenancy
may do, and the principle it enforces is: **ACU credit buys AI. It does not buy
the platform.** Separate purchases, separately gated. Three gates on `status`,
all of them where the act happens rather than route by route:

- **No writes.** `write` and `registerEvidence` in `engines/context.ts` — the
  choke point every state change passes through. Evidence is gated as well as
  the event, because it is registered *first*, and leaving it open would let a
  read-only tenancy append evidence records no event ever references.
- **No AI, whatever the wallet holds.** Checked at the top of `runAI`, before
  authorisation and long before anything is reserved. Refusing after the
  reservation would still put a hold on a customer's credit for work that never
  ran.
- **No top-ups.** Taking the money would be worse than the loophole: the credit
  is unspendable, so the transaction is a charge for nothing.

Answered **402**, not 403. This is not "you are not allowed", it is "this
account owes money", and a client that cannot tell the two apart sends somebody
to the wrong support queue.

`platform.setSubscriptionStatus` is the mechanism, operator-only, with a
required reason recorded as evidence — this is the switch that turns off a
paying customer's platform, and "who decided, when, on what basis" is the first
question asked when it turns out to have been wrong. When a payment provider is
wired its webhook calls this rather than reaching into platform state, so a
dunning failure and an operator's decision leave the same record.

What deliberately keeps working: reads, so a billing failure does not hide the
evidence somebody needs to resolve it; a regulator's access, because refusing it
over a contractor's invoice would be this platform enforcing a commercial term
against a statutory right; and erasure, because a data-subject right cannot be
made billable. Each is pinned by its own test.

Two things found while building it. The platform operator **cannot hold an
engine context at all** — `platform.context` needs a wallet and the operator
tenancy has none — so operators cannot write to a customer's ledger through the
engines regardless of subscription. That is a stronger separation than assumed
and is now asserted. And export stays refused on a stopped subscription, matching
what the gate already did: there is a real tension with the portability right,
but an export is a branded client-facing document rather than a data dump, so
leaving it open would let somebody cancel and keep producing deliverables for
ever. Resolving it properly means separating "take my records" from "generate a
report", which does not exist yet.

**Four more ways to end up worse off, and a real payment provider.** A second
pass over the same ground, because the first audit closed the routes that
handled money and left the ones that decided who was allowed to.

1. **Privilege escalation into the operator role.** `POST /v1/users` and
   `POST /v1/users/:userId/roles` took `roles` as an array of unconstrained
   strings and passed it through to `createUser`. An enterprise admin — which
   is what every self-serve signup receives — could create a `PLATFORM_ADMIN`
   identity, sign in as it, and hold the whole operator surface: crediting
   their own wallet with any amount, reactivating a cancelled subscription,
   reading the estate. **Every control in the first audit sat behind that one
   word.** `identity/roles.ts` now publishes `TENANT_GRANTABLE_ROLES` and
   `assertTenantGrantable`, applied at both doors, in the schema *and* the
   handler. `ROLE_UNKNOWN` and `ROLE_NOT_GRANTABLE` are separate codes on
   purpose: a typo is a mistake, an attempt at the operator role is a security
   event, and the audit stream should be able to tell them apart.

2. **Money was recorded without a currency.** Tenancies choose a display
   currency, and minor units are not comparable across currencies — JPY has no
   minor unit at all, KWD has three digits of one. Every published price is a
   bare integer, so a tenancy on JPY was quoted the same integer as a tenancy
   on GBP and paid roughly a hundredth of it. `BILLING_CURRENCY` in
   `billing/payments.ts` is now the single denomination for intents, receipts
   and invoices; the tenancy's own currency stays what it always was, a
   presentation choice.

3. **A provider reporting a nonsense cost charged nothing.** `settle`
   multiplied the raw provider cost by the markup, so a zero produced a free
   execution and a negative one would have *credited* the customer for running
   an engine. The compute was bought either way. `ACU_COST_INVALID` now refuses
   anything that is not a positive finite number.

4. **Trial farming.** The free grant was made per tenancy, and a tenancy is one
   signup form. `rowan+1@gmail.com`, `rowan+2@gmail.com` and `r.owan@gmail.com`
   are one mailbox at every major provider, and each was a separate grant of
   real provider compute. `identity/signup.ts` counts grants against a
   normalised key — the domain for a company address, the de-tagged and
   de-dotted mailbox for a free-mail one — under `TRIALS_PER_ORGANISATION`.
   The distinction matters in both directions: counting a whole free-mail
   domain as one organisation would refuse the second sole trader on Gmail,
   which is most of them. A refused grant still provisions the account, because
   turning a spend control into a lost sale is not a fix.

**Stripe, over `fetch` and `node:crypto`.** No SDK — zero runtime dependencies
is settled, and Stripe's API is form-encoded HTTP with an HMAC on the webhook,
which is how the AI providers are already wired. `POST /v1/billing/checkout`
opens a hosted session for a top-up **already on record**, at the amount on
that record; `POST /v1/webhooks/stripe` credits the wallet when Stripe says the
money arrived. The console redirects with `window.location.assign`, so the
hosted page never enters this origin: no third-party script, no iframe, and no
CSP relaxation anywhere.

The webhook is the dangerous part, and it is the only unauthenticated route on
the platform that moves money. Stripe holds no credential of ours, so **the
signature is the credential** — HMAC-SHA256 over the exact bytes received,
compared in constant time, inside a 300-second tolerance window, before a
single field of the body is parsed. Unverified, it would be a mint with a
payment provider's name on it. It reads its body as raw bytes with its own
256KB ceiling rather than the 50MB evidence limit, because a public route that
buffers 50MB per connection is a different kind of leak.

Four rules the implementation exists to enforce:

- **Nothing the browser says about money is believed.** The amount, currency
  and paid flag come from the object Stripe signed. A customer may choose what
  to pay; they may not choose what they are credited.
- **Live and test money are never confused.** A production deployment refuses
  `livemode: false`. Stripe test keys are free to anybody who signs up.
- **A payment is credited exactly once.** The reference is the *payment
  intent*, not the event — one Checkout sale raises more than one event, each
  with its own id, so keying on the event would credit a single payment twice.
  That was found and closed while building it. `payment_intent.succeeded` is
  deliberately not read: it is the duplicate half of the pair.
- **Money that arrived is always credited.** `creditFromPayment` now takes a
  `source`. A provider settling a second real payment against an
  already-answered request credits it, unattached; an operator doing the same
  is refused, because there the likely explanation is one payment entered twice
  under a mistyped reference. Answering 4xx to a provider holding a customer's
  money would have Stripe retry a rejection for days and leave the customer
  paid-up and uncredited.

Unset keys mean the checkout answers 503 and top-up requests are still recorded
for the operator to settle by bank transfer. The platform works without Stripe;
it simply cannot take a card.

**Making a wrong key visible.** One deployment mistake is silent and expensive:
a webhook secret that is *set but wrong* — the signing secret of a different
endpoint, or one copied before the endpoint was recreated. Every field is
present and well-formed, so no boot-time check can catch it; checkout works,
customers pay Stripe, every delivery fails verification, and nothing is ever
credited. Only a delivery can reveal it, so `GET /v1/admin/payments` now carries
`cardPayments.webhook`: accepted, rejected, and the code of the last rejection —
never the signature, which is still a credential somebody attempted. Rejections
climbing while accepted stays at zero has one likely cause. Boot warnings cover
the halves that *are* detectable: a secret key with no webhook secret, a webhook
secret with no key, and a `sk_test_` key on a production deployment.

Found while testing that: **refusing an oversized upload poisoned the
connection.** The body is rejected as it streams, so the unread remainder stayed
in the socket and the client's next keep-alive request was parsed as a
continuation of it — failing for no visible reason. The refusal now sets
`Connection: close`, flagged at the one place a body is abandoned rather than
inferred from request state, since `readableEnded` is false for every ordinary
bodyless request and closing on those breaks everything. Exercised in `backend/tests/stripe.test.ts`
(forged, wrong-secret, moved, malformed, stale and rotated signatures; test-mode
in production; unpaid sessions; wrong currency; redelivery) and
`backend/tests/moneyleaks2.test.ts` for the four above.

**Two things I said in the first audit that were wrong**, corrected here so the
record is not: export does *not* survive cancellation — `platform.ts` already
checked status, and that gate has been left as it was; and the storage limit
*is* enforced — `storage.assertCapacity` runs on the upload route and throws
`STORAGE_LIMIT_REACHED` with a 507. A duplicate check written before finding it
was removed.

**A deploy was not checking that the site was reachable.** It polled
`/readyz` on the container's own port, which answers a question the container
can answer about itself — did the application boot. It cannot answer the one
that matters: does a request from the internet arrive.

Those differ exactly when it costs the most. A deploy recreates the container,
and the container's attachment to the reverse proxy's network is remade with
it. When that attachment does not take, the container is `healthy`, `/readyz`
returns 200 on localhost, every check passes, and **the site returns 502 to
everybody**. That happened on the live deployment and the script reported a
successful deploy throughout.

The local check was also latently broken: it hard-coded port 8080 while the
deployment publishes 8090, so it had been passing by never being reached rather
than by succeeding. It now reads `CONSTRUX_HOST_PORT`, the same variable compose
publishes on, so the two cannot drift.

The public URL is derived from `PUBLIC_BASE_URL` — the origin the platform
already knows it serves — rather than being a second place to update when the
domain changes. Unset means the check is skipped rather than failed, because a
deployment behind a VPN is a real thing and inventing a URL for it would fail
every deploy.

**A routing failure does not roll the code back.** The previous commit would be
exactly as unreachable, so rolling back would churn the deployment and fix
nothing. Instead the one repair that matches the cause is attempted — re-attaching
the container to the proxy's network — and if that does not help, the run exits
non-zero with the two commands needed to inspect and fix the attachment by hand.

**Account mail and marketing mail are separate senders.** They shared one
address, which forces a choice between putting marketing in the mailbox staff
read and sending login codes from an address that cannot receive a reply.
`NOTIFICATIONS_FROM_ADDRESS` covers codes, verification links and account
notices; `NEWSLETTER_FROM_ADDRESS` covers the weekly issue. It falls back to the
newsletter sender when unset, so a deployment configured before this keeps
working.

It matters operationally as well as editorially: most relays, Hostinger
included, require the From address to be the mailbox `SMTP_USER` authenticates
as. One address for both means one of the two is always sending as something it
is not authorised to send as — and that refusal was invisible.

**A refused send now says so.** `notify` caught SMTP failures and recorded them
as `FAILED` without logging anything, so a broken relay looked identical to a
working one from outside: the screen said a code had been sent, the delivery log
said it had not, and nothing connected the two. An afternoon went into finding
that on a live deployment. The relay's own refusal is now written to stderr,
because the relay's words are the diagnosis.

**The operator bootstrap is keyed on the address, not on a count.** It created
one only when the platform held *no* operator, so changing
`PLATFORM_OPERATOR_EMAIL` afterwards silently did nothing — and a deployment
that picked a wrong or unreadable address once could never correct it, because
correcting it required signing in. Now each boot ensures the configured address
holds an operator and leaves any others alone.

**Nobody could be sent a login code.** Found by trying to sign in on the live
deployment, one layer behind the operator bootstrap.

Sending the MFA code called `exports.branding(user.tenantId)`, which refuses
when a tenancy has no **client** branding configured. Two consequences, and the
second is worse than the first:

- The platform operator can never have client branding — the operator tenancy
  has no client — so the platform could not be signed into at all.
- A tenancy is seconds old when its administrator first signs in, so it has no
  branding either. **The first person through the door of every new customer
  would have been refused their own login code.**

The sign-in screen reported *"Client branding must be configured before
documents can be exported"*, which is a true sentence about the wrong subject
and tells the person nothing they can act on.

`brandingIfConfigured` is the fix: account messages — a verification code, a
confirmation that a tenancy exists — fall back to the platform's own branding,
because they go out before anybody could have configured anything. `branding`
stays strict and must: an unbranded *document* reaching a client is worse than
no document, and that refusal is the thing preventing it. Different question,
different answer.

It survived every test because the login route only sends mail in production —
outside it the code comes back in the response so local development needs no
mail server. The regression test runs the route with `NODE_ENV=production`,
which is the condition that makes the defect reachable, and fails without the
fix.

**A production deployment could not be administered at all.** Found on the live
server, not in a test. Every admin route demands `PLATFORM_ADMIN`; the only
thing that created one was `seedDemoProject`; and that is reachable only through
`POST /v1/console/session`, which is `DEMO_DISABLED` in production — correctly,
since it hands a working session to anonymous callers. So the platform came up,
served the public site, reported `0 users across 0 tenancies`, and there was no
way to sign in, create a tenancy, or do anything else.

Closed with `PLATFORM_OPERATOR_EMAIL`: at boot, if the platform holds no
operator at all, one is created. **Deliberately not a route.** A public endpoint
that mints a `PLATFORM_ADMIN` is the worst thing that could be put on the
internet whatever guard sits in front of it, and the role-escalation leak closed
in the second money audit is what that costs — the operator role can credit any
wallet with any amount. Setting a variable requires the server itself, which is
the authority the act deserves.

Guarded on the platform holding no operator rather than on the variable being
absent, so it runs exactly once in a deployment's life and leaving the variable
set afterwards is harmless — which matters, because nobody remembers to unset
it. The boot banner reports which of the three states applies, including `NONE —
nobody can sign in`, since that was the state nothing announced.

Sign-in is an emailed one-time code and there is no password anywhere, so the
configured address *is* the credential. An operator created against a mailbox
nobody can read is an account nobody can use, and a test pins that.

`POST /v1/operators` adds the second onwards, operator-only — so this is a
bootstrap rather than a standing way to manage people.

**`docs/ACCEPTANCE.md` — what to test on a live deployment.** Ordered by
dependency, and written so each test names the failure it is looking for rather
than only the pass. Several of the failures on this platform are silent — a
wrong webhook secret takes money and credits nothing; SMTP that is configured
but not delivering records every notification and sends none — so a checklist
that only says "should work" cannot tell you which one you are looking at.

Part C is the one that matters: cross-tenant isolation, the 402 on a cancelled
subscription, the unsigned webhook, and the demonstration surface. None of it
should be reachable, and trying it is the only way to know. Each of those is a
control something else in the platform relies on being true.

**`docs/GO-LIVE.md` — nothing to taking payments, in order.** Where each key
comes from in each provider's dashboard, how to get it onto the server without
destroying what is already there, what every boot-log state means, and how to
prove a rail works rather than assume it does.

It exists because the deployment gap was not technical. Every commit passed CI
and none of it was running: the commit that added autodeploy had itself never
been deployed, so the deployer was never installed and the box sat eleven
commits behind for a day. Nothing detected that, because CI answers "does this
build" and nothing was answering "is this running".

Every command in it uses absolute paths. The Hostinger web console resets to
`/root` on reconnect, and instructions written as `cd` plus a relative path fail
in a way that looks like the platform is broken.

**`deploy/env-check.sh` — what a deployment's `.env` is missing.** Reports which
variables are unset and what each absence costs, reads no values and changes
nothing. Exit 1 when something critical is missing, so it can gate a deploy.

It exists because the instruction it replaces was dangerous. `.env` on a running
deployment already holds secrets that cannot be regenerated without consequence:
`GATEWAY_JWT_SECRET` signs every live session, and `SIGNING_PRIVATE_KEY_PEM` is
the key every signature the platform has ever witnessed was made with — replace
it and they all stop verifying, silently, with nothing raised anywhere.
Overwriting the file to add a payment key is a data-loss event wearing the
clothes of a configuration change, so the tool reports what to *append*.

`KEY=` present but blank counts as missing, which is the state a half-finished
edit actually leaves behind. It also catches the two half-configured pairs the
boot warnings cover — a payment secret key with no webhook secret, meaning money
taken and never credited — and a non-local `AI_MODE` with no provider key at
all, which the boot warnings do not cover because they check each key
independently.

**A third AI vendor, and two things that were wrong with the gateway.** The
platform was described as a gateway with failover across OpenAI, Gemini and
Claude. It had two of those, and the failover was not what it looked like.

**Claude was never built.** `AIProvider` was `'OPENAI' | 'GEMINI'` — a closed
vocabulary in `goldenthread/types.ts`, which every AI spend event records
against. There was no Anthropic endpoint, key or adapter. `.env.example` was
accurate to the code; the description was not.

**A third provider would have been Gemini wearing another name.**
`RemoteProviderAdapter` resolved both its endpoint and its key with a pair of
ternaries — `name === 'OPENAI' ? OPENAI : GEMINI` — so *any* name that was not
OPENAI got Gemini's URL and Gemini's key. Adding `'ANTHROPIC'` without noticing
would have sent that traffic to Google, authenticated as us, and written
"ANTHROPIC" into an append-only ledger against every pound of it. Replaced with
a provider table, so a fourth vendor is an entry rather than an edit to a
conditional that is already wrong at three.

**The provider-selection settings did nothing.** `AI_REASONING_PROVIDER` and
`AI_PERCEPTION_PROVIDER` were read into `config` and used by no code anywhere;
the adapters were constructed from hard-coded names. Setting either changed
nothing while `.env.example` presented both as a supported choice — a knob that
does nothing is worse than no knob. They now select, an unrecognised name falls
back to the default rather than resolving to whatever a conditional reached,
and `assertProductionSafety` warns when one is set to a name that is not a
provider.

**The failover was vendor-diverse by accident.** `adapterFor` fell back across
*capabilities*, not vendors: if reasoning was unhealthy the perception adapter
took the work. That gives vendor redundancy only because the two capabilities
happen to sit on different companies, and it silently stops giving any the
moment both are pointed at the same one. Any provider holding a key now joins
the chain as a third option, so the redundancy is deliberate rather than
incidental. A test pins that injected adapters stay isolated — otherwise a
suite exercising the exhausted-provider path would quietly reach a real vendor
whenever the environment happened to hold a key.

Anthropic is wired to the Messages API, which differs from the other two in
ways that matter: `max_tokens` is required, media is an `image` content block,
and a response can carry several blocks of which only the text one is the
engine's answer. `backend/tests/providers.test.ts` pins each provider to its own
endpoint and its own credential — the assertion that would have caught the
ternary.

**KODA, as a second payment rail.** Mobile money beside the card, wired to the
same shape as Stripe on purpose: a JSON call out to create an intent, a signed
webhook back, and `Platform.creditFromPayment` as the single door into the
wallet. A second provider reaching the balance by its own route would be a
second set of money rules to get wrong.

`POST /v1/billing/koda/checkout` opens a hosted checkout for a top-up already
on record, at the amount on that record; `POST /v1/webhooks/koda` credits when
KODA says the payment verified. `payment.verified.late` credits identically — a
slow operator SMS is the same money, and dropping it would mean a customer on a
bad network never receiving their credit.

**The signature has no timestamp behind it.** KODA signs the raw body only, so
unlike Stripe there is no tolerance window and a captured webhook stays
cryptographically valid for ever. Replay is stopped entirely by the payment
reference — KODA's own receipt id, spent exactly once. That makes the reference
the primary defence on this rail rather than a backstop, which is worth knowing
before anybody relaxes it.

**The wallet is in pounds and this rail settles in dollars.** That is the part
that needed a decision rather than an implementation, because
`BILLING_CURRENCY` exists precisely to stop minor units being compared across
currencies. Three rules:

- **The rate is an operator-set constant, not a live feed.** `KODA_USD_PER_GBP`.
  A rate fetched at settlement makes a credit impossible to reproduce from the
  ledger a year later, and adds a third-party dependency to the one path where
  failing means taking money and crediting nothing. The cost is FX drift between
  reviews; it is bounded and visible, which a silent dependency is not.
- **The rate quoted is the rate credited.** It is pinned to the intent when the
  customer is shown a price and reused when the webhook lands. Otherwise moving
  the configured rate mid-payment re-prices somebody who has already paid, in
  whichever direction the market went.
- **Every conversion is recorded.** The receipt carries `fx` — what was settled,
  in what currency, at what rate — so any credit can be recomputed from its own
  record without knowing the configured rate that day. Rounded half-up rather
  than floored: flooring would shave a sub-penny off every conversion in the
  platform's favour, which is small, systematic and indefensible once somebody
  adds it up.

`convertToBillingMinor` refuses a rate that is zero, negative or not finite, and
`assertProductionSafety` warns at boot when the rate is unusable or the keys are
half-configured — so the failure is found at deploy rather than at settlement.
The console tries both rails in turn; a deployment with both wired should let
the customer choose, and that is a real screen rather than a second dialog, so
it is not built yet.

Exercised in `backend/tests/koda.test.ts`: forged, wrong-secret, moved and
wrong-length signatures; the unconfigured refusal; the conversion and its
round-trip; a rate moved mid-payment; redelivery and the late event crediting
once between them; a verification with no receipt id or no tenancy crediting
nothing.

**Google Maps was checked and is not required.** Nothing in the platform
geocodes, renders a map or holds a coordinate — a project has a sector and a
jurisdiction, not a location — so there is no key to add and adding one would be
a credential for a dependency that does not exist.

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
why the public-surface invariant covers it. Both doors onto verification —
`POST /v1/signup/verify` for a client that speaks JSON and `POST /verify` for the
button on the emailed page — run one `activateRegistration`, so neither can drift
into provisioning differently or forgetting to send the welcome.

The anti-enumeration property now holds on the way **in** as well as the way up.
`POST /v1/auth/login` used to answer `404 No user with that email address`, which
gave away for free exactly what registration refuses to say. An unknown address
now gets a decoy challenge with nothing stored behind it, so it fails at the code
step like a mistyped one rather than at the address step.

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

**A demonstration tenancy that is not a hole in that.** Closing the above left a
production deployment showing a prospective customer nothing: the seed was off,
so the platform served a sign-in page onto an empty world and refused the
identity picker. `DEMO_TENANCY_ENABLED=true` seeds the Meridian lifecycle at
boot as a real tenancy with twelve identities that sign in through the ordinary
login and MFA path.

What the switch does, precisely: an identity the seed created — and only such an
identity — has its one-time code returned in the login response as `demoCode`
instead of emailed, because the address it would be emailed to is
`@meridian.example` and belongs to nobody. The challenge, its five-minute
expiry, its single use and the verification step are all the real ones. Verified
against a server started with `NODE_ENV=production`: a wrong code is refused, the
real one is accepted once, and replaying it is refused.

Four guards, each of which alone would refuse:

- The switch must be on, read fresh by `demonstrationEnabled()` for the same
  reason `isProduction()` exists — a gate nobody can test is a gate nobody has
  checked. It reads the variable by exactly the rule `bool()` uses, so a
  deployment set to `1` cannot seed a demonstration at boot that every route
  then refuses to show.
- The account must carry `demonstration: true`. It is set by `seedDemoProject`
  and by nothing else in the platform — no route sets or clears it — so an
  account cannot become public and a demonstration account cannot stop being
  one. It is written into `USER_CREATED`, so it survives a replay; a flag held
  only in the process would take the demonstration sign-in with it on the first
  restart.
- No operator, ever. `demonstrationUsers()` applies the tenancy and
  `PLATFORM_ADMIN` filters in one place rather than at each call site, and in
  production the identity list omits the operator layer entirely — a
  cross-tenant administrator should not be a button on the front door, and the
  button would not work anyway.
- `POST /v1/console/session` is **not** on this switch and stays refused in
  production whatever it is set to. Publishing an account that must still
  authenticate and skipping the challenge outright are different things.

Two consequences worth stating plainly rather than discovering:

- The demonstration tenancy is a **sandbox in a real ledger**. Anyone signed in
  can write to it, isolated from every other tenancy by the same tenant
  isolation that separates two customers.
- It **spends AI budget**. Seeding runs a full lifecycle's AI steps against
  whichever providers `AI_MODE` selects, and visitors spend from the same wallet
  afterwards. `DEMO_ACU_CREDIT_MINOR` caps it; when it empties the platform
  refuses to call a provider, which is existing tested behaviour. The cost is
  once per deployment, not per restart: the bootstrap **adopts** a tenancy
  already on disk rather than seeding a second one. Without that, every restart
  would have built another Meridian — another project, another wallet, another
  twelve identities — until the sign-in page listed duplicate Project Managers
  and nobody could tell which held the work. Harmless where the journal is
  discarded between runs, which is why it was never seen. Verified by restarting
  a production-mode server against its own journal: `12 identities, adopted from
  the record`, one tenancy, one operator.

The seed also stopped inventing an operator. It adopts one that already exists,
so seeding a demonstration onto a deployment that has bootstrapped its real
`PLATFORM_OPERATOR_EMAIL` no longer files `operator@construx.example` beside it.

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

**The handset was audited at 393×852, not assumed.** Three defects were found
by measuring, and all three are fixed:

- The lifecycle rail's seven `nowrap` stages rendered the console **541px wide
  in a 393px viewport** — the whole page scrolled sideways. The rail now scrolls
  within itself, bleeding to the screen edges so it reads as a scrollable strip
  rather than a clipped one.
- Controls and fields were below the 44px minimum a thumb needs. Every button,
  navigation item and field is now at least 44px under
  `(hover: none) and (pointer: coarse)`, and every text input is set at 16px —
  below that iOS zooms the page on focus and leaves the field off-screen, which
  reads as a broken layout.
- `span.mono` had **no rule behind it**: clause references, environment keys and
  state hashes were rendering in the prose face. Worse, an unbreakable 71-char
  `sha256:` on Project Control was the second source of horizontal overflow. The
  class now sets the mono family and `overflow-wrap: anywhere`, which breaks
  only a token that would not otherwise fit.

Verified by sweeping every route reachable by a project manager (20) and by the
platform operator (2) at phone width: no horizontal overflow, no empty view, no
page error on any of them.

**iOS is told how to install, because Safari will not offer.** `beforeinstallprompt`
is captured on Chromium so the offer appears where the work is rather than
buried in a browser menu. Safari fires no such event and exposes no API that
can start an installation — it is Share → Add to Home Screen and nothing else —
so a page that says nothing reads to an iPhone user as an application that
cannot be installed. `frontend/lib/install.js` says it in words, and this is
where a platform sniff is legitimate: the instruction genuinely differs by
browser. It is shown once, four seconds in so it does not compete with the first
screen, dismissed with one touch, and the dismissal is remembered. It is not
shown to Chrome or Firefox on iOS, which cannot install at all, nor inside an
already-installed application — checked in script and again by a
`display-mode: standalone` media query.

**The outbox is what makes it a field application rather than an installable
bookmark.** `frontend/lib/outbox.js` holds captured work in IndexedDB until the
sync engine has decided about it. Three properties, each verified in a browser
with the network genuinely cut rather than reasoned about:

- **`PWA` is a first-class event source**, added alongside `WEB`, `ANDROID` and
  `IOS`. A record typed at a desk and a record captured at a work face are
  different evidence, and a browser claiming to be Android would put a false
  provenance into a ledger that cannot afterwards be corrected. The client
  asserts it — nothing in a request distinguishes a standalone PWA from the same
  browser with a tab open — and it is a provenance note, never a permission.
- **The device timestamp survives the delay.** Verified end to end: an
  observation captured offline at `18:12:45.965` and flushed three seconds later
  carries `deviceTimestamp 18:12:45.965` against `recordedAt 18:12:48.983`. The
  time on the record is the time on site, which is the fact a delay claim turns
  on.
- **A governance action is refused at the press, not queued.** The sync engine's
  own `FIELD_FORBIDDEN_EVENTS` is published on `/v1/permissions/matrix` and the
  outbox reads it, so the operative is told immediately rather than shown an
  approval as "pending sync" that was never going to be accepted. The first
  version of that list was hardcoded in the browser and every one of its eight
  event names was wrong, which is settled decision 6 earning its keep.

What the outbox refuses to do is as load-bearing as what it does. An operation
the server did not *decide* about — a dropped connection rather than a verdict —
is kept, because dropping it is how a site record silently loses a day. A
rejection is surfaced rather than swallowed. And the queue is cleared on
sign-out, because a site handset changes hands and one operative's record must
not flush under another's token.

**Every command has a door, and the door is generated from the schema.**
Seventy-eight of the platform's one hundred and fifty-six write routes had no
console entry point at all: a command the platform accepts, an engine behind it,
a test proving the engine works, and no way for a person to reach any of it. Two
reviews concluded there was "nowhere to put information in", and this was almost
certainly why — not a missing feature, a missing door.

`GET /v1/commands` publishes every write route with the schema that governs its
body, and `frontend/lib/catalogue.js` turns one into the same `command()` spec a
hand-written panel uses. That is settled decision 6 applied to field lists: the
interface holds no rule the API does not publish, and a field list is a rule.
Curated panels stay where they exist, because a dropdown of *this project's*
current drawing revisions beats a text box called `drawingId`; what changed is
that a route without one now has a door instead of nothing.

The catalogue is authenticated, unlike `/v1/routes`. A list of what exists is a
different thing to hand a stranger from the shape of every request body the
platform accepts.

**The request-validation debt is paid.** Ninety-five write routes accepted a body
nothing checked — not at the edge, not at the ledger, and TypeScript types are
erased under `erasableSyntaxOnly`. It was recorded as a register that could fall
and never rise. Two things made paying it off unavoidable rather than tidy: an
unvalidated body reaches a handler that writes to an append-only ledger, so a bad
field is a permanent record rather than a bad request; and a generated door for a
route with no schema is a form with no fields — a door onto a refusal, which
reads as a broken product rather than an incomplete one. Every write route now
publishes a schema, so the test asserts zero rather than a ceiling. A ceiling
invites somebody to spend the headroom.

Most of those schemas refuse unknown fields. The exceptions are the deeply
nested ones — a tender estimate carries the twenty cost heads, whose shape
belongs to the cost model and is validated there — and they declare their
top-level fields and stay open rather than restating a shape in two places,
which is the drift the schemas exist to prevent. A test holds the ratio.

**Two answers the command centres reported as missing, derived rather than
built.** The site centre said "productivity against baseline is not derived" and
the design centre answered "what will happen next" with nothing at all.

`productivityPosition` publishes days earned over days spent — arithmetic that
already existed inside `forecastDelay`, where it was one input to a risk model
and nothing could read it on its own. Derived and not published is
indistinguishable from absent when you are looking at a screen. Three refusals
keep it honest: work nobody has started is excluded rather than scored 1.0,
because no elapsed time is no evidence either way; progress recorded against no
elapsed days is reported as a data fault rather than as infinite productivity;
and the project figure is weighted by duration, because an unweighted mean lets a
one-day snagging item cancel out a twelve-week structure.

`designReadiness` answers a deliberately narrow question — not "is the design
finished", which no project can answer, but *of the work in the published
lookahead, what is waiting on a question nobody has answered*. It became
answerable only once an RFI carried the activity it holds up. Committed work
sorts above merely planned work, because those are the promises that break, and
an activity with no open question is reported as ready rather than omitted: "nine
of eleven are ready" and "nine are ready" are different statements and only one
can be checked. Where a lookahead has not been published it says so instead of
inferring a window from the whole programme, which would answer a different
question.

**Letters, and what the contract does when nobody answers one.** The platform
wrote exactly one kind of letter — a site instruction, as a side effect of
marking up a drawing — and nothing said what a letter was for or what happened
if nobody replied. On a construction project that is the whole game.

`backend/src/domain/correspondence.ts` holds the matrix. Three rules, each a
fact about the contract rather than a convention. **The recipient is
contractual**: a notice served on the wrong party is not served, so serving one
is refused rather than filed with a warning — a warning on a screen nobody reads
is how a notice ends up invalid. **The period comes from the form**: an
extension of time application is twelve weeks under JCT and six under FIDIC, and
under a bespoke contract it carries none at all, which is reported as none
rather than defaulted to something that looks contractual. **Silence has a
consequence and it is written down**: under NEC 62.6 a quotation the project
manager does not reply to is *accepted*, and the position reports that as a
thing which has happened rather than as an overdue item — by then it is not
outstanding, it is decided, and putting it in the chase list is how the decided
ones get chased and the answerable ones get missed.

The matrix is published at `GET /v1/correspondence/matrix` and the console
builds its composer from it, because who a letter must go to is a rule and
settled decision 6 says the interface holds no rule the API does not publish.
Periods of under a week are reckoned through `reckonPeriod`, so NEC's one-week
reply excludes the s.116(3) days.

**Who was asked, and who answered.** Every fact was already on the record — the
invited list on the RFQ, the acknowledgements written against it, the
submissions naming it — and nothing stood them beside each other, which from a
screen is indistinguishable from not tracking bidders at all.
`reconcileTenderResponses` does. The word is the finding: a firm that declined
is a normal outcome, a firm that said it would bid and then did not return is a
hole somebody should have chased on the Friday, and a firm that never
acknowledged may not have received the enquiry at all — a question about the
issue rather than about the bidder. Nothing is ranked; comparing prices is a
different question asked after this one.

Two of the four remaining gap-matrix items turned out to be **built already**.
Competency expiry has fed the obligations calendar since the calendar existed,
and `issueRFQ` has always refused a package that is not `READY_TO_ISSUE`, which
is the completeness gate before issue. Rebuilding either would have been the
most expensive way to add nothing.

**Two defects the work found, one fixed and one reported.**

Fixed, because it made the change ship broken: on the Change & Claims screen the
`COMMANDS` object and its click handler sat *after* a `return` inside
`contractLabel`, so they were unreachable and **every command button on that page
did nothing** — silently, with no console error, since the listener was never
attached. Confirmed in a browser before and after. The two new correspondence
buttons would have been dead on arrival beside the nine that already were.

**The supply chain register and the returns now name the same firm.** This was
reported as a defect and left alone in the same commit that found it; it is
fixed here.

A firm was invited to an RFQ by its supply-chain register identifier and
submitted under the party identifier its people carry, and no `Supplier` record
held a party. Two consequences, and the second is the serious one. Every return
looked uninvited and every invited firm looked silent, which the reconciliation
could only report as an unreadable answer. And `assertEligibleForEnquiry` gated
who could be *invited* while nothing gated who could *return*, so the
prequalification the enquiry refused to go out without could be bypassed end to
end: an unqualified firm's bid received, evaluated, adjudicated and awarded.

`registerSupplier` now takes the party the firm trades as, required rather than
optional — an optional field leaves the same hole open for whoever is in a
hurry — and refuses a party another register entry already claims, because a
party shared by two firms makes a return ambiguous at the moment it has to be
attributed. `receiveSubmission` resolves the submitting party to its register
entry and refuses a return from a firm that was not invited; `acknowledgeRFQ`
does the same, and accepts either identifier from a firm answering for itself.
The submission records the register entry it resolved to, so the join is read
rather than re-derived on every report.

Nothing downstream was re-keyed. The award, the subcontract and the commitment
still carry the party, which is now a resolvable reference instead of an
unmoored string — that is what made the fix small.

Two things it does not do. Firms registered before the join cannot be matched to
their returns, and the ledger is append-only so those entries stand; the
reconciliation keeps reporting that as an unreadable answer rather than
inventing a match, and the fallback is tested against a fixture rather than
against the seed, because a test that only passes on broken data stops testing
the day the data is fixed. And a submission from an unrecognised party is still
accepted, since refusing it would make the ledger's own history unreplayable
through the command path.

**Storage became an entitlement instead of a claim.** Every package declared a
`storageGb`, the pricing page printed it, the billing screen printed it, and
**nothing enforced it** — the same shape of defect as the ACU bundle that
advertised a third more credit than the multiplier would yield. A tenant on the
hundred-gigabyte plan could upload a terabyte, and the first anyone would know
is a volume filling up.

`backend/src/billing/storage.ts` meters it: the allowance is the package plus
blocks bought, usage is measured from the object store, 70% raises a flag and
100% refuses the write with a 507. A hard stop rather than an overage invoice,
because nothing the ledger names is deletable — usage only ever rises, there is
no state an over-quota tenant returns to, and billing for the overage is a bill
that grows for ever against storage the platform can never reclaim.

**No package is uncapped.** Enterprise carried `null`, which meant unlimited,
which against a record nothing can be deleted from is an unbounded liability —
usage only rises and the plan carries it for ever at a fixed monthly price. It
now carries 4 TB, and removing the null case removed a branch from every screen,
route and function downstream: a position always has a limit, a percentage is
always a number, and there is no second path through the console for the tenancy
nothing could refuse.

The figures are derived rather than chosen. Photographs are 88–89% of everything
on every project size, so the unit of demand is a project: about 9 GB for a small
works job over six months, 52 GB for a mid project over twelve, 258 GB for a
major project over twenty-four. The rule is that an allowance must reach the 70%
flag no sooner than twelve months of typical use for that package — year-one
demand divided by 0.7 — which puts the warning a year in, early enough to be a
conversation and late enough not to tax a customer who has just arrived. That
rule reproduces the three existing figures exactly (5 GB, 100 GB, 500 GB) and
sizes the fourth at 4 TB. A test asserts it, so a package added later cannot be
priced with an allowance that trips its own flag in month nine.

**The cheapest byte is the one never uploaded.** Photographs are 88–89% of
everything stored, a handset shoots 3–12 MB a frame, and a defect, a pour, a
rebar cover check or a delivery ticket is completely legible at 1920px on the
long edge. `frontend/lib/capture.js` re-encodes them in the browser before
anything leaves the device: a mid project's photography falls from about 46 GB
to about 9 GB, which is the largest single lever on storage cost anywhere in the
system and the only one that also makes the upload faster on a site connection.

It runs **before the hash**, and that placement is the whole of its correctness.
The hash is the address the bytes are stored at and the value written into an
append-only event, so it must be taken over the bytes actually kept; compressing
after hashing would make the platform refuse its own upload. `command.js` is the
one path where a captured file becomes an address, so it is the one place this
is wired. The other `hashFile` call site — `audit.js`, supplying bytes against a
hash already on the record — must never compress, and does not.

Four rules keep it from being a risk. Only images, and only large ones: a PDF, a
drawing, an IFC or a signed document passes through untouched, because
re-encoding those is lossy where it matters and a drawing is exactly what
somebody zooms into three years later. It can never return a larger file, so an
already-optimised image keeps its original bytes. Every failure path returns the
original — a browser without `OffscreenCanvas`, a corrupt image, a codec the
canvas will not read — because an uncompressed photograph is a fine outcome and
a lost one is not. And EXIF orientation is applied during decode, without which
every sideways phone photo is stored sideways, which is the kind of defect
noticed a week and a thousand photographs late.

What is given up is the rest of EXIF, including the GPS fix and the capture
timestamp. Nothing reads either today — the event carries its own
`deviceTimestamp` and its own author, which is what a delay claim is argued from
— so nothing regresses, but if location ever becomes evidence here it has to be
extracted before this runs and cannot be recovered afterwards. The module says
so, at the top, in the place somebody would look.

Verified in a real browser rather than asserted: a 4032×3024 capture comes back
1920×1440 and 9.6× smaller, portrait stays portrait, a PDF and an IFC come back
identical, a 400×300 photograph is left alone, and a flat image the encoder
would have grown keeps its original bytes. The package sizing above is
deliberately **not** reduced to match: the demand model stays at capture size,
because it is the floor for a browser where the re-encode falls back, and
because cutting an allowance on the strength of an engineering change reprices a
customer who did nothing. The headroom is now real headroom.

**What the allowances cost, and what the block earns.** A block is 100 GB held
twice — live plus the off-machine backup the runbook requires — so every figure
below is 200 GB-months of underlying cost.

| Package | Included | Cost on B2 | On a VPS volume | Share of that plan's revenue |
|---|---|---|---|---|
| Trial | 5 GB | £0.05 | £0.44 | no revenue |
| Core Project | 100 GB | £0.95 | £8.80 | 0.10% – 0.93% |
| Professional Delivery | 500 GB | £4.74 | £44.00 | 0.22% – 2.00% |
| Enterprise | 4 TB | £37.92 | £352.00 | 0.58% – 5.42% |

Included storage costs under one per cent of subscription revenue on object
storage and up to five on a VPS volume, so **where the bytes live moves the
number nine times more than how many are allowed does**. The £15 block is a 16x
markup on B2, 4x on S3 and 1.7x on a VPS volume — which makes the price a bet on
the storage backend rather than on the customer, and moving the store to a
volume without revisiting it converts the margin quietly. The config comment
says so beside the number.

The backend decision is written down in `docs/GOING-LIVE.md`: the VPS volume to
launch on because it is built, and **Backblaze B2 before the first paying
customer**. `GET /v1/admin/tenants` reports every tenancy's meter and the estate
totals beside them, including `committedBytes` — what an Enterprise contract
moves the day it is signed rather than the day anybody uploads.

An earlier version of that plan said Cloudflare R2 at a 60 GB trigger and both
halves were wrong. R2 was wrong on the numbers: B2 is cheaper until a tenancy
reads back more than 3.9× what it stores every month, so R2's zero-egress
guarantee is £78 a month of insurance against a risk document-platform read
volumes do not produce. The 60 GB trigger was wrong on the migration: every
object must be copied, re-hashed and verified — a content-addressed store that
does not check the hash is not one — so moving costs ~0 objects before the first
customer, ~20,500 at 60 GB and ~170,700 at the first Professional Delivery
tenancy. The cost of that decision only ever rises, which makes it the one thing
not to defer.

The driver is **not built**, and `docs/GOING-LIVE.md` states its shape so nobody
starts blind. Three things make it more than a driver: B2 speaks the S3 API,
which is HTTP plus SigV4 and therefore `node:crypto` and no dependency, the same
argument that put SMTP and RESP here by hand; `projectRegister` calls `has()`
once per evidence record, which is a `stat` on a volume and a round trip against
object storage, so it has to become one `LIST` into an index; and it cannot be
tested against B2 from a development machine, so a fake S3 server proves the
signing and the protocol the way the fake SMTP and RESP servers already do, and
first deploy proves the rest.

**Firebase was assessed and rejected**, and the price is the weaker reason. At a
year-two book it is the dearest of the five at £2,312 a month against R2's £130,
almost all of it egress. But it also fights three settled decisions at once: the
SDK ends zero runtime dependencies, Firebase Auth would be a second identity
model beside the RBAC/ABAC that already enforces every permission, and its
central value — client-direct upload — bypasses the server-side re-hash that
stops a client storing bytes under a hash the ledger already trusts.

An earlier costing here used two copies on object storage and was corrected: the
store is content-addressed, so objects are immutable and never overwritten,
versioning costs nothing and object lock gives the logical protection a second
copy would buy. One copy is honest there; the volume still needs two.

Two consequences worth stating. **S3 is ruled out by egress, not by storage
cost**: one customer pulling a 4 TB archive is about £284, seven times what
holding it for a month costs, and B2 and R2 charge nothing for the same read.
And **the retention policy has a hole on the free tier** — nothing the ledger
names is deletable, which is right for a tenant with a contract and a limitation
period, and wrong for an abandoned trial that has neither. A thousand abandoned
trials is £19 a month on B2 and £176 on a volume, for ever. Nothing is built for
this yet and the policy question is a commercial one rather than an engineering
one.

Three things it is careful about. **What stops is supplying bytes**, never
recording an event, certifying a payment or signing a document: a full disk must
not stop a contract being administered, and the evidence hash still reaches the
ledger with the record saying the file is not held. **The incoming file is
measured, not just the running total**, so a tenant a megabyte under the line
cannot cross it with a forty-megabyte drawing set and leave the next upload to
fail for it. And **the meter measures held bytes, not recorded ones**, so a
tenancy that records evidence the platform does not hold is not charged capacity
for files that are not there.

Usage is measured from the volume and is deliberately not an event: bytes on
disk are a measurement, and an event asserting one would be a second source of
truth for a number the filesystem already holds. Capacity *bought* is the
opposite — money changed hands — so `STORAGE_CAPACITY_PURCHASED` is on the
record and the entitlement is summed from it rather than kept in a counter.

Writing it found `TIERS` carrying its own `storageGb` — 50, 250, 1000 against
the packages' 100, 500, uncapped, for the same customer. The package is what the
pricing page publishes and what is now enforced, so the legacy figures are
removed: two numbers for one entitlement is how a tenant gets sold one and
metered against the other.

**Running the asset, not listing it.** The FM centre was the weakest of the
seven — four of nine panels partial and one absent — for one reason: the asset
register was listable and nothing aggregated it. A list of assets is not an
operating position any more than a list of events is an audit.
`operatingPosition` and `maintenanceQueue` aggregate what was already there;
`recordOperatingCost` captures what was not. The absent panel is the instructive
one. "What is costing money" had no record behind it at all — nothing captured
energy or reactive-maintenance spend — so the honest options were to capture it
or to keep saying nothing. Deriving it would have meant inventing it. Reactive
share leads rather than total spend, because a facility spending more in total
and less of it reactively is being run better and a total cannot tell those
apart; a facility with no cost records reports unknown rather than zero; and a
statutory inspection ranks above an emergency, which looks wrong for a day and is
right for a year.

**Cash as the record says it will be, not as the tender assumed.** The
commercial centre said "cash-flow model exists at bid stage; no live forward
cashflow", and the two are different documents. `forwardCashflow` reads the
record; the S-curve stays a bid document. What it reports is the *low point* —
peak funding is what closes companies, and a project that ends level having been
£2m down in March still had to find £2m in March.

Four refusals keep it from becoming a second, quieter bid model. The run rate is
the mean of certificates that exist, and a project with nothing certified is told
so rather than handed the tender figure — a bid assumption presented as a reading
of the record is the worst thing this could do. A certified sum lands on the
period its own final date falls in, at its own value, rather than being averaged
into a mean. A period whose certificate is already paid contributes nothing
instead of also being projected: the seed pays ahead of its final dates, and
counting both overstated the closing position by more than the contract sum. And
the projection stops at what is left to certify — where the run rate exhausts the
contract early that is reported as a finding, because either the rate or the
programme is then wrong.

The outflow side is measured the same way or declared unmeasured. Nothing is
certified down the chain on the demo project, and dividing the subcontract
commitments across the remaining periods would have produced a confident outgoing
line with no certificate behind it. Direction comes from certificate →
application → cycle, because a payment entry records no direction of its own and
inferring one from the entry would be inventing a field rather than reading one.

**The mark has one source and everything is derived from it.**
`frontend/logo.svg` is the full mark — skyline, tower crane, ground line and the
orange X. `frontend/logo-glyph.svg` is the reduced mark used everywhere the full
one would turn to mud: rendering showed the crane becomes illegible below about
48px, so the small sizes drop it rather than draw it badly. The favicon, the site
header, the console sidebar, the in-document splash and every generated PNG carry
that glyph's geometry rather than each holding a private copy — which is exactly
how the console came to show a four-square placeholder while the brand was
something else entirely.

**The platform now holds the evidence, not only its hash.** Until this build the
chain proved a document *with a given hash* was the evidence and did not hold the
document. That is a real chain and it lasts exactly as long as somebody outside
the platform still has the file — which, three years after practical completion,
means the person who took the photograph has left and the phone has been wiped.

`backend/src/evidence/store.ts` is a content-addressed store on `node:fs` and
`node:crypto`, no runtime dependency, the same argument the durable ledger
journal already makes. S3 becomes a driver behind this interface when there is
somewhere to deploy it; the semantics do not change. `EVIDENCE_STORE_PATH` unset
is a legitimate deployment — hashes recorded, files not held — and
`assertProductionSafety` says so rather than letting it be discovered during a
dispute.

The rules that make it evidence rather than a file server, each verified by a
test that tries to break it:

- **A ledger record names a hash first; only then may bytes exist.** An upload
  for a hash nothing in the tenancy has claimed is refused. Without that rule
  this is an open blob store with an authentication check on it.
- **The bytes are hashed again on the server and refused if they do not match.**
  The browser's hash decides the address; if the upload were trusted to declare
  its own, a client could store anything under a hash the ledger already trusts
  and poison the chain at its root. Re-hashed on read too, so a corrupted volume
  cannot serve something that is no longer the evidence anybody recorded.
- **Deduplication stops at the tenant boundary.** Two tenancies uploading the
  same file get two objects. That looks wasteful and is correct: one tenant's
  retention decision must not reach into another's record.
- **The hash is whitelisted, never sanitised.** `^sha256:[0-9a-f]{64}$` is the
  only thing between a caller-supplied string and a path join; a check for `..`
  is a traversal waiting for an encoding nobody thought of.
- **Links expire and are bound to their tenancy.** An HMAC over tenant, hash and
  expiry, compared in constant time, so an adjudicator can be sent a link that
  works without a session and stops working afterwards. `GET /v1/evidence/:hash`
  is therefore a public *route* over a private *object*: valid signature, or
  authorised identity, or nothing.
- **Nothing uploaded is served inline unless a browser merely renders it.**
  Images and PDFs display; everything else downloads, under `nosniff` and a
  policy that denies the document every capability. An uploaded HTML file served
  inline would be stored cross-site scripting on the platform's own origin.
- **No ledger event is written on upload**, and that is deliberate rather than an
  omission. The hash was committed by the domain command that registered the
  evidence; bytes that hash to it assert nothing new, and bytes that do not are
  refused. Inventing an event type to record a non-fact would widen a closed
  catalogue for nothing.

**Retention here is mostly a policy about not deleting.** The usual retention
question — what is old enough to remove — has the wrong shape on an append-only
ledger. An evidence record can be argued over for as long as the contract can be
sued on, so age is not a reason to delete a file and does not become one. There
is no expiry sweep because nothing expires.

What retention *can* honestly report is where the volume and the record
disagree, in both directions. Recorded and not held is a chain that depends on
somebody outside the platform still having the file, and is already named on the
register. Held and not recorded is the opposite: bytes at an address no evidence
record names. The upload route cannot create one — it refuses a hash the ledger
has not claimed — so an orphan means a restored volume, a copy between
environments, or an interrupted write, and those are the only files here that
may be removed. `discardOrphan` refuses anything the ledger names, with no
override, because an override is what somebody reaches for on the day the
evidence is inconvenient. The guard lives in `registry.ts` rather than in the
store: the store holds bytes and knows nothing about what they prove.

Two authorisation subtleties are worth stating. Supplying the file is `I` —
import — because the record already exists and this completes it; `EVIDENCE_AUDIT`
carries no `C` for exactly that reason. And the person who *registered* the
evidence may supply its file with read permission alone, because a site
supervisor holds `EVIDENCE_AUDIT: ['R']` and is precisely whose phone took the
photograph. On `I` alone the field app could record a hash and then be refused
the file behind it — the feature failing for the role it exists for.

The Golden Thread screen now leads with **files held**, and the evidence register
lists every record with `held` or `hash only` against it. That number is the
honest one: a chain of hashes proves nothing has been altered, and says nothing
about whether anybody still has the documents. Supplying a file hashes it in the
browser first and refuses a mismatch locally, naming which document it should
have been, before anything is sent.

**The field app holds the bytes too.** `frontend/lib/outbox.js` keeps captured
files in IndexedDB as Blobs beside the operations that name them, and flushes
them *after* the operations — an upload is refused until a record names its hash,
so the record has to land first. A file the platform is not ready for is kept; a
file whose bytes cannot match its address is dropped, because that cannot become
true later. Both paths verified in a browser with the record deliberately absent
and then deliberately present. The queue is cleared on sign-out with the
operations, for the same reason: a handset changes hands.

That gap is now closed. A file whose operation was rejected outright waits on
the device for a record that will never exist, and nothing on the handset can
tell that apart from a record still in the queue — so the decision is a person's
and the Field Execution screen shows what this device is still carrying, with the
capture's name, the address the record would name it by, and a discard that
confirms and says what is being lost. There is no timer: a photograph deleted
automatically is evidence nobody chose to lose.

**Every command that takes evidence now stores the file behind it.** The console
already hashed a chosen file in the browser and put the hash in the event;
`frontend/lib/command.js` now sends the bytes after the command has been
accepted — after, and never as a condition of it, because a failed upload must
not undo a record the platform has already committed. What does not land is
queued on the device and retried on the next sync, and the person is told their
handset is carrying it rather than told their record failed.

---

### Perception ingestion — reading a file the platform holds

Drawing take-off, title-block reading and voice capture were three rows on the
gap matrix and they are one problem: take a file, ask a model that can actually
look at or listen to it, and turn the answer into something a person confirms.
`backend/src/engines/perception.ts` is that pipeline; the tasks differ only in
prompt, schema and where a confirmed answer goes.

It became possible only once the object store existed. Before it, the platform
held a hash and not the file, so there was nothing to show a model — the
title-block path worked from `rawTitleBlockText`, meaning somebody had already
read the drawing by hand.

**Nothing here invents an extraction, and that closed a live defect.** The local
adapter derives its answers from a hash of its inputs; it cannot read a drawing.
Asked to anyway it returns a confident, deterministic, entirely fictional title
block — and `registerDrawing` used to write it into the register as
`UNPARSED-<id> / Untitled / P01 / GENERAL`. On every `AI_MODE=local` deployment
that fabrication was the *only* possible outcome, and the resulting drawing could
never be superseded, because supersession keys on the number. An adapter now
declares whether it is multimodal, a perception command against one that is not
is refused with the reason, and `registerDrawing` throws `TITLE_BLOCK_NOT_READ`
rather than filling the fields in.

**An extraction is a draft, never a record.** `PERCEPTION_DRAFT_PRODUCED` is
AI-authored and goes no further. Confirming it runs the ordinary domain command —
`registerDrawing`, `runTakeoff`, `captureSiteObservation` — with the same
authorisation, the same phase gate and the same events a person typing the values
would trigger. The authority to start an extraction and to confirm one is the
authority the *downstream command* exercises, following `approveProposal`'s
precedent, rather than a second permission model for the same writes. Corrections
are recorded separately from what the model returned, which is the field a
take-off argued over in three years is answered by. A rejected draft is kept:
"the machine read this and we did not agree" is exactly the question asked later.

**The file goes to the provider as media.** `ProviderRequest.media` carries the
bytes and each adapter places them where its own API expects — an `inline_data`
part for Gemini, an `input_image` block for OpenAI. Base64 stringified into the
text prompt would be the same bytes charged at text rates and read by nothing,
and the built request bodies are asserted in the suite for exactly that reason.
The cost estimate counts the media, so a large file is not quoted at a small
file's price.

**Not verified against a live provider.** The remote adapters are written to both
vendors' documented multimodal shapes and exercised against a stub. No call to
OpenAI or Gemini has been made from this environment, and nothing above should be
read as saying one has. What *has* been run end to end, in the suite, is
extraction → draft → correction → confirmation → registered drawing, and in a
browser, the honest refusal that a local deployment gives instead.

---

### Signing — a witnessed signature, and it says so

`backend/src/signing/signature.ts`. The blueprint listed e-signature as a
connector to SignWell or DocuSign. It is built here instead, on `node:crypto`
Ed25519, because a signing service would have broken two settled decisions —
zero runtime dependencies, and secrets that stay on the server — and neither
needed bending. What a signing service sells beyond a signature is a certificate
authority relationship this platform is not in, and pretending otherwise is the
one thing that would actually matter.

**What a signature here proves, stated on the record rather than implied.** The
platform holds the key. A signature attests that an identity the platform
authenticated, with multi-factor satisfied, affirmed a named document — by its
content hash — at a recorded time, in their own words, and that the attestation
is in an append-only chain. It does **not** attest that a key under the
signatory's sole control was used, because there is no such key. Under eIDAS and
its UK equivalent that makes this a *simple* electronic signature with unusually
good evidence behind it — admissible, and what the overwhelming majority of
construction documents are signed with in practice — and not an advanced or
qualified one. Every record carries `assurance: WITNESSED_BY_PLATFORM` and a
sentence saying so, so nobody has to have read this file.

The rules, each with a test that tries to break it:

- **A key is configured or signing is refused.** An ephemeral key generated at
  boot would invalidate every signature the platform had ever made on the next
  restart, silently. `SIGNING_PRIVATE_KEY_PEM` unset means requests are refused
  at the request, not at the first signature — a request raised where it could
  never complete reads as progress and produces nothing. A key that is not
  Ed25519, or not a key at all, is refused the same way.
- **You cannot put to signature a document the platform cannot show anybody.**
  The bytes must be held, not merely hashed. A signature over the hash of a
  document nobody has is a signature over a number — which is precisely the state
  the whole platform was in before the object store existed.
- **What is signed is a statement, canonicalised.** Request, document hash,
  purpose, signatory, tenancy, project, time and assurance. Every field is there
  because dropping it lets a signature be lifted somewhere it does not belong,
  and each one is asserted to change the signed bytes. Canonical ordering means
  verification is reproducible by anyone holding the record and the public key,
  which travels on the signature so a later key rotation cannot silently
  invalidate what it signed.
- **Multi-factor or no signature.** The strongest thing this ceremony can assert
  about who signed; without it a signature is made by whoever had the password.
- **Only the people who were asked, once each, with something actually said.** A
  blank affirmation records a click.
- **A refusal is a record and it ends the request.** Somebody refusing to sign is
  a materially different fact from nobody getting round to it, and a half-signed
  document left open reads as progress toward an agreement that is not coming.
- **The register verifies as it reads.** Every signature is re-checked against
  the public key when the screen is drawn rather than trusting a stored flag: the
  record's value is that it can be checked years later, and a check nobody runs
  is a check that does not work.

Signing takes *read* on the document's capability area, not approve. That was
briefly `A` and it was wrong in a way worth recording: a quantity surveyor holds
`PAYMENT_APPLICATIONS` create and not approve — they prepare the application, the
employer certifies it — so requiring approve meant the person who prepared a
certificate could not put their name to it. The authorisation that decides *who
signs* is the request, made by somebody who does hold create in the area; what is
checked at signing is that the signatory may see what they are signing.

Signatories are resolved from the ownership map rather than typed, so a request
goes to whoever actually holds approval in that area today — naming them by hand
is how a certificate goes to somebody who left in March — and an area with nobody
seated says so in the picker before the form is filled in.

Verified in a browser end to end: a certificate filed and its file stored, put to
signature by the surveyor, signed by the client representative with an
affirmation in their own words, the request moving to COMPLETE and the signature
verifying on the register. None of these events is AI-authorable, which is the
same rule that keeps agents at PROPOSE: a signature is a person agreeing to
something, and nothing else can be the one who agreed.

Regenerate the assets with `node tools/icons.mjs` after any brand change; the
generator parses `logo-glyph.svg` rather than restating it, and refuses any path
it cannot render exactly. The PNG encoder is in that file: `node:zlib` is built
in, so it was shorter than the argument for a dependency. The generator used to
write to `web/icons/`, which nothing had served since the backend/frontend split
— every regeneration since then had been a no-op. It writes to `frontend/icons/`,
where the gateway actually looks.

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

**Stage instances and gate reviews.** A lifecycle stage used to be a string on
the project plus an array of past transitions inside its state. That records
*that* a project moved. It cannot record what was frozen at the moment it moved,
who decided, on what authority, or what was still open when the decision was
taken — which are exactly the questions asked three years later, when somebody
wants to know why the design was signed off with a clash still on the register.

So an occupancy of a stage is now an entity (`StageInstance`) with its own
status machine, and the decision that ends one is another (`GateReview`), in
`backend/src/lifecycle/stages.ts`:

```
StageInstance:  DRAFT → ACTIVE → READY_FOR_GATE → GATE_REVIEW
                              → APPROVED | REJECTED → LOCKED → SUPERSEDED

GateReview:     NOT_READY | READY_FOR_REVIEW
                          → APPROVED | APPROVED_WITH_ACTIONS | REJECTED
                          → SUPERSEDED
```

**Two acts, two people, enforced twice.** Submitting a gate takes `U` on
`PROJECT_SETUP`; deciding one takes `A`. That split makes the permission matrix
carry segregation of duties — a project manager holds `U` and not `A`, an owner
the reverse — and the command additionally refuses a decision from whoever
submitted it, for the roles that hold both. A gate one person can raise and
approve is a formality with a timestamp on it.

**Locking freezes component versions, not a summary.** The baseline hash covers
the exact `refType:refId@version` of every entity that satisfied the gate. "The
design was approved" is not a checkable claim; "these entities at these versions
were approved" is, and it is what lets a later dispute establish whether the
thing being argued about is the thing that was signed off.

**`APPROVED_WITH_ACTIONS` earns its place.** Real gates pass with conditions
attached, and a system offering only approve or reject forces that into one of
two lies: an approval with the conditions recorded nowhere, or a rejection of
work everybody agreed should proceed. The conditions carry across the boundary
they were attached to, with owner and due date, and land as open items on the
stage that follows.

**Ungated moves are marked as such.** `structure.transitionPhase` still exists
and still works; it now closes the outgoing instance as `SUPERSEDED` with no
baseline, because no gate approved it. Only a gate decision produces `LOCKED`
with a hash. A regression is exactly this case and must not look like approval.
Both commands reach one writer — `stages.applyPhaseChange` — so a stage record
cannot drift from the project it describes.

**Re-opening never rewrites.** An authorised re-open supersedes the live
instance and opens a new one carrying reason, scope and authority; the approved
instance it returns to keeps its decision and its baseline exactly as taken. The
decision was made on the evidence available at the time, and editing it destroys
the only record of what was actually known.

**The last phase is reviewed, not exited.** Operations runs for thirty years and
has no terminal gate: it is assured annually and at each change, refurbishment
or replacement. An approval there locks the period reviewed with its baseline
and opens the next, writing no phase transition — a transition in the project's
history that nothing corresponds to is worse than no record, because it is a
phase change somebody will later try to explain. This was found by driving the
API rather than the unit tests: the check used to sit *after* the decision
event, so at OPERATIONS it wrote the decision and then threw, leaving a review
marked APPROVED with its actions carried nowhere while the caller was told
nothing had happened. Every reason to refuse now precedes every write.

Six event types were added to the closed catalogue, all `aiAllowed: false`. An
agent that could record a gate decision would be an agent that could approve its
own proposals, which is the one thing the governance model exists to prevent.

What this does not have yet: a curated console panel. The four write routes are
reachable through the generated command catalogue, which is a real door and is
what `doors.test.ts` checks — but a gate review is a governance ceremony, and
deciding one through a generated JSON form with a `gateReviewId` text box is
poor. `GET /v1/projects/:projectId/stages` has no view at all.

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

**The right to erasure, against a ledger that cannot be erased.** UK GDPR
Art. 17 gives a data subject the right to have their personal data erased;
Art. 17(3) withdraws it where processing is necessary to comply with a legal
obligation or to defend legal claims. A construction record is inside both —
CDM 2015 and the Building Safety Act require the safety file and the golden
thread to be retained, and an adjudication three years later is decided on what
the record says happened and who did it.

So the ledger is not touched. Deleting events would break the hash chain, which
is the thing that makes the record evidence at all. What is erased is the
**identity**: name, email and mobile are replaced with a token that identifies
nobody, and every event keeps referring to the same actor id, so the chain still
verifies and the sequence of who-did-what still reads — it just no longer
resolves to a person. A test asserts the chain still replays as VERIFIED after
an erasure, and another asserts the erased name does not appear in the event
that records the erasure.

A request starts a **30-day grace period** (`ERASURE_GRACE_DAYS`) rather than
acting immediately. The delay is a safety feature: erasure is irreversible, and
without a window whoever holds a stolen session can destroy an identity that a
competent person's approvals are recorded against. The seat is revoked at once,
so the account stops working and stops being billed for. The mandatory
`privacy.account_deletion_requested` notice goes to the real mailbox, which is
what lets the true owner stop it.

Reachable at `/app/account` by **every** signed-in identity, outside the
capability matrix — asking to be erased is not a permission somebody else
grants you, and the mobile stores require the route to exist. What the screen
says is kept and removed is read from `GET /v1/me/erasure`, so the wording
shown before the button is pressed is the same rule the platform applies.

**Procurement takes input, and no console form can be dead.** Tender &
Procurement had no input surface at all: raise an enquiry, issue it, record a
submission and award were API-only. All four are now on the page, drawing their
options from records that exist — packages from the scope, suppliers from the
register, submissions from what came back.

They are permission- and phase-gated like everything else, which is visible
rather than hidden: on the seeded project, which sits at OPERATIONS, all four
read *"Procurement award cannot be written during the Operations phase"*. That
is the lifecycle gate doing its job, and it is also why a reviewer looking at
the demonstration project concludes there is nowhere to put information in —
**the seed ends at the end of the lifecycle, so most write surfaces are
correctly locked when the console is first opened.**

`consoleforms.test.ts` now checks every path the console calls against the route
table. It found a dead one immediately: the procurement supplier picker was
written against `/v1/supply-chain/suppliers` when the route is
`/v1/supply-chain`, and because the fetch carried a `.catch(() => [])` the page
rendered perfectly with an empty picker and no error. It also holds a floor
under the number of input forms and evidence fields, so a module cannot quietly
stop accepting work.

**The portfolio position is computed, not assembled in a browser.** The console
built its enterprise view by listing projects and then fetching entities per
project — an N+1 that put the aggregation rule in the client, where nothing
tests it and every page wanting the same number computed it again slightly
differently. `GET /v1/enterprise/command` computes it from the ledger under the
governance capability, so a delivery role holding project access does not
thereby hold a view across the business.

Three things it refuses to do, because each produces a wrong number that looks
exactly like a right one: it does not count a project with no published CVR as
zero (it reports coverage — how many projects each figure is built from —
before the figure); it does not average across projects that cannot contribute
to the average; and it does not sum two currencies, reporting `null` instead so
the console has to say "mixed".

**The enterprise can add to its own estate.** The same page could read the
portfolio and not create anything in it: `POST /v1/portfolios` and
`POST /v1/projects` existed with no console entry point, and the only place a
portfolio's `enterpriseId` appeared was inside a portfolio that already existed.
`GET /v1/enterprises` publishes it, and both commands are on the Enterprise &
Portfolio page behind `ENTERPRISE_STRUCTURE:C` — locked with a stated reason for
a role that does not hold it, in the same way as every other command bar.

Two vocabularies were closed at the same time. `location` on a project was an
unvalidated object, so `continentCode` accepted `EU`, `Europe`, `europe` and
`eu` in one tenancy and no estate view could group on it; it now validates
against `CONTINENT` — six regions, `AM` for the Americas — with the same
argument that closed `currency`: the ledger is append-only, so each bad value is
permanent. And `SECTOR_GROUPED` gives the nine ONS sectors three `<optgroup>`
headings, so a reader looking for **Building** finds it without a tenth code
being added that overlaps three of the others. The stored value is unchanged.

Verified against a running server: a project created in Columbus, Ohio at
`continentCode: 'AM'` in USD; `continentCode: 'Americas'` refused with a
per-field problem+json error; and the estate's contract-value card switched to
"mixed currencies" rather than adding dollars to pounds.

**4× everywhere, and no rate below it.** Confirmed as a pricing decision and
applied through the whole billing path.

Three things were carrying a 3× assumption. The **volume bands** stepped
4.0 → 3.6 → 3.3, so a large consumer paid below the headline; they are now flat
at 4.0. The table is kept rather than deleted, because `effectiveMultiplier`
reads it and every charge is stamped with the rate it was raised at — a band
reintroduced deliberately would show up in the operator's realised multiplier
rather than hiding in a total, and deleting the mechanism would mean rebuilding
it blind. The **go-to-market documents** advertised a 3× markup and are
corrected. And the **ACU bundles** hardcoded 10,000 / 40,000 / 110,000 usable
ACUs — the figures a 3× markup produces — while billing ran at 4×.

That last one is the one worth reading. No money was misposted: a top-up credits
the price and spend is billed at the effective multiplier, so the figure only
ever appeared on the pricing catalogue. That is exactly what made it worth
fixing — a promise to a customer the billing engine was never going to keep, and
the customer would have found out when the bundle ran out a third early. The
yield is now derived from the multiplier, floored at the profit rule, so the two
cannot disagree again. (At the 4× rate that was £300 for 7,500 ACUs; the rate
has since moved to 5× and the catalogue followed it without an edit, which is
what deriving the yield bought — see the rate change recorded below.)

A consequence follows and is stated rather than hidden: with a flat multiplier
every bundle is the same value per pound, so a bundle is a convenience — fewer
transactions, one purchase order — and not a discount. Four tests asserted the
old ladder and were rewritten to assert the new rule, which is the stronger one:
switching the volume incentive on must now change nothing at all, because a flag
that silently discounts is how a sub-4× rate would come back without anyone
deciding it should.

**Permits to work, gated on the competency register.** The register existed —
qualifications with issue and expiry dates, marked `EXPIRED` on read — and
nothing consulted it. A permit could name an operative whose confined-space
ticket lapsed eight months ago, and the platform would record it as a control.

This is the one command in the codebase that **refuses rather than records**,
and the exception is deliberate. Everything else preserves the record and flags
the problem, because a refused write is evidence destroyed. A permit is
different: the permit *is* the authorisation. Issuing one against an expired
ticket does not document a risk, it creates the very authority the ticket was
the basis for. There is nothing to preserve, because the thing being written is
the harm.

Expiry is checked against the permit's own end date rather than today. A ticket
valid this morning that lapses on the Wednesday does not cover a permit running
to Friday — the failure a today-check misses entirely. Every named operative is
checked, not the first: a gang of six where the fifth ticket lapsed is the
realistic case. An activity accepts any of the qualifications that recognise it
(work at height is IPAF or PASMA or a general ticket, not one card), and the
requirements are published so a form can explain a refusal rather than just
issue one.

Three other second-tier gap-matrix items turned out to be **already built** and
were not rebuilt: CVR completeness confidence (computed in `publishCVR`, alerted
on when low, shown in the console), negotiation delta between the adjudicated
figure and the executed subcontract (`negotiatedValueMinor` on award), and
sequential correspondence numbering (markup → instruction).

**Late design information is priced.** The design centre could say how many
RFIs were overdue and by how long; it could not say what that was worth, which
is the only form in which the number reaches a commercial conversation.

What the endpoint refuses to fabricate is the load-bearing part. An RFI carries
a discipline and a linked drawing and **no activity reference**, so nothing in
the record proves which RFI sits on the critical path. A figure that assumed
every overdue RFI delays completion would be a large confident number built on
an assumption the data does not support. So the exposure is reported as
conditional and bounded — what the *worst single* RFI costs *if* it sits on the
critical chain, at the contract's own damages rate — and the qualification
travels with the figure rather than living in a comment.

Float is subtracted first, because days absorbed by float cost nothing; that is
what float is for. And the response names the one change that would make it
exact: an activity reference on an RFI turns every figure from conditional into
computed, which is worth more than any refinement of the arithmetic.

Three overdue RFIs at 30, 20 and 10 days are not sixty days of delay. The
exposure takes the worst, never the sum — a test asserts it, because summing is
the arithmetic that produces an eye-catching wrong number.

**Contra charges, and the notice that decides whether they are money.** The gap
matrix listed the purchase ledger as absent; most of it was not.
`ledgerPosition` already gave committed against certified against paid, with
retention held and a three-type exception queue. What was genuinely missing was
set-off.

`raiseContraCharge` records a deduction against a subcontract, and the rule it
enforces is the one that decides whether the money is recovered. Under the
Construction Act a payer may not pay less than the notified sum without a valid
pay less notice given in time, so a contra raised without one is not a deduction
— it is an intention to deduct, handed back at adjudication and then chased
separately. Contractors lose this argument on the notice rather than on the
merits: the charge is usually justified and the notice was late.

So enforceability is **computed, not supplied** — a field the caller could set
is a field the caller sets to true — and an unnotified charge is recorded rather
than refused, because refusing would destroy the evidence of the cost, which is
what is needed to recover it by the route that remains open. A notice that
exists but is ineffective (late, or with no basis of calculation) gives no
effect either, and the console offers only effective notices in the picker.

Both figures reach the commercial ledger. £180,000 charged reads as £180,000
recovered; if most of it was raised without a notice, that is a debt claim
rather than a deduction, and only one of those belongs in a forecast.

Adding the entity caught its own omission: `entityAccess` had no classification
for `ContraCharge`, which would have left it un-withholdable in the audit feed
and the change window. The suite failed on it before anything shipped.

**Every obligation cites the clause that created it.** The calendar knew what
was due and when, and cited the contract as a whole. That is enough to work from
and not enough to argue from: a contract administrator challenged on a retention
release answers "clause X16.2", not "the system said so".

`contractClauses.ts` maps each obligation to its clause under JCT 2016, NEC4,
FIDIC 2017, IChemE and MF/1. It is a table rather than an extraction because the
fact is about the standard form, not about the words on a page — a JCT contract
with an amended clause 4.20 is still JCT, and the register has to point at the
clause the parties would turn to. Two refusals: **BESPOKE is empty**, because a
bespoke contract has whatever numbering its drafter chose and a confident wrong
citation is evidence that gets quoted in a letter; and an obligation a form does
not have is left unmapped rather than pointed at the nearest thing — NEC has no
loss and expense, it assesses a change to Defined Cost. Where a project runs two
different standard forms nothing is cited at all.

`GET /v1/projects/:projectId/contracts/:contractId/terms` reads the executed
contract as a position rather than as fields. It resolves percentages into money
— nobody argues about a percentage, they argue about the sum — durations into
the dates somebody has to diarise, and derives the figure no field carries: how
many days of delay the LD cap buys. On the seeded NEC4 contract that is £12.5K
per day against a £2.05M cap, so **164 days**, which is what decides whether
damages are a deterrent on a project that size. It also names the obligations
the form has no clause for, because one that cannot be argued from a clause
number is exactly the one worth knowing about.

**The AI says who it is, and the queue says whose it is.** Two halves of the
same defect: the behaviour was already role-specific and the presentation was
not.

`ENGINE_CONTRACTS` now carries a `name` alongside the purpose and phases, so the
copilot can say "Commercial analyst — say where the margin is going" rather than
`RESOURCE_COST`. The engine codes are the platform's, not the industry's; a QS
asked to trust a database column is being asked the wrong question. The console
lists every mode before the question is typed, with what each reads and whether
a charged run of it is bound to this phase.

That last column was mislabelled on the first attempt and the fix is worth
recording. It read "Available", which contradicted the product: a QS asking
about margin at OPERATIONS gets a real answer grounded in the final account,
even though `runAI` would refuse a charged commercial run in that phase. Asking
reads project state and spends nothing, so there is no charge to gate. The
column is about charged engine runs and now says so.

`pendingProposals` marks each item `mine`, read from the raising agent's own
mandate, which already names the roles that may approve it. Nothing new is
asserted and no capability is granted — approval is still checked at approval.
Ordering is mine-first, then severity, then oldest: severity ahead of ownership
was what made the panel unusable, putting another role's urgent item above the
reader's own overdue one. Verified as the QS on the seeded project: two items
theirs, nine for other roles, and their INFO item correctly sorts above another
role's URGENT one.

An item that is not yours is **marked, never hidden**. A queue that filtered by
role would make a stalled design decision invisible to everyone except the
person already not acting on it.

**The operator can see spend across the estate, and what it really earns.**
Each tenant's wallet knew its own position and nothing put those positions side
by side, which left the platform centre unable to answer the question the
commercial model depends on. `GET /v1/admin/burn` reports four figures, each a
different question: **runway** per tenant (null where a tenant is not spending,
never a large number that reads as the healthiest account on the estate),
**realised multiplier** across the estate, **concentration** — the share of
revenue from the largest single tenant, which the arithmetic alone never
reveals — and **absorbed margin**.

Absorbed margin was found by running it. The seeded estate reported a realised
multiplier of 3.806x against a configured 4x, which looks like a
misconfiguration and is not: `settle()` caps a charge at the amount held, so a
customer is never billed above what was reserved and disclosed, and an execution
that overruns its estimate costs the platform the difference. The figure
reconciles exactly — `(784 + 40) / 206 = 4.000` — and it is an
estimation-quality signal rather than a leak. Without it the low multiplier
invites the wrong diagnosis and the wrong fix.

The view keeps the same boundary as the tenant estate view: spend and margin
only. An ACU entry names a module and a feature, both billing facts, and never
the content of the work that produced the charge.

**The estate answers "what changed" and "when will it finish".** Both existed
per project and neither was aggregated, so a portfolio reader learned them one
project at a time.

`GET /v1/enterprise/changes` windows the ledger across the tenancy and **counts
rather than lists** — every event in a tenancy for a week is thousands of rows
and answers nothing. Grouping is read from the event catalogue's own
`EventGroup`, so a new event type lands in the right group without
`portfolio.ts` being touched, and the busiest group sorts first because what
moved most is what to look at. Access is evaluated per event with the same rule
the audit feed uses: an event whose entity the caller may not read is **counted
and marked withheld**, never described and never dropped. Against the seeded
estate an enterprise admin sees 361 movements with 29 withheld in delivery and
11 in governance — the entity-access boundary holding inside an aggregate.

Tenant-level governance commits against a `{tenantId}-governance` pseudo-project
with no entry in the project list, so it was labelled with a raw identifier
until it was named. Not cosmetic: the reader could not tell governance from a
project they had never heard of.

`GET /v1/enterprise/forecast` runs the completion simulation per project and
counts how many miss their contractual date at P80, with the contract value of
those projects. **It does not simulate the portfolio.** Two projects do not
share a critical path, so a combined distribution has a confidence interval and
no referent. It also states its own precision — iterations per project — because
a forecast whose precision is unstated invites more confidence than it earned.

One correctness trap found while verifying it: CPM answers in working days and a
project's dates are calendar dates, so comparing them directly flatters every
project on the estate by about forty percent. The contractual span is converted
at five days in seven, stated in the code rather than left implicit. Public
holidays are ignored deliberately — at portfolio level the question is whether a
project misses its date at P80, and eight days do not change that for a project
hundreds of days out. `businessDaysBetween` remains the exact reckoning where
exactness is the whole question, as it is for a statutory payment deadline.

**Every actionable item can name a person.** The permission matrix resolves a
*capability* — it says a planner may approve a baseline. It does not say which
planner, and an item that names nobody is an item nobody picks up. `ownership.ts`
resolves the same matrix against the tenancy's named identities, published at
`GET /v1/ownership`.

The ordering rule is the design decision. Holders are ranked by how many areas
their role holds **that permission code** in, narrowest first. Counting every
area a role touches was the obvious version and does not discriminate — PM
touches 22 and OWNER 21, so one area of noise would decide who a screen names.
Counting approvals separates them properly: a baseline names the planner
(approves in one area), escalating to the PM (eight), with the client behind
both (ten). That is the real chain of authority on a project, and it falls out
of the matrix rather than being asserted.

Two refusals. The platform operator is never named against a delivery decision
even where the matrix would allow it, because that account layer is deliberately
blind to delivery. And an area with no approver is classified rather than left
blank: `SEAT_GAP` where roles approve and nobody in the tenancy holds one — a
queue that cannot drain — against `NOT_APPROVABLE` where nothing in the area is
approved at all. An audit feed is read; reporting it as a missing seat would
send an administrator looking for a role that does not exist.

**Every AI engine declares when it may run.** The routing matrix says which
provider an engine reaches; it said nothing about applicability, so every engine
was reachable in every phase. A handover engine could be asked to assemble an
O&M manual for a project still at CONCEPT — it would answer, spend the ACUs and
write the answer to a ledger that cannot be edited.

`ENGINE_CONTRACTS` binds each of the eight engines to a purpose, its declared
inputs and outputs, and the lifecycle phases it is active in. `runAI` refuses an
engine outside its phases **before** anything is reserved or charged, and
`/v1/ai/control-plane` publishes the same table so the console can grey out what
does not apply rather than offering it and failing. `EXECUTIVE` is unbound on
purpose: a portfolio spans projects in different phases.

**Rate limits that survive a second replica.** The limiter is a token bucket
in a `Map`. For one process that is right; behind a load balancer with four
replicas it is four separate buckets, so the configured limit is enforced four
times over — and the login route, which carries the tightest limit precisely
because it is the brute-force surface, hands out four times the budget.

`GATEWAY_RATE_LIMIT_REDIS_URL` moves the buckets into Redis, spoken directly
over a socket the way `messaging/smtp.ts` speaks SMTP, because zero runtime
dependencies is settled. The refill and the decrement run as one script inside
Redis: doing it as GET then SET across the network is a race under exactly the
load the limiter exists for. Unreachable is a denial, never a fall-back to the
local bucket — the local bucket during a backend outage is the multiplied limit
again, and the outage is when somebody is most likely to be pushing.

Unset, the behaviour is byte-identical to before. `assertProductionSafety`
warns when it is unset in production, because it cannot see the replica count.

The bucket arithmetic is tested against a real `redis-server`, including two
clients sharing one bucket; a fake reimplementing the Lua would be testing the
fake. **The test run starts its own server** — an ephemeral port, persistence
off, killed afterwards — because a test that skips in every run verifies
nothing, and these five skipped in every run. `redis-server` is a binary rather
than a dependency: nothing imports it, `package.json` does not name it, and the
platform still boots with no `node_modules`. `TEST_REDIS_URL` overrides where CI
already runs one. Where the binary is genuinely absent the group still **skips
loudly** and CI fails on the skip, because a green tick against an unexercised
security control is worse than no test.

**The operator console is a command centre, not a status page.** It was four
counters and two tables. Everything an operator actually opens a console to ask —
how much came in this month, where the AI money went, which tenancy loses service
first, is a payment rail silently rejecting webhooks, who is being refused at the
gateway — had to be answered somewhere other than the console, and three of the
four operator write routes had no door in the interface at all. A route only its
author can reach is not a feature.

`GET /v1/admin/overview` (`billing/overview.ts`) counts the commercial position:
tenancies by status and tier, identities and seats, revenue today, month to date,
last month and lifetime, split by how the money arrived, and top-ups raised but
unsettled. `estateBurn` gained a per-day series and a realised provider split.
Both are counted from records the platform already holds; nothing is modelled.

Three properties hold the arithmetic honest, and each is a way a dashboard lies.
**A projection is labelled and shows its working** — the run-rate is month to date
÷ elapsed days × days in the month, and it is *withheld* on the first of a month
rather than extrapolating one day across thirty. **Absence is returned as absence**
— `null`, not zero, so the console can say "no history yet" instead of making a
claim. **A share is of the whole set** — spend with no provider attribution is
named `UNATTRIBUTED` rather than dropped, because dropping it makes the remaining
shares sum to 100% over part of the money. Every day inside the window appears in
the series including the quiet ones, because a series that omits them draws a
rising line out of a flat month.

The console reads it through `frontend/lib/charts.js` — inline SVG, no library,
since zero runtime dependencies is settled and a line over a bounded series does
not need one. The axis is never auto-scaled to invent activity out of zeroes, an
empty series renders its empty state rather than an axis around blank space, and
points are joined straight because a curve through daily figures invents readings
between the days that were measured.

Four write doors now exist where there were none: onboard a tenancy, appoint an
operator, credit a wallet against a received payment, and change a subscription
status. Verified against a running server, not only in tests — every door
exercised over HTTP, including crediting the same payment reference twice and
getting one credit, and the whole page rendered in Chromium with no console
error. `available` on `/v1/ai/control-plane` reports every keyed provider with
its role, so a configured Anthropic key sitting in the failover chain is visible
rather than invisible behind "OPENAI + GEMINI".

**The operator has a governance record, and its boundary is an allow-list.**
An operator can open a tenancy, suspend a paying customer's platform, credit a
wallet and appoint somebody who can do all three. None of it was readable: the
acts were in the ledger, and the ledger was reachable only per project through
routes scoped to a tenant the operator is not in. The most consequential surface
on the platform was the only unaudited one from the point of view of the person
using it. `GET /v1/admin/audit` answers it, and verifies each chain on every
request through the same replay engine the project audit uses — "hash-chained" is
worth saying only if something has walked the chain.

The first boundary was wrong, and the way it was wrong is worth recording. Every
governance act is written to a `<tenantId>-governance` project, so selecting
those projects looked like a clean structural boundary that would hold for
commands that do not exist yet. It is not: that project is where *everything
tenant-scoped* is written, so it handed the operator a customer's portfolios,
programmes, suppliers and bid pipeline. Nine tests passed, because a fresh
`new Platform()` has no delivery data on it to leak. It was found by looking at
the rendered screen, which read "Supplier prequalified · Opportunity qualified".

`PLATFORM_GOVERNANCE_EVENTS` in the event catalogue now names the fifteen acts
explicitly, and anything absent is out of reach by default — the right direction
for the failure to fall, since a missing code is a gap in an audit screen and a
wrongly added one is a customer's work handed to somebody with no business seeing
it. `ACU_CONSUMED` and the cap alerts are deliberately excluded (spend has its own
view and they would bury the fifteen acts worth reading), as are
`PAYMENT_CERTIFIED` and `PAYMENT_NOTICE_ISSUED` — those are Construction Act
payments between a customer and their subcontractor, and the shared word is the
whole trap. The replacement test runs against a seeded tenancy that has actually
done work, and was confirmed to fail on the old filter before being kept.

The estate table now carries lifetime revenue, headcount and administrator count
per tenancy, and the overview separates trial tenancies and counts any tenancy
with no administrator — which should read zero for ever now that onboarding
creates one.

**The product is CONSTRUX.** It was written as "CONSTRUX.AI" in 29 places —
page titles, the OpenGraph card, the JSON-LD organisation name, the manifest, the
boot banner, mail templates, the legal footer and the export branding. Corrected
everywhere; the name is the OS, not a domain suffix.

Separately, `construx.ai` was standing in as the platform's own domain: the JWT
issuer every session is validated against, the `type` URI on every problem+json
response, the Message-ID domain on outbound mail, the public contact address on
the site, and the default sender for both account mail and the newsletter. That
domain is not the company's. It now reads `construxvg.com` throughout, with the
two sender defaults split the way the addresses are actually used —
`contact@construxvg.com` for account mail, `no-reply@construxvg.com` for the
weekly issue. Changing the issuer invalidates any session minted before the
change, which is one re-login.

The test fixtures using `construx.ai` are deliberately left: they exercise the
foreign-sender-domain check, and a domain the platform does not own is exactly
the case that test is about.

**A tenancy an operator provisions is one somebody can get into.** Found by
provisioning one against a running server and then trying to use it. `POST
/v1/admin/tenants` created the tenancy, its subscription and its wallet — and no
identity. Creating a user requires `ENTERPRISE_ADMIN` *of that tenancy*, and a
tenancy seconds old has none, so the operator's own attempt came back 403. The
customer was provisioned, billed, credited with a trial grant, and unreachable.

Nothing said so, which is what made it survive: the estate view showed a healthy
new tenancy with zero seats used, and that is exactly what a legitimate brand-new
tenancy looks like. Public signup never had the defect — it creates the tenancy
and its first `ENTERPRISE_ADMIN` together, because somebody has to be able to
invite the rest. The operator route now mirrors that shape.

`adminName` and `adminEmail` are required rather than optional: optional
preserves the defect for anybody who omits them, and there is no correct tenancy
with no way in. A duplicate address is refused *before* the tenancy is created,
because creating it and then failing on the administrator leaves exactly the
unreachable tenancy this prevents — and leaves it in the ledger. The route
accepts no `roles` field at all; `ENTERPRISE_ADMIN` is decided server-side, so
this cannot become a second door onto the role-escalation prize the user-creation
audit already closed.

Verified end to end against a running server: onboard, the named administrator
signs in, and invites a colleague.

**The deployment can now be asked what it has configured.** `config.ts` held
every flag and `assertProductionSafety` computed the judgements at boot — into a
log nobody reads twice. So the one person whose job is to fix a half-configured
deployment could not see its state without shell access to the box, which is how
a live deployment sat for a day with a payment rail keyed on one side and a
ledger writing to nothing.

`GET /v1/admin/readiness` (`api/readiness.ts`) reports fourteen capabilities:
ledger durability, session secret, operator, authorisation enforcement, evidence
store, signing key, both payment rails, AI providers, transactional mail,
newsletter, shared rate limiter, public address and analytics. Each carries its
state, what that state means operationally right now, and the variables that
govern it **by name**. Critical capabilities that are not configured are listed
as go-live blockers.

Two properties are load-bearing. **No value crosses the boundary** — the report
says whether a secret is set and never what it is, including inside a `detail`
string, and a test searches the whole serialised report for every secret the
process is holding so a future capability that helpfully quotes one fails there
rather than in production. Variable *names* are published deliberately: they are
already in `.env.example`, and an operator cannot fix what they cannot name.

**Half-configured is its own state.** Two states would file a Stripe key with no
webhook secret under either "configured" or "not set", and both are wrong in the
direction that costs money — that deployment takes the payment and credits
nothing. Verified by booting production-mode with exactly that half-rail: it
reported `DEGRADED` and named the two blocking gaps.

Operator-only despite carrying no secret. It is a map of which locks on this
deployment are unlocked, which is the reconnaissance an attacker wants most.

**Both HTML responses carry the policy layer.** The application shell used to
write its own response head, which made it the one page on the server with no
content-security-policy, no frame refusal and no `nosniff`. A console whose
buttons certify payments and approve baselines must not be framable. Found by
reading the headers of a running server, not by a test — no test asked. Inbound
`x-trace-id` is now validated before it is echoed back and written into every
log line; a value carrying a header separator used to turn the request into a
500 from `writeHead`.

### The chain, and the exception when it breaks

Bid → Contract → Subcontract → Commitment → Application → CVR is one enforced
data flow. Every other check in `domain/consistency.ts` compares two records
that *disagree*; this one looks for a record that is **unattached**.

An orphan is quieter than a disagreement and worse. A disagreement is two
numbers that do not match, and somebody eventually notices. An orphan looks
entirely correct on its own screen and simply never reaches the screen
downstream: money committed against nothing, an application outside every cycle,
a CVR whose contract sum came from a place no longer traceable.

Six links, checked by reference rather than by count — "six subcontracts and six
packages" proves nothing about whether they are the same six:

| Link | Downstream record | Field | Upstream |
|---|---|---|---|
| Contract from the winning bid | `Contract` | `sourceBidPackId` | `BidSubmissionPack` |
| Subcontract from the awarded enquiry | `Subcontract` | `rfqId` | `RFQ` |
| Commitment against a subcontract | `Commitment` (type `SUBCONTRACT`) | `contractId` | `Subcontract` |
| Payment cycle against the contract | `PaymentCycle` | `contractId` | `Contract` |
| Application against a payment cycle | `PaymentApplication` | `cycleId` | `PaymentCycle` |
| CVR from the contract | `CVR` | `contractId` | `Contract` |

**The field names are the ones the engines write, which is not always the name
the link suggests.** A `Commitment` names its subcontract in a field called
`contractId`, because a commitment can stand against either. The first draft of
this check asserted `estimateId` on a Contract and `subcontractId` on a
Commitment — plausible names that exist nowhere in the codebase — and would have
reported a complete break on every correctly connected project. Caught by
reading `procurement.ts` and `cost.ts` rather than by trusting the shape of the
requirement.

**Absent and dangling are both breaks, and they are different mistakes**: one was
never linked, the other points at something that is not there. A check that
caught only the first would pass a commitment whose subcontract has since been
superseded.

**A link with no upstream at all is skipped, and said to be skipped.** A contract
on a job that was never tendered through CONSTRUX is negotiated or novated work.
Calling that a broken chain would fire on every imported contract on the first
day and teach people to ignore the check, which is the same as not having one.

**One defect fixed at source rather than reported.** `publishCVR` reads the
contract to get the sum and never recorded which one, so a published CVR could
not name the contract sum it started from — and `consistencyReport` reads the
*latest* executed contract where `publishCVR` reads the *first*, so on a project
with a supplemental agreement the two were not necessarily the same document.
The CVR now carries `contractId`.

**Escalation is separate from detection, deliberately.** `consistencyReport`
stays read-only: opening a screen must never be the act that alerts somebody, or
every dashboard refresh becomes an escalation. `escalateChainBreaks` is the
other half — it writes a `ChainException`, and the console offers it as a button
on the panel that shows the findings.

Three properties make it an exception rather than a repeated complaint. It is
**recorded, not only sent**, because an alert that exists in an inbox and nowhere
else cannot be shown as open or closed and cannot be counted. It is **raised
once** — an escalation that re-fires on every sweep is one people filter to a
folder, and then the one that mattered goes to the folder too. And it **closes
itself** when the link traces again, so an exception left open is evidence of a
break that is still real.

Addressed to `COMMERCIAL_MANAGER`, which is the holder A1 Rule 2 names, with
`PROJECT_DIRECTOR` alongside it because a commercial manager is not guaranteed to
exist on a small job and an exception with no recipient is not an exception. Where
a tenancy holds neither, the API says so in the response rather than reporting a
successful delivery to nobody.

**Not built: a background sweep.** The exception is raised when somebody asks for
it — from the console, or by calling
`POST /v1/projects/:projectId/consistency/chain-exceptions`. Nothing runs it on a
timer, so a break on a project nobody opens is detected but not yet escalated.
The scheduler pattern exists (`messaging/newsletter.ts`); wiring this to it is a
separate piece of work and is not claimed here.

### The Build Standard on the delivery screens

Two of its clauses were met on exactly one screen — the operator console — and
on none of the screens a project person actually works in. Both are now met on
all ten delivery screens: the command centre, commercial, programme, contracts,
procurement, design, field, risk, handover and control.

Both were failures of **reach** rather than of machinery, and that is worth
saying because neither fix built a new subsystem. The ledger has held the events
behind every figure since it was written, and there was no way to ask it from a
tile. The agent fleet has produced findings with evidence, proposed commands with
their cost, and mandated approvers, and all of it lived on the autopilot queue —
the screen somebody opens once they have already decided to look at what the
agents found. Which is backwards: a recommendation is worth something at the
moment somebody is looking at the number it is about.

**Every KPI opens to the events behind it.** `frontend/lib/drill.js` and one
delegated listener; `metric({ sources })` for a plain tile and `drillable()` for
one whose inner markup does not fit that shape. The tile hands the drill the same
array of records it added up — not a query, because a query is a second
description of the calculation and the day one changes without the other the
drill starts lying. `GET /audit/events?refs=Type:id,Type:id` narrows the feed
the audit trail already uses, so there is one place where an event's content is
authorised rather than two. Refs split on their **first** colon only: a ULID
carries none but an imported reference might, and splitting on every one would
truncate the id and return another record's events.

Content the reader may not see is withheld and marked, never dropped — a drill
that silently omitted those rows would be a way round the capability model.

**Four tiles are deliberately plain**, each for a stated reason. The Golden
Thread event count would open the whole ledger, which is what the audit screen
is. The control screen's Gaps, Not-at-this-size and Not-tracked tiles all count
the *absence* of records. An affordance that opens empty is worse than none.

**One defect fixed at source.** `evaluateControl` filtered the ledger for each
control item and kept only `.length`, so "4 of 5 in place" could not be opened.
It now carries the refs it found, capped at 25 with the truncation stated rather
than silently applied.

**Every command centre carries the AI Insight / Recommendation panel**, scoped by
capability area and filtered by the server — so the narrowing is one rule the
product shares and a screen cannot quietly widen it.

A proposal with a command is placed by the area that command exercises. An
observation — most of what the fleet produces — is placed by the areas of the
records in **its own evidence**, read from `ENTITY_ACCESS`. Placing observations
by the raising agent's *read mandate* was the first attempt and it is far too
loose: an agent that reads eight areas appears on eight screens, and a handover
finding landed on the field command centre because the handover agent reads
quality data. An agent reading something is not the same as a finding being about
it. Caught by looking at the rendered panel, not by a test.

Two of the four actions had to be built.

**Mitigate** closes a finding that was right and is being handled another way.
It is not a softer rejection, and the distinction is the point: rejected means
the finding was *wrong*. Most findings on a real project are neither approved nor
wrong — an agent proposes re-sequencing and the manager has already agreed a
different recovery — and without this that outcome had to be recorded as a
rejection, which is a lie about the finding, or left open, which fills the queue
with things somebody has already dealt with. The statement of what is being done
instead is mandatory: `MITIGATED` with nothing behind it reads as a control and
is a shrug.

**Assign** names who will decide it and leaves the proposal **open**, because
moving something to somebody's name is not dealing with it. The assignee is
resolved from the tenancy rather than taken from the request, and must hold a
role that can actually decide it — an item assigned to somebody who cannot act
looks owned and cannot move, which is worse than an unassigned one.

`ownersByRole` was added beside `ownersFor` for the same reason the observation
rule changed: asking the wrong question returns nobody. `ownersFor` resolves a
*capability*, which is right when there is a command to run. An observation has
none, the first version invented `EVIDENCE_AUDIT` approve as a fallback, and no
role in the matrix holds it — so every observation reported that it could not be
assigned to anybody.

**Reject is kept**, though it is not among the specification's four. A finding
that is simply wrong has to be recordable as wrong, or every incorrect finding is
closed as "mitigated" and the platform loses the only signal it has about whether
its own findings are any good.

Emphasis follows what the item offers: with a command, Accept is primary; without
one the card says there is nothing to run and Review is primary instead. Making
Accept the loudest button on an item that runs nothing teaches people the
emphasis means nothing.

**Found while doing this, and fixed: the programme screen's command bar had never
worked.** `moneyOf` in `frontend/pages/programme.js` returned on its first line,
and the entire `COMMANDS` object and the click handler below it were unreachable.
Every button on that screen — create activity, set baseline, raise and clear
constraints, record progress — did nothing. Pre-existing, unrelated to this work,
and reported rather than left: the block is moved back inside `programme()`,
which is the scope it was written for and where every identifier it names is
bound.

### The account layer, enforced at the gateway and enumerated

`projectContext` and `tenantContext` both refuse a platform operator, and both
are reached *inside* a handler — which is after schema validation. So an operator
posting to a customer's quality register got `400 VALIDATION_FAILED`: a refusal,
but the wrong one. It reads as "fix your body and retry" to an actor who is
barred whatever the body says, and it hands the shape of every customer route to
somebody who may use none of them.

The fence now sits in the gateway, on the route **pattern**, before the body is
read. "Every project route remembers to build a project context" is not a
property a codebase can hold — the lineage route already carried its own copy of
the check for exactly that reason.

`accountlayer.test.ts` walks the routing table rather than sampling it: all 176
routes whose pattern names a project, called with an operator's token, each
required to answer 403. A route added next year is in that test the day it is
added. It also asserts the same endpoints answer 200 for a project person, so
the sweep cannot pass on a platform where nothing works.

**One correction, where the platform was right and the test was wrong.** The
first version expected the operator to read `/v1/control/estate`. It is barred,
correctly: estate control measures every one of a customer's projects against the
control standard, which is the widest possible view of their delivery. That it
aggregates does not make it the operator's. The test now asserts the refusal.

### Every published CVR carried two invented numbers

Found by auditing the command centres against the specification, not by a test.

`commercial.js` posted `costToCompleteMinor: 1_193_000_000` and
`accrualsMinor: 47_000_000` — £11,930,000 and £470,000 — hardcoded, on every
publish, on every project, for every customer. `Take EVM snapshot` did the same
with `plannedValueMinor: 590_000_000`.

The forecast final cost is the number that decides whether a job is making money.
It was computed from a cost-to-complete that came from nowhere and then written
to an append-only ledger, where it cannot be corrected — only superseded. CPI and
SPI were computed against a planned value belonging to a different project, and
both render on three screens. Nothing on any of them said so.

Rule 9 of the operating directive names this exactly: *a screen showing invented
numbers is not a finished feature*.

Both are now entered by the person publishing, through the same command panel
every other write uses. Cost to complete opens at the approved budget less cost
to date — derived from records the screen already holds — and the hint says in
terms that this is a starting point and not a forecast. Accruals start blank
rather than at zero, because zero understates cost and flatters the margin.
Planned value is entered from the baseline. The ACU estimate still renders inside
the panel above the button, so the cost is on screen before the commitment, which
is what the confirmation dialog this replaced existed for.

`month` was added to the command panel's field types at the same time. It was
falling back to free text, and the specification requires every calendar input to
be picked rather than typed.

### Voice-first capture on the field screen

The specification calls voice-first an adoption requirement rather than a
convenience, and it was the largest gap on the field screen. The platform could
transcribe a site recording, classify it into one of its own observation
categories, read the location out of it and name who was said to be responsible
— and there was **no way to make a recording**. The entire path existed with
nothing at the front of it: no microphone, audio, speech or dictation code
anywhere in `frontend/`.

`MediaRecorder` and `getUserMedia`, both native. No library — a dependency for
something the browser does is what the zero-dependency decision is about, and an
audio library on a phone on a building site is bytes over a connection that is
already bad.

**Walk and record** is the whole record made during the walk. Four steps, three
of which already existed:

1. **Record.** Level meter, elapsed clock, playback before use, five-minute hard
   stop so a phone in a pocket cannot record for an hour and then fail to upload
   it. Works with no signal at all — nothing in the capture touches the API.
2. **File it**, on its own, before anything is said about it. This was the one
   thing that had to be built on the server (`POST /projects/:id/field/recordings`).
3. **Transcribe.** The existing perception task, with its own ACU cost.
4. **Review and confirm.** The transcript, category, location, action flag and
   owner are all editable, and the confirmation — not the model — creates the
   observation. What the person changed is recorded separately from what the
   model returned.

**Why a recording has to be filable on its own.** Every other evidence file
arrives attached to a command — a photograph with a progress record, a survey
with a measurement — and that is right, because the person already knows what
they are recording. A dictated note is the opposite: nobody knows the category,
the location or the owner until it has been listened to, and the point of walking
and recording is that the structuring happens afterwards. The evidence store
refuses bytes that no ledger record names, so without this there is nothing for
a transcription to read.

That is not a placeholder record. An audio file of a site walk is evidence in its
own right whatever is subsequently made of it, and it is the piece a delay claim
is argued from in three years. It is registered as `SITE_RECORDING` and gated by
the **same lifecycle phase** as `captureSiteObservation`, deliberately — a
recording that could never become the observation it feeds is a record in a dead
end, and the person would find out after the walk, after the upload, and after
paying to transcribe it.

**The container is normalised before the file is named.** Chromium records
`audio/webm;codecs=opus`, Safari `audio/mp4`. The perception task matches its
accepted types by exact string, so a file typed with the codec parameter would be
refused *after* the upload had already happened. Pinned by a test, because it is
invisible from either side alone.

**Dictation is not only on that one flow.** Any `command()` panel that takes an
evidence file now offers "Dictate instead" beside the file input — the
specification wants voice across every field module, and a note is sometimes a
photograph and sometimes a sentence. The dictated file takes the identical path:
prepared, hashed, filed, uploaded, queued on the device if it cannot be.

**Both fallbacks say what happened rather than pretending.** Where the upload
cannot land, the recording is queued and the screen says the audio follows on the
next sync and can be transcribed then. Where the deployment has no multimodal
provider, the recording is filed and the screen gives the provider's own reason.
Neither path silently loses audio, and neither implies a transcript is coming.

**One wording defect found by testing and fixed.** The panel said "Microphone
refused" for every `getUserMedia` failure, including `NotFoundError` — which
means the device is not there. Telling somebody with an unplugged headset that
permission was refused sends them into browser settings to fix something that is
not broken. Refused and absent are now separate messages.

**What is verified and what is not.** The server chain is covered by ten tests.
In a real browser: `voiceSupport()` reports available and picks
`audio/webm;codecs=opus`; the button renders and opens the panel; the refusal
path renders correctly; and filing, uploading and the capability check were all
exercised over HTTP against a running server with a synthesised recording.
**`MediaRecorder` capture itself has not been exercised** — this container has no
audio device, so `getUserMedia` returns `NotFoundError` and Chromium's fake-device
flag does not supply one. That is stated rather than implied: everything
downstream of the `File` is proven, and the capture of the bytes is not.

### The design review cycle

D-WF-03 — design production, check, review and acceptance. The register, the
revisions, the supersession, the clashes and the RFIs were all built. The thing
between them was not: **there was no act of accepting a design**. A drawing
existed at a revision and nothing recorded that anybody had looked at it, said
what was wrong with it, and agreed it was fit to build from.

`backend/src/engines/designreview.ts`. Five closed vocabularies — severity,
disposition, decision, CDE state, and the blocking set — seven routes, 23 tests.

The sequence is **submit → comment → disposition → close → decide**, and every
step of it is a separation of duties at the act, which is how this codebase has
always done it:

- The **author self-checks** before submitting. Twenty characters minimum, and
  it is recorded on the cycle rather than thrown away — the self-check is part
  of the record of what was claimed at submission.
- The **author cannot comment on their own submission**. A check that the person
  being checked can write is not a check.
- The **author dispositions** each comment — accepted, rejected, or an
  alternative proposed — with a response. Only somebody who is **not the author
  closes it**. The person who says a comment is dealt with is never the person
  who said it was dealt with.
- The **submitter cannot decide the review**.

**The one rule that matters most:** a deliverable cannot reach `PUBLISHED` while
a critical or major comment is open — and that holds for **accepted with
comments** as well as for a clean acceptance. Accepted-with-comments is the
status that hides open comments in every system that has one; it is the
mechanism by which a design with a known fire-stopping problem gets issued for
construction. The refusal names the comments it is refusing over.

Revise-and-resubmit returns the deliverable to `WORK_IN_PROGRESS` and the next
submission counts as a further revision. `reviewPosition` reports duration, days
overdue and who it is waiting on — the checker before a decision, the author
while comments sit open.

**The demo had no design approver at all**, which is what building this exposed.
A Design Manager is now seeded (`design@meridian.example`), because a review
cycle with nobody able to decide it is not a cycle.

**Verified against the running system, not only the tests.** Driven through the
real API as the real people — the PM submits, the BIM Manager checks, the Design
Manager decides — in sequence: submit opens the cycle; the author's comment on
their own work is refused `REVIEW_SELF_CHECK`; the checker's critical is recorded
as blocking; accepted-with-comments is refused `BLOCKING_COMMENTS_OPEN` naming
the comment; acceptance after the *author* has answered is still refused;
acceptance after the *checker* closes it publishes. The panel renders on the
design screen with that history.

**Not built, and not to be claimed:** ISO 19650 suitability codes (S0–S7,
A1–A5), model federation as a review input, an automatic review trigger on
drawing issue, and any reviewer rota — the checker is nominated by the submitter.
The CDE state lives on the review cycle; the evidence store itself still has no
containers.

**Open for the product owner:** the engine enforces that the submitter cannot
decide. It does not require the decider to be the `PRINCIPAL_DESIGNER` now that
role exists, so a `DESIGNER` who did not submit may still accept a design. That
may be right, and it may not.

### Tender intake, and the deadline that is not an instant

T-WF-01. The pipeline scored opportunities and decided whether to chase them;
the ITT analyst read an invitation into a compliance matrix with an owner on
every line. **Nothing existed between them** — the moment an invitation actually
lands, which is where the deadline is set and where bids are lost.

`backend/src/domain/tenderintake.ts`, seven routes, 42 tests, and a panel on the
pipeline screen with four commands. Named `tenderintake` rather than `tender`
because `backend/src/engines/tender.ts` is the estimating and pricing engine and
already owns that word.

**Most of the workflow was reused, not rebuilt.** The compliance matrix is
`analyseITT` — its requirement catalogue, owner-by-category table, evidence
probes and commercial-term assessment are called, not copied. The scoring is the
existing ten-factor qualification. The decision is `decideBidNoBid`. The
back-planning calendar is the Construction Act business-day calendar, bank
holidays and all. Three things are new.

**The deadline is a wall-clock reading plus a zone.** An ITT says "12:00 noon on
14 October". *Whose* noon is a question almost nobody asks, and a portal that
closes at noon in Dublin has closed an hour before noon in London. So the
reading and the IANA zone are recorded separately and resolved to one instant,
and everything downstream counts from the instant. Where the invitation did not
state a zone, the assumption made is recorded and raised as a **Critical
clarification** written in the words it would be put to the buyer in — not
defaulted silently.

Twice a year a local reading is not one instant at all. 01:30 happens twice on
the night the clocks go back and never on the night they go forward. Both are
detected and named, and where there is a choice the **earlier** instant is taken:
a deadline resolved early is a bid submitted early, and the other way round is a
bid submitted late. `Intl.DateTimeFormat` does the work — the zone database is
the runtime's, not a copy in this repository.

**A mandatory deliverable needs a source, an owner and an internal date — and a
bid is refused until every one of them has all three.** Not warned about:
refused. A bid disqualified for a missing certificate was priced correctly and
lost anyway, and that is the single most avoidable way to lose a tender. Optional
deliverables are deliberately exempt, because blocking on those would teach
everybody to mark things optional. Declining is never gated: refusing bad work is
what the qualification algorithm exists to encourage, and making a refusal the
expensive option would defeat it.

**An addendum appends.** The original issue is never rewritten, because "what
was the deadline when we planned the bid" is what a late submission turns into a
dispute about. An addendum that moves the date or adds a mandatory deliverable
makes the bid decision stale — and staleness is **derived from the order of the
ledger**, not from timestamps. Both records stamp `new Date().toISOString()` and
two events written milliseconds apart can carry the same millisecond, so `>`
misses a real addendum and `>=` invents one. The append-only log already knows
what came after what; nothing can clear the condition except deciding again.

**The tender programme is back-planned and refused rather than compressed.**
Eight stages from reading the documents to a checked submission, scaled
proportionally to the window with a floor of ten business days, landing exactly
on the last business day before the deadline. Below the floor the platform states
how many days remain and how many the spine needs. A programme that reads as
achievable and is not is a worse answer than "this is not enough time". Work
packages come out of the deliverables and the compliance matrix together — the QS
who owns the pricing schedule also owns the commercial requirements behind it,
and giving them two lists is how one goes unread.

**An override needs the authority it was taken under named.** New refusal on
`decideBidNoBid`: deciding against the algorithm is permitted, and it always was,
but an override with nobody's authority on it is the finding a post-mortem goes
looking for and cannot find. Conditions and recorded dissent sit alongside it.

**Two defects the browser found that the tests did not.**

*The refusal did not read as English.* "has no an owner, no a source in the
invitation, no an internal date" — assembled by joining a list with a separator.
That sentence is put in front of somebody the day before a return, and a mangled
one is how a real warning gets skimmed past. It now reads out loud.

*The console applied the wrong project's phase gate.* Every tender command
showed as locked — "Estimate tender cannot be written during the Operations
phase" — while the API accepted the same commands. The bid pipeline exists
**before there is a project**, and the API runs it against the tenant governance
scope, which has no lifecycle phase. The browser was gating it on whatever
delivery project the console happened to have selected: the browser holding a
rule the server does not, which is the exact drift `blockedReason` exists to
prevent. `can()` and `blockedReason()` now take a `tenantScoped` option. Checked
against every other screen: `BILLING_ACU` and `ENTERPRISE_STRUCTURE` carry no
phase gate at all, so no other screen was affected.

**Both now have a test that fails if they come back**, which is the part that
actually mattered — a defect found by looking at the screen is found again the
next time unless something is watching for it.

The sentence is asserted verbatim. The phase gate has a new static invariant in
`consoleforms.test.ts`, in the same family as the check that every console form
posts to a route that exists: **a page that phase-gates a capability area must
declare at least one project-scoped path.** A page whose every endpoint is
tenant-scoped has no project to take a phase from, so gating on one is always
wrong. It runs over all twenty-three page modules, and it reads the
`{ tenantScoped: true }` idiom by name so the screens can keep declaring it once
rather than four times.

Both were proved by reverting the fix and watching the suite go red — a test
that has never failed is a test that has never been checked.

**Not built, and not to be claimed:** reading deliverables or requirements out of
the invitation *file* — they are supplied structured, one at a time by a person
or in bulk by an agent; a bid-team resource model behind the programme; and any
link from the tender programme to the delivery programme engine.

**Event names.** `TENDER_RECEIVED`, `TENDER_REQUIREMENTS_EXTRACTED`,
`TENDER_ADDENDUM_ISSUED` and `TENDER_PROGRAMME_CREATED` are new and take the
specification's own names. The specification's `COMPLIANCE_MATRIX_CREATED` and
`BID_DECISION_RECORDED` are `ITT_ANALYSED` and `BID_NO_BID_DECIDED` here, already
written to an append-only ledger. They are **mapped, not renamed** — renaming
orphans every record carrying the old name — and a test asserts the mapping so
it stays readable.

**Verified in a browser against a running server**, not only by the tests: the
QS records an ITT with no stated zone and gets the Critical clarification; a bare
mandatory deliverable is recorded and the Owner's decision to bid is refused,
naming it; an addendum moves the deadline and the board shows the re-review. The
panel and the command are screenshotted.

### The settlement meeting, and the bridge that has to reconcile

T-WF-07. `backend/src/domain/settlement.ts`, six routes, 23 tests.

The last two hours before a bid goes out, where the price stops being the
estimate and starts being a decision. Somebody takes £180,000 out of the
preliminaries. Somebody puts the margin up half a point. Somebody says the piling
risk is covered and takes the allowance out. All of it is right or wrong on the
day, and none of it is written down — so when the job is losing money eighteen
months later, the estimate is what gets examined and the estimate is not what was
bid.

Named **settlement**, not adjudication: `adjudicate` in the tender engine already
means choosing a subcontractor from an evaluation, and two acts sharing a word is
how somebody eventually calls the wrong one.

**Five refusals, and every one is a refusal rather than a warning** — a
governance control that produces a warning is a governance control that produces
a warning:

- **The bridge reconciles to the penny.** Pre-settlement, plus every adjustment,
  equals the price being approved. The refusal shows the arithmetic and names
  what the gap is: *an adjustment nobody recorded*.
- **Every action is closed or carried.** Those are the only two honest endings —
  it was done, or it was not done and the bid says so out loud. A carried action
  becomes a condition the submission declares. An action that simply stopped
  being discussed is a third thing, and approval refuses over it.
- **The programme belongs to the price's cut-off.** A price settled against
  addendum three and a programme built against addendum two produce a bid that
  does not hang together, and nobody finds out until the first extension-of-time
  claim.
- **Nobody approves above the authority they hold**, and the refusal names both
  the limit and the value.
- **The person who ran the settlement does not approve it.** Somebody who was not
  moving the numbers has to look at where they ended up.

**Every adjustment carries a reason and a named decision-maker.** A line reading
"-£180,000" is a hole in the price; one that says what came out of it is a
decision somebody can defend or reverse.

**Evidence where evidence exists — a deliberate departure from the clause as
written.** The specification says every manual adjustment requires reason *and*
evidence. Supplier prices, scope corrections and benchmark corrections point at a
document and are refused without one. Margin, contingency and risk allowance are
judgements taken in a room, and demanding a file for those produces a file
attached to satisfy the platform — worse than nothing, because it looks like
proof. The split is stated in the code and in `docs/SPEC.md` rather than left
implicit.

**Not built:** automatic abnormal-rate and coverage detection, resource and
lead-time review driven from the settlement, and the risk and qualification
registers sharing the cut-off explicitly (price and programme do).

---

### Submission, award, and the conversion that must not re-key anything

T-WF-08. `backend/src/domain/award.ts`, five routes, 22 tests.

The bid pack was already compiled and locked with a content hash, and a contract
could already be converted from it. What was missing sat either side, and both
halves are where money is lost.

**Before**: a submission went out and nothing recorded that it arrived. The
portal receipt — the one piece of paper proving the bid was in before the clock
stopped — lived in somebody's inbox. The receipt is now bound to the pack's
content hash, so the record does not say *"a bid was submitted at 11:52"*; it
says **this** bid, these bytes, was submitted at 11:52 and the buyer
acknowledged it. The position reports `hashMatches`, so a pack re-locked after
submission shows up rather than passing silently.

**After**: an award arrived and was signed, and nobody compared it against what
was actually bid. That is where a contract sum quietly differs by £40,000, where
a completion date has moved three weeks, and where the qualification the price
depended on has been struck out. The comparison is now computed, not typed —
because a departure somebody noticed is not the one that costs money — and it is
run at the only moment it is cheap.

**A departure is a difference, not an opinion.** Every one names both values and
says what it means: a sum below the bid, a sum *above* it (which means the client
has priced something we did not), a date that moved and by how many days, a term
harder than the one the price was given on, and a qualification struck out —
which is the single most expensive line on the list, because whatever it
excluded is now inside the contract sum.

**Silence is not a change.** A letter of intent names two terms and nothing else.
Reporting the unstated ones as departures would bury the real ones.

**Nothing here decides whether a departure is acceptable.** A person does, and
the acceptance carries their reason — the question a year later is never whether
the sum differed, it is who agreed that it could. Conversion is refused while one
is still open, which is `AC-T-WF-08-03`: the comparison exists to be acted on
before the money starts moving.

**The budget is not typed.** `AC-T-WF-08-02` asks the contract sum, the budget
and the buyout targets to reconcile to the awarded submission without re-entry,
so the sum comes off the award and the budget's cost codes are the estimate's own
priced cost heads. A budget re-keyed from a spreadsheet agrees with the tender
until the first typo. The buyout target is the **estimate** figure rather than
the budget figure: a package bought at budget has spent the contingency for it,
which is exactly the drift the number exists to catch.

**Converting needs two authorities.** It approves a cost baseline as well as
accepting an award. A project manager holds award approval and not budget
approval — deliberately — so the platform refuses before it writes anything
rather than halfway through.

**Two things found while building it.** A second receipt on an already-submitted
pack was answered with *"only a locked pack can be submitted"* — true, useless,
and hiding what the person needed to know. Already-submitted is now checked
first. And the estimate stores its breakdown as `heads`, not the `byCostCode` the
first draft guessed at; reading the real shape is what makes the budget
reconcile.

**A lost bid is not a dead end.** The market intelligence in a losing bid is the
only thing that pays for it, so a loss records who won and at what, and stays
searchable. Converting one is refused, and the refusal says why.

**Not built:** the deterministic file-name, size and page-limit checks against
the deliverable register at compile time; post-tender clarification cycles; and
the procurement records and mobilisation tasks the conversion could also seed.

---

### The site visit, and what the walk still obliges

A site visit produces a document nobody opens again. Somebody walks the site,
photographs eleven things, writes them into a template, emails it — and eighteen
months later a crane is erected over a boundary nobody agreed to oversail. The
information was never missing. It was recorded and then it stopped being
anybody's problem.

`backend/src/engines/sitevisit.ts`, six routes, 46 tests, and a panel on the
field screen with four commands and a report button. **Not a report generator
with a register attached**: every finding is an obligation with a life, and the
life runs from the walk to handover.

    walk → finding → what it obliges → who owns it → when it is discharged

**A finding that obliges nothing is a note.** Every finding declares what it
does to the job — prices something, sequences something, needs a permission, is
a hazard, changes the design — and one that claims none of those is refused.
That single rule is what stops the register filling with "the site is muddy".

**A finding seen on site needs a photograph.** Not one read out of a planning
consent, and not one the client's agent mentioned — those are recorded with
their source named instead, and the basis of every finding is on the record. An
assertion about a physical condition with no image is the thing that gets argued
about later, and the argument is unwinnable.

**A finding that constrains an activity raises a real constraint.** Not a second
constraints log inside a site-visit module: `raiseConstraint` in the planning
engine, so the lookahead already refuses to commit that activity and the
constraint appears in the PPC trend beside every other one. The walk feeds the
programme rather than a parallel list.

**A permission has a lead time, and a lead time is a programme fact.** A highway
order quoted at 84 days against work starting in three weeks is not a risk to
monitor — it is already late, today, before anybody has applied. `permitPosition`
does that arithmetic from the authority's own quoted lead time and the date the
work it unlocks starts, so the answer is *"64 days late"* rather than *"needs
attention"*. An application that has gone in is not called late merely for being
inside the lead time: the authority may beat its own quote, and crying wolf on
the one register that must not be ignored is how it gets ignored.

**The logistics checks are the ones arithmetic can settle.** The platform does
not draw a logistics plan — a drawing is a drawing, and a picture without the
geometry behind it would be worse than nothing. It records the elements and the
dimensions and runs seven checks, each of them a thing that is missed often and
costs a great deal when it is:

- a crane whose radius exceeds the distance to the boundary **oversails**, and
  needs an agreement from an adjoining owner with no reason to hurry;
- a jib that reaches further than the distance to an overhead line can be slewed
  into it;
- a crane standing inside the network operator's stated exclusion (their figure,
  asked for — never one the platform derived from a voltage);
- the longest delivery against each route's length, height and weight limits;
- a plan with no welfare on it, which CDM 2015 Schedule 2 requires from the
  first day anybody works on site;
- a plan with no gate and no access route, which says nothing about how anything
  arrives.

**Closure is evidenced, and the serious ones are not self-certified.** A finding
that needed a permission or named a hazard is closed under approval authority
and never by the person who raised it — you cannot certify your own goalposts.
Everything else can be closed by whoever did the work, because a two-person
contractor is a real customer and a second signature on a hoarding line would
only teach people to route around the register. The permission matrix already
separates planner from approver; the per-act rule is what holds when one person
holds both roles, which is the ordinary case on a small job.

**Photographs are in the PDF.** `DocumentBlock` gained a `PHOTOGRAPH` kind that
names the image by its SHA-256 rather than carrying bytes — the document model
stays serialisable and hashable, and because the evidence store is
content-addressed the document's own content hash therefore commits to exactly
which image was on the page, which is stronger than embedding it. `renderPdf`
takes a resolver, so the renderer is handed a way to fetch one tenant's bytes by
hash and never the store itself. A JPEG passes straight through as `DCTDecode`
— PDF's image filter *is* JPEG — so nothing is decoded and re-encoded, and each
photograph is embedded once however many times it is referenced. A photograph
the platform does not hold says so on the page rather than rendering as nothing.

**Verified against a running server with a real evidence store**: the walk is
recorded, an observed finding with no photograph is refused, a finding that
obliges nothing is refused, a live 11kV cable raises `CON-0003` against a real
activity, the highway order reports 64 days late, the planner cannot close their
own hazard, the logistics plan returns three criticals and a major, and the
report comes back as a three-page PDF with the photograph embedded under
`DCTDecode`.

**One defect found by opening the PDF and reading the viewer's tab.** It said
*"Site visit report Š SV-001"*. A literal string outside a content stream is read
as PDFDocEncoding, not the WinAnsi the fonts are declared with, and the two
disagree above 0x7F. Pre-existing, and it would have turned "Société Générale"
into noise on every document that client was ever sent. Document-level strings
are now UTF-16BE behind a byte-order mark, which every reader understands; plain
ASCII titles stay readable literals in the file.

**Not built, and not to be claimed:** a drawn logistics plan; a bid-stage walk
(there is no `BID` purpose, because that happens before a project exists and
belongs with tender intake, which is tenant-scoped); multi-crane and multi-route
plans through the console (the API takes them, the modal sets one of each);
photographs in the HTML export, which states the hash instead because that
renderer has no way to serve bytes.

**A site finding is not a site observation.** An observation is about the state
of the work and closes next week; a finding is about the state of the site and
governs the job for years. Both exist and neither replaced the other — asserted
by a test, because the temptation to collapse them is exactly how the long-lived
one would be lost.

---

### Reading the tender documents before pricing them

T-WF-02. `backend/src/domain/tenderreview.ts`, nine routes, 24 tests.

Between deciding to bid and starting to price there is a review nobody records:
what is in the pack, whether it can be relied on, which package carries each
obligation, what the contract actually says, and what the price is deliberately
not covering. It is done — on paper, in somebody's head, in an email thread —
and then the price is built and the reasoning is gone. This makes it an entity
with a frozen snapshot, so the question *"what information was this price built
on"* has an answer with a hash on it.

    documents → validation → scope map → contract → qualifications → freeze

**A pack that cannot be relied on blocks the packages it informs, not the whole
job.** An unreadable file and a citation pointing at something absent are
Critical and stop exactly the packages that document feeds; a price built
against a document nobody could open was built against a guess. The same
document at two revisions is Major and blocks nothing, because a superseded
sheet in a pack is ordinary — it is only *sometimes* wrong, and the register
cannot say which one was priced against, so it says so and stops there.

**One finding blocks everything: a standard form "as amended" with no schedule
of amendments.** That is not a contract form. The amendments are where the
fitness-for-purpose obligation, the uncapped damages and the payment terms live,
so pricing the unamended suite prices a different contract entirely. There is no
package that can be safely priced against an unknown set of amendments, and the
freeze refuses while it stands.

**A gap and an overlap are both expensive, in opposite directions.** An
obligation no package carries gets built and nobody priced it, which costs the
job. One carried by two packages is priced twice, which loses the bid — and that
is the quieter failure, because nobody ever finds out why the number was high.
Both are derived from the mapping rather than asked for, and neither is
auto-resolved: which package should carry it is a commercial decision.

**The contract is held verbatim, and the extractor does not accept their own
extraction.** `wording` carries the clause word for word, because the executed
wording is what binds and a paraphrase is a second document that will be
believed. The freeze is refused while any obligation is still `DRAFT` — an
interpretation nobody independently signed is one person's reading of a
contract. This is not a new control invented here: the permission matrix already
separates reading a contract from accepting an interpretation, so the QS
extracts and the person carrying commercial authority accepts.

**A qualification has to come from somewhere.** Every exclusion and
qualification names the scope gap or the contract obligation it answers, or it
is refused at the point of entry. A qualifications schedule that accumulated by
habit is how a bid ends up excluding something the client asked for and nobody
can say why.

**The addendum impact is computed from the frozen review, not typed.** The
addendum names the documents and clauses it changed; what depended on them —
packages to reprice, obligations whose review is void, qualifications resting on
something that moved — falls out of the mapping already built. Asking somebody
to list the affected packages is asking them to remember a fortnight-old
mapping, which is how one gets missed.

**Not built, and not to be claimed:** reading obligations out of the contract
file itself — they are supplied structured, exactly as in tender intake; any
risk score or likelihood/impact rating on an obligation; and any automatic link
from a qualification into the submitted bid pack's qualifications schedule,
which stays a deliberate act.

**Event names.** `SCOPE_GAP_IDENTIFIED`, `CONTRACT_INTERPRETED` and
`TENDER_REVIEW_FROZEN` are new and take the specification's names.
`TENDER_DOCUMENT_VALIDATED` is an `UPDATE` that may create, so re-validating the
register after a missing document arrives appends rather than being refused as
"already exists" — validation happens more than once by design. Addendum impact
writes `ADDENDUM_IMPACT_ASSESSED`, the name T-WF-06 gives the same act, so there
is one event for it and not two.

---

### The stage gate, and the clause it will not pretend to have checked

8.4. `backend/src/domain/stagegate.ts`, three routes, 25 tests, and a panel on
the Project Control screen. **With this, section 8 of the specification —
all eight tender workflows and the stage gate — is complete.**

The lifecycle already had a gate: `evaluatePhaseGate` counts the entities a
phase cannot be left without, and `transitionPhase` refuses a forward move that
does not clear it. That is untouched, and a test asserts it. This is the
seven-clause Definition of Done on top of it, and the difference between them is
the difference between *"an estimate exists"* and *"this tender is finished"*.

**One rule matters more than any of the seven.** A clause the platform cannot
assess is reported as **unassessable**, never as passed, and it blocks a clean
pass exactly as a failure does. A gate that quietly passes what it did not check
converts a gap into a signed assurance, and the signature is the thing somebody
relies on two years later. This is the same principle the Project Control screen
was already built on — untracked items greyed and excluded from every
percentage, because they are the platform's gap and not the project's — applied
to the gate that governs leaving a stage.

Two of the seven are unassessable today, and each names on the screen exactly
what is missing:

- **AI accounted for.** Every AI output carries its evidence, its confidence,
  its model class and its ACU settlement. **Assumptions, prompt version and
  human disposition were not recorded anywhere in the platform**, so the clause
  could not be assessed in full and said those three words rather than a tick.
  All three are now recorded and the clause passes — see *The three words the
  gate had been saying since the first one* at the end of this file.
- **Downstream created.** The contract, the cost baseline and the buyout targets
  come off the estimate without re-entry. **Mobilisation tasks with owners and
  due dates, and inherited residual obligations, are not built.**

The other five are answered from the ledger. Inputs: the tender review frozen
with no blocked package, every measurement schedule frozen, every enquiry
approved, and no firm holding a pack they never acknowledged. Approvals:
re-verified from the events themselves rather than trusted because the command
refused at the time — which is the point of checking twice, and catches anything
written before a control existed. An approval by `System` or `AI` is as wrong as
one by nobody. Blockers: every critical finding, unchecked reissue, open
material query and open award departure, by name. One cut-off: the comparison
and the settlement must state the same addendum. Replayable: the whole event log
re-verified through `replayProject` against its own state and chain hashes.

**`PASS` is currently unreachable on a tender that used AI**, and that is the
honest state of the product rather than a defect in the gate.
`PASS_WITH_CONDITIONS` is the route through and is the specification's own:
every outstanding clause needs a condition with an owner and a date, because a
condition with no date is a hope and one with no owner is somebody else's
problem. The position reports every condition past its date — the day after
which a conditional pass stops being a pass and becomes a list of things
somebody promised.

**One finding while building it.** The AI clause first reported forty failures.
They were all `AI_EXECUTION_COMPLETED` — the billing record of the call itself,
which correctly carries no confidence and no input refs because it is not a
change the model justified. Counting the accounting ledger doing its job as a
defect would have buried the one finding that mattered. The clause now reads
"AI outputs **used in the decision**" as the specification wrote it.

**Verified against a running server**: a clean pass over an open clause is
refused naming all four, a conditional pass covering only one is refused naming
the three it left uncovered, a condition with no date or no owner is refused,
and a QS cannot decide the gate at all.

**Not built, and not to be claimed:** the same Definition of Done for the other
six lifecycle phases — this is declared for the tender gate; a risk cut-off to
reconcile against the other four; and the mobilisation tasks that would let the
seventh clause be assessed in full.

---

### Buy it or do it, and the three figures that are not the same figure

T-WF-05. `backend/src/domain/pricingroute.ts`, eight routes, 35 tests, and a
panel on the Tender & Procurement screen with six commands. **This completes
all eight workflows of section 8.3.**

Every package is priced twice and one of the two answers goes in the bid. What
was missing is not the arithmetic — it is the three things that make the two
numbers actually comparable.

**Raw, normalised and evaluated are three different figures.** A quotation
arrives on the firm's own basis: their currency, their tax treatment, their idea
of what the package includes. Getting it onto the common basis is
*normalisation*, and it is a **correction** — the same scope, differently
priced. What it costs us to choose that firm — the risk they hand back, the
interfaces somebody has to manage, the management time, the programme — is
*evaluation*, and it is an **addition**. Mixing them produces a number nobody
can defend, because half of it is arithmetic and half of it is judgement. All
three reconcile, for every option, and the tests assert it.

**The normalised figure is read from the return comparison, not rebuilt here.**
`ReturnComparison` already holds the raw returns immutably and every adjustment
against them, each citing a return line or an issued clarification. That *is*
normalisation, and a second register of the same adjustments would be two
sources of truth for one thing. What this adds is the evaluation layer on top
and the decision that follows.

**The self-perform estimate is kept independent of the quotations.** An estimate
built after seeing them is not an estimate, it is a reaction to them, and it
will land just under the cheapest one every time. It also has to state peak
operatives: capacity is what constrains a self-perform route, and one chosen
without it was chosen on price alone.

**An evaluation adder may be negative.** A firm that takes single-point design
responsibility off us genuinely costs less than its price, and refusing that
would push the saving into a fudge somewhere nobody can see it.

**Every exclusion is somebody's cost.** A return excluding scaffold is not
cheaper; it is incomplete, and the scaffold is ours until somebody says
otherwise. Each has to be disposed — priced as an allowance, answered by an
*issued* clarification, or accepted as a project exclusion the client carries —
and an undisposed one makes that route not comparable, withholds the ranking,
and blocks the selection. It is not a report at the settlement meeting.

**A route chosen on price alone is chosen on a quarter of the question.** Cost,
risk, programme and capacity, none of them optional. The cheapest evaluated
option does not have to win — but choosing another has to say so out loud,
because that is the sentence somebody will be asked about, and the position
reports every package where it happened.

**A declared interest is declared before the decision.** Declaring one
afterwards is not a declaration, it is an explanation. And the person who
declared it cannot then make the decision on that firm: declaring and deciding
anyway is worse than not declaring, because it puts the conflict on the record
beside your own signature.

**Verified against a running server**, and the arithmetic tells the story the
workflow exists for: Amey looked £130,000 cheaper than Balfour on the raw
return, and once the scaffold they excluded is priced back in they are the most
expensive of the three options. Self-perform is cheapest on evaluated cost;
Balfour was chosen anyway, and the four bases behind that are on the record.

**One correction made on the way.** `compareReturns` authorised
`PROCUREMENT_AWARD` `X`. The commercial roles who decide between buying a
package and self-performing it hold `R` and `A` on procurement, not `X` — so the
person who adjudicates could not read what they were adjudicating, which is the
wrong way round. It computes and writes nothing, so it is a read: `R` now, with
the `COMMERCIAL_L3` sensitivity gate unchanged, and a test asserts the deciding
roles can read it.

**Not built, and not to be claimed:** mapping each exclusion onto the
scope-matrix item it belongs to; automatic currency conversion — the rate and
the restatement are recorded by a person, deliberately; and any link from a
selected route into `consolidateMasterPricing`, which stays a separate act.

---

### The enquiry pack, and which revision each firm is holding

T-WF-04. `backend/src/domain/enquiry.ts`, ten routes, 41 tests, and a panel on
the Tender & Procurement screen with eight commands.

The failure this exists to prevent is quiet and expensive. An addendum goes out
on the Tuesday; two of five bidders price the Monday pack. Nothing in the
returns says so. The comparison then ranks five prices for two different scopes,
and the cheapest is cheapest because it is pricing less work.

**A pack has numbered revisions and every firm's record says which one they
hold**, with the content hash of that revision. Composing a new revision after
issue *is* the addendum: it marks every live firm's acknowledgement stale, by
name, and the position lists them. Re-issuing does not discharge the debt — it
moves it onto the revision they now hold, because being sent an addendum is not
agreeing to price it, and clearing the flag when the email left would report the
firm as up to date at precisely the moment it is not.

**Approval is a separate act from composing, and never by the composer.** Even
where one person holds both rights — which on a small commercial team is the
ordinary Tuesday rather than the exception — the per-act rule refuses it.
Approval is somebody taking responsibility for what is about to bind every firm
that prices it, and that is not a second click.

**Incomplete does not mean blocked, it means authorised.** Six document kinds
are mandatory and a pack short of one is refused — *unless* an exception names
what is missing, why, and who is accepting the risk. Refusing outright would be
simpler and wrong: packages go out short of a document constantly, and a
platform that only says no teaches people to route around it, into a
spreadsheet, where nothing is recorded at all. The exception is refused if it
names no reason or nobody behind it, and refused again if it excepts a document
that is in the pack — which is what stops one being attached out of habit.

**A bidder cannot infer the size of the field.** The bidder view returns that
firm's own pack and nothing else: no other firm, no count of them, no
acknowledgement rate. A field of two is priced differently from a field of six.
It is a refusal in the domain rather than a filter applied when rendering,
because a filter is something a later screen forgets to apply — and "never
invited" and "removed" return the identical answer, so nothing can be learned
from the difference.

**Removing a firm does not remove what happened.** That firm received revision 1
and opened it, and both stay true in the ledger — asserted against the events
themselves rather than against the read model. Re-inviting a removed firm is
then refused, because it has to be a deliberate decision rather than a side
effect of somebody pasting a distribution list.

**States move forward only.** A delivery receipt arriving after an
acknowledgement is an out-of-order webhook, not a firm un-acknowledging, and
treating it as the latter would lose the acknowledgement that matters. Decline
is terminal and reachable from anywhere.

**The return period closes and the late return goes through a person.** The
close reports who returned and who went silent as separate facts, because a
supply chain is read from the difference between a firm that declined and a firm
that never answered. A late return is not refused — refusing only moves the
decision into an email — but it costs an approval and a named authority, and it
sits on the record beside every return that met the date. The figure recorded
against it is minutes after the stated deadline and deliberately not clamped at
zero: a negative value means the workspace closed before the date it published,
which is a real thing to have done by mistake and worth seeing.

**Verified against a running server**, every refusal driven over HTTP as the
real roles: the short pack names both missing documents in the words a person
would use, issuing before approval is refused, the QS cannot approve at all, the
addendum makes all three firms stale and only acknowledging the new revision
clears one, the bidder view leaks no competitor, the removed firm reads a 404
identical to a firm never invited, re-inviting it is refused, and the addendum
after the deadline is refused with the reason.

**Not built, and not to be claimed:** any actual transport — the recipients and
times are recorded and sending is somebody else's system; a bidder-facing
portal; and per-recipient watermarking of the documents themselves.

---

### Measurement — the layer under the estimate

T-WF-03. `backend/src/domain/measurement.ts`, nine routes, 58 tests, and a panel
on the Tender & Procurement screen with six commands.

The estimate already worked and is not rebuilt: twenty cost heads, time-related
costs by the week, contingency from the risk register at P80. What did not exist
is the layer underneath, where a bid is actually lost, and always the same three
ways.

**A quantity nobody can trace.** Somebody measured 1,240 m² of blockwork off a
drawing eleven weeks ago. Which drawing, at which revision, off which sheet? If
the answer is not recorded the line cannot be checked, and when the drawing is
reissued nobody knows whether this one moved. Every priced item names the
drawing **and its revision**, or a model object set, or — for an allowance —
what it is based on and who agreed it. A drawing named without its revision
counts as no source at all, because Rev A and Rev D are different drawings and
recording the number is the entire point.

**A formula that does not produce its own answer.** `12.4 × 3.85 × 2` is 95.48
and the line says 94.58. It is a transposition, it happens constantly, and it is
invisible in a spreadsheet because the spreadsheet computed the wrong cell too.
The formula is held beside the quantity and re-evaluated. The evaluator is a
small recursive-descent parser over numbers, `+ - * /` and parentheses —
deliberately not a general expression language and deliberately not `eval`,
because this parses text arriving over an API and the only safe evaluator for
that is one that cannot express anything but arithmetic. Anything it cannot read
is reported as unreadable rather than run, and the comparison carries a 0.1%
tolerance so the rounding a written-down quantity always has does not produce a
finding on every line of a hundred-item bill.

**A drawing reissued mid-tender.** Rev C arrives, the estimator prices on, and
forty items measured off Rev B are wrong by an amount nobody has computed.
Recording the reissue names every item measured from the superseded revision,
and the schedule will not freeze until each has been looked at — not because
they have all changed, since most will not have, but because which ones did is
the question nobody can answer three weeks later. **"Unchanged" is a first-class
answer** and has to be recorded, because otherwise there is no way to tell an
item somebody checked from one nobody opened.

**Rates are built, not typed.** A rate is resource constants times resource
costs — 0.85 hours of concretor at £28.40, 1.02 m³ of ready-mix at £118 with 5%
waste — and holding the components rather than the answer is what makes a rate
arguable, reusable and repriceable when the labour rate moves. Waste on anything
that is not a material is refused: waste is what is cut off, broken and
over-ordered, and putting it on labour is somebody meaning "lost time" and
hiding it where nobody will look. The total is rounded once at the end rather
than per component, because rounding four components and adding them is a
different number, and on ten thousand square metres the difference is real.

**Preliminaries, risk and OH&P are not spread across item rates.** The
specification asks for them to be separated, and the separation already in place
is the right one: they are priced once at the estimate, each on the basis it
actually has. Adding a percentage to every rate would have satisfied the words
and destroyed the property that makes a slipped programme a known number here
instead of a surprise at final account. The build-up produces direct cost, and
the panel says so.

**What is not firm is said out loud.** Four bases — measured, provisional,
approximate, allowance — and a report giving the share of the direct cost
sitting on each quantity that is not firm, largest exposure first, with the
reason it is not firm and, for an allowance, what it was based on. A tender
total containing 18% provisional quantity is a different commercial position
from one containing none, and the difference is invisible in the total.

**The reconciliation refuses to nearly explain itself.** Schedule to schedule,
every movement named as added, removed, remeasured or repriced, biggest first.
If the movements do not sum to the difference between the two totals, it says so
rather than presenting a list that almost accounts for it. Reconciling across
two currencies is refused outright: that is a rate decision, not a measurement
one.

**The freeze refuses three things**, each of which the schedule would otherwise
be asserting untruthfully — an error in the bill, an item nobody priced (an
unpriced line in a frozen schedule is priced at zero by everybody who reads it
afterwards), and a drawing revision nobody looked at.

**Verified against a running server**, every refusal driven over HTTP: the bad
formula is caught at the point of recording and again at the freeze, waste on
labour is refused with the reason, the reissue names both affected items, and
the freeze succeeds only once all three are answered — returning a content hash
over what it froze.

**Two wording defects the run caught that the tests had not.** The uncertainty
summary read *"1 quantity that are not firm"*, and the affected-items list came
back in recording order rather than bill order. Both are the kind of thing that
makes a reader stop trusting the rest of the page, and both are now locked by a
test.

**Not built, and not to be claimed:** importing a bill from a file — items
arrive structured, as in every other workflow here; graphical take-off overlays;
and any automatic link from a frozen measurement schedule into the twenty-head
estimate. The two are separate records today, and joining them is a decision
rather than a wiring job.

---

### Clarifications, and the comparison that must not become an opinion

T-WF-06. `backend/src/domain/tenderintel.ts`, ten routes, 51 tests, and a panel
on the Tender & Procurement screen with seven commands.

Two failures are what this exists to prevent, and neither of them is a missing
record.

**Unequal information.** One bidder gets the answer on Tuesday and the other on
Friday, and the tender has stopped being a competition. It is almost never
malice; it is a reply-all that was a reply. The platform refuses the two shapes
it can recognise — a commercial-in-confidence answer going to a competitor, and
an open bidder answer that misses an entitled bidder — and records the
distribution and the reads for everything else, because the question a year
later is never what the answer was. It is whether one firm had it first.

**The comparison that became an opinion.** Nobody sets out to do it. Two quotes
are on different bases, somebody normalises them, and six weeks later nobody can
say why the one that won had £180,000 added to the other. So the **raw return is
written once and never edited** — a second write is refused, and a correction to
what a firm meant is an adjustment sitting beside their own number — and **every
adjustment cites the return line it corrects or the clarification that
authorises it**, as a refusal rather than a report. A clarification that has been
raised but not answered is refused as a source too: an adjustment resting on a
question nobody has answered rests on nothing.

**The register is one register.** The RFQ-scoped supplier question already
existed and already wrote `CLARIFICATION_RAISED`. The tender-level register
writes the same event against the same entity and continues the same `TQ-nnn`
sequence, so a reference on a piece of paper still identifies exactly one thing.
What was added is the two sides that had nowhere to go — the internal question
and the question to the client — and the link into the controlled information
that makes an answer findable by whoever prices that thing a fortnight later. A
question naming no document, clause, drawing, package or scope item is refused.

**Completeness is a count, and the first version of it was wrong.** It
multiplied two proportions — how many firms returned, by how many material
queries were answered — and on a real case with both firms returned and one
query open, the screen said **0% settled**. Nobody believes a number claiming
nothing is known about a comparison holding two complete priced returns, and a
measure nobody believes is worse than none. It now counts what the comparison
needs to know (one return per firm, one answer per material query) against what
it has, and confidence is stated from the facts rather than from a threshold:
a firm that has not returned is low, everything in with a material query open is
medium, everything answered is high.

**The ranking is withheld, not footnoted.** A ranked list is read as a
recommendation however it is labelled, so while a firm has not returned or a
material query is open there is no ranking at all — and the reason is on the
screen. What the open material queries are worth is carried into adjudication as
a stated priced risk rather than lost.

**Closing is deliberately not refused while a query is open.** A bid deadline
does not wait for an answer, and a refusal there would only teach people to mark
queries immaterial — which would destroy the one signal that matters. What the
close records is exactly what is being carried, and the person who ran the
comparison does not close it: the matrix already gives the QS the right to run
one and not to close it, and the arithmetic is shared between the two acts
without either demanding the other's authority.

**Verified against a running server**, every refusal and every acceptance driven
over HTTP as the real roles: the confidential answer to a competitor is refused
naming the firm it would have reached, the open answer missing a bidder is
refused naming them, the unsourced adjustment is refused, raw plus adjustments
reconciles to evaluated for both firms, the material query drops the comparison
to 67% and withholds the ranking, and the QS is refused the close that the
project manager is granted.

**Two defects a browser found that no test had.** The confidentiality badge on
the register rendered as the literal text `[object Object]`, because `raw()`
called on something already marked as markup ran `String()` over the object.
`raw()` now passes an already-marked value through, which is the root cause and
would have bitten anywhere else the same natural-looking call was written; there
is now a test file for the escaping layer. And every comparison command opened a
modal with an empty required dropdown once the last comparison was closed — a
dead end the person could not diagnose. Those commands now lock with the reason,
using the same affordance the permission matrix already uses.

**One security correction made on the way.** The `Clarification` entity was
classified `DESIGN_INFORMATION` with no sensitivity. Every write against it is a
procurement act, so that was wrong before this workflow; it would have been a
leak after it, because the register now carries commercial-in-confidence bidder
questions and anyone holding design read could have listed them. It is
`PROCUREMENT_AWARD` / `COMMERCIAL_L3` now, asserted by a test.

**Not built, and not to be claimed:** the quantity and estimate halves of the
addendum impact — they need T-WF-03's measured items, which do not exist;
automatic outlier detection across a comparison; and any bidder-facing portal.
The recipients are recorded; sending is somebody else's system.

### The two records a document could not be composed from

Meeting minutes and material approval submittals are on the list of documents
this platform generates, and neither had a record behind it. Generating them
anyway would have produced exactly the invented content the document engine
exists to refuse: a set of minutes with no meeting behind it reads precisely
like one with a meeting behind it, and nobody downstream can tell them apart.
So the two records were built first.

**`backend/src/domain/meetings.ts` — the `SiteMeeting`.** Seven meeting types,
attendance with apologies recorded rather than omitted, agenda items, and an
action register. Seven routes, 21 tests.

Three refusals carry it. An action needs an owner *and* a date — without both it
is a topic somebody mentioned, and a register of those stops being read. Minutes
are issued once and a correction is recorded *beside* them, never applied to
them: the commonest abuse of a set of minutes is quietly amending what was
agreed after somebody objects, and rewriting the text destroys the only thing
minutes are for. And an action carried forward from an earlier meeting keeps the
date it was originally given, so an action raised in March and still open in
June reports as eighty-two days overdue rather than as due next Tuesday — which
is how registers full of overdue actions report themselves as healthy.

Closing an action is deliberately permitted *after* issue. The minutes record
what was agreed on the day and do not change; the register is live, and freezing
it would mean every closure needed a new meeting.

The `LOOKAHEAD_CONSTRAINTS` classification is not a convenience. It is the area
that already owns actions somebody owns by a date, it is not phase-gated — a
design coordination meeting in CONCEPT is not a process error — and it splits
the two parties correctly without widening the matrix: the planner, supervisor
and EPC hold C and U, so they minute; the project manager and project director
hold A, so they issue. That is how a set of minutes is actually produced.

**`backend/src/domain/submittals.ts` — the `MaterialSubmittal`.** Six kinds,
four review outcomes, revisions on one record, six routes, 37 tests. This closes
a gap the corporate control standard had declared open rather than hidden:
`DEL.SUBMITTALS` carried a `notTrackedReason` saying supplier submissions are
tender returns and nothing tracked a product submitted for approval. It is
tracked now, and a test asserts the excuse is gone.

The number that makes the register worth keeping is **the date the decision was
actually needed** — the date the material must be on site, less its procurement
lead time. Nobody types it; typing it is how it ends up agreeing with nothing.
A register that tracks status alone discovers its delays after they have
happened. The platform also reports *negative slack*: where the contractual
review period runs past the ordering date, the reviewer can answer entirely
within the contract and the material still cannot arrive. No status field can
express that.

Two more refusals. A compliance claim carries the specified value and the
offered value or it is not recorded — one side of a comparison is an assertion
the reviewer is being asked to countersign. And a submittal cites a clause that
exists on the project, so the reviewer is approving a compliance rather than a
product.

**What it deliberately does not refuse** is a late approval or an order placed
before one. Both are real acts real projects perform for good commercial
reasons. Ordering an unapproved long-lead item is refused only as an *ordinary*
order: `atRisk` with a justification and a named person records it truthfully.
Refusing the act outright would push it into an inbox, which is the one outcome
that makes the register worse than useless.

Revisions stay on one record rather than opening a new row per cycle. A product
that has been round three times is the one fact the register exists to surface,
and splitting the cycles is how that becomes invisible. Each new revision clears
the previous decision, because carrying it forward would show revision D as
approved on the strength of a review of revision C.

---

### The fifteen documents, and the screen that says why not

`backend/src/documents/planning.ts` and `backend/src/documents/quality.ts`
complete the catalogue: five safety, five planning, five quality, one generation
path, 46 tests. `frontend/pages/documents.js` is the screen.

The safety five were built around **cross-reference** — a permit checked against
the expiry date of the ticket that authorises each operative, against the
permit's own end date rather than against today. The ten added here are built
around **arithmetic nobody does by hand**, and each one exists to surface a
number that is invisible on the paper version of the same document.

- **Master Programme.** The critical path the platform computed, and — for each
  critical activity — the constraints and unanswered RFIs currently in front of
  it. That join is between three record sets, none of which knows about the
  others, and it is the only column that says why a date will move. It also
  names activities with no logic at either end: an unlinked activity floats free
  in the calculation and can never appear on the critical path, whatever it
  actually depends on.
- **Bill of Quantities.** Every dimension formula is re-evaluated against the
  quantity billed *when the document is composed*, and any that no longer agrees
  is named with both numbers. A formula and a quantity that have drifted apart
  is the commonest error in a bill and the least visible one. Dimensions the
  evaluator cannot parse are reported as unchecked rather than counted as fine.
- **Site Diary.** Named gaps. Every calendar day between the first and last
  entry that carries no entry is listed, because a diary that skips a day
  silently reads as a project where nothing happened, and on a delay claim the
  silence is the whole argument. Each entry states whether it was written on the
  day or afterwards.
- **Meeting Minutes.** Apologies shown rather than filtered out, and an action
  carried from an earlier meeting measured against the date it was originally
  given.
- **Request for Information.** The revision the question was asked against,
  beside the revision now on the register, with a paragraph when they differ.
- **Inspection and Test Plan.** Each stage beside the inspection actually
  recorded against it, and hold points with no recorded release named outright.
- **Material Approval Submittal.** Both sides of every compliance claim, and the
  date approval was needed derived from the lead time rather than typed.
- **Non-Conformance Report.** Where the disposition is use-as-is, a paragraph
  saying in plain words that a departure has been accepted into the permanent
  works, with the name of the person who accepted it.
- **As-Built Drawing Register.** File hashes beside every drawing, drawings still
  at a preliminary revision named, and the models section counting how many are
  actually recorded as as-built rather than claiming all of them are.
- **Operation and Maintenance Manual.** Warranties crossed against open defects,
  so an unclaimed defect under a warranty running out in four months is visible
  from two registers that never meet.

**The screen.** `Site Documents`, under Assure. Its most useful column is
**why not**: for each of the fifteen it shows either Ready or the sentence naming
the record it is waiting on and where that record is created. Above the
categories, one row per *missing record* rather than one per blocked document —
a register that does not exist blocks everything composed from it, and creating
it once clears all of them. Generation is a button on the row, not one modal
asking for a type and then offering every record on the project: with the type
settled first, the record list can only ever be that type's own.

**Two panels, so two of the fifteen have somewhere to come from.** Meetings and
their action register sit on Project Control; material submittals sit on Design
& BIM. Both are curated rather than reached through the generated command
catalogue, because both need this project's own records in a dropdown.

**Nine of the source bindings now say "the All commands screen".** They used to
name screens that do not exist — "the Quality screen", "the Delivery screen" —
and four record-scoped types said "the screen that creates it", which is true
and useless. A refusal that sends somebody somewhere the console does not have
is the same dead end as a greyed-out button with no reason on it. A test asserts
every screen named is one the navigation actually carries.

**Ten defects found by rendering rather than by testing**, which is the method
that has caught every real one: a formula check that silently skipped what it
could not parse; `1 of 3 items carry`; a quantity formatted two ways in two
tables on the same page; an action's overdue count replaced by "Closed"; a
warranty reported in force before it had commenced; a models table claiming
every model was an as-built one; `[object Object]` where a badge was
interpolated into a plain template literal instead of an `html` one; `Cdm
document`, because `humanise` split CamelCase but not a leading acronym; a
meeting minutable in the future, which produced a document asserting decisions
nobody had taken; and a subject list offering a method statement for a set of
minutes, caught only by the server refusing it.

---

### What the machine wrote, and whether a machine wrote it

The reasoning engine contributes the connective prose a good document has and a
generated one usually lacks. Every fact on the page comes from a record; the
model is given the records and asked to reason about them, and is never asked
for a fact. Fifteen document types, twenty narrative briefs, and a test
asserting every one of them opens with "Reason about" rather than "write" or
"describe" — a model handed a blank page and a document title writes an
excellent, entirely invented document.

**The defect this closed was not a wrong figure.** The platform ships a local
adapter that answers every request with the same sentence so it runs with no
provider key configured. That sentence landed on the page under a heading,
followed by *"Written by the platform's reasoning engine from the records set
out above, at a stated confidence of 84%"* — an attribution to reasoning that
never happened, on a document whose whole architecture is a refusal to do
exactly that.

Three changes fix it and one test file proves both directions:

- **`ProviderResponse.synthetic`.** Declared by the adapter, not inferred from
  `config.ai.mode` — a test injecting a real-shaped adapter runs with the mode
  still set to local, and the honest answer is a property of who answered rather
  than of how the platform was configured. `runAI` passes it through.
- **A synthetic answer is dropped.** The heading stays and the section states
  that it could not be produced, which is what actually occurred. The ACUs are
  still reported: the run happened and was charged for, and hiding that would be
  a second untruth in service of covering the first.
- **A real answer is attributed by name.** "By stub-reasoning-v9 via ANTHROPIC,
  at a stated confidence of 81%." *Machine-written* is not enough — a reader
  weighing a paragraph is entitled to know which machine, and a page that said
  only "the platform's reasoning engine" could not distinguish a frontier model
  from a stand-in that reasons about nothing.

The live path is verified against a stub adapter that writes prose, because that
is the only way to verify it from here: **no call has been made to a real
provider from this environment**, and nothing in this repository should be read
as saying one has.

**And the wider gap it exposed, now closed.** Seven engines write a provider's
prose into ledger state — `bim`, `claims`, `cost`, `handover`, `planning`,
`safety`, `tender`, at eighteen call sites under eleven different field names —
and none of them recorded which model produced it. The event carried the answer
in its `ai` block; a *reader* holding the materialised record could not see it,
and the O&M manual duly presented the local stand-in's sentence as a maintenance
regime somebody had extracted.

The fix is one line in `runAI`, not eighteen at the call sites. Every record it
writes is stamped with `aiProvenance` — provider, model class, engine, task type
and `synthetic`. Doing it at the choke point is the whole point: the nineteenth
engine gets it without being told, there is one place for it to be right, and a
test asserts it over *every* AI-authored event on a fully seeded project rather
than over a list somebody maintains.

`wasSynthetic(state)` is what a consumer asks. The first version of this
recovered the answer by matching the stand-in's opening words, which worked and
was brittle — it would have missed any engine that phrased it differently, and
there are seven. That predicate is gone; the constant stays so the wording lives
in one place.

---

### The design information plan, and the three things it refuses

D-WF-01. `backend/src/domain/designplan.ts`, nine routes, 34 tests.

The plan for who produces what information, by when, for whom, and who checks
it. It is the first thing set up after the concept gate and the last thing
anybody looks at, which is why design programmes fail quietly. Three refusals
carry it, and none of them is about a missing record.

**Information planned to arrive after it was needed.** A deliverable carries the
date it will be issued, the date the thing waiting for it needs it, and the
review period between them. On most projects those three numbers live in three
documents held by three people. Here the platform subtracts them: a drawing due
on day 30, reviewed for fifteen days, needed on day 35 is ten days short — and
it is ten days short on the day the plan is written rather than the week it
fails. It is **recorded anyway**. A plan with negative slack is a plan a real
project is working to, and refusing it would push it into a spreadsheet nothing
can see; it blocks the MIDP approval instead.

**An interface with an owner on one side.** Every expensive coordination failure
lives at a boundary both sides assumed the other held, and an interface with one
name on it is that assumption written down. Two owners or it is not recorded.
Closing one needs what was agreed, not a tick.

**Responsibility that moved without the incoming party seeing it.** A transfer
needs the outgoing party's release *and* the incoming party's acceptance,
because a reassignment nobody accepted reads afterwards exactly like a clean
handover. Prior holders are kept rather than replaced: somebody who held a duty
for four months held it for four months. And a transfer that would leave one
person as both author and checker is refused, because the separation is worth as
much after a reassignment as when the plan was written.

**Delegation is not transfer, and the platform will not let it become one.** A
lead designer who sublets a deliverable keeps the author of record and keeps
every interface the package crosses. That is the rule the CDM regime already
states and the one most information plans quietly lose the moment a specialist
is appointed.

**The MIDP is reconciled, not written.** It is what the team plans add up to, so
it is computed across every package: one reference planned twice, an interface
naming a package that does not exist, anything late by its own arithmetic.
Approval is refused while any of those stands — approving a plan the platform
can already prove does not work is the signature that makes everything
downstream somebody else's problem. A master plan maintained by hand beside the
team plans it summarises diverges within a fortnight and nobody notices for a
quarter.

**A departure from the specification, recorded rather than argued later.**
D-WF-01 step 4 asks for CDE states to be *configured* with permission rules.
That would be a second permission model beside `identity/roles.ts` answering the
same question differently. The four states are implemented as a fixed ladder
with the one rule the specification actually names beneath it — nothing reaches
Shared without an author, a checker and its metadata — and who may make each
move is the permission matrix's answer, given once.

**The design block is complete.** D-WF-01 to D-WF-08 and the 7.4 stage gate are
built.

---

### The review the people who build it hold before anybody freezes it

D-WF-07. `backend/src/domain/constructability.ts`, seven routes, 28 tests.

The cheapest hour on a construction project and the first one cancelled. What
makes it worth recording is not the meeting; it is what happens to the findings.

**The occasion is the four voices.** Construction, design, HSE and operations.
A buildability review attended only by designers is a design review with a
different heading, and the whole value is that the people who will build it, the
people who will maintain it and the people who drew it are reading the same
drawing at the same time. A review missing any one of them is refused, and the
refusal names which.

**Every finding becomes one of five things.** A design change, a risk somebody
owns, an RFI, a constraint on the method, or a thing the review deliberately
accepted. Those are five different outcomes with five different owners, and the
disposition is required *at the point the finding is recorded* — "we will work
out what to do with it" is how a review's output becomes a list nobody owns. The
rationale is required too: a disposition chosen without a reason is one that
will be argued about.

*Accepted* is closed, not open: the decision is the discharge, and leaving it
outstanding would fill the register with things somebody already answered. And a
**critical** finding cannot be accepted — accepting is a legitimate answer to
something the review decided to live with, a critical finding is by definition
not that, and recording it as accepted would turn the severity into a label
rather than a decision.

**Access and testability stop a freeze.** Named by the specification, and for
the same reason in both cases: a thing that cannot be safely reached or cannot
be proved to work is a defect that only becomes visible once it is buried.
`freezeBlockersFor` is exported for D-WF-08 to call rather than re-derive — a
gate that reimplemented the rule would be a second answer to the same question.

**Eliminate, reduce, communicate — and it is always the third that fails.** A
residual risk names who is exposed and the drawing it lives on, because a hazard
that survives into the works has to be findable *from* the works. It is then
carried as an obligation with two states, not as a note: it is outstanding until
it has reached both the pre-construction information and a method statement, and
each of those is recorded by document reference. "It is in the PCI" with no
reference is the assertion this record exists to replace. An **eliminated**
hazard needs no communication — there is nothing left to tell anybody — so it is
discharged on the spot rather than filling the register with work nobody has to
do.

**A temporary works category is assigned by a person, never inferred.** The
specification says outright that the category and the checking regime cannot be
derived by an agent, so the platform records who assigned it and refuses one
with nobody's name on it — guessing would produce a designer of record for a
falsework scheme nobody appointed. Design and check by the same party is refused
above category 0 and permitted at category 0, which is where BS 5975 permits it.
And the interface itself is what the *permanent* works assumes about the
temporary one — the load path, the sequence, the props that stay in. That
assumption is the thing that gets lost when the two designers are different
firms, so it is required.

**One thing deliberately absent: a review cannot be closed.** Findings close;
the review is the occasion they came from and is finished when it happened. A
review with a closed state invites the register to be tidied rather than
discharged, which is the exact failure the disposition exists to prevent.

---

### The Construction screen, and the five registers that had no door

`frontend/pages/construction.js`, under Deliver. Permits to work, method
statements, inductions, inspection and test plans and non-conformances were
reachable from the API and from nowhere a person could get to — the generated
command catalogue opened onto a text box called `ramsId`. They are the five
records the platform's five site documents are composed from, so they belong on
one screen held by the person accountable for them.

**The authority split is the permission matrix's, not the screen's**, and the
matrix already carried it exactly. The site manager raises: drafts a method
statement, records an induction and a qualification, creates an inspection plan,
records an inspection, raises a non-conformance. The safety lead approves the
method statement and issues the permit; the construction manager or QA engineer
dispositions the non-conformance. Nothing on the screen is a second copy of
that — every button asks `can()`, which reads the matrix the API publishes.

**Three things this exposed.**

*The site manager did not exist.* `SUPERVISOR` is the role holding create and
update on `SAFETY_RAMS`, `QUALITY_COMMISSIONING` and `FIELD_EXECUTION` — it
issues nothing and raises everything — and no identity on the demonstration
project held it. Every one of those paths was in the matrix and could not be
walked by anybody. There is a Site Manager now.

*The competency register had no door.* A permit is refused where an operative's
ticket does not cover it, and `recordCompetency` was reachable from the engine
and from a test only. A site manager whose permit was refused for a missing
ticket had no way to record the ticket. `POST /v1/projects/{id}/safety/competencies`.

*`Issue a permit` asked for the wrong authority.* Issuing looks like creating,
so the button asked for `SAFETY_RAMS C`; `issuePermit` requires `A`, because
issuing a permit is the act of allowing dangerous work to start. The site
manager was offered a button the server refused — the dead end the screen exists
to remove, reproduced. Found by pressing it in a browser, not by a test.

The capability code beside each button is the one thing the screen restates
rather than reads, so `backend/tests/construction.authority.test.ts` pins the
whole table by driving each act through the real engine as each seeded role. A
code that moves on either side fails there rather than in front of somebody on a
wet Tuesday. It also pins the thing the phrase "construction manager" hides: the
project manager dispositions a non-conformance and does **not** approve a method
statement, which is the safety lead's.

**The phase gate is said on the page, not left in a tooltip.** Quality records
are writable from construction through to handover and the demonstration project
finishes in operations, so three buttons grey out for a person who holds the
permission. A notice says so — a person looking at a disabled button is entitled
to know it is the project's phase and not their own permissions.

**The loop closes.** A permit issued on this screen becomes a branded, hashed
Permit to Work through the document catalogue, driven end to end in a browser:
ticket recorded, permit issued against the approved method statement, operative
competency checked, document generated at `MIGL-PTW-0001` revision A. The nine
document source bindings that said "the All commands screen" now say "the
Construction screen", because it exists.

---

### Four thousand clashes are forty problems

D-WF-04. `backend/src/domain/coordination.ts`, six routes, 33 tests.

A clash report is the easiest document in construction to produce and the
hardest to act on. Four failures, and the module is built around them.

**A result nobody can reproduce.** "The models clashed" is worthless a week
later because the models moved. A run is against a **federation set**: an
immutable list of exact model revisions with their file hashes, formed once and
never edited. The hash is checked against the model the platform holds, so the
set commits to the bytes — "revision C" is a name somebody typed and a hash is
not. Every run copies those revisions onto itself, so a result stays readable
whatever happens to the set afterwards.

**A run that measures the misalignment rather than the design.** Two models in
different units, or on different coordinate systems, clash everywhere. Reporting
that as findings would bury the real ones, so the federation refuses to form and
the refusal names what disagrees with what. The platform does not parse IFC —
that is a declared gap — so units and coordinate system are **declared** by the
person federating, and the platform holds them to it across the set.

**Four thousand rows that are forty problems.** Raw clashes are grouped by
location and by the unordered pair of systems, because that is what a fix
addresses: a duct through a beam clashes with every rebar it meets and somebody
moves the duct once. The pair is sorted, so a duct-through-beam and a
beam-through-duct are one problem — and so the same issue is recognised again in
a later run. Severity comes from `scoreClashes`, extracted out of the BIM
engine's `detectClashes` rather than reimplemented: two severity scales over one
set of clashes would let the same overlap read CRITICAL on one screen and MEDIUM
on another, and nobody could say which was the platform's view.

**An accepted clash marked as resolved.** The rule the specification states
outright and the one that matters most. Accepting needs a reason, a named risk
owner and an approval, and the issue's state is **not** changed — resolved means
the geometry changed, accepted means somebody decided to live with it. It gets
its own event so an audit can tell the two apart without inspecting state, it is
refused to anybody without approve on the area, and an accepted issue cannot
then be walked through verification because there is nothing to verify. It also
leaves the blocker list, because somebody with the authority decided: a blocker
list that included decisions would never clear, and a list that never clears
stops being read.

**A closed issue that comes back.** The next run reopens anything closed that it
finds again, automatically, with what reopened it and what state it had been in
written on the history. An issue closed on the strength of a revision that did
not fix it is the commonest way a clash reaches site. The reverse — a clash a run
*stops* finding — is reported and never closed: a clash disappearing is evidence,
not a decision, and closing on it would let a model somebody broke close forty
issues.

**Verification is somebody else's.** The designer holds create and update on the
area and resolves; only the BIM lead holds approve, so confirming a clash is
actually gone is the coordination authority's rather than the party who says
they fixed it. Verification can send an issue back to resolution, which is the
whole point of having the state.

**A guardrail that could not see round a ternary.** `catalogue.test.ts` asserts
every event type has a command able to emit it, by reading the source for
`eventType: 'X'`. Two of these events were written as
`eventType: recurred ? 'A' : 'B'` — real emissions the pattern could not see, so
both branches read as dead events. The code is now two explicit writes, which is
clearer anyway, and the detector reads the whole expression: it has to be at
least as clever as the code it audits.

---

### The change register that decides what the project is building to

D-WF-06. `backend/src/domain/designchange.ts`, seven routes, 47 tests.

**It is not the variation register, and that is the point.** `ChangeRequest`
under `CHANGE_VARIATION` is contractual: entitlement, a notice type, affected
subcontracts, a claim for money or time. This is a change to *approved design*,
and most instances of it are a designer correcting their own work and never
become a variation at all. Collapsing the two would put every drawing correction
in front of the commercial team and make the variation register useless, which
is the commonest way a project loses track of what it is owed. Two registers,
one link: a design change with contractual consequence carries the change
request reference rather than becoming one.

**Implementation does not start before approval.** A revision issued while the
change is still being assessed is a decision taken by whoever drew it, and that
is the whole reason the change was registered. There is an emergency path,
because a safety correction cannot wait for a Tuesday meeting — and it is
recorded *as* an emergency, with the retrospective approval still owed. The
register keeps saying so until somebody goes back and gives it, and closure is
refused while it is outstanding: the expedited route defers the approval, it
does not remove it, and closing without it would turn a deferral into a bypass.

**Six domains, each assessed or explicitly not applicable with a reason.**
Design, commercial, planning, safety, procurement, information. Approval is
refused while any of them is silent, because a change approved on cost alone is
a change whose programme consequence somebody discovers on site. "We looked at
it and it does not affect procurement" is a different statement from silence and
only one of the two is a record. A rejection needs no complete assessment —
forcing six assessments of a change everybody has agreed is not happening would
teach people to write nothing in them.

**Materiality is a proportion, never a figure.** `lifecycle/scale.ts`'s rule,
applied: what decides whether a change is the design manager's, the project
director's or the client's is its value as a **share** of the project's, plus
whether it touches safety or a statutory approval — both material at any size,
because a change to a fire strategy on a small job is not cheap enough to be
somebody's alone. Where the project carries no value to size against, the higher
route is taken: an unknown proportion is not a small one. A test reads the
module's own source and fails if the configuration ever grows an amount.

**Closure confirms every affected thing.** The list comes from what the change
itself named at the start, so it cannot be quietly shortened at the end. Each
entry is confirmed revised, or established as unaffected after all with the
reason — a change that named four packages and closed with two of them untouched
has left two packages built to superseded information, which surfaces at
handover, where it is at its most expensive.

**The proposer cannot be the decider**, on a correction as much as on a client
change; and no event in the set is `aiAllowed`, because a change to approved
design is a decision and no agent mandate exceeds propose.

---

### The moment design stops moving

D-WF-08 and the 7.4 stage gate. `backend/src/domain/designbaseline.ts`, four
routes, 37 tests, plus the design gate inside `backend/src/domain/stagegate.ts`.

**A baseline that does not say what it froze.** "Design is frozen" is worth
nothing without the revisions. A freeze copies the exact deliverable references,
their suitability and their acceptance record onto itself, so a package frozen
in March is still readable in September whatever the model has done since —
AC-D-WF-08-01. Nothing below `PUBLISHED` can be frozen, because a baseline over
work in progress is the failure the whole step exists to prevent.

**A partial freeze with no boundary.** Freezing half a package is normal and
useful. It is also how a project ends up with two halves nobody can tell apart,
so a partial freeze needs all three of the specification's conditions: a stated
boundary, the open interfaces across it checked by name and by a person, and its
own baseline reference. A tick with nobody behind it is refused as a tick.

**A freeze that quietly goes stale.** A deliverable revised after the freeze
invalidates what depended on it. That is **derived on every read**, never a
stored flag: the freeze holds what it saw, the package holds what is true now,
and the difference is computed when somebody asks. A stored flag is a second
answer to the same question and is always the one nobody updated. Revalidating
is re-freezing at the new revisions, because there is no honest way to say
"still fine" without looking — and the superseded freeze stays readable, which
is the point of baselining at all.

**A tender priced on superseded information.** AC-D-WF-08-03, and the one with
money behind it. `enquiry.ts` asks `tenderReadinessFor` before composing a pack
and refuses where the package's design is unfrozen or has moved since. It can
still go out — a programme sometimes leaves no choice — but only on an
authorised exception, and on the **same** exception object as the missing
documents, so the firm pricing it reads one list of what they are pricing
without rather than two mechanisms disagreeing about whose warning counts. A
project that runs no design packages at all is pricing client information and is
left alone; refusing it for want of a baseline would be inventing a requirement.

**A critical finding blocks the affected baseline**, full freeze or partial —
isolating a boundary does not isolate a hazard. The rule is `freezeBlockersFor`,
reused from D-WF-07 rather than re-derived, which is why that function is
exported.

#### The 7.4 gate

6.4, 7.4 and 8.4 are **word for word identical** in the specification. What
differs is the evidence each is answered from, so the clause list, the titles,
the `NOT_ASSESSABLE` rule, the AI clause (unassessable when this was written,
assessed now), the replay clause and the report
arithmetic are shared outright: `evaluateDesignGate` answers the same seven from
the design stage, `evaluateTenderGate` from the tender, and `gateFor` picks by
phase — a project in DESIGN is assessed against 7.4 and everything else falls to
the tender gate, which is where the only implemented gate always pointed. Three
copies of "every approval satisfies party separation" would be three answers to
one question inside a year.

The design stage's four specific clauses: inputs are the approved delivery plan
and a baseline whose every container carries its suitability and its acceptance;
approvals add "no design change decided by its proposer" and "no deliverable
checked by its author" to the generic re-verification; blockers are the
constructability findings, the critical clashes, the emergency changes nobody
went back and approved and the residual risks that never reached the
pre-construction information; the cut-off reconciles the delivery plan against
the baseline. Clause 7 is `NOT_ASSESSABLE` for the same honest reason as the
tender gate's — the worklist is derived without re-entry, but mobilisation tasks
with owners and dates are not built and the report says so by name.

---

### Start is an authorisation, not a date

CN-WF-01, the first workflow of the construction stage.
`backend/src/domain/mobilisation.ts`, five routes, 35 tests.

The failure this is written against is the commonest one on site. Work starts
on a Monday because the programme said Monday. The method statement is still in
draft, the temporary works design has not been checked, and the drawing the gang
is working to was superseded on the Friday. Nobody decided any of that — it
happened because start was a date.

**No authorisation over a failed critical prerequisite.** Twelve are checked.
The specification names five as blocking — design, RAMS, permit, temporary
works, competence — and contractual authority and possession are added to that
list, because work you have no possession of is not work you can authorise
whatever the paperwork says. The remaining five (quality plan, welfare, survey,
resource, logistics) are what a *conditional* readiness can carry.

**What the platform can check, it checks.** A readiness check does not ask
whether the RAMS is approved; it reads it — and an approved method statement
nobody has been briefed on counts as not met, because the briefing is the
control and a RAMS in a drawer is a document. It does not ask whether the gang
is ticketed; it reads the competency records against the **whole window**, so a
ticket lapsing on the Wednesday does not cover a start that runs to Friday. It
reuses `packageReadiness` from D-WF-08 for the design answer rather than growing
a second opinion about whether a package's information is current. Every result
records whether it was `VERIFIED` or `DECLARED`, and **a declaration over a
verification is refused outright** rather than ignored — an ignored input is one
somebody believes took effect. Competence with nobody named is never "not
applicable": an unanswerable question reported that way reads as satisfied to
whoever scans the list.

**Conditional readiness expires.** Every condition needs an owner and a date,
and the readiness itself needs an expiry — without one the conditions stop being
conditions and become a description of the site. An authority cannot run past
its check's window or its expiry.

**Changed information rechecks the authority.** Derived, not stamped: the
authorisation records the freeze it was issued against and the exact revisions,
and the position reports it as needing recheck the moment the design moves.

**And Not Ready stops work.** `recordProgress` asks `startBlockedReason` before
a task can move to in progress — AC-CN-WF-01-02. The rule is exactly the
acceptance criterion and no wider: a package **assessed and found not ready** is
stopped, and a package this workflow has never seen is untouched, because
refusing progress on every project that does not run mobilisation would be
inventing a requirement rather than enforcing one.

Authorising is `FIELD_EXECUTION` **approve** and never `aiAllowed`: the site
manager, safety and quality run the check, and only the project or construction
manager gives the authority to put people to work. Revocation writes the same
event as the authority — withdrawing is that authority saying something
different, not a new kind of act, and the record of what was authorised and
against which revisions stays exactly where it was.

---

### The four things the programme was missing

CN-WF-02. `backend/src/domain/programmecontrol.ts`, five routes, 27 tests.

**Most of this workflow was already built and none of it was rebuilt.**
`engines/planning.ts` holds the critical path, the programme baseline, the
six-week lookahead, the Last Planner commitment rule, the constraint register,
PPC and productivity. This module owns only the four things that were genuinely
absent.

**Logic nobody validated.** The baseline was approved by running the critical
path over whatever logic happened to be in the ledger. A programme with forty
open ends has a critical path; it is not the project's. `validateProgrammeLogic`
reports open ends at both ends, dangling links, self-dependencies, duplicate
logic, negative float, detached float, negative durations and out-of-sequence
work — each **naming the activity**, with the four that make the arithmetic
wrong rather than untidy marked critical. The critical path is still computed
over the links that resolve, which is exactly why a dangling link is worth
reporting: it silently drops out of the answer.

**A forecast that overwrites the baseline.** The baseline is what delay is
measured against, so a forecast that replaced it would destroy the only
reference the measurement has, and every extension of time argument with it. A
forecast is its own record, carrying the baseline it was taken from by name and
its variance against it, and a **second baseline is refused unless a change
request authorises it** — a baseline replaced quietly is a delay that measures
itself against its own new position and always reports zero. The forecast also
carries the hash of the logic it ran over, so the position can say the programme
has moved under it without anybody having to remember to check.

Building this found a real defect in the existing code: `recalculateProgramme`
writes the live recalculation onto a `ProgrammeBaseline` record marked `LIVE`,
so counting every record of that type as a baseline made the re-baseline refusal
fire on the demo project and would have quoted every variance against a
recalculation rather than against the contract programme. `approvedBaselines`
filters on the type and status, and says why in the code.

**A blocked task with nothing behind the word.** AC-CN-WF-02-02 asks for a
reason, an owner, an impact and a next action, and all four are required —
"blocked" with none of them is a way of not saying who has to do what. A task
cannot be marked complete without the verification evidence the third exception
control names.

**Out-of-sequence progress with no decision behind it.** Retained logic and
progress override give different completion dates from the same facts, so the
status update carries which was chosen and why, per activity. A setting
configured once at the start of a project is a decision nobody took. There is
one definition of "started" — a percentage above zero *or* an in-progress or
complete status — used by the validation and the status update alike, because
two of them would let the same activity be out of sequence on the report and in
sequence at the point it was recorded.

Reproducibility, AC-CN-WF-02-01: every calculation hashes the logic it ran over
— durations, dependencies, types and lags, sorted canonically — so two runs over
the same stored programme give the same hash and the same critical path, and a
different hash is evidence the programme moved rather than noise from record
ordering.

---

### A shift is captured over a day, not in one shot

CN-WF-03. `backend/src/domain/dailylog.ts`, five routes, 22 tests.

**Most of what this workflow asks for was already built and none of it is
rebuilt.** `field/sync.ts` is the offline path — operations carry a
client-minted id so a retried batch changes nothing the second time, device
timestamps survive the server's receipt time, and conflicts resolve
deterministically with the losing change still recorded. `engines/perception.ts`
takes a voice capture to a draft a person confirms before anything becomes a
record, which is this workflow's own guardrail. And `recordSiteDiary` already
held the evidential rules: no future dating, contemporaneity stated, weather on
the good days too.

What was missing was the **lifecycle**. The diary was written in one shot, and a
shift is not: it is captured across a day, on a device, often with no signal, and
submitted once at the end of it.

**A draft that survives.** The device mints the id, so a capture interrupted by
a flat battery is the same capture when it comes back rather than a second one,
and a sync that runs twice writes it once — AC-CN-WF-03-01, done by the client
id rather than by a server-side guess about what looks like a duplicate.

**The device's clock is kept, and its error with it.** The receipt time never
replaces the capture time, and the *variance* is stored as well. A handset
eleven minutes fast is a fact about the evidence, and the position surfaces any
device out by more than a minute — somebody has to fix the phone.

**Submitted once.** After submission, editing is an amendment: a new record
naming what it supersedes, with the reason, and the **before and after of every
field that changed** computed onto it. AC-CN-WF-03-03 asks for exactly that, and
a diff nobody computes is a diff nobody reads. The original is never touched. An
amendment that changes nothing is refused, as is amending an entry something has
already superseded — two corrections of one day with no way to tell which is
current is worse than one wrong entry.

**Anomalous totals are reported, not refused.** Twenty-six hours in a day is
impossible and is refused; a fourteen-hour shift is unusual and is surfaced for
the supervisor to confirm, and cannot be submitted unseen. Refusing the merely
unlikely teaches people to enter the number the form will accept instead of the
one they measured, which is how a diary stops being evidence.

The rules now live in one place: `checkDiaryContent` is exported from
`engines/planning.ts` and used by both the one-shot desk entry and the device
submission, because two copies of "a diary cannot be dated ahead" eventually
become one copy and one omission. `currentDiaries` excludes drafts, so a shift
captured but not submitted leaves the gap in the evidence visible rather than
quietly closing it.

---

### A claim and an acceptance are different records

CN-WF-04. `backend/src/domain/progressverification.ts`, four routes, 27 tests.

The money path. Progress is what a valuation is built on, what earned value is
computed from and what the programme's remaining duration comes off, so a figure
that is wrong here is wrong in three places at once.
`engines/planning.ts` already measures productivity against baseline and
`engines/cost.ts` already computes earned value; neither is rebuilt. What was
missing is the thing that makes those numbers trustworthy.

**Submitted and accepted stay separately auditable.** AC-CN-WF-04-01. A verifier
who adjusts a claim from 240m³ to 180m³ cannot leave a record saying 180 was
claimed — the gap *is* the finding, and it is what a productivity argument and a
payment dispute both turn on. `submittedQuantity` is written once and never
touched. An adjustment needs a rationale **and** evidence of what the verifier
saw that the claim did not show; without it the record says only that two people
disagreed, which is exactly what gets argued about later. The claimant cannot be
the verifier.

**Nothing is claimed twice.** AC-CN-WF-04-03. A claim is against an activity, a
location and a period, and the same three arriving again is refused. Duplicate
reporting is rarely dishonest — a gang reporting the same pour on Thursday and
again on Friday — and it inflates earned value by exactly the amount nobody
notices. Rework is exempt from the duplicate rule, because redoing a bay is the
same place in the same week and treating it as a duplicate would make it
unrecordable, which is how rework disappears.

**Cumulative quantity cannot exceed the control total**, checked at *acceptance*
rather than submission: the claim is a fact about what somebody measured, and
refusing to record it would lose the evidence that the scope has moved. The
refusal names the drawing the control total came from, because that is what the
conversation will be about.

**Rework earns nothing.** Recorded against the same activity so the productivity
picture is honest, and contributing zero to the accepted quantity — recording it
as progress would report a project going backwards as one going forwards.

**One accepted figure, read by everything.** AC-CN-WF-04-02. Acceptance is what
writes the activity's percentage, so the programme, earned value and the
valuation read the same version by construction rather than by three modules
agreeing to; the task carries the accepted version number that produced it.
Where an activity has a measurement basis it is under this workflow and
`recordProgress` is refused for it — two doors to one money field is how they
diverge. An activity with no basis is untouched.

**Observed, not changed:** the quantity surveyor holds no `FIELD_EXECUTION`
entry at all, so they cannot read the progress verification register even though
they own the valuation it feeds. `acceptedProgressFor` is an unauthorised helper
so the valuation path itself works, but this is a permission-matrix gap worth a
product-owner decision rather than a silent edit.

---

### The platform could buy, and could not receive

CN-WF-05. `backend/src/domain/delivery.ts`, nine routes, 32 tests.

`domain/procurement.ts` took an RFQ to an award, a subcontract and a commitment;
`domain/supplychain.ts` decided who could be asked. Neither could receive
anything. There was no delivery, no goods receipt, no batch or serial, and
therefore no answer to the question every commissioning engineer asks: *which
valve is this, and where is its certificate?*

**A long lead nobody was tracking.** AC-CN-WF-05-01. Every item carries the date
the programme needs it and the lead time it takes, so the order-by date is
derived and a fourteen-week item with eleven weeks to run is reported as late
**on the day it is registered** — the only moment that is cheap to fix. Its
progress runs a fixed ladder from requisition to acceptance, and every step names
the evidence it rests on, because "in manufacture" from a supplier who has not
started is the commonest overstatement on any project and a document is the only
defence. Skipped steps — nothing imported has a customs step — are recorded as
skipped rather than passed over, and delivery and acceptance cannot be
*declared* at all: they are recorded by receiving something.

**A delivery nobody could take.** Bookings carry a slot, and two crane lifts in
one slot on one day are refused rather than discovered on the morning.

**A quantity nobody reconciled.** Ordered, dispatched and received are three
different numbers. A mismatch is not refused — the material is on site whatever
the paperwork says — but it cannot pass into stock without a reconciliation
naming whether it is a shortage, an over-delivery or damage, and who is chasing
it.

**A safety-critical product with no certificate is quarantined**, on arrival,
automatically. A traceable unit *and* a certificate against it: a batch number
with no certificate proves nothing about the batch, and a certificate with
nothing to attach it to proves nothing about what arrived. Quarantine is a state
the material cannot leave without **quality approve authority** saying what
resolved it, and a release that would leave the same gap is refused. Accepting
and installing are both refused while it stands.

Acceptance happens once, so inventory and the accrual move once
(AC-CN-WF-05-02); and an accepted serial is installed against a location and its
test evidence (AC-CN-WF-05-03), one serial in one place, which is the chain that
turns a delivery note into an as-built record.

**A defect this found in its own first draft:** the damage check read the
free-text condition for the word "damage" and reported "Sound, no visible
damage" as damaged. Guessing a fact from prose is the wrong shape; a person now
answers `damaged` explicitly, and the test fixture keeps that exact phrasing so
the regression cannot come back.

---

### The hold point nobody was enforcing

CN-WF-06. `backend/src/domain/qualitycontrol.ts`, seven routes, 26 tests.

`engines/quality.ts` already built the ITP, the inspection, the hold-point
register and the NCR. This module owns the five things that were missing, and
the first of them was **predicted by a comment in the existing code**:
`assertHoldPointsClear` was written with a note saying "a hold point nobody
enforces is a comment in a document", and nothing in the platform called it.

**A hold point that is actually enforced.** AC-CN-WF-06-02. A stage cannot be
inspected while an earlier hold point in the same plan is unreleased —
precisely that, rather than blocking all work on the package, which would stop
the job the moment an ITP was written.

**A release that is not the inspection.** A passed inspection is the inspector's
finding; the release is the authority to build over it, and on a hold point
those are two acts by two people. This changed existing behaviour: previously a
pass released the point by itself, which made a hold point a witness point with
a stronger word on it. The chain test that encoded the old assumption was
updated to prove the new one, and says why in its own comment.

**An inspection against an exact revision.** AC-CN-WF-06-01. The request names
the drawing or specification revision, the acceptance criteria off the stage,
who has to attend and what was finished first. "Inspected and passed" against a
drawing superseded on the Friday is invisible afterwards unless the revision was
written down at the time.

**A reading from an instrument out of calibration.** A torque wrench three
months past its certificate did not measure anything: the readings are not wrong
so much as unknown. The register makes that answerable, and an instrument nobody
registered is reported as unanswerable rather than as fine.

**A closure with something behind it.** AC-CN-WF-06-03. Rework and repair close
on a corrective action naming containment, root cause, corrective and preventive
action — and the preventive part is usually the only one with lasting value.
**Use-as-is is not a quality decision at all**: accepting work that does not meet
the specification is the designer accepting that the as-built differs from the
design, so it needs a concession under `DESIGN_INFORMATION` approve, from a
different person than the one closing the record. A concession states what it
does *not* cover, because one with no limits on it is read later as approval of
the method.

And a closed defect **reopens** when the evidence it closed on is withdrawn —
the survey sheet that turns out to be for the adjacent bay. The original closure
is kept in full on the record, because somebody acted on it.

---

#### The 9.4 gate

9.4 arrived **word for word identical to 6.4, 7.4 and 8.4**, which is exactly
what the shared machinery was built for: `evaluateConstructionGate` adds four
stage-specific clauses and shares the other three outright, and `gateFor` now
picks design, construction or tender by phase.

The construction stage's four: **inputs** are a mobilisation plan, a readiness
check and a start authority behind every package that was worked, and no daily
log left as a draft on a device — a shift captured and never submitted is a day
of evidence that does not exist. **Approvals** add "no progress certified by its
claimant" and "no use-as-is closed without a design concession" to the generic
re-verification. **Blockers** are the packages found not ready, the material
still quarantined, the open major non-conformances, the blocked tasks and the
hold points that passed and were never released. **The cut-off** uses the
programme's own reproducibility hash: if the logic has moved since the forecast
was taken, the cost and the programme are not describing the same job — and a
progress claim still awaiting verification means the valuation and the programme
are reading different numbers.

Clause 7 is `NOT_ASSESSABLE` and says why: every accepted serial traces to an
installed location, but the commissioning turnover pack, the system boundaries
it transfers and the retained construction obligations are CM-WF-01 onwards and
are not built.

---

### The second half of RAMS, permits and incidents

CN-WF-07. `backend/src/domain/safetycontrol.ts`, seven routes, 22 tests.

`engines/safety.ts` could already draft a method statement from a hazard
library, approve it, record the briefing, hold the competency register, issue a
permit against checked tickets, log an observation and record an incident.
Four things were missing, and each is the **second half** of something the
platform could already start.

**A method that was revised and nobody rebriefed.** A revision now supersedes
rather than edits: the new one starts unapproved and unbriefed whatever the last
one was, everybody who acknowledged the old revision is listed as owed the
difference **by name**, and the superseded revision stays readable because
somebody worked to it. `ramsCurrencyBlockedReason` is exported and called by
CN-WF-01's readiness verification, which previously could not see this case at
all — it checked that *a* method was approved and briefed, and a revision leaves
that true while the gang is on Tuesday's briefing.

**A permit that ran out and nobody handed back.** An extension cannot run past
the competency of the people it authorises — a permit extended over a lapsed
ticket authorises work by somebody nobody has checked — and cannot shorten a
permit, because that is a revocation and a different act for the people under
it. A handback records the state the area was left in, any outstanding hazard
and who checked it: the commonest injury after a confined-space entry is to the
person who goes in next, and that sentence is what they are relying on.

**An observation nobody closed.** AC-CN-WF-07-02: an owner, what was done and
the evidence that verifies it, all three or nothing.

**An incident recorded and never investigated.** Immediate cause, underlying
cause, root cause and the actions out of them — an investigation that stops at
the first concludes that somebody was careless. An incident cannot be closed
without one. What was already right stays: the platform *asks* whether an
incident is RIDDOR reportable and refuses to proceed without an answer either
way, and never decides it, which is the guardrail the specification names.

---

### Who was sent what, and what was only ever said

CN-WF-08. `backend/src/domain/informationcontrol.ts`, eight routes, 23 tests.

The drawing register, its supersession, the markup that becomes an RFI and the
answer recorded against a revision were built. Four things were not, and three
of them are the same failure from different sides: **the site is working to a
revision the office has already replaced.**

**Nobody recorded who was sent what.** Superseding a drawing changes the
register; it does not reach the person holding the old one in a site cabin. A
transmittal is the controlled issue — named documents at named revisions to
named recipients for a stated purpose — and each recipient acknowledges. Until
they do, the platform names exactly who is still holding superseded information,
which is the only useful form of that question. A document issued with no
purpose on it is refused: a drawing issued for comment and built from is how a
preliminary revision ends up in the ground.

**"Which revision am I building to?"** `currentInformationFor` is
AC-CN-WF-08-01 as one call: what is current, what it replaced, who has not
acknowledged the replacement. Latest issue wins per reference, resolving a
same-tick tie to the later ledger entry.

**An instruction that was a conversation.** The expensive one. Somebody senior
tells a foreman to move a wall, nobody writes it down, the wall moves, and six
months later there is no instruction, no variation and a contractor who did the
work. An **unconfirmed direction** records what was said, by whom, to whom, and
what the site did about it — "nothing yet" being a complete answer and a
different exposure from "started" — and stays visible until an instruction
confirms it or somebody records what happened to it. **The platform never
converts one into an instruction**: that is the guardrail the specification
names, and issuing one is `CHANGE_VARIATION` approve.

**An instruction with no authority on it.** AC-CN-WF-08-03: sequentially
numbered, under a named clause, to named recipients, with the issued document as
evidence and an implementation status somebody other than the issuer verified.

AC-CN-WF-08-02 is answered by deriving rather than typing: an RFI's *due* date is
contractual and its *required-by* comes off the programme through the activity
the answer is holding up, so the position reports both and the float between
them. A second typed date is a second date to be wrong.

One honest limit is stated in the code and the test: the instruction-length rule
is a **floor, not a judgement of clarity**. No rule distinguishes "proceed as
discussed" from a real instruction; what it stops is the one-word instruction,
which is common and always a dispute.

---

### Five values that are not one value, and a deadline somebody checked

CN-WF-09 and CN-WF-10 together. `backend/src/domain/valuechain.ts`, four routes,
19 tests.

Almost all of both workflows was already built and is reused rather than
rebuilt: change requests and the variation control matrix, upstream/downstream
reconciliation, delay events and their cost, the contract obligations calendar
with its clause citations, the payment cycle with its over-certification and
overpayment refusals, the Construction Act notices, the commitment ledger and
the live CVR. Two things were genuinely absent.

**One number where there are five.** AC-CN-WF-09-03 and AC-CN-WF-10-01: what was
*submitted*, what was *assessed*, what was *certified*, what was *agreed* and
what was *paid* are five separate facts, and collapsing them destroys the three
questions the commercial team actually asks. Submitted against assessed is the
**negotiating position**; certified against paid is **cashflow**; agreed against
paid is the **dispute**. Each stage is written once and never overwritten — a
submitted figure that gets edited down to the assessed figure is how a claim
loses its own history — and the authority follows the stage rather than being
one blanket permission for five different acts: `CHANGE_VARIATION` create for
submitting and assessing, approve for certifying, agreeing and recording
payment. The whole entity is `COMMERCIAL_L3`, for the same reason the variation
register is: it is the negotiating position.

No order is imposed between certified and agreed. Contracts differ on which
comes first and a platform that insisted on one would be wrong on half of them.
What is refused is paying above the certificate, and paying below it is recorded
rather than refused — that is cashflow, not an error.

**A deadline the platform derived and nobody checked.** AC-CN-WF-09-01 and
AC-CN-WF-10-02. A time bar computed from a clause the platform has interpreted
is a liability if it is wrong and nobody looked. Each derived deadline carries
its **rule source**, its **calculation inputs** — trigger event, trigger date,
period, calendar basis — and, until a person with `CONTRACTS_CLAIMS` approve
signs it, `validated: false`. The position reports unvalidated time bars
separately, because a time bar nobody has checked is the one that cannot be
recovered. A validator who disagrees must say what the right date is; marking it
wrong and leaving it there is worse than the derivation. A correction keeps the
derived date alongside the corrected one — the pattern of corrections is how a
wrong rule gets found.

---

### One action, one identity, and a decision with alternatives on it

CN-WF-11. `backend/src/domain/decisioncontrol.ts`, six routes, 23 tests.

`domain/meetings.ts` already held the meeting record, attendance with apologies,
the agenda in the words used, actions with an owner and a date, carry-forward
that never resets the original date, closure with a note rather than a tick,
issue-once and a correction recorded beside issued minutes with both versions
readable. None of that is rebuilt. Three things were absent.

**The same action, counted twice.** AC-CN-WF-11-01. Actions are raised in a
meeting, on a non-conformance, against a safety observation and at a stage gate,
and every one of those registers reported its own — so a person reading two
screens saw one commitment twice and could not tell. The register derives a
**stable identity from the source record** and writes nothing: the source
register stays the only writer of its own actions. Escalation climbs the role
hierarchy the permission matrix already defines rather than a list of names
somebody has to maintain, and nothing escalates on the day it falls due. A
source the reader cannot see is **omitted rather than refused** — a register
that threw on the first safety entry a planner could not read would be unusable
for everyone, and a safety action still never reaches a role without safety
read.

**Minutes that changed after they were approved.** AC-CN-WF-11-02. Issue already
froze the narrative, but closing an action is deliberately permitted afterwards
— the register is live and freezing it would need a new meeting for every
closure. That means the *state* of an issued meeting is not what the chair
approved, and a minutes document regenerated in November would show October's
actions closed. Approval now takes a hash-addressed snapshot of exactly what was
approved, stored as its own `MinutesVersion` entity rather than on the record it
snapshots, and issue is refused if the draft has moved since. Re-approving
amended minutes records a second version beside the first. The guard binds only
where the project approves minutes at all, so it imposes no step on a project
that predates it.

**A decision with no alternatives.** AC-CN-WF-11-03. A material decision that
records only what was chosen is an instruction being minuted; what a reader six
months later needs is what else was on the table and why it was not taken. A
`DecisionRecord` carries the named authority and what gives them it, the
rationale, the alternatives each with the reason it was not taken, and an impact
**per dimension including where there is none** — an impact nobody assessed and
an impact somebody assessed as nil are indistinguishable when the field is
simply left out, and only one of them is safe. Legal and commercially sensitive
discussion takes a restricted classification, read through the same clearance
the access decision reads (`abac.clearedFor`, exported so there is one answer
rather than two), and is withheld from a role without it while the rest of the
position still answers.

The specification's guardrail is kept exactly: **the platform never converts a
decision into a contractual instruction.** A decision that needs one says so and
stays on the outstanding list until a person calls
`informationcontrol.issueInstruction` and the reference is recorded against it.

Two of the specification's five event names are already in the catalogue under
different names and are not duplicated: `MEETING_RECORDED` is `MEETING_HELD`,
and `ACTION_ASSIGNED` is part of it, because attendance, agenda and actions are
one act. The register derives rather than re-emitting them.

---

### A cut-off that reconciles, and a system with a boundary on it

CN-WF-12. `backend/src/domain/completion.ts`, seven routes, 30 tests. This
completes the construction workflow block: CN-WF-01 to CN-WF-12 are built.

Reused rather than rebuilt: the delay forecast with its costed corrective
measures, the CVR and cashflow, the commissioning test and system acceptance,
the document engine that renders a report once the numbers exist, the stage gate,
and every position function the construction block added. Four things were
absent.

**A report with no cut-off.** AC-CN-WF-12-01. Every position function on the
platform answers *now*, so a monthly report built from four screens read on four
different days reconciles to nothing — and the discrepancy is always found by
whoever is arguing with it. A snapshot is defined as **the ledger as at a stated
instant**, the same definition replay uses, and its content hash is over what
was read rather than over the record, so anybody re-running the cut-off
reproduces it. `reconcileSnapshot` proves it still holds after the project has
moved on.

**A report that hides what it could not see.** The exception control. A source
with no records renders as a zero on every reporting tool ever built, and a zero
looks like good news. Here an unreported source is **named**, a source nobody
has touched in more than a fortnight is named as **stale with how many days**,
and the sources whose absence is a reporting failure rather than a genuine nil
are separated into `criticalGaps` — a project with no deliveries this period is
not a project with no progress records.

**A recovery option nobody chose.** The forecast produced costed measures; what
could not be recorded was a person selecting them, which is exactly the
specification's guardrail — the platform "cannot declare completion or select
recovery". An approved plan names the measures, their owners, what they recover
and what they cost, and reports the **shortfall** rather than refusing it: a
plan that recovers part of a delay is a real plan, and one presented as
recovering all of it is the problem.

**Turnover as a state rather than a boundary.** AC-CN-WF-12-02 and -03. A system
handed to commissioning with no defined boundary is how two parties each conclude
the other holds the isolation. Release requires the boundary, the isolations with
their holders, what construction **retains** after turnover, every residual
defect classified with an owner and a completion condition, and evidence against
each of eight rules — completeness is computed from a table, not declared by a
tick. A defect classified as blocking cannot be carried through the release that
starts commissioning. `handover.recordCommissioningTest` now refuses a system
that has not been released, unless somebody with authority has recorded an
exception saying what is missing, why, and when it will be in place — an
exception with no expiry becomes the permanent state.

**The stage 9 exit.** `CONSTRUCTION_COMPLETION_ACCEPTED` is issued only by a
role holding approve on the project itself, which is the matrix's existing answer
to "only by authorised party". It is refused while no system has been turned
over, while a residual obligation has no owner, and over a turnover exception
that has passed its date — accepting completion over an expired exception accepts
the thing the exception was covering, without saying so.

One defect in existing code was found and fixed on the way: the stage-gate
evidence description used a two-way ternary and labelled every construction gate
report as a tender one.

**Still to build in the construction block:** the
stage workspace described in 9.2. The specifications received so far — the
construction stage control, 9.1, 9.2, CN-WF-01 to CN-WF-12, the 9.4 gate, the
commissioning stage control with 10.1 and 10.2, and CM-WF-01 to CM-WF-06 — are
recorded verbatim in `docs/WORKFLOWS.md`.

---

## The commissioning block (stage 10)

### Every asset in exactly one boundary

CM-WF-01. `backend/src/domain/systemisation.ts`, eight routes, 19 tests.

The commissioning stage's first workflow, and the one thing the platform had no
representation of at all. `engines/handover.ts` records a commissioning test
against a `systemId`, and until now that was a free-text string: two engineers
could test "AHU-1" and "AHU-01" and the platform would hold two systems, or one
could test a fan coil nobody had said belonged to anything.

**The hierarchy.** Facility → system → subsystem → equipment, each with a stable
tag, a boundary description and its own asset list. A level cannot be skipped: a
subsystem hanging off a facility is a missing system, and the level nobody owns
is the level nobody tests.

**Both silent failures, detected rather than asked about.** AC-CM-WF-01-01. A
**gap** is an asset in nobody's boundary — the asset nobody tests. An **overlap**
is an asset in two — the asset each team believes the other is testing. Assets
are declared on the boundary that owns them rather than on the asset itself,
because the question is about the boundaries, and an answer stored on the asset
would let two boundaries disagree with it. Either blocks approval, as does a
boundary drawn around nothing, which produces a test pack with no scope.

**A test with no witness is a test nobody has to attend.** AC-CM-WF-01-02: stage,
owner, witness, acceptance criteria, the controlled source those criteria come
from, and the prerequisite — all six checked at approval, plus a notice period,
because a witness who finds out on the day does not attend. Approval then
records a `TestPackRequirement` per planned test, so a test executed without a
pack is visibly outside the plan rather than merely undocumented.

**The programme has to reach both ends.** AC-CM-WF-01-03: a commissioning
programme naming no construction milestone and no handover milestone is a plan
for a building nobody is constructing and nobody is taking over. A milestone
depending on one nobody planned is refused too.

**Temporary operation is a separate state, never implicit commissioning.** The
exception control, and it matters because running plant to dry out a building or
provide temporary heat is not commissioning it — but the plant runs, the hours
accrue and the manufacturer's warranty starts. It is its own record with a
purpose, a bounded period, a responsible party and what is *not* in place that
commissioning would require; if the answer to that last one is genuinely
nothing, the system is ready to be commissioned rather than temporarily
operated. A system running past the end of its period is named in the position.

---

### A revision that stops moving

CM-WF-02. `backend/src/domain/testpack.ts`, seven routes, 23 tests.

Reused: the instrument register and `qualitycontrol.calibrationBlockedReason`,
which already answers "was this instrument in calibration when the reading was
taken"; the readiness-check pattern from `domain/mobilisation.ts`; and
CM-WF-01's boundaries and test-pack requirements.

**The frozen revision.** A test executed against a procedure somebody edited
afterwards proves nothing, and the edit is invisible — the pack reads as current,
the result reads as a pass, and only the person who made the change knows the two
do not belong together. Release hashes the procedure; `executionBlockedReason`
is AC-CM-WF-02-01 in one call, and it catches both the unreleased pack and the
released one whose steps have since moved. A revision after release **cancels**
it rather than amending it, because the readiness check was carried out against
the old steps.

**Criteria that can be argued from.** AC-CM-WF-02-02: every criterion cites a
controlled source and names the raw reading and unit that answer it. "To the
satisfaction of the engineer" is not an acceptance criterion, and a criterion
with no measurement behind it produces an opinion. Contradictory tolerances — a
lower limit above the upper — are refused at creation, which is the
specification's "identify contradictory tolerances" as a rule rather than a
review.

**Nine readiness items, of which five block.** The three the exception control
names — calibration expiry, an open critical defect, a missing safe isolation —
are all the same failure in different clothes: the reading cannot be relied on.
Instrument calibration is **derived from the register, never declared**: a
checklist that let somebody tick "instruments" over an expired certificate would
be a checklist that could be wrong. An unanswered item is refused rather than
treated as passed, and a blocker with no description is refused because nobody
except the person who raised it could clear it. A blocked release is **written to
the ledger** as well as refused — the pattern of blocked tests is how a late
commissioning stage is diagnosed, and a refusal leaving no trace makes the same
blocker look new every week.

**A witness is a person and a time.** AC-CM-WF-02-03: notification and response
are separate events, so both carry their own timestamp. Short notice is reported
rather than refused — it happens, and the contractual consequence is somebody
else's to draw. A waiver is an authorised record naming the contract rule that
permits it; the witness who did not turn up has not waived anything.

---

### A reading that is a measurement, and an exception that leaves the factory

CM-WF-03. `backend/src/domain/vendortest.ts`, six routes, 20 tests, plus one
field added to `delivery.procurementPosition`.

Built **on** CM-WF-02 rather than beside it: a factory test runs against a
released test pack, so its criteria, controlled sources, units and limits are
the ones that workflow already refuses to accept without — and AC-CM-WF-02-01
applies at the factory too, since a FAT against an unreleased procedure is
refused here as anywhere else. Instrument calibration is
`qualitycontrol.calibrationBlockedReason`, unchanged.

**A reading is a measurement, not a number.** AC-CM-WF-03-01: value, unit, the
instrument it came off, who took it and when. A reading from an instrument out
of certificate is refused rather than flagged, and a reading whose unit differs
from the criterion's is refused too — a unit converted in somebody's head is the
commonest way a test passes when it should not.

**The result is calculated and the decision is a separate field.**
AC-CM-WF-03-02. The platform compares readings to limits and gets one answer
every time; what a person does about it is recorded beside that, never in place
of it. Recording a pass over a reading outside its limit is refused, naming the
reading and its value: that is not a decision, it is an overwrite. The same
readings accepted **conditionally** are a decision, and a conditional acceptance
needs the operating restriction and the date it clears by — one with no date
never clears.

**A vendor PDF is not a result.** Completion requires a reading against every
criterion, so a certificate asserting the equipment passed cannot complete
anything. That is the exception control enforced by having no way round it.

**An exception raised at the factory does not stay at the factory.**
AC-CM-WF-03-03. Exceptions follow the equipment tag and are read by one exported
function, so the delivery screen, the SAT and the position all show the same
list rather than each keeping their own — the commonest way a factory exception
is lost is that the delivery note closes it. Closure needs the verification, not
the vendor's assurance. A serial mismatch between the unit ordered and the unit
tested blocks shipping release: either the wrong unit was tested or the wrong
unit is being shipped, and both are found on site months later.

---

### Static completion is a statement, and a fail is never edited into a pass

CM-WF-04 and CM-WF-07 together. `backend/src/domain/prefunctional.ts` and
`backend/src/domain/commissioningexception.ts`, twelve routes, 24 tests.

Built as one vertical although the specification numbers them apart: a failed
pre-functional check has to go somewhere, and two modules each keeping their own
idea of an open item is exactly what rule 6 forbids. The exception module was
written first so there is one owner of the entity, and CM-WF-05's failures will
raise into the same one.

**Readiness from accepted checks, not file count.** AC-CM-WF-04-01. Thirteen
checks, weighted, and only items somebody accepted count towards the numerator —
the number this replaces goes up when somebody attaches the wrong drawing twice.
A **not applicable** item leaves the denominator rather than counting as a pass,
and it needs a rationale and an approver, because "N/A" is the commonest way a
check is skipped and the ones skipped are disproportionately the ones that would
have failed. An observation counts as accepted; a failure counts for nothing.

**Static completion is not construction completion.** It is the statement that
the system is safe to energise and operate. It is refused while any item is
unanswered, while any item is failed, and specifically over the four the
exception control names — guarding, isolation, earthing and pressure integrity —
with a message saying why those four are never carried.

**Rework invalidates what it reaches.** The platform does not guess the scope: a
rule that invalidated everything would be ignored within a fortnight. A person
names the affected checks, and those items return to **unanswered** rather than
failed — nobody has looked at them since the rework, and "not looked at" is the
true state. `functionalTestBlockedReason` is AC-CM-WF-04-03 in one call and
binds only where the project runs pre-functional checks.

**The exception chain is references, not retyped sentences.** AC-CM-WF-07-01:
criterion → raw result → action → retest → closure. The specification's "create
exception from failed item **without re-entry**" is implemented literally — the
raw result is read out of the failed check or the failed reading, so an exception
can never disagree with the test it came from.

**A fail is never edited into a pass.** Closure does not change the original
result; it *adds* a verified succeeding one, and every failed attempt stays
(AC-CM-WF-07-03). Closing is refused while no retest has passed, and refused
while nobody has confirmed what the failure invalidates — the tests that assumed
the failed one was right are the dangerous ones, because they read as complete.
The platform proposes no scope: the specification says a human confirms it, and
an empty list is a finding that has to be explained rather than a default.

Repeated failure is counted from **retest attempts** rather than exceptions —
one exception retested four times is the signal, not four separate items — and
escalates against both the system and the responsible party. A safety-critical
conditional acceptance is deliberately harder than a closure: an exceptional
authority by name, an operating restriction saying what may not happen while it
stands, and a review date.

---

### A response rather than a number, and an abort that is not a fail

CM-WF-05. `backend/src/domain/functionaltest.ts`, eight routes, 22 tests.

Almost nothing here is a new idea, which is the point: the criteria come from
CM-WF-02's released pack, the calculated-result-beside-authorised-decision split
is CM-WF-03's, the static-completion guard is CM-WF-04's and failures raise into
CM-WF-07's exception. One small refactor removed a real duplication —
`testpack.satisfies` is now the single definition of whether a reading meets a
criterion, where CM-WF-03 had its own copy.

**A response, not just a number.** AC-CM-WF-05-01. A damper that eventually
closed and a damper that closed in eight seconds give the same reading and are
different systems, so every step records what was observed and when, and a
criterion answered by a description alone is refused — nobody could recalculate
it. A response *time* is a measurement the criterion judges, on the same
footing as a value. The trend dataset is referenced by hash and never
summarised, because a summary of a trend is an opinion about a trend.

**An abort is not a fail.** The exception control, and it matters because the
two are recorded identically on most systems and mean opposite things about the
equipment. A test abandoned because the chilled water was off tells you nothing
about the plant; recording it as a failure puts a defect against equipment
nobody tested. The partial data and the reason stay, somebody decides afterwards
what it meant, and the one decision refused is a pass — that would assert a
result nobody observed.

**A deviation is an annotation, not an edit.** Engineers deviate for good
reasons and the deviation is often the most useful thing in the record; what it
may not do is quietly change what was proven. It is authorised by name and
carries an explicit judgement on whether the result still stands — and where it
does not, the platform refuses a pass over it.

**An integrated test cannot pass on unproven dependencies.** Checked when the
test *starts* rather than when it completes, because the wasted day is the point
of checking it. A fire-alarm cause-and-effect test that passes while the
ventilation it commands is conditionally accepted has proved the ventilation did
what it was told this once, which is not the same as the ventilation working.

**AC-CM-WF-07-02 turned out to be enforceable, not merely visible.** A test some
open exception invalidated cannot be re-run as though nothing happened — it has
to be run as a retest against that exception, so the failure and the succeeding
result stay one chain.

---

### The only test that cannot be passed by doing something well once

CM-WF-06. `backend/src/domain/reliability.ts`, seven routes, 19 tests.

A soak test asks whether the plant *keeps* working, and everything that makes it
hard is about the gaps: the hour the trend logger was down, the night somebody
put a valve in hand to stop an alarm, the fortnight the run was quietly
restarted after a failure.

**Metrics are derived on every read, never stored.** AC-CM-WF-06-01: they
reproduce from the raw trend and the configuration. Coverage is the **union** of
the imported segments — two exports of the same fortnight is how a trend is
usually assembled, and a naive sum would report 200% coverage — and availability
is available time over *covered* time, with the uncovered part reported
separately as the gap. Rolling the two together would let a fortnight of missing
trend read as a fortnight of unavailability, which is a much more specific claim
than the truth, which is that nobody knows. A stored availability figure is the
one that stays at 99.4% throughout the fortnight the logger was off.

**A data gap is a hole in the evidence.** Derived from what was imported rather
than declared, so nobody has to remember to mention one, and judged against a
configured tolerance. A soak test passed on a dataset with a day missing from
the middle proves nothing about that day.

**A manual override is a fact about the result.** Putting a valve in hand is the
single most effective way to pass a soak test and is invisible in the trend
unless somebody records it. An override counts against availability like a
failure, and the refusal names the minutes — for that period the system was not
controlling itself. Availability is checked **before** duration deliberately: a
run that lost ten hours to a valve in hand is also short of its duration, and
telling somebody to run it longer would be advice that fixes nothing.

**Continue, reset or retest is authorised.** AC-CM-WF-06-02. It is the most
consequential decision in a soak test — a reset costs the whole duration again —
and the one most often taken by whoever is standing nearest the panel. An
anomaly pauses the run; acceptance over an undecided one is refused; and a run
that was reset cannot be accepted for the part of it that ran.

**A seasonal test is an accepted obligation, not an intention.** AC-CM-WF-06-03.
Heating cannot be proven in July. The criteria are fixed *now*, because criteria
agreed in November against a system already in use are agreed under pressure and
the party that has to meet them is by then least able to argue. A named party
accepts the obligation, and `outstandingSeasonalTests` is exported as one list
for the handover stage to inherit by reference rather than copy.

---

### Completeness from required records, and obligations that transfer by reference

CM-WF-08 and the 10.4 gate. `backend/src/domain/commissioningclose.ts`, six
routes, 24 tests, plus `evaluateCommissioningGate` in `domain/stagegate.ts`.
This completes the commissioning block: CM-WF-01 to CM-WF-08 and the stage gate
are built.

**A dossier is scored on required records, not files.** AC-CM-WF-08-01, the same
principle CM-WF-04 applies to readiness. A dossier scored on uploads reaches
100% when somebody attaches the wrong O&M twice, and 60% on a system whose six
records happen to be in one combined PDF. Twelve required records per system,
each present by controlled reference *and revision*, and a duplicate is refused
rather than counted — it adds nothing and hides which is current. The index is
hashed, so a dossier that can be quietly topped up afterwards is not the dossier
anybody accepted. Six of the twelve are marked as records an operator cannot
start without, and their absence blocks acceptance rather than merely lowering
the percentage.

**Training on superseded information is not training.** The exception control,
and the one nobody expects. Operators are trained in the last fortnight before
handover, which is exactly when as-builts and control descriptions are still
moving. Every session records the documents it taught from **at the revision
taught**, and superseding one invalidates every session that rested on it — the
role then appears on a retraining list rather than a training record standing
that taught people to operate a building that does not exist.

**An acceptance is a named person's acknowledgement.** AC-CM-WF-08-02. The party
accepting a system is the party running it at three in the morning, and
"accepted" with nobody's name on it is the row nobody can be asked about. A
conditional acceptance carries operating limits, risk owner, expiry and closure
plan — all four, because a condition missing any of them becomes permanent. A
system cannot be accepted over an open safety-critical exception, though it can
always be *rejected*, which is what a rejection is for.

**Obligations transfer by reference.** AC-CM-WF-08-03. `handoverObligations`
reads the seasonal tests from CM-WF-06 and the residual items from CM-WF-07,
each keeping the identifier it already has. The completion event stores
identifiers and kinds, never copied text: a second copy of a seasonal test is
the one that disagrees with the first within a month.

**The 10.4 gate** is word-for-word 6.4, 7.4, 8.4 and 9.4, so only the five
stage-specific clauses are written and the AI and replay clauses stay shared.
Approvals are checked for maker-checker on the thing that matters most here — a
test decided by the actor who ran it — and the blockers clause treats a
conditional acceptance as the permitted time-bound condition the clause allows,
until its review date passes. Clause 5 reported `NOT_ASSESSABLE` as it did at
every other gate, for the same honest reason — the AI event block recorded no
assumptions and no prompt version. That is closed; the clause now assesses.

One stale claim was corrected on the way: the **9.4 downstream clause** had read
`NOT_ASSESSABLE` because the commissioning turnover pack did not exist. CN-WF-12
built it, so the clause now assesses the boundaries and retained obligations
properly instead of reporting a gap that had been closed.

**Still to build:** the commissioning stage workspace described in 10.2.

---

## The handover block (stage 11)

### A matrix no file can close

H-WF-01. `backend/src/domain/handoverrequirements.ts`, nine routes, 23 tests.

The spine of stage 11. Every other handover workflow satisfies requirements that
live here, and readiness is the arithmetic over them.

**No requirement is closed by a file upload.** AC-H-WF-01-03, and the rule the
whole workflow turns on. The commonest failure of a handover matrix is that it
becomes a document-collection exercise: somebody attaches a PDF, the row goes
green and nobody has read it. Every requirement carries an **evidence rule**
saying what would actually satisfy it, and acceptance is an act by the **named
acceptance party** — a decision recorded for anybody else is refused, and one
with no reasoning is refused with the evidence rule quoted back. An acceptance
*with conditions* counts as **unmet**: it is a requirement somebody agreed to
close later, and counting it as done would show a project ready to hand over
with its conditions still open.

**Readiness is derived, never stored.** The specification lists a
`READINESS_UPDATED` event and this platform registers none, for the reason it
declines every stored derivation: a readiness percentage is the number nobody
updates after the requirement it was computed from moved. It is recomputed on
every read over the **weighted mandatory** requirements — an advisory one still
appears as unmet but cannot inflate the figure — and AC-H-WF-01-02 falls out of
computing it that way: each unmet row carries its source, its clause, its owner,
its date and *why* it is unmet.

**A statutory requirement is not waivable.** Absolutely, by any role in the
matrix, because the authority that could waive it is not a project authority at
all. An ordinary one can be waived by whoever governs the project, with a reason
and an **expiry** — and readiness read past that date shows it unmet again, which
is what stops a waiver becoming permanent by neglect.

**A reissued source is a question, not a silent update.** Requirements drawn
from the replaced version are flagged for delta review rather than re-pointed: a
matrix that quietly followed a reissue would be satisfying obligations nobody
has read.

**A partial handover needs its own boundary and subset.** Accepting a floor
against the whole project's matrix means accepting it against requirements that
do not apply to it, and a section is scored against its own.

---

### As-built status from a person, not a filename

H-WF-02. `backend/src/domain/asbuilt.ts`, eight routes, 21 tests.

`engines/bim.ts` already generates an as-built model by reconciling design intent
against captured site reality, and it is untouched: that is the *drafting* side
and legitimately an AI act. What an agent cannot do — the specification says so
plainly — is certify accuracy, and this is the verification layer.

**AC-H-WF-02-01.** A set called "AS-BUILT-FINAL-rev-C" is a set somebody named.
A set that *is* as-built is one an authorised professional has verified against
the approved design and the changes implemented since, with their name and
registration on it. Until then it is submitted, and an unverified set cannot be
published for operational use.

**AC-H-WF-02-02.** The commonest defect in an as-built package is not a wrong
line — it is a change that was approved, built and never drawn. Every
implemented change is answered `REFLECTED` or `NOT_APPLICABLE`, and both need a
reason: "not applicable" is a claim about the change, and one with no reasoning
is how a change gets lost.

**AC-H-WF-02-03.** One link record answers both directions, so the asset cannot
open from the drawing while the drawing does not know the asset is on it — and
it carries the set's status, so a maintenance engineer knows whether they are
reading published information or a submission somebody is still arguing about.

The three exception controls are enforced rather than reported: a **material
variance** blocks verification and, through an exported guard, the handover of
the system it touches; a converted deliverable needs the **native file** behind
it and a note of what the conversion dropped; and publishing a revision
**supersedes** the earlier one, because an operator with two current as-builts
has none.

---

### A manual is not a folder of PDFs

H-WF-03. `backend/src/domain/ommanual.ts`, eight routes, 26 tests.

`handover.publishOMManual` still extracts maintenance tasks, intervals and
spares from manufacturer documentation and is untouched — extraction is a
legitimate AI act, and what it produces is a **draft**. This is the structure,
the review and the acceptance that turn a draft into something an operator can
run a building on.

**Eleven sections, each answering a question an operator asks.** A section with
a manufacturer catalogue behind it and no mapping to the installed tags is
refused: a generic pump manual covering forty models tells an operator nothing
about the two in the plant room. Troubleshooting must carry symptoms and
maintenance must carry tasks with frequency and skill — prose describing
maintenance is not a schedule anybody can plan from.

**AC-H-WF-03-02: source, version and approval on every section.** The question
asked of a maintenance interval at three in the morning is where it came from
and who agreed it. Acceptance needs **two** reviews — the technical checker and
the operator who has to use it — and a section checked by the person who wrote
it is refused.

**AC-H-WF-03-01: searchable four ways.** Symptom is the one usually missing from
an O&M and the one that matters: nobody looks up "AHU-01 maintenance" at three
in the morning, they look up "no heating on level three". Every hit carries the
section's source and status, so nobody works from a draft believing it is
accepted.

**AC-H-WF-03-03: changed asset data finds its sections.** When a pump is
replaced with a different model, the maintenance schedule, spares list and
troubleshooting entries that named the old one are wrong and read as current
until somebody notices. They are flagged for revision.

Acceptance is refused on the things an operator cannot start without: a missing
emergency or safety section, AI-drafted text nobody accepted, an asset the
manual names and never describes, and — the quiet one — **the same task given
two different frequencies**, which comes from two source documents neither of
which was wrong.

---

### Blank is not pass, and export success is not acceptance

H-WF-04. `backend/src/domain/assetregister.ts`, four routes, 17 tests, plus one
correctness fix in `engines/handover.ts`.

`registerAsset` and `registerWarranty` are reused unchanged. What was absent is
everything that decides whether the register is **fit to hand over**.

**Blank is not pass.** An asset register with empty serial columns scores as
complete on every tool that counts rows, because a blank passes a presence check
by not being examined. Here a mandatory attribute is either supplied or recorded
as an explicit **Unknown with an owner, a reason and a date** — a different
thing entirely, because somebody has to be asked about it, and readiness blocks
once that date passes. The asset's own identity — tag, manufacturer, model —
cannot be declared Unknown at all: an asset with none of those is not a record,
it is a row.

**A duplicate identity blocks acceptance.** The tag is what the maintenance
system, the O&M manual, the drawing link and the warranty all resolve to a
single machine, so `registerAsset` now refuses a tag that is already registered
— a correctness fix to existing code, not a new rule. A duplicate *serial* is
reported rather than refused, because it usually means a row was copied rather
than a machine registered twice.

**Export success is not acceptance.** AC-H-WF-04-03, and the failure that makes
asset handovers famous: a COBie file uploads cleanly, the project closes, and
eighteen months later the maintenance system turns out to have silently rejected
four hundred rows for a classification value it did not recognise. An export
here is a claim; **reconciliation** against what the target actually accepted is
the answer, the totals have to add up, and a rejected row with no reason — or
one that was never in the export — is refused. Exporting a register that still
carries validation errors is refused too: it does not fix them, it copies them
somewhere harder to correct.

---

### What the platform will not do, and the three things a recipient confirms

H-WF-05. `backend/src/domain/regulatorycompletion.ts`, six routes, 22 tests.

The most consequential workflow in the handover stage, and the one where the
platform's limits are stated first, in the module's own doc comment and here.

**What it does not do.** It does not decide what any jurisdiction requires. The
checklist is the specification's own list of required inputs, and the
`jurisdiction` recorded against a readiness check says which regime the pack was
assembled *for* — it does not encode that regime's law. Nothing here makes a
legal classification, signs a declaration or submits anything: submission
happens outside the platform, and what is recorded is that it happened, by whom,
and what came back. Pretending otherwise would be the most dangerous thing this
codebase could do, so it is refused by construction — every event carries
`aiAllowed: false` and the declaration is a required field somebody signs.

**AC-H-WF-05-01: exact versions.** A completion pack referencing "the as-built
drawings" references nothing. Every evidence item names its document *and its
version*, because the question asked of a completion pack years later is which
revision was in it.

**A readiness check reports rather than refuses.** One that could only be run
when it would pass would never be run at all. The pack *approval* is where the
refusals live: a missing mandatory item, or an open completion blocker — which
prevents the application, not merely the occupation.

**AC-H-WF-05-02: the recipient confirms three separate things.** Transferring
the golden thread is not sending a link. The accountable person confirms
**access**, **completeness** and a **usable format**, and any one of them false
means the duty has not moved — because they fail separately: a recipient can
have access to something incomplete, or receive something complete in a format
they cannot open. The transfer needs **two authorities**: `EVIDENCE_AUDIT`
import/export, which nearly every delivery role holds and should, *and*
`PROJECT_SETUP` approve, because transferring control of the duty is a
governance act rather than an export.

**AC-H-WF-05-03: conditions outlive the project.** A certificate granted subject
to conditions is a certificate with work still to do. Each condition needs an
owner and a date, and `regulatoryConditions` exports them for the handover
obligations to inherit by their own reference. A refusal leaves the submitted
pack untouched — it is the evidence of what was applied for — and a corrective
version is a new pack that names it.

---

### Attendance is not competence

H-WF-06. `backend/src/domain/operatorreadiness.ts`, six routes, 21 tests.

CM-WF-08 already ties a training session to the revision it taught and
invalidates it on supersession — that is AC-H-WF-06-02 and the second exception
control, already built, and this reads those sessions rather than keeping a
second set. An invalidated session drops out of the coverage entirely, and an
assessment cannot be recorded against one: assessing somebody on a building that
no longer exists proves nothing about the one that does.

**Attendance is not competence.** The exception control every training record in
construction gets wrong. A signature on a sheet proves somebody was in the room.
Where the needs analysis says an assessment is required, it is a separate act by
a separate assessor with a method and evidence — and until it happens the person
is *awaiting assessment*, not competent. A self-assessment is refused: that is
not an assessment, it is a declaration.

**AC-H-WF-06-01: every operational role covered, or a controlled gap plan.** The
question at handover is not "was training delivered" but "is there a competent
named person for every role this building needs to run". A gap plan is accepted
in place of one, but it needs the **interim arrangement** — somebody still has
to operate the building on Monday — with an owner and a date. A readiness
acceptance also needs the outstanding support arrangement stated: nobody runs a
new building unaided in the first month, and one that pretends otherwise is
withdrawn in week two.

**AC-H-WF-06-03: the blocker names the person, not the consequence.** A failed
assessment is reported before the coverage shortfall it causes, because "K. Osei
was assessed as not yet competent" is actionable and "no competent named person"
describes what follows from it.

**One honest limit, stated in the code and here.** The specification asks for
personal competence data to carry restricted access *and retention*. The
sensitivity ladder has **no personal-data tier**; a competence assessment is
classified `SAFETY_L2`, which is a real restriction and the nearest available,
but it is not a purpose-built personal-data control and is not claimed as one.
The retention half is not implemented.

---

### There is no field a secret could go in

H-WF-07. `backend/src/domain/transfer.ts`, six routes, 47 tests.

The unglamorous half of a handover, and the half that decides whether anybody
can get into the plant room on Monday.

**AC-H-WF-07-02 is structural, not a rule.** "No secret value appears in the
audit log or export" cannot be enforced by validating input, because a rule that
inspects a secret has already handled one. So the credential path has **no field
a secret could occupy**: a credential is registered by its vault reference and
its status, and the transfer records that it happened through a named mechanism.
The platform never holds, sees or moves the value, and because the type has no
place for one, no future caller can supply it by accident. The test for this
walks the serialised ledger rather than asserting that a validator stripped
something — the point is the absence of the field, not the presence of a guard.
A vague mechanism is refused: "sent it over" covers an approved secret store and
an email, and the difference between those two is the whole control.

**AC-H-WF-07-01: both parties, and a receipt that was kept.** An inventory
transfer signed by one side is a note somebody wrote, so the sender and the
recipient are both named and cannot be the same person. The criterion says
*retain* the receipt: it is registered as hashed evidence rather than cited as a
reference, and both transfer events carry `requiresEvidence`. A reference to a
document nobody kept is what either party finds six months later when the tools
are not where they should be.

**AC-H-WF-07-03: a shortage is an obligation, not a note.** The commonest
outcome of a handover inventory is that most of it arrives, and what happens to
the rest is decided in the fortnight afterwards or never. The moment the
recipient counts what arrived is the only moment anybody is looking, so a short
delivery cannot be accepted without an owner and a date, and it is written as a
**second event** — the transfer happened; separately, some of it did not arrive,
and that second fact is the one somebody has to act on. A critical item short
blocks readiness; a non-critical one does not.

**A lost key is a security incident, not a shortage.** Deliberately a separate
route from the shortage, and reported ahead of every other blocking reason. A
spare that never arrived is a commercial problem. A key that was issued and
cannot be accounted for is a building somebody may be able to get into.

**No agent mandate reaches the register at all.** Every one of the seven events
is `aiAllowed: false`, including the register itself. The specification's
guardrail is "no access to or reproduction of secret values; only status
metadata", and a credential's whereabouts is as useful to an attacker as its
value.

---

### A date nobody checked is not a date to start a liability from

H-WF-08. `backend/src/domain/practicalcompletion.ts`, nine routes, 51 tests.

**What was already there and is reused.** `engines/handover.raiseDefect` raises
a defect and finds the warranty covering it; `raiseSnag` and `dispatchSnags` run
the snag list; `engines/quality.closeSnag` closes one. `domain/valuechain`
already holds SUBMITTED, ASSESSED, CERTIFIED, AGREED and PAID separately —
which *is* the exception control that says a final account states them
separately — so `agreeFinalAccount` reads that chain and refuses agreement the
commercial record does not show, rather than becoming a second place to type the
number in.

**The exception control the clause register exposed.** "Certificate trigger
dates derive from a *validated* project-specific contract pack." Every clause
the extraction engine writes carries `requiresLegalReview: true`, and **nothing
in the platform could ever clear it** — the seeded demo project has ten
extracted clauses and not one of them had been read by a person. So a
certificate could have started a defects liability running from a machine
reading of a contract nobody had checked. `validateContractClause` is the act
that clears it; a rejection has to say what the clause actually is, and what the
machine read is kept either way as part of the record of how the date was
arrived at.

**AC-H-WF-08-02, in two halves.** The dates are derived once at issue and frozen
under a hash of the set. There is no path that edits one: a change is a revision
that names the authority, states the reason, records which dates moved and keeps
the hash of the set it replaced. The difference between "the defects period ends
on the 14th" and "it ended on the 14th until somebody changed it" is the
difference between a record and a draft.

**Four classifications, not four severities.** Blocker, minor defect,
outstanding work and post-completion obligation decide what happens next, not
how bad it looks — calling all four "snags" is how outstanding work ends up
being argued about a year later. A blocker cannot be deferred, because that is a
decision about whether the building can be handed over rather than a scheduling
change. A deferral carries all four of owner, risk, access constraint and
acceptance condition; the last is the one people leave out, and without it
nothing settles the argument about whether the item was ever put right.

**AC-H-WF-08-03: closed against rectification somebody else accepted.** The
person who did the work cannot be the one who re-inspects it, and "Rectified"
is refused as a description — it records that somebody pressed a button.

**Step 3 read literally.** Determining completion needs `CONTRACTS_CLAIMS 'A'`,
which the project manager does not hold. An AI readiness score may be recorded
alongside the decision and never in place of one, and a score submitted without
its basis is refused because a bare number reads as a verdict.

**Commercial closeout never blocks safety-critical closure, and that rule is
enforced by omission.** `completionBlockedReason` reads defects and the contract
pack. It does not read the final account, the retention position or any
security, and a test asserts that a disputed retention leaves the blocked reason
null. A blocked-reason function that mentioned retention would turn a commercial
argument into a reason to leave a building uncertified.

---

### Eight guards already answered it

H-WF-09. `backend/src/domain/handoveracceptance.ts`, seven routes, 35 tests.

**This module composes; it does not re-derive.** Step 1 asks for a final
cross-domain validation across physical, commissioning, information, asset,
regulatory, competence, access and commercial conditions — and every one of
those eight already had a guard, written when its own workflow was built.
`crossDomainValidation` calls them and computes nothing itself, because a
second opinion about whether the as-builts are ready is a second thing to keep
in step with the first. `engines/handover.compileHandoverPack` and
`acceptHandover` already existed and are not replaced; the validation is wired
into the *existing* accept.

**The commercial domain reports and never blocks.** H-WF-08 settled that
commercial closeout does not delay a safety-critical closure, so an unagreed
final account is shown to the acceptor and is absent from the blocking set. A
test asserts that specifically.

**AC-H-WF-09-01: a manifest that verifies.** A list of hashes proves nothing
until somebody recomputes them. `verifyManifest` re-hashes every entry against
the live ledger and reports drift *by name*, distinguishing three cases:
drifted, missing, and added. An addition leaves the manifest verified — nothing
it named has changed, and what it means is that the pack is now a subset.
Accepting against a manifest that no longer matches is refused; rejecting
against one is allowed, because refusing a moved target is the right call.

**AC-H-WF-09-02: no re-entry, structurally.** `activateOperations` reads the
accepted register and raises maintenance and warranty obligations from it.
There is no parameter on the command an asset attribute could arrive through —
only who activated it and when — so the criterion is a property of the
signature rather than a rule. It refuses to run before a decision, after a
rejection, or twice.

**AC-H-WF-09-03: immediately, because it is derived.** `residualObligations`
reads the acceptance conditions, the commissioning obligations, the deferred
defects and the regulatory conditions on every call. A stored transfer list
would be as current as the last rebuild, and the gap between acceptance and
that rebuild is exactly the window in which nobody is watching. The transfer
event records the count and the owners at that moment and does **not** copy the
obligations into itself.

**Conditional acceptance carries four things.** Risk owner, due date, expiry
and escalation route — because the common failure is a list of sentences nobody
owns that quietly become permanent. A condition expiring before it is due is
refused. Conditions attached to a *clean* acceptance are refused too: that
leaves obligations nobody is watching, which is the failure the conditional
decision exists to prevent.

**The archive deletes nothing, and says so.** The ledger is append-only, so an
archive is a statement about which records are no longer the working set rather
than an act that removes any. The record carries that sentence explicitly so
nobody reads "archived" as "disposed of". A legal hold needs a stated reason,
or nobody will ever know when it can be lifted.

---

### A lesson from a hospital is not a lesson about a warehouse

H-WF-10. `backend/src/domain/aftercare.ts`, eight routes, 33 tests.

**Reused rather than rebuilt.** CM-WF-06's `SeasonalTest` records *are* the
seasonal tests; `completeSeasonalTest` closes them by their own reference and
opens no second register, which is the whole of AC-H-WF-10-01 for that class of
obligation. `domain/control.captureLesson` already writes the lesson with an
actionable recommendation and an impact in money or days. H-WF-09's
`residualObligations` is read rather than copied.

**A failed seasonal test does not discharge the obligation.** The building
still has not been shown to work in the condition the test was deferred for. A
test run outside its window is *recorded* rather than refused — whether it is
enough is the operator's judgement, and not flagging it would let it pass as
though it were in season.

**AC-H-WF-10-02, enforced rather than described.** The period, the baseline and
the operating context are all required. A building at 140% of its design energy
figure is unremarkable if it was measured through a winter it was commissioned
before, or if a third of it is unoccupied — and a register of gaps recorded
without their context produces a year of arguments and no fixes. A comparison
inside tolerance writes `PERFORMANCE_COMPARED`, not a gap; recording both as
gaps would make the register useless.

**The privacy control is structural.** Occupant feedback has **no field a name
could occupy**. It is recorded against a role and a location, which is what
makes it actionable: "the second-floor east occupants are cold" is a heating
problem, and which of them said so is not information the building needs. The
same approach H-WF-07 took to secrets, for the same reason.

**AC-H-WF-10-03 is the reuse control.** A lesson stays out of organisation
memory until it is approved *and* tagged with the sectors and stages where
reuse is valid. `reusableLessons` never returns an unapproved lesson and
returns an approved one only where its own tags say it applies. A memory that
serves a hospital's medical-gas lesson up as a warehouse lesson is worse than
an empty one — it is wrong with authority.

**A post-occupancy review refuses to run with nothing to review.** No
comparison and no feedback means the document would be produced to close an
action, which is why the exercise has the reputation it has.

---

### The gate that reads the guards, and the queue that opens on them

11.4 and 11.2. `backend/src/domain/stagegate.ts` and `frontend/pages/handover.js`.

**The 11.4 gate is word for word identical to 6.4, 7.4, 8.4, 9.4 and 10.4**, so
only the five stage-specific clauses are written; `reportOf`, `aiAccounted` and
`replayable` stay shared, and `gateFor` dispatches to it in HANDOVER. Two
clauses read H-WF-09 directly: the blocker clause **is** the eight-domain
validation, and restating it as a second set of thresholds is the duplication
this file exists to prevent — a test asserts the two agree rather than that the
gate holds its own opinion.

The cut-off clause is the one worth naming. It fails while no baseline has been
frozen, and it re-hashes every record in a frozen baseline against the live
ledger: a record that moved after the freeze means the frozen set and the live
set are two different things, and the gate says so. The AI clause reads
`NOT_ASSESSABLE` here as at every other gate, for the same honest reason.

**11.2's stage workspace** is a band at the top of the handover screen that
opens on the action queue rather than a static summary: the gate state, the
domains ready, requirement completeness, blockers and warnings, the approved
baseline, overdue residual items and the permitted next command — then the
queue itself, which is the failing domains and the open residual obligations,
because those are the two lists a person on that page can act on.

Nothing is scored in the browser. Both figures come from `/handover-acceptance`
and `/stage-gate`, because a console that computes its own thresholds is a
console that will disagree with the platform it is a window onto. Two absences
are shown as absences rather than as zero: a project with no requirements
matrix reads "no requirements matrix" rather than 0% — which would say a
project had done none of its handover instead of that nobody had written the
matrix — and a reader whose role cannot see the gate is told that, not shown a
failure.

**What 11.2 does not have:** the nine-tab set (Overview, Inputs, Workflows,
Deliverables, Decisions & Approvals, Risks & Changes, Evidence, AI Runs,
History) and the right rail. The header, the action queue and the permitted
next command are built; the tabbed navigation is not, and the 9.2 and 10.2
workspaces for construction and commissioning remain unbuilt.

**The handover block is now complete** — H-WF-01 to H-WF-10, the 11.4 gate and
the 11.2 header and queue. The cross-stage sections 12 to 18.1 and the
appendices are recorded verbatim in `docs/WORKFLOWS.md`; several arrived out of
sequence during the build and are recorded there in the order they were sent.

---

---

### Making it stop looking generated

A visual pass over the whole product, on the brief that it should read as a
premium instrument rather than as something a machine produced. `frontend/app.css`
and `frontend/site.css`. **No class name, selector or markup changed**, so no
page script was touched and nothing had to be re-verified beyond looking at it.

**What was actually giving it away.** Not one big thing — five small ones, each
a known default. A near-black ground with a single acid accent. Pure neutral
greys, mixed from equal parts, which is what a screen shows when nobody chose a
colour. Every surface the same flat fill on one plane. A radial glow of the
accent behind the login headline, and a left-to-right colour ramp filling the
landing headline. And every number in the interface set in the UI face.

**The number rule is the one that mattered most.** Currency, durations, counts,
percentages, references and timestamps are data; they sit in columns; and digits
that do not line up are most of why a dashboard reads as a website with figures
on it. Metrics, table numerics, label/value pairs, deltas, bar values, the ACU
balance and the nav counts are now tabular mono, and `font-variant-numeric:
tabular-nums` is set on `body` so a new numeric slot inherits it rather than
having to remember.

**Depth is an ambient shadow plus a one-pixel inset highlight on the top edge.**
That highlight is the whole trick — a real bevel catches light on its upper
edge, and a panel without one sits flat however much shadow is under it. Fields
take the opposite treatment, an inset recess, so a form is legible at a glance
without reading it: what you press is raised, what you type into is sunk.

**Orange was demoted back to meaning something.** It had spread to the active
nav item, nine role badges on the sign-in screen, every table hover, the whole
lifecycle rail and four large figures on the landing page — and an accent that
appears everywhere carries no information. The active nav item is now a rail on
its leading edge, role badges and hero figures are neutral, and the table hover
is a neutral wash. Orange is left where it means attention.

**No webfont, and that is a decision.** The server sends `font-src 'self'`, so a
face from a font CDN would be blocked by the platform's own
content-security-policy. Loosening a security header to change how the headings
look is not a trade worth making, so the identity comes from a deliberate native
stack and the numeric discipline above.

**One drift found and closed.** `frontend/site.css` carries a duplicate token
block — the two stylesheets serve different pages and neither should import the
other — and it had fallen behind the console's. Its own header comment says a
marketing site in different colours from the tool it sells is a small lie people
notice on their first login, and it had become one. Both are now on the same
values, and the launch colour is moved in all eight places that hardcode it
(manifest, splash, both theme-colour tags, and the three renderers) so the PWA
launch screen still matches the ground by construction.

---

### The accessibility audit, actually run

Section 16 asks for a WCAG 2.2 AA target. This was previously recorded as *not
done*, which was accurate; it has now been run against the rendered console in
a real browser rather than reasoned about, and what it found was fixed.

**How it was measured.** A script walks the signed-in console and, for every
element carrying text, composites each translucent layer down onto the opaque
surface beneath it before computing the contrast ratio. That compositing step
is the whole method: read as though they were opaque, the interface's tinted
badges and washes appear to fail everywhere, and a first pass reported fifteen
failures of which nine were the script's own arithmetic. Changing a token on
the strength of a measurement that wrong would have made the product worse
while appearing to make it accessible.

**What was genuinely wrong, and is now fixed:**

- **`--text-3` failed 1.4.3 everywhere it was used** — 4.26:1 on the page
  ground, 4.00:1 on a card, 2.93:1 on a raised surface, against the 4.5:1 body
  text needs. It carries breadcrumbs, metric captions, empty states, timestamps
  and every card title. It now keeps the same hue lifted until the *lightest*
  surface it is ever set on clears: 4.56:1 worst case, 6.21:1 on a card. Muted
  is a design decision; unreadable is a defect.
- **`--critical` failed on its own badge** — 4.39:1 for the critical text on the
  13% red tint the badge paints, which is small text and needs 4.5:1. Lifted
  until it clears on every surface, worst case 4.50:1.
- **No landmark regions at all** (1.3.1). The shell was `div`s throughout, so
  there was no way to skip the navigation or reach the content. It is now
  `<aside aria-label="Primary">`, a labelled `<nav>` per group, `<header>` and
  `<main>`.
- **Nineteen decorative icons announced themselves** (1.1.1). Every navigation
  glyph sits beside its own text label, so a reader announced each item twice.
  They are `aria-hidden` and `focusable="false"`; the label does the work.
- **The heading outline jumped h1 to h3** (1.3.1), implying a section that was
  not there. 254 card titles across 22 pages are now `h2`. The *size* is
  unchanged — the element is the outline and the CSS is the appearance, and
  they are allowed to disagree.

**What the audit reports clean:** language declared, one `h1` per view, no
unnamed control, no unlabelled input, every data table with `th`, no target
below 24×24 (2.5.8), and one uniform `:focus-visible` treatment so no control
can forget to declare one.

**One reported failure is the script's, not the page's.** `.btn` paints a
gradient, which `getComputedStyle` reports as transparent, so the walk passes
straight through it. Measured by hand the button label runs 6.82:1 to 8.07:1,
and 4.72:1 in its pressed state — it passes.

**What is still not claimed.** This is an automated audit of the signed-in
console at one viewport, not a conformance statement. It does not cover the
marketing pages, keyboard traps, screen-reader announcement order, reflow at
320 CSS pixels (1.4.10), motion actuation, or any of 2.2 AA's cognitive
criteria. Non-colour status indicators exist and are used — the strengths and
weaknesses lists carry ✓ and ✗ marks, badges carry text — but no systematic
1.4.1 review has been done. Calling this "WCAG 2.2 AA compliant" would be a
claim the evidence does not support; what is true is that the failures an
automated check can find have been found and fixed.

**On the screenshots.** `frontend/shots/` is gitignored and was never a
committed artefact, so the earlier note that it "predates this pass" described
local working files rather than anything in the repository. The set has been
regenerated against the redesigned console for local reference.

---

### Two menu items nobody could ever open

The sidebar's rule is that a capability the viewer cannot reach is shown locked
with the reason, because somebody needs to know it exists and who to ask. That
is right for a capability a *colleague* holds: a facilities manager seeing
Programme locked learns something true and actionable.

It was wrong for two of them. **Platform Admin and Newsletter** sit under
`PLATFORM_ADMINISTRATION`, which only the `PLATFORM_ADMIN` role holds — and
that role is in `OPERATOR_ONLY_ROLES`, so no tenant administrator can grant it
to anybody. Those two items were therefore locked, on every screen, for every
customer account, permanently. There was no colleague to ask. That is not
information, it is furniture, and it made the permission model look arbitrary
rather than considered.

An item is now shown only if *somebody in the customer's world* could hold read
on its area. That is computed from the published permission matrix and a newly
published `tenantGrantableRoles`, rather than from a hard-coded role name in the
browser — the same reason the matrix and the phase gates were published in the
first place, so the console cannot drift from the server's own answer.

The group-level rule is unchanged and deliberate: a group where the viewer can
reach nothing is hidden outright, because a whole section of locks teaches less
than it costs, while inside a group they do use, an unreachable item stays
visible and locked because there the lock names somebody to ask.

For a facilities manager this takes the sidebar from six locks to four, and the
four that remain — Programme, Field Execution, ACU & Billing, Communications —
are all genuinely held by other roles on the same project.

---

### "Is the live site running the latest?"

Until now, nothing could answer that. `/readyz` reported status, environment,
AI mode, tenant and event counts — and not one thing identifying the build. The
only way to tell whether a push had reached the site was to look at a page and
judge whether it had changed.

That is not hypothetical. This document already records a day on which every
commit passed CI and none of it was running: the commit that *added* the
deployer had itself never been deployed, so the deployer was never installed
and the box sat eleven commits behind. Nothing detected it, because CI answers
"does this build" and nothing was answering "is this running".

`/readyz` now carries the commit the running container was built from.
`autodeploy.sh` reads it with `git rev-parse HEAD` **inside `deploy()`**, which
matters: the rollback path re-runs `deploy` after resetting the checkout, so a
rolled-back site reports the commit it rolled back *to* rather than the one
that failed — reporting the failed commit would look like a successful deploy
of a broken build. Compose passes it through, and CI asserts the whole chain by
booting the image and checking the value comes back out.

Unset reads as `unknown`, which is what a container started by hand produces.
A default of `main` or a build timestamp would answer the question wrongly
rather than admit it cannot.

**One test caught this and was right to.** `deployment.test.ts` refuses any
variable in compose's `environment:` block that is not declared and justified,
because `environment:` outranks `env_file:` — so a passthrough written as
`${BUILD_COMMIT:-}` would silently replace a `.env` value with an empty string.
The variable is a third category the test did not model: not container-owned
(a path or port where a `.env` value would be *wrong*) but deployer-supplied
(known only to the thing running the deploy). It is now declared as that, and
documented in `.env.example` with an explicit "do not set this" — because a
variable nobody can discover is worse than one somebody sets wrongly.

---

### What the probe stopped telling strangers

The commit above made `/readyz` the way to check a deploy from a browser, which
is what put it in front of a pair of eyes. Its live output read:

```
{"status":"ok","env":"production","commit":"e6dc014…",
 "tenants":3,"events":3164,
 "controlPlane":{…every provider, its health, the routing matrix,
  and every engine contract…}}
```

Unauthenticated, to anybody who asked for it. Two disclosures, neither of which
a probe needs. `tenants` is the customer count, and in an industry that buys on
references it is the number you least want on a public URL — a competitor can
watch it move week to week. `controlPlane` names the AI sub-processors holding
customer material and says which are reachable right now: reconnaissance, and a
sub-processor disclosure made by accident rather than by policy.

`/v1/admin/readiness` was already operator-only, and the reason written on it
applies here word for word — it is a map of which locks on this deployment are
unlocked. That argument had simply never been carried across to the probe.

So the figures moved rather than went. `platform.health()` now returns
`status`, `env` and `commit`: what a container HEALTHCHECK, a load balancer and
a deploy check actually consume. `platform.operationalHealth()` returns that
plus `aiMode`, `tenants`, `events` and the control plane, and is reached
through `/v1/admin/readiness` — one operator-only door onto both the capability
map and the operational picture, instead of a second public one. `healthReport`
in `ops/reports.ts` follows it, so the operator's own report is unchanged.

`publicsurface.test.ts` pins both halves: the probe must answer with a status
and a commit and must not carry `tenants`, `events`, `controlPlane` or
`aiMode`; and a `PLATFORM_ADMIN` must still see every one of those figures
under `running`. The second test is the one that matters — without it this is a
deletion dressed up as a fix.

---

### An error that names the wrong house

Found from a live 404, not from the code. Two requests against the running
platform came back with different problem `type` URLs — one naming
`construxvg.com`, the other `construx.ai` — which is only possible if two
deployments are running two different source trees, because the domain was a
**literal** in `backend/src/core/errors.ts`.

RFC 7807 says a problem `type` is a URI that documents the problem, so it has
to be a host the deployment actually answers on. Hardcoded, it could only be
changed by editing source: a second domain needed a second fork, and the sole
visible difference between the two builds was the string inside their error
bodies. Nothing else would have shown it.

It is now derived from `PUBLIC_BASE_URL`, with a malformed value falling back
to `about:blank` rather than throwing — an error response is the wrong place to
raise a second error. Three tests hold it: no domain literal may reappear, the
config value must be read, and the rendered origin must match the configured
one.

**What this does not tell us** is which of the two deployments is the one that
matters, or whether the second is an old fork nobody meant to leave running.
That is a question for whoever owns the DNS, and it is not answerable from the
repository.

---

## What is partial

Implemented in a form that works, with a stated part missing. The missing part is
named so it is not mistaken for finished.

| Area | Built | Missing |
|---|---|---|
| Take-off | Governs, evidences and prices measured items, traced to sheet and revision. Quantities can be read off a held drawing by a multimodal provider and confirmed before they become BoQ items | No provider call has been made from this environment. The **wire contract** is now proven against the response shapes the three configured vendors actually send (`tests/modeloutput.test.ts`); what remains unproven is the **reading** — whether a real model measures this drawing correctly |
| Drawing register | Title-block reading from the held drawing itself or from supplied text, supersession, markup→RFI carrying the activity it blocks | Same: the wire contract is proven against real vendor response shapes; the quality of the reading is not |
| Model ingestion | Records the model, hash, discipline, LOD, element count as a governed event | IFC parsing, geometry hash, model diffing |
| Digital twin | Reconciles observed against expected element status | Observations are structured input, not derived from imagery |
| Evidence capture | Real SHA-256 over the real file, recorded against the event, and the file itself held in a tenant-scoped content-addressed store | Retention and deletion policy; no antivirus scan on upload |
| File ingestion | Structural inspection, rules classification with its signals, native text and table extraction, and a lexical index over what was read. A file that is not what it claims to be is quarantined with the finding on the record | A PDF or a photograph reports `NEEDS_OCR` rather than being read; the index is lexical, so it finds a near-duplicate and not a paraphrase |
| Signature scanning | `evidence/scanner.ts` speaks clamd's INSTREAM protocol over a socket. Every ingested file is sent to it where one is configured, and the record names the daemon and its signature database. Unset means unscanned and every record and every read says so; configured-and-unreachable refuses the ingestion rather than recording an unscanned file as checked | The platform holds no signatures itself and never will. Verified against a daemon of the suite's own speaking the real protocol, not against ClamAV — no ClamAV exists in this environment |
| Vision tasks | Progress, PPE, plant and defects read from a held photograph, each as a draft a person confirms into the ordinary domain command | The wire contract is proven against real vendor response shapes, including fenced, prefaced, truncated, empty and non-object replies. What no test here can establish is whether a model reads a photograph correctly |
| Commitment extraction | Reads a held letter for what it promises and what it demands, drops anything not quoted verbatim from the letter, and registers a confirmed one in the obligation calendar that already exists | Needs a provider that reads prose; a local deployment is refused rather than given an invented undertaking. The wire contract is proven against real vendor response shapes; the reading is not |
| Clause extraction | From supplied text | OCR and table extraction from a PDF |
| 4D scheduling | Twin states link to task ids | No visualisation |
| Newsletter delivery | SMTP submission verified against a socket, per-recipient outcomes recorded | No bounce processing or suppression list; DKIM belongs at the relay, where the key should live |

---

## What is not built

Specified in the source documents, deliberately absent, and **not to be claimed
as present**. Most of it is perception and ingestion infrastructure — real ML and
parsing work, not wiring.

- ~~**The ETABLIX AI Site Services module itself**~~ — **built.** This entry was
  written when only the entitlement gate existed and is left visible, struck
  through, rather than deleted: a register that quietly loses an entry is a
  register nobody can audit. §2 to §13, §17 and §19 are now implemented,
  tested and reachable from the Site Services screen under the `SITE_SERVICES`
  capability area — see *Which of three businesses ETABLIX is on this job*
  onwards. What remains genuinely absent inside the module is listed under
  **What ETABLIX does not do** below, and each gap is reported on the screen
  that would otherwise imply it
- **OCR, and any semantic embedding** — the ingestion pipeline reports
  `NEEDS_OCR` for a PDF or a photograph and routes to the perception pipeline,
  which refuses where no multimodal provider is configured. The document index is
  feature hashing over words and word pairs, and the field is named
  `lexicalVector` because it finds a near-duplicate revision, not a paraphrase
- **A plant register** — plant recognised in a photograph is filed as a site
  observation naming what was seen and whether it was standing. There is no
  register of plant on hire, and utilisation is not derived
- **Deployment topology** — Terraform, Kong, MSK, RDS, S3
- **Native Android and iOS clients** — the installed PWA covers the field case
  today, including offline capture, and the `ANDROID`/`IOS` event sources exist
  server-side for when a native client arrives. Two things a PWA cannot do that
  a store app can, and neither is worked around here: background sync while the
  application is closed, and camera or location capture beyond what the browser
  grants
- **External data feeds** — commodity pricing, weather, credit reference
- **Horizontal scale in production** — every piece now exists and none of it has
  been run at scale. The **schema** is verified against a real Postgres 16
  (`deploy/postgres/verify.sh`, 19 checks) and the **client** is verified against
  one too (`deploy/postgres/client-check.sh`, 18 checks): a zero-dependency
  wire-protocol implementation doing SCRAM-SHA-256, parameterised statements,
  transaction-scoped tenancy under RLS, and the two-concurrent-writer race the
  chain trigger exists to settle. What is **not** done is the migration itself:
  `goldenthread/ledger.ts` still reads and writes the in-process journal, and
  moving it is a separate, careful piece of work on the most dangerous file in
  the repository. Until that lands the writer lock is still load-bearing, point-
  in-time recovery is still the backup interval, and there is no automatic
  failover
- **A metrics store and dashboards** — the *egress* is built. `ops/otlp.ts`
  ships counters, the latency histogram and the security stream to any OTLP
  collector over HTTP with the JSON encoding, on an interval, from a bounded
  queue that drops the oldest and **exports its own drop count** so a lossy
  pipeline cannot look like a quiet one. Unset means local-only, and the boot
  banner says so in those words. What is absent is a collector and a dashboard
  to point it at, which is infrastructure rather than code

### What ETABLIX does not do

Every one of these is reported on the screen that would otherwise imply it, so
the platform states the gap rather than leaving a reader to find it. They are
collected here because a gap named in nine different places is a gap nobody can
count.

| Gap | Where it is stated | What is actually missing |
|---|---|---|
| **The knowledge library** (§6 stage 8, §1's stated advantage) | The workflow card, as `NOT DERIVABLE` — the only such gate in the nine | No site-services supplier score written back from an engagement, no price benchmark promoted out of a normalisation, no reusable package template. §7 normalises bids inside a project and nothing carries the result forward |
| **Room, bed and allocation records** (§13 Accommodation Desk) | The workspace's *what this cannot answer* table | §4 composes an accommodation system sized against demand; there is no room, bed, allocation, arrival or housekeeping record beneath it. One entity family, not a screen |
| **Transport journeys** (§13 Accommodation Desk) | The same table | Transport and logistics is a service family with a KPI that is reported rather than enforced; there is no journey, vehicle or booking record |
| **QR asset scan and delivery check** (§13 Field Mobile) | The same table | A composed system is the unit; there is no per-asset register for a code to resolve to, and deliveries are attested as gate evidence rather than booked against a schedule |
| **Supplier-side authentication** (§13 Supplier Portal) | The same table, and the portal refuses an unscoped read | External project invitations exist; a supplier account layer with its own login does not. The portal is an internal view of one supplier's obligations |
| **Paid, accrual and cash** (§13 Commercial) | The same table | §10 certifies value and records who owes it; it does not record payment against a certificate. CONSTRUX holds a purchase ledger and the two are not joined |
| **Contingency and EAC** (§13 Commercial) | The same table | Change exposure is an input to an EAC, not an EAC |
| **The cross-project roll-up** (§13 Executive Portfolio) | The same table | Every position is project-scoped by construction |
| **An ETABLIX perception task** (§19.10) | The acceptance test, which asserts the fact that makes its pass condition hold | The draft/confirm mechanism exists and is proved in `tests/perception.test.ts`; no perception task reads a workforce curve or a welfare schedule into the brief register, so nothing a model produces can reach the baseline |
| **Forecast accuracy** (§17) | The automation card, as not measurable | It compares a prior estimate at completion against a final outturn. No site-services account has been closed out, and reporting it on a live project would compare the forecast against itself |

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
   charged at 5x — every £1 of provider cost produces £5. **The company takes
   at least 100% profit on every AI
   transaction** — the multiplier floor is derived from that rule, not
   configured beside it. 20% of every subscription payment is credited as AI
   allowance. No AI work runs without available ACUs.

   The 5x is confirmed and deliberate. Several specification documents state
   3x and the rate ran at 4x for a period; the instruction given directly is
   **5x — every £1 the platform spends with a provider must produce £5**. It is
   one value, `ACU_MARKUP_MULTIPLIER`, and every test fixture derives its
   arithmetic from it, so the suite follows whichever number is set.

   The **loss floor is the price**, at 400% required profit: no band, bundle or
   cap may take a charge below 5×. The cost is the estimate cap — an overrun is
   charged for what it cost rather than capped at the disclosed hold — and that
   is handled by naming the overrun on the entry and the invoice line.
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

## Concept, stage 6 — C-WF-01 to C-WF-08 and the 6.4 gate

The head of the lifecycle, and the last stage to be built. That is the right way
round: every rule here had to be answerable by something downstream before it
was worth writing. A requirement that nothing verifies is a wish; an option
selected against no cost plan is a preference.

Six modules, twenty-eight events, seventeen entities, fifty-two routes, one
console screen and 103 tests. What follows is what each one refuses, because
that is the part that does the work.

**C-WF-01 — the configuration is versioned, never edited.** Changing
jurisdiction, time zone or currency after work has been approved against them is
a different act from setting them up, so version 2 onwards requires an impact
assessment and records what it supersedes. A mutable configuration cannot answer
"under what rules was this approved", which is the only question it gets asked
two years later. Time zones are validated against `Intl` rather than a list this
codebase maintains — a zone the platform accepts is a zone every later
`toLocaleString` will accept. The authority matrix is bound to the configuration
version it was approved under, so a reconfiguration surfaces it as needing
re-approval rather than leaving a stale delegation in force.

**C-WF-02 — an extracted requirement is two events, not a flag.**
AC-C-WF-02-02 asks that a machine-created requirement be visibly distinct until a
person accepts it, and a single event carrying `accepted: false` is exactly the
shape that gets defaulted to true by the next caller. `REQUIREMENT_EXTRACTED`
creates it; `REQUIREMENT_ACCEPTED` is somebody's act, and the acceptor is
recorded separately from the author. The brief baseline freezes the **hash** of
every requirement rather than a list of ids: a list proves the same requirements
exist, a hash proves they have not moved.

A conflict between two mandatory requirements does **not** block the baseline. A
brief can honestly record two mandatory requirements that conflict, and
pretending otherwise is how the conflict gets buried. What it blocks is choosing
an option, because no option satisfies both and selecting one decides the
conflict silently. Only *declared* conflicts count — the platform does not infer
that two requirements conflict, because that is a professional judgement and a
machine guessing at it produces a register of false conflicts nobody trusts.

**C-WF-03 — `SiteConstraint` is not `Constraint`.** The platform already has a
`Constraint` entity and it is untouched: that one is the Last Planner constraint
log, something blocking a task next week, closed by a phone call. This is a
permanent property of the ground. Overloading one entity with both would put
"waiting for the crane" and "the aquifer is six metres down" in the same list,
sorted by date.

Readiness is **evidence coverage, not document count**, which is the rule that
makes the score worth reading: registering the same report three times moves
nothing, and a superseded or expired survey stops counting while staying
readable as history. The coordinate system and the limitations are both
mandatory at registration — `NONE` is a legitimate coordinate system for a desk
study and is a different fact from an unrecorded one, and the limitations field
is where "no access to the eastern boundary" lives. Its absence is how a project
prices ground nobody has seen.

**C-WF-04 — the raw score survives the weighting.** Once they are multiplied
together the raw value is gone, and with it any ability to ask what the answer
would have been under different weights — which is the question every option
review actually asks. `compareOptions` **refuses** across different base dates,
currencies or criteria sets rather than normalising: normalising a 2024-base
option to 2026 requires an inflation assumption, and inventing one inside a
comparison function would put an unstated assumption at the centre of the
decision. The refusal names what to do about it and still returns the rows.

The brief baseline hash is frozen onto the selected option, so AC-C-WF-04-03 is
a property of the record rather than a claim about it: the option links to the
brief it was chosen against, not to whatever the brief later became. Rejection is
its own act — a rejection that happened automatically has no rationale, which is
the gap that turns a decision record into a record of a preference.

**C-WF-05 — two totals, not one with a footnote.** An unverified rate is
excluded from the high-confidence total, and `provisional` is *derived* from
whether the rate has a named source and a base date rather than asserted by the
caller — letting a caller assert it would make the exception control a matter of
opinion. P50 and P80 are computed from the stored line ranges by the plan's
declared method, and the independence assumption behind the P80 is stated in the
module rather than buried: a real construction P80 is wider, and AC-C-WF-05-03
asks for the method precisely so somebody can disagree with it. The count of
lines carrying no range is reported, because a P80 built from point estimates is
a P80 of nothing.

Cost and programme are approved by **one** command under one declared cut-off.
Time-related cost is material on every construction project, so approving a
programme without the cost of it is approving half of a coupled pair. An
affordability gap is not refused — a project can be legitimately unaffordable at
concept — but approving one with no actions against it is.

**C-WF-06 — the gap is the expensive half.** Every package declares the scope
elements it carries, and approval refuses if an element appears twice or in
none. An overlap gets argued about at tender; a gap gets discovered on site. The
lead time must also fit between award and required-on-site, which is the
arithmetic that puts a sixty-week switchgear order in month fourteen when nobody
checks it. The contract strategy is `provisional: true` as a literal on the type
rather than a settable field: the real clause register comes from the executed
contract through the path that already exists, and nothing here is presented as
a legal position.

**C-WF-07 — the risk register was already built and is not rebuilt.**
`engines/safety.ts` carries `RiskRegisterItem` with three-point impacts,
probability and residual exposure; `engines/maths/risk.ts` is the arithmetic.
Two acts were missing. Statutory applicability is an approval carrying a named
competent person and their basis — "the person who pressed the button" is not
evidence of competence — and an applicable gateway must be a milestone that
exists on the concept programme *and* is marked statutory, or a resequence walks
straight past it. The risk review reconciles the declared allowance against
`RISK_ALLOWANCE` in the cost plan: two numbers for the same money is how a
contingency gets counted twice.

**C-WF-08 and 6.4.** Five stage-specific clauses; the AI and replay clauses are
the shared ones every other gate uses. `gateFor` now routes CONCEPT to it, so
every lifecycle phase with a specified gate has an implemented one and TENDER is
the fall-through.

Two clauses report `NOT_ASSESSABLE`, and both name what cannot be seen:

- **AI accounted for** — the same answer at every gate since the first. The AI
  event block records no assumptions, no prompt version and no human
  disposition. On a project that used no AI at all the clause passes and says
  so, which is a different statement and is worded as one.
- **Downstream created** — the package strategy carries the dates design plans
  to, and the design mobilisation worklist the specification names is not
  generated by this platform. Said, rather than passed.

**Two defects the tests found in this work.** A mandatory conflict declared from
only one side was silently dropped whenever the declaring requirement sorted
higher, which is most of them — people write the conflict down when they meet
the second one. And the gate's downstream clause required a concept baseline
that `approveConceptBaseline` would only produce over a passing gate, so neither
could ever happen. The baseline is the gate's output, not its input.

**The demonstration project walks the stage.** The modules existed and passed
their tests while the seeded project skipped stage 6 entirely — it created a
project, defined one scope package and moved straight to design, which satisfied
the coarse lifecycle gate and left the Concept screen showing seven blank panels
on a project that had reached operations. A workflow nobody can see working is
a workflow nobody can check.

`seedDemoProject` now runs C-WF-01 to C-WF-08 in order, each command under a
role that actually holds the authority for it: the enterprise admin configures
and baselines, the client representative delegates and decides, the QS builds
the cost plan, the planner the programme, the HSE manager confirms statutory
applicability. The party separation the gate checks is real rather than
arranged — three different people sign the brief, the option and the controls.

The seeded stage carries a configuration on `Europe/London` and GBP, four
delegations, six requirements of which one is superseded before the baseline,
four surveys covering eleven of the twelve impact categories with heritage left
open under a named investigation, four constraints all assessed, three options
compared on one template with two rejected and their reasons kept, an eight-line
cost plan of which one line is provisional by derivation, an eleven-milestone
programme with three statutory gateways, a reconciled cashflow, a Design and
Build route over three assessed alternatives, two packages with no scope gap or
overlap, seven risks with owners and responses, and a frozen concept baseline of
twelve components. The 6.4 gate reads **five clauses PASS and two
`NOT_ASSESSABLE`** — the two the platform genuinely cannot see.

**Seeding the stage found two more things.** The first was the statutory
gateway check refusing the seed: three applicable regimes had been pointed at
the design freeze, and only one of them was marked statutory. The rule was
right and the data was wrong — a permit determination and a planning
determination are dates a regulator controls, not dates the design team can
move — so they now have their own statutory milestones.

The second was in `compareOptions`, and only a decided project could show it:
rejected options dropped out of the comparison the moment one was selected,
leaving a one-row table at exactly the point somebody looks at it. The
comparison now keeps every option that was **scored**, because the table is the
record of the decision; the comparability check that gates a selection runs over
the options still **in contention**, because an option already ruled out must
not be able to block one. Without that split, rejecting an option for having the
wrong price base would have deadlocked the project — the comparison would stay
incomparable for ever and nothing could be selected.

**One layout defect, fixed for every page.** `.view-head .actions` never
wrapped. Six commands fit on a laptop; Concept carries seven and pushed the
whole page sideways on a phone, and every other screen was one button away from
the same. Swept afterwards: all 21 routes an enterprise admin can reach render
at 393px with no horizontal overflow and no page error.

---

## The three words the gate had been saying since the first one

Every stage gate's fifth clause — *AI outputs fully accounted for* — has read
`NOT_ASSESSABLE` since the first gate was built, and it named the same three
missing things at all six: **assumptions**, **prompt version**, **human
disposition**. That is the oldest open answer in the product. It is closed.

The three are not one problem. Two are properties of the call and belong on the
event; the third can never be a field at all.

**Assumptions** now ride on the AI event block (`ai.assumptions`), sourced from
the provider response. An empty array is a recorded answer — *this run declared
none* — not a gap, which is why the clause checks for the array rather than for
content. The local stand-in declares the three assumptions that are actually
true of it, the first being that no external model was called.

**Prompt version** is derived, not declared: `promptVersionOf()` is
`${taskType}@${8 hex}` over the task string and the response schema the engine
sent. Derived because a hand-maintained version string is one somebody forgets
to bump on exactly the change that mattered, and because a derived one cannot
disagree with what was sent. The **payload is deliberately excluded** — it is
this project's data and differs on every call, so including it would give every
execution its own "version", which is a fingerprint rather than a version.

**Human disposition** could not have been a field. It is a later act by a
different party, and on an append-only ledger a field cannot be filled in
afterwards. So it is its own event, `AI_OUTPUT_DISPOSED`, merged onto the
execution record rather than replacing it: `backend/src/domain/aidisposition.ts`,
two routes, 14 tests. Three decisions — accepted, accepted with change,
rejected — and anything but a clean acceptance requires a reason. A second
disposition is refused, because replacing one would erase an acceptance
somebody stood behind. **No model may dispose of its own output**: refused in
the command by `ctx.source === 'AI'`, and again in the catalogue by
`aiAllowed: false`. One rule, both layers.

The clause now assesses all three at all six gates and **passes**, and fails
naming the execution nobody has decided about — not a count. That distinction
is the whole point: a gate that says "3 outstanding" sends somebody hunting.

And because a gate that names something has to lead somewhere, the decision has
a curated door on **Autopilot** rather than only the generated one: what has
been accepted, accepted-and-changed and rejected, and every execution still
waiting, each with the engine and task that produced it and three buttons. It
belongs on that screen because it is the same shape as everything else there —
something the platform did, waiting on a person who holds the authority. The
difference is stated in the code: a proposal asks whether to run something, a
disposition is a person saying what they did with the answer after it ran.

**One defect found writing the test for it, and it was real.** `hashEvidence()`
returns an algorithm-prefixed value, `sha256:<hex>`. `promptVersionOf` sliced
the first eight characters of that, which is `sha256:` plus **one** hex
character — four bits of entropy wearing a version's clothes, sixteen possible
versions across the entire platform. Every prompt version written to the ledger
before this was very nearly meaningless. The prefix is stripped now, and a test
asserts thirty-two distinct questions produce thirty-two distinct versions,
which the old code could not have passed.

### The mobilisation worklist the concept gate needed

Clause 7 at the concept gate wanted a design mobilisation worklist and reported
that it did not exist. It did exist, in pieces: the approved package strategy
already carries the award date, the lead time and the required-on-site date for
every package. `designMobilisationWorklist()` in `domain/conceptstrategy.ts`
derives the worklist from those three, with no re-entry and nothing stored —
the same derived-never-stored rule the readiness, availability and residual
obligation positions follow. The clause reads it and passes. The design and
tender gates' clause 7 still read `NOT_ASSESSABLE`, correctly: their
mobilisation tasks with owners and due dates are a different thing and are not
built.

### Unblocking the two things a fresh deployment could not do

**The demonstration tenancy is on by default.** It was off, and the argument for
that was cost: a demonstration wallet is real money and a visitor can spend it.
That argument no longer holds, because `seedDemoProject` now runs inside
`AIOrchestrator.withLocalProviders()` — the seed executes against the
deterministic local engines whatever `AI_MODE` says, restoring the real
providers in a `finally`. Seeding is therefore free, and it is also
**reproducible**: two deployments of the same commit seed the identical
lifecycle, which is a second and independent reason to do it this way. What was
left was a deployment that came up, served a sign-in page onto an empty world,
and required the operator to know about an environment variable before the
product would demonstrate itself. That made the common case the broken one. A
deployment carrying real customers that would rather not publish a sandbox sets
`DEMO_TENANCY_ENABLED=false`.

**A deployment with no mail server can be signed into.** Sign-in requires a
one-time code, the code goes by email, and in production it is not returned in
the response. With `SMTP_HOST` unset that locked out everybody — including the
operator whose job is to configure SMTP. Every credential correct, and a locked
door.

So when, and **only** when, no SMTP host is configured, the code is written to
**stderr**. Not to the response, not to the ledger, not to any route. Reading it
requires a shell on the server, which is a strictly higher bar than an email
inbox and is already the level of access needed to change the secret that signs
the tokens. The message is loud on purpose — a deployment sending sign-in codes
to its own logs should be uncomfortable to look at until SMTP is set. This
reverses an earlier decision to have no logged-code path at all; the trade is
stated here so it is a choice on the record rather than a drift.

### One test that was passing by accident

`publicsurface.test.ts` asserted that no demonstration identity is published on
a production deployment. With the demo now on by default, a sibling test calling
`/v1/console/identities` *seeds* — so `pm@meridian.example` became a published
identity by test-ordering accident, and the assertion's outcome depended on
which file ran first. `asProduction` now sets `DEMO_TENANCY_ENABLED='false'`
alongside `NODE_ENV`, which is what "production" meant in that test all along.

---

## Pictures nobody could put anywhere

The landing page has had five picture slots since it was built, and the only way
to fill one was to copy a file into `frontend/media/` and restart the process.
On a laptop that is a copy and a restart. **On a deployed container it is a
rebuild** — the directory is inside the image — so in practice the slots could
not be filled at all by the person whose pictures they are. The feature was
finished and unreachable, which is the same failure the command-catalogue work
fixed for seventy-eight write routes.

Three things had to change together, and none of them works alone.

**Somewhere to write that survives a redeploy.** `SITE_MEDIA_PATH` points at the
same kind of volume the ledger journal already uses. Unset, it falls back to the
checkout, so a development machine behaves exactly as it did. The gateway serves
`/media/` from that directory as its own mount — ahead of the frontend, so a
file committed at `frontend/media/` cannot shadow the one the operator uploaded.

**Presence that does not need a restart.** It was read once at module load,
which was the right call for the reason given at the time: the landing page
renders on every visit and a `stat` per slot per visit buys the reader nothing.
That reason still holds, so the check is still not per-visit — it is a cache
`site/media.ts` owns and invalidates on every write. A picture appears the moment
it is uploaded.

**A door.** `POST /v1/site/media/:slot`, `DELETE` beside it, and a panel on the
operator's screen showing all five: where each lands, what it has to show, what
size to export at, and whether anything is in it. An empty slot is stated as
empty, because the page renders *nothing at all* for one — there is no broken
frame on the site to notice it by.

### A route that writes into a served directory

This is the shape of a remote code execution, and it is worth writing down which
two properties stop it being one, because both are load-bearing.

**The caller never supplies the path.** The slot id is compared against five
literals. It is not sanitised, escaped or normalised — `../../frontend/app` is
refused because it is not one of the five, which is the same refusal an
ordinary typo gets. There is no path arithmetic to get wrong.

**The caller never supplies the type.** The stored extension comes from the
file's own first bytes — PNG, JPEG or WebP signatures — and a file matching none
of them is refused. The declared content type is not consulted for anything: it
is a claim by the uploader about a file the platform is about to serve from its
own origin. **An SVG is refused outright**, and that is not an oversight about a
perfectly good image format: an SVG is a document that can carry script, so
accepting one would be storing cross-site scripting on the marketing site.

The route is operator-only in both directions, which mirrors a rule already in
the codebase: the evidence upload refuses a `PLATFORM_ADMIN` because operators
are barred from customer delivery data, and this refuses everybody else because
customers have no business editing the platform's marketing page.

Replacing a PNG with a JPEG deletes the PNG. Without that both would sit in the
directory and the page would render whichever the signature order found first —
which is the one that was replaced.

**One defect of my own, caught by the browser rather than by a test.** The HTML
comment I wrote inside the panel used backticks around a CSS property name. The
panel is a template literal, so the first backtick closed it and the console
stopped booting entirely — "Starting the operating system…" and nothing else.
`node --check` on the page file finds it in a second, and that is now the first
thing to reach for when the shell will not start.

The slots, their alt text and their dimensions moved into `site/media.ts` as one
registry. They were in `landing.ts` and would otherwise have been in three
places — the page, the route and the screen — which is three chances to disagree
about which picture belongs where.

---

## Order, and who lost

Two acceptance criteria and one whole offline behaviour, all three about the
same thing: something happened before something else, and the platform had no
opinion about it.

### What a change reaches, before it is made

AC-C-WF-02-03. `briefDrift()` already answered this question backwards — it
reports, after the fact, that the baseline no longer matches the register. That
is the right thing on a dashboard and the wrong thing to show somebody about to
press supersede, because by then the damage is a fact rather than a decision.

`requirementImpact()` names what a change would reach: the brief baseline the
requirement is frozen in, the option selected against that baseline, the cost
and programme approved after it, the package strategy, the concept baseline the
gate produced, and the design packages downstream.

**Every link is one the ledger already holds.** Nothing is inferred from the
text of a requirement and nothing is guessed from its category. An impact
appears because an artefact froze this brief baseline's hash, or was approved at
a cut-off after it — both recorded values. A tool that guessed which cost lines
"relate to" a requirement would produce a plausible list nobody could check,
which is worse than no list at all.

`HARD` and `SOFT` are not severities of consequence but of **provenance**. Hard
means an approval names the hash that is about to change, so the approval will
no longer describe what was approved. Soft means the work sits downstream of the
brief without having frozen this version of it. Only the first is a
contradiction; the second is a re-read by somebody who knows the design.

The selected option is matched through the baseline **it** froze rather than the
one in force. They are usually the same, and the difference matters: an option
chosen against an earlier baseline is affected if the requirement was in *that*
one, because that is the brief the decision was actually taken on.

**One defect of my own, caught by its own test.** The first version reported the
concept baseline as affected by every requirement, including ones added after
the gate. A requirement that was not in the brief the gate read is not something
the gate was answered on, and saying otherwise is exactly the plausible,
uncheckable claim the whole function exists to avoid.

### Design cannot publish before the concept gate

AC-C-WF-08-03. The coarse phase gate requires a scope package to leave CONCEPT,
and that is a different rule about a different thing: it governs the project's
*phase*, not what design *issues*. A project could be moved into DESIGN and
start freezing packages with 6.4 never decided — design published against a
concept nobody approved, arriving through the door beside the gate.

The rule lives in `stagegate.ts` beside the gate it is about, and `freezePackage`
reads it rather than restating it. A freeze is the moment design publishes:
creating a package is planning, and the baseline is over freezes that already
happened.

**What counts as a decision.** A `PASS` or a `PASS_WITH_CONDITIONS` is one —
conditions are the mechanism for proceeding with work outstanding. A `HOLD` or a
`REJECT` is a decision *not* to proceed and does not open the door either. And
the decision has to **predate** the freeze: a gate decided afterwards ratified
what had already been issued, which is the thing the criterion is about.

### Every conflict has a losing side

The sync engine has always resolved offline conflicts deterministically and
reported what it did. What it did not do was *keep* the report — and the device
receiving it is, by construction, the one on the bad connection. A supervisor's
pour record refused for progress regression simply vanished: the work was done,
the record was made, and nothing in the platform said it had been discarded.

Every conflict is now a `SyncConflict` record in `OPEN` state, written before
anything else happens, with **both sides kept whole**: the device's payload and
the server's state at that moment. Deciding after the fact means reading what
each party actually wrote, not a summary of the difference. That includes the
ones the engine let through — a `DEVICE_WINS` overwrote somebody's server-side
change, and a governance action refused offline is work attempted and lost.

`resolveSyncConflict()` is where a person decides. Two decisions, and the second
one **writes**: `KEPT_SERVER` confirms the engine's pick by a named person with
a reason, and `APPLIED_DEVICE` overturns it and commits the device's payload —
because a resolution that only annotated the conflict would leave the paperwork
tidy and the site record wrong, which is the wrong way round. The re-commit is
made under the resolver's identity, not the device's: overturning a refusal
means taking responsibility for the write, not laundering it back through the
supervisor who was refused. It needs `A` on field execution rather than `U`, so
the person whose record was refused cannot reinstate it alone.

### The merge that was in the vocabulary and could never happen

`MERGED` has been one of four resolutions since the first day and nothing could
produce it. Two people editing one record usually edited different parts of it —
a supervisor sets the plant on site while the engineer sets the pour volume —
and picking a winner there throws away a change nobody disagreed with.

It needs the base state, so `SyncOperation` gained an optional `baseState`. The
hash said *that* the device was out of date; this says *what it was out of date
from*, which is the only way to tell a field the device deliberately changed
from one it merely carried along. Absent, everything resolves exactly as before.

A merge is refused unless every changed field on both sides is a **scalar**. Two
devices appending to the same array have not edited different fields — they have
both edited the array, and merging them means choosing an order neither asked
for. Getting that wrong invents site data, which is worse than a conflict
somebody has to look at. Any overlap at all refuses too, including two people
setting a field to the same value by coincidence: that is a race whose outcome
happens not to matter, and treating it as agreement hides the next one where it
does.

**A defect in the existing rules, found by building this.** The monotonic
progress check read the device's raw payload. A device sends the whole record,
so a handset that never touched progress still carries the figure it last saw —
and the rule was reading that as the device's claim, refusing a note about
formwork because somebody else had moved the percentage meanwhile. It now reads
what would **actually be committed**, which is what the guard was always meant
to protect. The safety-stop rule stays first and unchanged.

---

## Nothing lost between deciding to tell somebody and telling them

A notification was transmitted first and recorded afterwards. That ordering has
exactly one failure and it is the worst one: a process that dies between
deciding to send and sending leaves **nothing at all** — no notice, no record,
and nobody who could know a notice was owed. The payment-failure email that
never went is indistinguishable from the payment that never failed.

The intent is now written down first. `NOTIFICATION_QUEUED` goes into the
ledger, which means onto the volume through the journal's write-ahead fsync,
carrying everything a later process needs to deliver it: the catalogue code, the
recipients, the payload, the branding. Only then is anything transmitted, and
`NOTIFICATION_QUEUE_SETTLED` records how it went.

Every existing caller keeps its signature and its inline delivery — `notify()`
queues, drains that one entry and returns the dispatch it produced. What changes
is what remains when the send does not happen.

**Two things the platform did not have before.** A queued notice that was never
settled is one it still owes, so `drain()` picks it up at boot and on a timer:
delivery is **at-least-once** instead of at-most-once. And a refused relay used
to record `FAILED` and be forgotten in the same breath; there is now a retry,
five attempts with a doubling backoff, and an **abandoned** state with the
relay's own words on it. The operator's screen reads the abandoned count,
because each one is somebody who was entitled to a notice and did not get it.

**What this is not, said plainly.** It is an outbox: the intent is durable in
the same store as the record, and nothing is lost after the decision to send.
It is *not* a distributed transaction. The domain event that prompted the notice
and the queue entry are two appends to the same journal, one after the other, so
a crash in the microseconds between them loses the notice and keeps the fact.
Closing that would take committing both in one journal write — a batched commit
on `ledger.commit`, the most load-bearing function in the codebase — for a
window this narrow. It is stated in the module and here rather than papered
over, and it is one of the things the Postgres design closes properly.

**Nothing about who gets told moved.** Preference checks, channel routing and
the transports all stay in `notify.ts`. The outbox owns durability and ordering.
A second opinion about who may be emailed, one file away from the first, is the
duplication rule 6 exists to prevent.

---

## A harness that checks the platform, not the model

The specification asks for AI evaluations: a gold set, drift monitoring and a
prompt-injection suite. Two of those are straightforward here. The first is not,
and the honest answer shaped the whole thing.

**It does not score model judgement, and it says so.** On a deployment running
the local engines the "model" is a hash of its inputs, so grading its judgement
produces a number that means nothing. Against a live provider, grading a
construction judgement takes a construction professional, not a fixture. A
harness that printed 87% would have invented the one figure nobody could check,
in a codebase whose entire argument is that its figures are checkable — so a
gold set of graded judgements is recorded as **not built** rather than faked.

**What it checks instead** are the properties the platform itself depends on,
which hold or fail whichever provider answered. Nine cases, in four kinds:

- **Accounting** — every AI event carries its assumptions, its prompt version
  with a whole digest, and a settlement against the wallet it held from. These
  are what the fifth stage gate clause reads before it passes.
- **Boundary** — the engine's own arithmetic is what lands in the record. The
  computed risk index is the one stored, not a plausible number a model
  returned.
- **Refusal** — a wallet capped at zero refuses before the provider is called,
  because a call made and then found to be over the cap is a bill the platform
  cannot pass on.
- **Injection** — an instruction written as an attacker would write it, placed
  where free text legitimately goes: the description of something observed on
  site, typed by a person and read by a model afterwards.

The injection cases are the reason the harness exists, and the platform can make
the claim honestly **because its defences are structural rather than written
into a prompt**. The closed event catalogue refuses an `aiAllowed: false` event
from an AI actor whatever the model was persuaded to attempt; no agent mandate
exceeds `PROPOSE`; no model may dispose of its own output. Those are assertions
about the ledger, not about how well a prompt held.

**Where it runs.** On its own instance of the demonstration project, built fresh
each time. It never writes into a customer's project — an evaluation that left
fixtures in a live record is a harness nobody could afford to run. Only the
result is recorded, on the platform that asked, which is what makes drift
comparable. Two independent platforms on the same commit produce the same
outcome hash.

**Drift is the number to read.** This run against the last one, case by case and
named. Against the local engines a change means the *platform* moved: a refactor
that quietly stopped recording assumptions shows up as a case that used to pass.
Against a live provider it means the provider changed under you, which is
otherwise the kind of thing a customer finds out first.

### It caught two things on its first run

Which is the only evidence worth having that a suite of checks can go red.

**The planning engine is phase-gated out of Operations**, and the demonstration
project sits there — so the case that ran a delay forecast failed with a refusal
that was entirely correct. The case moved to the safety engine. A harness that
had moved the project's phase to suit itself would have been testing a project
it had altered.

**The refusal case left the wallet capped**, and every case after it failed for
a reason that had nothing to do with what it was checking. The cases share one
fixture, so the one that changes it puts it back.

### And the threshold that was a constant

15.5 also asked for configurable per-task confidence thresholds. The review
threshold below which a machine-read result is held rather than taken as read
was `0.75`, fixed in one domain module. How much a deployment trusts extraction
is a policy about its models and its documents, not a fact about a brief.
`AI_CONFIDENCE_THRESHOLD` moves it, `AI_CONFIDENCE_THRESHOLDS` moves it per task
— reading a title block and reading a contract clause are not the same risk —
and the default is what it always was, so nothing changes by upgrading.

---

## The gold set, and the two fields that finished 15.4

Two things were left open at the end of the last pass, and both are closed.

### Known gaps and alternatives considered

The AI output schema wanted six things. Four were recorded; assumptions and
prompt version were added; **known gaps** and **alternatives considered** were
the last two, and they are on the event now.

A known gap is **not** an assumption, and the difference is what makes the field
worth having. An assumption is something taken as given and probably true — a
decision resting on one is a decision somebody can check. A gap is something the
answer needed and did not have: a drawing not in the inputs, a rate with no base
date, a ground investigation that stops above the founding level. A decision
resting on a gap is one somebody has to **close**. A gate that could not tell
them apart read the second as the first.

Alternatives considered is there because an option nobody wrote down is one
nobody can reopen. Three years into a dispute the question is rarely "was this
reasonable" but "what else was on the table", and an output listing one course
of action reads as though there was only ever one.

Both follow the same `[]`-versus-absent rule as assumptions: "it declared none"
and "nobody asked" are different facts, and the gate distinguishes them.

### A gold set of things with right answers

The last pass refused to build a gold set, and gave a reason: grading a
construction judgement needs a construction professional, not a fixture. **That
refusal stands.** Whether a programme is good or an allowance prudent is not
something this platform will print a mark for.

But it was the wrong conclusion to draw from it, and the instruction to decide
rather than defer was the right correction. A great deal of what this platform
computes has **no room for judgement in it at all**, because statute, standard
or arithmetic already decided:

- The notified sum under HGCRA s.111 when no pay-less notice was served is the
  applied sum. Not a view — the Act.
- A pay-less notice one day late does not bite. Neither does one in time that
  states no basis.
- An adjudicator's decision is due 28 days from referral, extendable by 14 on
  the referring party's consent alone.
- A PERT mean is `(o + 4m + p) / 6`. The critical path is the longest path.
  Total float is late start minus early start.
- CPI is earned over actual. EAC at current performance is budget over CPI.

Fourteen cases, in `ai/goldset.ts`. Every one **states the authority its
expected value comes from and derives it by hand in the comment**, so a quantity
surveyor or a planner can read the case and say whether the expectation is right
without reading a line of TypeScript — which is the review a gold set exists to
be open to. A case citing "as implemented" would be a circle, and a test asserts
that none does.

They run through the same functions the engines call, so a model introduced into
any of those paths cannot move an answer that was never the model's to move.
Tolerance is stated per case and is **zero** on eleven of the fourteen: a
statutory sum is exact. The three that carry one are the places the platform
legitimately rounds — a duration at a confidence level through a normal
approximation — and the tolerance is named in the case rather than assumed.

The harness now reports five kinds: accounting, boundary, refusal, injection and
**determined**. The first four ask whether the platform's defences hold; the
fifth asks whether its answers are right.

---

## The scaling answer, made checkable

`docs/STATE.md` recorded Postgres as the answer to horizontal scale and left it
as prose, and prose cannot be wrong in any way anybody notices.
`deploy/postgres/` is the schema plus a script that stands up a throwaway
Postgres 16, applies it, and tries to break each property it claims. Nineteen
checks, and the platform still does not use it: there is no wire-protocol driver
and there is not going to be a dependency. What changed is that the design is
now falsifiable.

**The first run passed every isolation check while the database was enforcing
nothing.** The script connected as the cluster's bootstrap superuser, and
row-level security does not apply to a superuser — nor to any role holding
`BYPASSRLS` — whatever `FORCE ROW LEVEL SECURITY` says. Each tenancy read the
other's events and the cross-tenant write the policy was supposed to refuse
succeeded. The policies were right and the connection was wrong, which is
exactly the mistake a deployment makes and exactly the one a schema file cannot
show. `construx_app` is `NOSUPERUSER NOBYPASSRLS` now, the script connects as
it, and one check asserts it is neither.

A smaller one from the same run: the cross-tenant write was refused by the
*chain* trigger, which under RLS could not see the other tenancy's head row and
reported "this project has no events" about a project with two. Correctly
refused, misleadingly explained — so there is an explicit tenant check, named to
sort before the chain trigger because Postgres fires BEFORE row triggers in name
order.

The property worth the whole exercise is the concurrency one. A row lock on the
project's head plus `UNIQUE (project_id, chain_hash)` means two writers may both
try to extend the chain and exactly one succeeds — which is what the writer lock
buys by *refusing* the second process, bought instead by the database. That is
the difference between refusing to scale out and scaling out.

---

## Asking something that has signatures

The ingestion pipeline says plainly that it is not an antivirus, and it still
does. What it never had was a way to *reach* one, so `antivirusScanned: false`
was permanent — a deployment with a perfectly good ClamAV beside it carried an
evidence store nothing had ever scanned.

`backend/src/evidence/scanner.ts` is the missing half: a client for clamd's
INSTREAM protocol over a socket, about as much code as the SMTP client already
in this repository, holding no signatures of its own. Unset changes nothing.
Configured, every ingested file goes to it and the record names the daemon and
its signature database — "clean" against a database from 2019 is a different
statement from clean against today's — and a signature quarantines the file
**by name**, because a quarantine record that will not say what was found is one
nobody can act on.

**Configured and unreachable is a refusal, not a shrug.** Ingesting anyway and
marking the file unscanned would leave it in the register looking checked, and
the operator who configured the scanner would never learn it had stopped
answering. So the command refuses and the file stays in the not-yet-read queue
where it is visible.

Two defects came out of running it rather than testing it. The refusal was a
plain `Error`, so the gateway had no mapping and answered `500 INTERNAL_ERROR —
The request could not be completed` — precisely the outcome the message was
written to prevent; it is a `DomainError` at 503 now. And the position endpoint
read `127.0.0.1:3310 — 127.0.0.1:3310 refused the connection`, because both the
caller and the reason named the address.

Verified against a daemon of the suite's own speaking the real protocol — the
framing is the thing being tested, so a stub that answered whatever it was asked
would test nothing — and then driven through a running server and a browser:
clean, infected, and scanner-down all read correctly on the screen.

---

## The file nobody had looked at

The evidence store already held the bytes, refused anything whose hash did not
match, and reported what the register named and did not hold. What it never did
was **look at the file**. A Windows executable renamed `site-photo.png` hashed
correctly, stored correctly, and sat in the register looking exactly like a
photograph.

`backend/src/evidence/ingest.ts` is five stages as pure functions — inspect,
classify, extract, index, available — and `pipeline.ts` is the governed half:
who may run it, what it writes, what it refuses. Each stage is a separate fact
on the record rather than one "processed" flag.

**It is not an antivirus and the record says so.** Zero runtime dependencies is
settled, so there is no signature engine and there is not going to be one.
`antivirusScanned: false` is on every inspection and `antivirusConfigured: false`
on every read, because a deployment reading `0 quarantined` as "nothing infected"
would be believing something nobody checked. What is checked is **structure**:
the declared type against the first bytes, executable magic (PE, ELF, both Mach-O
byte orders, Java class), the EICAR test string, active markup in a text-shaped
file, an archive carrying an `.exe`, and a compression bomb read from the ratio
the archive itself declares so nothing has to be expanded to find out.

**A quarantined file is not deleted.** The record is append-only and the bytes
are already an address something else may reference; deleting the object would
leave a hash in the chain pointing at nothing, which is the failure the evidence
register exists to report. Quarantine is a state saying nothing downstream should
read this, and why.

**The classifier is rules and is named that way.** `method: 'RULES'`, a
confidence that is the count of agreeing signals rather than a self-report, and
the signals listed so somebody can disagree with the answer. Each signal is a
sentence — it published the regex itself at first, so a project manager was shown
`the filename matches /(spec|specification|nbs)/i`.

**The index is lexical and is named that way.** Feature hashing over words and
word pairs, L2-normalised, compared by cosine. It finds the second copy of a
specification and revision C beside revision B; it does not find a document that
means the same thing in other words, and a test asserts the paraphrase it *fails*
to match, because the overclaim is the defect rather than the miss.

Two defects were found by building the tests rather than in production. Three
lines of a letter carrying the same number of commas were read as a
three-column table — the delimited parser now needs three rows and a header row
with no sentence in it. And the second and third events wrote the same state as
the first, which the ledger refuses: `FILE_INGESTED` now carries what the file is
and what came of trying to read it, `FILE_EXTRACTED` adds what actually came out,
and `FILE_QUARANTINED` is the change of status.

Ingestion takes `EVIDENCE_AUDIT` **`I`**, not `R`. Every role in the platform can
read the evidence register; producing a governed statement that a file is a
specification, or that it is a renamed executable, is an act on the store.

---

## Four more prompts, not a second pipeline

Progress estimation, PPE compliance, equipment recognition and defect detection
were specified as a separate vision pipeline. They are four more tasks in
`backend/src/engines/perception.ts`, because every rule a vision pipeline needs
was already there: refuse where no provider can see, send the file as media
rather than stringified into the prompt, write a draft, let a person confirm it
into the ordinary domain command.

A second pipeline would have been a second way into the progress register, the
NCR register and the safety log — the one thing the draft-and-confirm discipline
exists to prevent. So a confirmed progress reading runs `submitProgress` and is
refused by the measurement basis if the model measured in the wrong unit; a
confirmed defect reading runs `raiseNCR` once per defect, so each closes on its
own evidence; PPE runs `logSafetyObservation`; plant runs
`captureSiteObservation`.

**What the model is not asked.** No task's schema contains an activity id or a
claim period, and a test asserts it: those decide who gets paid and neither is in
the frame. The PPE prompt says *do not identify or describe any individual* —
a model naming an operative from a photograph is a disciplinary allegation
produced by a machine. None of the four accepts a PDF: a drawing is a document
about what is intended and these report what is there.

`PROGRESS_EXTRACTED_FROM_IMAGES` is written against the submission beside
`PROGRESS_REPORTED`. It carries the provider, whether the answer was synthetic,
the stated basis of measurement, what the model said it could not see, and what
the confirmer changed. The submission's own state is carried forward rather than
replaced — one entity holds one state, and writing the provenance alone would
have deleted the quantity a valuation is built on.

Two things were found on the way. `PerceptionDraft` declared `provider: string`
and nothing ever wrote it; the provider was on the event's `ai` block and on
`aiProvenance`, so the type was a lie to anybody reading a draft. And the voice
note's confirm branch never passed `actionByDate`, so a note the model read as
actionable could not be confirmed at all without first correcting
`requiresAction` to false — the confirmer overwriting what the speaker said in
order to file it.

**Verified against a stub, not a live provider**, the same limit the drawing and
voice tasks already carry. In the console the refusal branch is what a local
deployment shows, and it was checked in a browser: the panel states that no
provider here can read a file, and offers only the tasks the reader's own
authority covers.

---

## The dates inside the letters

The obligation calendar held what the *contract* required. What nobody was
tracking was what the parties said to each other afterwards — "we will complete
the outstanding remedial works to panels 3 and 4 by 14 October", "unless we
receive your comments by 30 September we will proceed on the basis set out
above". Those dates sat in the correspondence register as prose.

`backend/src/domain/commitments.ts` reads one held letter and offers what it
finds as candidate obligations. `COMMITMENT_REGISTERED` is the reading;
`DEADLINE_TRACKED` is a person confirming it, and it registers the obligation
through `registerObligation` so the date lands in the calendar that already
counts down and already reports overdue. There is no second list of dates to
disagree with the first.

**Nothing is recorded that the letter does not say.** Every commitment the
provider returns has to carry the sentence it read it from, and that sentence
has to appear verbatim in the body — whitespace normalised, so a letter reflowed
by an email client does not lose its own commitment. Anything that does not is
dropped before it is written, and if nothing survives the command refuses.

This is the same problem the perception pipeline solves with its `multimodal`
flag, solved without one. The local stand-in derives its answers from a hash of
its inputs; asked what a letter promised it will answer, confidently and
fictionally. A verbatim quote is the one thing a provider that never read the
letter cannot produce, so the check makes fabrication impossible to *file*
rather than merely discouraged. It also makes every entry arguable: a date in
the calendar can be read back against the sentence it came from.

**Three refusals, not one, and only one of them is about the letter.** Found
against a running server: the local engine returns no commitment list at all,
and the platform told the operator "nothing in COR-0001 undertakes to do
anything by a date" about a letter that plainly did. An empty list is an answer
(`NOTHING_PROMISED`); no list is a provider that cannot do this
(`PROVIDER_CANNOT_READ`); findings that all failed the quote check is a provider
answering anyway (`NOTHING_QUOTED`). The console says which.

**The date is the confirmer's.** A letter that says "within ten working days"
states a period, and which day that lands on — from which receipt, past which
holidays — is not something to infer from prose and file against a party. The
reading records no date at all in that case, and the screen says "a period, not
a date" rather than offering a guess.

The entity is `CorrespondenceCommitment`, not `Commitment`: that name was
already taken by a cost commitment against a budget, and one word for two
concepts is how a permission model goes wrong.

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
- The install prompt's **iOS branch is verified** — shown under a Safari agent,
  suppressed under Chrome-on-iOS, suppressed once dismissed, dismissal
  persisted. Its **Chromium branch is not**, and cannot be here: headless
  Chromium does not fire `beforeinstallprompt` (it is gated behind the browser's
  own installability and engagement heuristics), so the listener is exercised
  by no test. What is verified is that the listener is attached and that nothing
  paints when the event does not arrive. The Android offer needs a real handset
  to confirm.

---

## What a real model sends back, and what used to happen to it

Every perception row above carried the same caveat — *exercised against a stub,
not a live provider* — and the stub was written by the same hand as the engine,
so it answered in exactly the shape the engine asked for. Real vendors do not,
and the path from a provider's `200 OK` to a record in the Golden Thread was
`JSON.parse(text)` with the result cast to an object.

Three live behaviours went straight through it, all found by reading the three
configured vendors' documented response shapes rather than by calling them:

- **A fenced or prefaced answer threw.** A model told in a *system prompt* to
  reply in JSON very often replies "Here is the title block:" and then a
  ` ```json ` block. Anthropic is the likeliest: it is configured with no
  structured-output enforcement at all, only the instruction — and its body was
  never sent `responseSchema` either, so the one vendor without enforcement was
  also the one never told what shape to answer in. Both are fixed: the schema
  travels in the message, and a fenced, prefaced or trailing-prose reply is read.
- **Valid JSON that is not an object was accepted.** `null`, `[]`, `42` and a
  quoted refusal all parse. The cast to `Record<string, unknown>` made them
  objects to the type system only. `null` reached the ledger as a draft's
  extraction, and the legibility check then dereferenced it — a `500`, with the
  null already committed to an append-only record. The parse now requires a
  JSON object and refuses everything else by name.
- **A truncated answer was reported as malformed.** Anthropic's ceiling here is
  8,192 output tokens, which a large take-off reaches. The operator was told
  "did not return valid JSON" when the actionable truth was that the ceiling was
  too low. Every vendor's own stop reason is now read — OpenAI's
  `status: incomplete`, Gemini's `finishReason` and `promptFeedback.blockReason`,
  Anthropic's `stop_reason` — and a cut-off answer is refused **even when it
  still parses**, because a take-off truncated at item 140 of 200 is a plausible
  partial quantity, and a plausible partial quantity becomes a BoQ item and then
  a price.

The worst of it was the accounting. `#consecutiveFailures` was reset on the line
*before* the parse, so a provider answering `200 OK` with something unreadable on
every single call stayed **healthy for ever**: never taken out of rotation, never
failed over from, billing the vendor in full for every request while every caller
received a `502`. Health is now reset only once an answer has actually been read.

What this does **not** establish: no call has been made to any vendor from this
environment, and none of it says a model reads a drawing correctly. It says the
platform will understand the reply when one arrives, and will refuse safely when
it cannot.

---

## The mandate ladder, and why declaring ACT confers nothing

The fleet was twelve agents in four divisions, every one of them capped at
`PROPOSE`, and a test asserted that no agent anywhere declared `ACT`. That test
was a placeholder, and its own failure message said so: acting unattended "needs
an explicit product decision, not a default". There was no mechanism by which
such a decision could be taken, so the ban stood in for one.

**The ladder is now OBSERVE → DRAFT → PROPOSE → ACT.** `DRAFT` is the rung that
was missing: a complete, valid command prepared and held, nothing reaching the
ledger, which is exactly what the perception pipeline already does and had no
name for.

**Declaring is not granting.** `registry.ts` declares which agents are *eligible*
for ACT and the outside edge of what such a grant could ever cover — named
commands, a value ceiling, and a sentence saying why. That confers nothing. An
agent reaches ACT only through an envelope a person granted:

- authorised against `ENTERPRISE_STRUCTURE` `G`, which within a tenancy only
  `ENTERPRISE_ADMIN` holds — deliberately not `AI_EXECUTION`, because every role
  holds `X` on that area and deciding that a machine may act without asking is
  not the same kind of act as asking it a question;
- recorded as `AGENT_ENVELOPE_GRANTED`, a governance event with
  `aiAllowed: false`, so an AI actor committing one is a hard failure in the
  ledger. There is no path from an agent to its own envelope;
- narrowing only. A command outside the declaration is refused, a ceiling above
  the declared one is refused, and a command whose event type is
  `aiAllowed: false` is refused at grant time *and* would fail again in
  `commit()`;
- bounded in time. No open-ended grant — 366 days is the maximum, because the
  grant nobody remembers making is the one still running in three years;
- one at a time. Two overlapping grants for one agent is ambiguous authority,
  and every way of resolving it is wrong in a different direction, so the
  platform refuses and names the grant in the way.

Revocation takes effect on the next evaluation, not mid-flight. An act already
executing completes and is recorded; the next pass finds no live envelope.
Claiming the platform can interrupt a command mid-write would be a safety story
that is not true, which is worse than a narrow one that is.

**An ungranted act is queued, not lost.** The runtime degrades an `ACT` proposal
to `PROPOSE` and attaches the reason. Refusing outright would trade a small
safety gain for the loss of the finding entirely.

Exactly one agent is ACT-eligible — `health` — and its envelope carries a value
ceiling of zero and writes no governed state: it may tell somebody the platform
is unwell, and that is all. It is the only act on this platform where waiting
for an approval makes the outcome worse.

## Nineteen more agents, and the seven that are declared rather than stubbed

Twelve became thirty-two, across nine divisions. Thirteen new ones are deployed
and read real state: `defect-triage` clusters 5xx by route with the correlation
ids to reproduce them; `threat-hunter` compares each actor to that actor's own
baseline rather than a global one; `vulnerability` reads
`assertProductionSafety()` rather than restating its rules; `fraud` flags two
applications against one cycle, a valuation landing on an exact round figure
against a basis that says it was measured, and a certificate signed out of
hours; `expansion`, `retention`, `collections`, `success` and `onboarding` read
the wallet, the standing and the ledger's own record of who did what and when;
`regulatory` watches the dates that lose a right rather than open a negotiation.

Seven are **declared, not stubbed**: `competitor`, `pricing`, `release`,
`identity`, `kyb-kyc`, `aml` and `support` carry a mandate, no `evaluate`, and a
sentence naming exactly what each is waiting on — an external award feed, enough
settled projects for the benchmark to rise above FLOOR confidence, CI metadata,
device binding, an identity-verification connector, a live payment path and a
sanctions source, an inbox. A manifest listing thirty-two agents where seven read
from a source that does not exist would be a lie told in a table, so the runtime
never runs one and the published manifest says which is which.

---

## The Postgres client, and what it does not yet do

`deploy/postgres/` has carried a schema verified against a real Postgres 16
since it was written, and `docs/STATE.md` has carried the same sentence beside
it: *what is absent is the client*. The design was checkable and unreachable.

`backend/src/store/` is the client. Zero dependencies, because `pg` is not an
option and the alternative to writing this was not using Postgres. Two files:
`wire.ts` is the protocol as pure functions, `postgres.ts` is the socket, the
state machine and the pool.

**Verified twice, in two different ways.**
`deploy/postgres/client-check.sh` stands up a throwaway cluster initialised with
`--auth-host=scram-sha-256`, applies the schema, and runs 18 assertions through
the client — so a client that only spoke MD5 could not have connected at all.
It proves SCRAM-SHA-256, a parameterised statement carrying `'; DROP TABLE
event; --` as a value, `null` distinct from `''`, `numeric` never becoming a
float, a megabyte crossing many TCP reads, a `text[]` containing a comma and a
quote, the tenant-mismatch trigger, forced RLS as a `NOBYPASSRLS` role, the
append-only rules affecting zero rows, and **exactly one of two concurrent
writers extending the chain**.

Separately, `tests/wire.test.ts` runs in `npm test` with no cluster and checks
SCRAM-SHA-256 against **RFC 7677's own published test vector**. That matters: a
live server proves the two ends agree, and only an external vector proves this
end is the one that is right.

**Three defects were found by running it, not by reading it.**

- The tables live in the `goldenthread` schema and a connection's default path
  is `"$user", public`, so every statement answered `relation "event" does not
  exist`. The client had connected perfectly and could see nothing. `search_path`
  is now a **startup parameter** rather than a later `SET` — it holds for the
  first statement as well as the hundredth, and it cannot be changed
  mid-connection, which is what stops a function in an attacker-created schema
  shadowing one the triggers rely on.
- The RFC vector sends a username in `n=` and Postgres sends it empty. The class
  hard-coded the empty form and therefore could not be checked against the only
  external authority on whether it was correct. It is a parameter now, defaulting
  to what Postgres wants.
- A test asserting that `null` and `''` produce different message lengths was
  wrong: both carry a four-byte length and no data, so the size proves nothing
  and the *value* of that length is the whole distinction.

**What this does not do.** The ledger has not moved. `goldenthread/ledger.ts`
still reads and writes the in-process journal, and switching it is a separate,
careful piece of work on the most dangerous file in the repository — not
something to fold into the commit that introduced the client. Until that lands:
the writer lock is still load-bearing rather than redundant, recovery is still
bounded by the backup interval, and nothing fails over. Named here so the
distance is not mistaken for zero.

Statement caching and binary result format are both deliberately absent.
Caching is how a pooled connection ends up holding a plan built for a different
search path, and binary format would mean converting `numeric` client-side — a
rounding error in a payment certificate is not a trade worth making for parsing
speed.

---

## Telemetry that outlives the container

The counters, the latency histogram, the security stream and a correlation id on
every request have all existed since the gateway was built, and `docs/STATE.md`
said the same thing about them throughout: *structured JSON still goes to stdout
and nothing collects it*. Everything needed to reconstruct an incident existed
and died with the process.

`ops/otlp.ts` ships it. OTLP over HTTP with the JSON encoding — which every
collector accepts and which needs no protobuf runtime, the same reasoning that
produced an SMTP client and a clamd client rather than dependencies.

Four properties, because a telemetry exporter that misbehaves is worse than none:

- **It never blocks a request.** Nothing on the request path awaits anything in
  this module, and `record()` neither throws nor returns a failure — the only
  thing a request handler could usefully do with the knowledge that telemetry is
  unwell is fail a request that otherwise worked.
- **It never grows without bound.** The queue is capped. When it fills it drops
  the *oldest* — in an incident the newest records are the ones describing it —
  and `construx.telemetry.dropped_total` is exported alongside everything else,
  so a lossy pipeline is impossible to mistake for a calm platform.
- **Local telemetry survives egress failure.** The counters are the source and
  this is a reader. A collector being down changes what anybody else can see, not
  what the platform knows about itself. A failed batch is put back at the front,
  oldest first, so ordering survives.
- **It ships no secret and no personal data.** Route ids, status codes, counts,
  durations, and security events whose addresses were already truncated to a
  network upstream. The collector's own auth token is parsed from
  `OTEL_EXPORTER_OTLP_HEADERS` and never appears in `egressPosition()`, so the
  admin screen shows the endpoint and not the credential.

Verified against a collector of the suite's own — a real HTTP server capturing
what arrives — rather than a stub that answers 200 to anything, because the
payload *shape* is the whole point: a collector rejects a malformed OTLP body and
the symptom is silence, which looks exactly like a healthy quiet platform. The
tests assert the things that are wrong in a plausible way: integers as strings
rather than numbers, cumulative-and-monotonic rather than delta, and per-bucket
histogram counts differenced from the cumulative source — sending the cumulative
array as if it were per-bucket produces a total several times the real one and
every percentile derived from it is wrong in a way that looks reasonable.

---

## Evidence that two containers can both reach

The evidence store held real files behind their content hashes, on a volume.
Correct for one instance, and precisely the reason the application tier could not
be replicated: two containers on separate volumes each hold half the evidence,
and a request routed to the wrong one answers *"the platform holds the hash of
this evidence but not the file"* about a file the platform certainly holds.

`store/s3.ts` is an S3-compatible client, SigV4-signed by hand because zero
dependencies is settled and the AWS SDK is therefore not available. S3's API is
the one every object store implements — R2, MinIO, Backblaze, Ceph — so the
endpoint and region are configuration rather than a rewrite.

**The signer is checked against AWS's own published SigV4 vector**, not against
itself. A signature this repository and a fake server both agree on proves two
halves of the same misunderstanding; only an external vector proves the
signature a real S3 would accept. The percent-encoding tests exist for the same
reason: `encodeURIComponent` leaves `!'()*` alone where AWS requires them
encoded and encodes `~` where AWS requires it left alone, and both differences
produce *"the security token is invalid"* — an error about credentials, for a bug
about punctuation.

**When an object store is configured it is the only store**, not a cache in
front of the volume. A write-through cache means two places a file might be and
two answers to "is it held", and the whole point of a content-addressed evidence
store is that there is one answer.

**An unreachable store throws rather than answering "not held".** "Not held" is a
fact about a file and "cannot tell" is a fact about the platform; conflating them
is how an evidence register reports files as missing during an outage and
somebody re-uploads what was already there. The hash is re-verified on read
exactly as the volume path does, and checked *before* the bytes travel on write —
uploading first and finding the mismatch afterwards leaves an object in the
bucket that no record names, which is what the retention sweep then has to reason
about.

### The cost of it: five reads became asynchronous

`has`, `get` and `list` were synchronous because a volume answers synchronously.
An object store is over a network and there is no honest synchronous answer to a
question that needs a round trip, so `holds`, `fetch`, `store` and `held` are
async and every caller was migrated — `requestSignature`, `projectRegister`,
`retentionPosition`, the perception extraction and the ingestion pipeline.

That migration surfaced a defect worth naming, because it is silent: **making a
function async turns every synchronous `throwsCode` guard into a no-op that
passes.** Three signature tests asserting a refusal were asserting nothing at
all — the rejected promise was never inspected. They use `rejectsCode` now. Any
future change that makes a tested function async has the same trap in it.

`ingestionPosition` had a related one: the filter that made `held` mean "evidence
the platform holds the *bytes* for" rather than "evidence it holds a *hash* for"
had to become an awaited presence check, and dropping it would have silently
turned a meaningful figure into a meaningless one.

---

## The stored session that could never work again

Reported as *"I cannot access and test: UNAUTHENTICATED — Token issuer or
audience mismatch"*, and reproduced exactly against a running server.

The issuer string moved from `construx.ai` to `construxvg.com` in `dfd980a`.
Both builds default to the same JWT secret, so a token minted by the **older**
build passes the signature check — the first thing `verifyToken` does — and then
fails the issuer check. A browser holding one from before that change was
refused on every request.

**The refusal was correct. What was wrong is what happened next: nothing.**

- `rotate()` returned `null` when the refresh was refused and left the dead
  session in `localStorage`. The next request presented the same token and got
  the same answer.
- `draw()` called `loadMatrix()` **outside** its `try`/`catch`, so the 401
  escaped the function entirely — no sign-out, no redirect, no shell rendered,
  just an unhandled rejection.

The result was permanent. Every reload produced the same refusal for ever and
the only way out was clearing browser storage by hand. Nobody discovers that,
and on a field device nobody can reach it to do it.

Both halves are fixed, and the fix is at the layer that fixes every path rather
than the one call site that noticed:

- A **refused** refresh clears the session, because a refusal is final — an
  expired refresh token, a revoked one, a rotated secret, or an issuer that has
  since changed. A **network failure** does not, because a session may be
  perfectly good and the browser simply offline, and clearing on that would sign
  a site operative out for driving through a tunnel.
- A session with no refresh token at all is discarded rather than kept: it can
  never be renewed, so keeping it only guarantees the next failure.
- `loadMatrix()` is inside the guard, and only a 401 signs out. Treating every
  failure as an expired session would hide a real defect behind a login form.

The service worker needed no change: its cache key is derived from a hash of
every servable file, so changing `app.js` and `lib/api.js` rolls the version,
installs the new worker and evicts the old cache on activate. That mechanism was
built for exactly this and it worked.

### The server-side half, which is what actually unblocks somebody

Clearing the session client-side sends a person back to sign-in, which is a
recovery rather than a fix — they still lost their session for a rename they had
nothing to do with. So the server now accepts a **legacy issuer at
`/v1/auth/refresh`, and nowhere else**.

That is the standard way an issuer rename is migrated, and the bound is what
makes it safe rather than a weakened check:

- the signature must still verify, so the token is genuinely this platform's;
- it is refused on every ordinary route, so nothing is ever *used* under a legacy
  issuer — it can only be traded in;
- the presented token is revoked as the new pair is minted, so the exchange works
  exactly once;
- the window closes on its own with the refresh token's expiry.

The issuer check exists to stop token confusion between *different* systems that
share a secret. These are not different systems; they are this one, before it was
renamed.

**Anyone holding a stale session is back in on one transparent round trip**, with
nothing cleared and nothing to do: the first request 401s, the client exchanges
the refresh token, the request is retried and succeeds.

### The third thing that strands a device, and the way back

The two fixes above cover a session the server refuses. They do not cover the
other state a browser keeps across a deploy: **a service worker still serving the
shell it installed months ago, and the caches behind it.**

That worker is versioned by build id and evicts its own old caches on activate,
so an ordinary deploy is picked up. What it cannot recover from is a device where
the worker itself is the broken part, or where the substitution that versions it
ever failed — and the symptom is identical to a dead session: *"it worked
yesterday and now nothing loads."* Every published fix for that class of problem
is a devtools instruction, which is useless advice for a handset in a site cabin.

So **`/app?reset=1`** clears the stored session, unregisters every service worker,
deletes every cache, and reloads. Three properties make it a recovery rather than
a new failure mode:

- it runs **before** `draw()`, because a shell that cannot start is the case it
  exists for — running it after would make the recovery depend on the thing being
  recovered;
- the boot is gated on it, so nothing draws and the outbox does not drain behind
  a navigation that is already leaving — a drain there would try to send queued
  operations with no credential to send them under;
- the `load` handler does not re-register the worker while a reset is in flight,
  which would put back the worker the reset had just removed.

It is deliberately **not a button in the interface**. It destroys queued offline
work, and the address bar is a high enough bar that nobody reaches it by accident
while meaning to sign out.

Driven through a real Chromium rather than only asserted in the suite: a planted
cache from a build that no longer exists (`construx-shell-FROM-AN-OLD-BUILD`) and
a session the server would refuse were both gone after the reset, and the sign-in
screen rendered.

---

## The blog, as records rather than as source code

Six posts lived as a hard-coded array in `site/posts.ts`. Publishing a seventh
meant editing TypeScript, rebuilding the image and redeploying — so nobody did,
and the marketing site had a blog that had not moved in months.

`site/blog.ts` puts a post in the ledger and lets the reasoning engine draft one.
Four properties make that a publishing tool rather than a spam generator pointed
at the company's own domain.

**A model drafts; a person publishes.** `draftPost` writes a DRAFT and nothing
else. `publishPost` is a separate command a named human runs, and it is the only
thing that puts a URL on the public internet. No agent mandate reaches it: the
ladder governs acting on a project's record, and this acts on the company's
public face.

**The stand-in is never published.** With no provider configured the local
adapter reasons about nothing and says so. Dressing that as an article under the
company's name would be the failure `documents/generate.ts` already refuses —
prose attributed to reasoning that never happened — so a synthetic draft is
refused at the point of drafting. Verified live: with `AI_MODE=local` the route
answers **503 NO_REASONING_PROVIDER**.

**SEO is a gate, not a score.** Seven checks — title length, meta description,
slug shape, depth, the keyword in the title and the opening, the standfirst —
and publication is refused while any fails, with every failure named. A blog that
publishes anyway and shows a red number nobody acts on is how a site accumulates
pages that make it rank worse.

**The compiled posts stay.** They are not migrated, rewritten or replaced.
Published records are added alongside them, and the count on the screen is read
from the data rather than written into the sentence.

Model output is **escaped** into the page; the compiled six keep their trusted
markup. That difference is stated in code rather than assumed — a script tag in a
drafted paragraph would otherwise be an injection on the company's own domain,
published and indexed.

### What it cost to let the operator run AI at all

The blog needed the operator to reach an engine, and three things stood in the
way. Each was load-bearing and each was replaced rather than removed.

- **No `AI_EXECUTION` in the role matrix.** Granted, and bounded below.
- **No wallet on the platform tenancy.** The platform is now a tenant of itself:
  same wallet, same ACU arithmetic, same refusal when it runs out. Letting the
  company's own AI run uncharged would put the one figure an operator most needs
  to trust — what this platform costs to run — outside the meter that governs
  everybody else's. It takes no trial grant, so an unfunded deployment is
  refused for want of credit and says so.
- **ABAC barring the operator from every area but three.** `AI_EXECUTION` joins
  them.

The bound that makes all three safe is **not** any of those lists. It is
`Platform.context`, which now refuses a `PLATFORM_ADMIN` any project outside
`platform-*`. An engine context is the only way to reach `runAI`, so an operator
can run AI on `platform-marketing` and nowhere else.

That property used to hold by accident: the operator tenancy had no wallet, so
`context` threw, and `entitlement.test.ts` pinned that and called it stronger —
correctly, because a route guard can be forgotten on a new route. Giving the
platform a wallet removed the accident, so the property is now an explicit check
with both directions asserted: the platform's own project is allowed, a
customer's is refused by name.

### Two defects the walk found and the suite did not

**The quote refused, so the button never enabled.** `/v1/ai/quote` demanded a
project, the blog draft has none, and the console holds submit shut until a price
arrives. The rule that nothing spends without showing its cost first had made the
one honest path impossible. An AI route with no project now quotes against the
platform's own wallet, and the exception is named in `quote.test.ts` and
`doors.test.ts` rather than left implicit.

**The platform tenancy existed only on a first boot.** It was created in
`createOperator`, which does not run when an operator is replayed from the
journal — so the wallet was present on a fresh deployment and absent on every
restarted one. It is created from the constructor now.

---

## Landing-page pictures were being written somewhere that does not survive a deploy

Reported as "my pictures are nowhere to be found", and it was not the stale
deployment that explained the rest.

`SITE_MEDIA_PATH` was blank in `.env.example` and unset in compose, so
`mediaDir()` fell back to the checkout — which inside the image is the
container's own writable layer. Uploading a picture worked, looked right, and
survived exactly until the next rebuild, which autodeploy does on every push.

`.env.example` had documented the risk in full. Nobody set it, which is the
whole lesson: a warning in a file nobody opens at the moment it matters is not a
control.

Two changes. Compose now supplies `/data/site-media` — on the same volume as the
journal — as a **default rather than an override**, so a deployment that sets its
own still wins. And the boot banner states where the pictures go and whether they
will outlive a redeploy, so a deployment in the bad state is uncomfortable to
look at rather than silent.

The deployment invariant was taught the difference between `NAME: literal` and
`NAME: ${NAME:-default}` in the process. It had treated every line in compose's
`environment:` block as a shadow, which made "give this a safe default"
indistinguishable from "override whatever they set".

---

## The developer surface: a credential that is not a person

An integration wants to post daily progress. Giving it a user's session gives it
the ability to certify a payment. `developer/keys.ts` and `developer/webhooks.ts`
close that.

**A key is never wider than the person who issued it.** Requested scopes are
intersected against the creator's live scopes and anything wider is refused *by
name* — silently trimming produces a key that half works and a support call
nobody can answer. `admin:*` is refused for everybody, including a caller who
holds it: there is no integration whose correct answer is "everything", and a
credential that can do anything is the one that ends up in a public repository.

**Sandbox is a tenancy, not a flag.** A sandbox key acts on `<tenant>-sandbox`.
A flag is a filter and every filter is one forgotten `if` away from a sandbox
integration writing into a live payment cycle; a separate tenancy is enforced by
the isolation the platform already applies to every read and write, with no new
check anywhere.

**The secret is shown once.** Stored as a SHA-256 digest, never in the ledger,
withheld from every read — so a leaked database is not a leaked key, and a
register cannot be brute-forced offline. Every key expires; 366 days is the
ceiling.

**Authentication reads an index, not the ledger.** A key is presented before the
platform knows whose request it is, so a tenant-scoped read is impossible — and
`entitiesOfType` says in its own doc-comment that nothing serving a request may
use it. Keys are indexed at boot from the record, exactly as the people who can
sign in already are, and maintained by issue and revoke. A revocation takes
effect on the very next request rather than at the next reload.

### Webhooks, and why they are not the notification outbox

The outbox delivers to *people* through a closed catalogue of notification codes,
with consent, branding, unsubscribe tokens and channel preference on every entry.
A webhook delivers to a *URL*, carries a signature rather than a template, and
its catalogue is the Golden Thread's. Folding one into the other would mean a
notification code per event type — 494 of them — and a consent model for a
machine. So webhooks are a separate queue following the same discipline, stated
rather than inherited.

- **The endpoint is constrained, because it is an outbound request to an address
  a customer chose.** https only, no credentials in the URL, and nothing that
  resolves inside the deployment — otherwise the feature is a server-side request
  forgery primitive handed to whoever can create a subscription. The limit is
  stated rather than hidden: a *name* that resolves to a private address at
  delivery time is not caught, and closing that needs the check at connect time
  in the egress layer.
- **The signature is `t=<seconds>,v1=<hex>` over `"<t>.<body>"`**, and
  `verifySignature` is exported and tested because an integrator has to implement
  it — a scheme described only in prose gets implemented three ways, two of which
  accept a forgery. The timestamp is inside the signed material, so a replay is
  detectable and moving the timestamp invalidates the digest.
- **At-least-once, with a stable delivery id**, so a receiver can make it
  exactly-once. Promising exactly-once from a retrying sender would be promising
  something no retrying sender can give.
- **An abandoned delivery is reported, not hidden.** It is data an integrator
  never received, and a screen carrying only successes lets a customer believe an
  integration is complete when it has gaps. A subscription that fails ten times
  consecutively is disabled: continuing to post to an endpoint that has been
  refusing all day is a slow outbound flood against somebody else's server.

One defect worth naming, found by the catalogue test: recording a delivery
failure originally re-used `WEBHOOK_SUBSCRIBED`, which `creates`. The second
failure against the same subscription would have been refused as a duplicate
creation — so the drain would have failed on the endpoint that was already
failing, which is exactly the wrong moment. Health is its own UPDATE event now.

---

## Verifying the chain before somebody has to rely on it

`replayProject` has recomputed every state hash and every chain link since the
ledger existed. What did not exist was anything that **ran** it — so the first
realistic moment a divergence could be discovered was during a dispute, by the
person least able to do anything about it, in front of the people it was going
to be shown to.

`ops/assurance.ts` runs it continuously and raises a **critical** alert on the
first divergence rather than the first query. It uses `replayProject` rather
than a verification of its own: two implementations of "is this chain intact"
would eventually disagree, and the one that disagreed quietly would be the new
one.

**A rotating slice, and honest about being one.** Verifying every project every
pass is O(all events) and would consume the process on a mature estate. So a
slice moves through the estate, and the position reports **when each project was
last proved** and **how many passes a full circuit takes** — because "verified
continuously" means nothing without that second number.

**It detects and never repairs.** A divergence in an append-only hash chain
cannot be repaired; that is the point of it, and a process that "fixed" one
would be indistinguishable from the tampering it exists to catch. A test asserts
the module exports nothing whose name suggests otherwise, so nobody adds a repair
later as a convenience. A verification that itself throws is recorded as a
failure, never as intact — reporting "all clear" for a check that did not run is
the single worst thing this module could do.

## Auto-repair, bounded to restart and reroute

Two silent failures are worth fixing without asking, and both have a blast radius
identical to normal operation: **a timer that stopped**, and **a queue that is
owed and idle**. A stopped drain produces no error — the outbox fills, nothing
sends, and the first symptom is a customer saying they never received something.

`ops/repair.ts` restarts the drain and re-runs it, and flushes telemetry that
stalled after a collector recovered without telling anybody. That is the whole
list.

**What it refuses is published** on `/v1/admin/repair` rather than left to be
assumed — changing code, deploying, writing project state, changing
configuration or credentials, and repairing a chain. The line from the blueprint
is kept literally: an agent that can change the code holding the evidence can
change the evidence, and no approval workflow around that changes it, because
the capability itself is the problem.

It is deliberately **not offered to an agent**. The `health` agent's envelope is
notify-only, which is the right ceiling for something that reads rules and tells
somebody; this changes the running process, and "an agent may restart parts of
the platform" needs a much better reason than convenience.

**A repair that keeps firing is reported as a finding rather than a fix.** Once
is a blip. Five times means something is re-breaking and the thing meant to
paper over a blip is hiding a defect instead.

---

## Account pictures

Every account type can carry a picture. The mechanism is deliberately the one
the landing page already had rather than a second one beside it: the bytes go to
the content-addressed evidence store, the magic-byte table in `site/media.ts` is
exported and shared, and the user record holds only a `pictureHash`. So a
picture is an object the ledger commits to by hash, not a blob in a user row,
and `USER_PICTURE_SET` records who set it and when.

**A person sets their own picture and nobody else's.** `POST /v1/me/picture`
takes the actor from the session; there is no route that names a target user, so
an administrator cannot set a colleague's picture. Reading is open within the
tenancy — `GET /v1/users/:userId/picture` — because a face in a sidebar is the
whole point of having one.

**Type is decided by the bytes, not the filename.** `SIGNATURES` matches PNG,
JPEG, WebP and GIF headers; an SVG is refused, by name, because an SVG is a
document that executes. The refusal says so rather than saying "invalid file".

**It requires an object store.** With `EVIDENCE_STORE_PATH` unset the upload is
refused with "No object store is configured" — an honest refusal, not a silent
in-memory success that vanishes on the next deploy. Compose sets it to
`/data/evidence` on the ledger volume.

## What is not built: document cover branding

`ClientBranding` carries `logoEvidenceHash`, and the PDF renderer places that
logo in the header of every page. It does **not** carry a cover image, and the
renderer has no cover page. The design is settled — `coverEvidenceHash`
alongside the logo, resolved through the same `ImageResolver` a site photograph
takes, so the document's content hash commits to exactly which image was on it —
but none of it is written. Printed documents today are branded by logo only.

---

## The operator console: twenty-five screens, no locks

An operator signed in and saw five sidebar items, three of them wearing a
padlock, and two screens that worked. The locks were the tell: they sat on
customer capability areas an operator can never hold — a different account layer
rather than a senior role — so they named nobody to ask and could never come
off. That is furniture, not information.

The cause was structural. There was one navigation model, written for delivery
work, filtered down for an operator. Filtering "which project screens can
somebody who is barred from every project reach" was always going to answer
"almost none".

**`OPERATOR_NAV` is a second navigation model**, and `navigation()` picks between
them. Six groups, twenty-five screens, every one of them reachable, none of them
locked — because every entry is a surface an operator actually holds. The
delivery navigation is untouched; a customer account gets exactly what it got.

| Group | Screens |
|---|---|
| Overview | Command Center · Performance · Customer Value · Predictive Intel |
| Customers | Tenants & Users · Onboarding Queue · Support Queue · Communications |
| AI & economy | AI Engine · ACU Economy · Billing & Invoices |
| Risk & system | Risk & Alerts · System Control · Platform Operations · Audit Logs · Event Store |
| Content & reports | Reports · SEO & Content · Newsletter · Blueprint |
| Account & settings | Growth Partner Programme · Influencers · Company Profile · Settings · My Account |

**The Command Center stopped being the whole console.** It was every panel the
platform had on one scroll: an operator opening it had to read four thousand
pixels to find out whether anything was wrong. It now answers one question — is
anything wrong, and where is the money — and hands off. Its "Needs you today"
panel is assembled from the watch, the forecast, the readiness report, the
support queue and the estate at once, so finding out whether anything needs
attention does not require visiting five screens.

### What was built to fill them

Six of these had no backend at all. Each is a real read over the record rather
than a panel that looks like one.

**`ops/performance.ts`** aggregates the gateway's log buffer per route. The
console had one estate-wide p95, which hides a four-second document generation
behind ten thousand cheap reads. The panel that earns the screen is **tail
attribution**: not "which route has the worst p95" — a route called twice slowly
has a terrible p95 and costs nobody anything — but which routes' calls are
actually landing past the estate p95. Two limits are published rather than
implied: the buffer is in-process and bounded at 5,000 records, and a restart
empties it. The request total is read from a monotonic counter instead, so the
one number somebody watches for saturation never goes down when the buffer trims.

**`ops/eventstore.ts`** counts and never reads. Every figure comes from an
event's type, tenancy, chain and timestamp; the diff, entity, evidence and actor
of a customer chain are not reachable from the operator layer. Two things it
answers that nothing else could: **which catalogue codes have never been
written** — the catalogue invariant proves a command exists that emits each
code, not that anybody ever ran it — and **whether the journal agrees with the
ledger**, where a ledger holding more than the journal means writes that would
not survive a restart.

**`ops/forecast.ts`** is Predictive Intel, and it forecasts nothing it cannot
show its working for. There is no churn score. A "churn risk 72%" on an estate
of a dozen tenancies is invented, and the first time somebody acts on one and is
wrong, every other figure on the console loses its credibility with it. What is
there is a queue of things that will happen unless somebody acts — AI credit
running out, a renewal, a trial ending, seats full, storage full, no
administrator, a tenancy gone quiet, a top-up never settled — each with the
arithmetic printed beside it and ranked by when it lands. `notForecast` names
what is deliberately absent so the absence is a position rather than a gap.

**`support/queue.ts`** is a genuine vertical, not a panel. A request is a ledger
record on the *raising tenancy's* governance chain, so it belongs to the customer
who raised it and they can read back what they were told after whoever told them
has gone. One screen serves both sides and the server decides what each may see.
`respondedAt` is set once, at the first operator reply, so first-response time
cannot be improved by replying twice — a queue measured on how fast it closes
things is a queue optimised for closing things. An operator cannot raise one;
they have nobody to raise it with.

**`growth/partners.ts`** carries resellers and influencers on one mechanism with
different terms. The rule that runs through all of it: **commission is computed
from payments actually received**, walked from settled receipts, never from
signups. A programme that accrues against expected revenue eventually pays
commission on money that never arrived. Attribution is fixed at signup —
`referralCode` is written onto the tenancy at creation and never afterwards,
because attribution that can be edited later is attribution somebody can rewrite
once they know what a tenancy turned out to be worth. A code is never reused,
including after an agreement ends. Recording a payout writes down that money was
sent; it moves none, because there is no outbound rail and pretending otherwise
inside a financial record would be the worst kind of fiction.

**`ops/reports.ts`** composes six operator reports at the moment they are asked
for, from the same reads the console uses — so a report and the screen it came
from cannot disagree. Nothing is stored: a report is a view of the record, not a
new fact about it, and committing one would put a second copy of every number
inside the thing the numbers are derived from. Each prints what it excludes.

**`ops/blueprint.ts`** does not display `docs/ai-os-blueprint.md`. It reads the
roadmap and the `[BUILT]`/`[EXTEND]`/`[NEW]` markers out of it and puts them
beside figures counted from the running process. Where a claim and a count
disagree, the count is the one that is true.

### A denial shown as zero, found by walking the product

The suite was green and the console was wrong. On Communications, an operator's
refused delivery log rendered as **"0 of 0 attempted"** — which reads as "this
tenancy has sent nothing" when the truth is "you may not see this". The refusal
had already been fixed on the table below it and the tile above it was still
lying. Found by opening all twenty-five screens in a browser and reading them,
which is the fourth defect in a row that no test caught.

### The binding invariant, corrected rather than worked around

`consolebindings.test.ts` failed on a *comment*: "`humanise` would render
`OPENAI` as Openai" reads as a call to `render` to a regex. The fix is comment
stripping in the detector, not rewording the prose — a check that fails on
correct comments is a check somebody weakens, and then the `ReferenceError` it
exists to catch comes back. Bindings are still read from the whole file; only
usages are read from the code.

### What is deliberately not on these screens

- **Settings changes nothing.** Every setting is an environment variable on the
  server. A settings page that could write configuration is a page that can
  disable authentication or repoint a payment rail from a browser session, with
  no deployment and no review. System Control reports what this process actually
  received, which is the useful half.
- **No report is a PDF.** The PDF renderer builds *branded customer documents*
  against a project; an operator report has no customer and no project, and
  running one through that path would put a client's branding on the company's
  own internal position. The reports print from the browser.
- **No health score, anywhere.** Customer Value shows four honest columns —
  paid, consumed, headcount, record built — because a score would be the number
  people quoted. "Record built" is labelled as a count of events and not a
  measure of engagement: a tenancy between projects is quiet and perfectly
  healthy.

---

## The blog: a score, a count, and an SEO agent

Three things were asked for and each turned out to be a different kind of claim,
so each is built differently.

**The score is not the gate.** A post is refused publication while any check
fails, with each failure named — that has not changed and is not weakened. What
a score adds is the one thing a gate cannot express: **how far off** a post is.
A gate is binary and gives no gradient, so it cannot tell a post failing one
check by two characters from one failing four badly, and cannot say whether the
blog is getting better. `seoScore` is weighted from the same checks — depth and
the meta description carry most, because those are what decide whether a page
ranks and whether the result is clicked — and it is always rendered beside the
failing checks, never instead of them. The estate average excludes drafts, so
starting to write does not make the blog look worse.

**The view count is a count of requests, and says so everywhere.** `site/views.ts`
records one line per server-rendered request for a published post's page. It is
not a reader count and is never labelled as one: a crawler counts, one person
reading twice counts twice, and nobody is identified — no cookie, no address, no
fingerprint, just a slug and a day. A number that is honest about what it
measures is worth more than a bigger one nobody can defend, and a page for which
no slug resolves records nothing, so a crawler probing for pages cannot
manufacture traffic for articles that were never written.

Views are **deliberately not Golden Thread events**. A page view is not a
governed act, and one line per view on the hash chain would bury the record of
what the company actually did under a stream of traffic. It uses `RecordJournal`
— the same mechanism the ACU wallet uses, for the same reason — as a third file
beside the chain and the wallet. With no journal path set, counts are in-memory
and lost on restart, and the screen reports that rather than letting somebody
discover it when the numbers reset. `recordView` never throws: a post that
failed to render because its counter could not be written would be the analytics
tail wagging the publishing dog.

**The SEO agent is not in the agent fleet, and that is a placement rather than
an omission.** Every agent in `agents/registry.ts` evaluates an `EngineContext`
over a *customer project* — that is what the mandate ladder, the proposal queue
and the autonomy rules are built around. An agent reading a customer's project
to decide what CONSTRUX should blog about would be the account boundary
collapsing in the one direction nobody would think to check. So `auditBlog` is a
command an operator presses, on the platform's own tenancy, reasoning over the
platform's own published posts. It answers two questions: what is wrong with what
is published, and what to write next. It **proposes and never acts** — nothing it
returns is written, published or scheduled — and a proposal can be taken straight
into a draft, which a person still edits and still publishes.

It refuses on the local stand-in, like `draftPost`: an audit produced by an
adapter that reasons about nothing, presented as an audit, is a fabricated
professional opinion about the company's own website. And it publishes its own
limits on its face — no ranking data, no search volume, no competitor data, views
that are requests — because an audit that looks authoritative and is not is worse
than no audit.

**The posts written into the build are not scored.** They predate these checks,
carry no keyword and no meta description, and are deliberately not migrated —
they are the engineering notes this project actually produced. Scoring them
against a standard they were never written to would produce a page of failures
nobody intends to act on and drag the average down with noise. They are handed to
the model as titles instead, so it does not propose an article that already
exists.

### A second exception, argued rather than appended

`doors.test.ts` and `quote.test.ts` both required every AI route to be
project-scoped, with `/v1/site/posts/draft` named as the single exception and a
comment saying a second should be argued for. `/v1/site/posts/audit` is that
second: same surface, same wallet, same operator, refused to everybody else. What
would not belong is a route spending a customer's ACUs with no project to quote
against — which is the failure the check exists to prevent, and both files now
say so.

---

## Document branding: covers, persistence, and a route that authorised nothing

**Every generated document now opens on a cover.** A branded instrument that
opens straight into a table reads as a printout rather than as something issued,
and the four things somebody checks before reading a word — what it is, who it is
for, who issued it, and which document this is — are exactly what a cover is for.
It is always drawn, image or no image: a cover that appeared only when somebody
had a photograph would make the document's shape depend on whether marketing had
one. Without an image it is a band of the client's colour and type.

`ClientBranding` gained `coverEvidenceHash`, resolved through the same
content-addressed path a site photograph takes. That is the point of using the
evidence store rather than a data URI: **the document's own content hash commits
to exactly which image was on its cover.** Swap the image afterwards and the
hash changes and the document stops verifying — correct for something somebody
may have to stand behind. An image the renderer cannot decode is left out and
the cover falls back to type; it never stops a bundle being produced, the same
rule the photographs and the logo already follow.

The cover carries **no running footer**. It has the reference, the legal detail
and the content hash laid out as part of it, and "Page 1 of 5" across a cover
competes with that and prints the hash twice. Content pages are numbered from
two against the true total, so a page pulled out of a bundle still says how much
of the bundle it is. `pdf.test.ts` states that rather than having been loosened
to accommodate it.

### Branding was held in a map and lost on every restart

The same failure as the landing-page pictures, one layer up: configure a
tenancy's identity, redeploy, and every document reverts to
`BRANDING_NOT_CONFIGURED`. Setting branding is a governance act — it decides what
a client-facing instrument says about who issued it — so it is now a
`CLIENT_BRANDING_SET` event on the chain, and `rehydrateBranding()` rebuilds the
read path at boot beside the other rehydrations. The boot banner counts what it
restored.

### `PUT /v1/branding` enforced nothing

Any authenticated identity in a tenancy could change the name, the mark and the
registered legal detail every document goes out under — including instruments a
client, an adjudicator or a regulator reads and acts on. It survived because
nothing had a door for it: the console never offered the button, so nobody
pressed it, so nothing failed. **A capability with no door is not one nobody has;
it is one nobody is watching.**

It now takes `ENTERPRISE_STRUCTURE` update, which only the enterprise
administrator holds, and `branding-authority.test.ts` pins both directions —
the administrator may, the project manager may not. A rule that refuses
everybody is not a permission model.

### The door, and the upload path

The documents screen could read whose identity a document carried and not change
it, so the one thing somebody does after finding it wrong had no button anywhere.
It now has both: a form for the identity and a file input for the cover.
`command()` gained a `method` option, because the platform has PUT routes and
this door could only POST — a configuration route is a replacement, not an
append, and PUT is the honest verb.

Cover images take their own upload route rather than the evidence one. That
route requires an `EvidenceItem` record already naming the hash, because it
exists to supply the file behind something somebody committed; a cover is
configuration, and the branding record is what names it. Type is decided by the
bytes through the same magic-byte table the account pictures and the landing page
use, so an SVG is refused everywhere for the same reason.

**A refusal that cannot fire was removed rather than left in.** The first version
guarded "no identity configured yet" on both cover routes. `createTenant`
establishes an identity at onboarding precisely so an export is never discovered
to be unbrandable when somebody needs one — so neither guard could ever run. A
refusal nobody can reach is worse than none: it reads as cover. What is asserted
instead is what actually happens: with no object store, the upload is refused
with that reason rather than succeeding into memory and vanishing on the next
deploy.

---

## `/demo` — the demonstration page, and booking

### The demonstration was behind the login screen

Everything worth showing — a seeded infrastructure programme carried from
concept to thirty-year operations, twelve identities that each see a different
part of it, a permission model that visibly refuses — sat at the **bottom of the
sign-in panel**. It was wrong in both directions at once: nobody browsing the
public site ever reaches `/app`, so the strongest thing the product has was
behind a door; and every real customer signing in had to scroll past twelve
fictional people to reach the form they came for.

It is now a page, at `/demo`, first in the site navigation as *Try it*, and the
landing page's two call-to-action rows lead with `Try it now` and
`Book a 20-min demo` beside `Start free`. A page rather than a section, because
it is a link somebody sends — into an email, a deck, a post. Not folded into
`/get-started`, because that is the signup form: somebody who wants to look
before signing up is a different person at a different moment, and merging them
makes the demonstration compete with the conversion.

### Two ways in, because there are two questions

**① Start from nothing.** `backend/src/cleanroom.ts` — a second demonstration
tenancy with no project in it and three seats: Workspace Administrator, Delivery
Manager, Team Member. The seeded programme answers *what does a finished record
look like*; it cannot answer *what is it like to put something in*, because
every screen on it is already full. The page says to start as the administrator,
because on an empty tenancy that is the only seat that can create the structure
the other two need. It is credited through `creditFromPayment` like any other
tenancy, so the reasoning engine runs here too — an empty workspace where the AI
refused on an empty wallet would demonstrate the refusal and nothing else.

**② Loaded with a real programme.** The twelve seeded identities, described by
**what each one will put in front of you** rather than by its role code. A role
code means nothing before you have seen the product: "are you the BIM Manager?"
is unanswerable, "design coordination as a record rather than a meeting" is not.
Keyed by role in `DEMO_ROLES`, so renaming a person in the seed does not silently
drop them to the fallback.

Both tracks say what is real and what is not, in four cards: the platform is
real, the AI is on, the project is invented, and it is a shared sandbox — *what
you write is visible to whoever looks next.*

### `/app?as=<email>` — the cards had to actually sign somebody in

Each card is an **anchor**, not a button, because an anchor works with scripting
disabled. So the address arrives in the query string, and `login()` consumes it.
It bypasses nothing: `/v1/auth/login` issues a real challenge and
`/v1/auth/mfa/verify` mints the token, and whether a code comes back at all is
the platform's decision under the rules already recorded above — `devCode`
outside production, `demoCode` only for an account the seed marked. An address
that gets no code lands on the ordinary form with that address filled in and the
challenge kept, so the code already in their mailbox still works rather than
being invalidated by a second attempt. The message says only that the address is
not a demonstration account — never whether it has an account at all, which is
the answer `/v1/auth/login` deliberately refuses to give.

The query is cleared before the attempt, so a refresh, a back button or a link
sitting in somebody's history cannot sign a second person in as the first.

**Clicking a demonstration link while already signed in did nothing at all.**
The shell saw a session, drew the console, and `login()` — the only thing that
reads `as` — never ran; somebody walking the roles would sign in as the first and
find every link after it inert, which is exactly the walk the page invites. The
link now wins: `draw()` drops the session in hand first, including the outbox,
for the same reason `signOut` drops it.

### Booking, and the form that needs no JavaScript

`backend/src/site/booking.ts` computes availability from `config.booking` rather
than storing it — working days, an hour grid, a lead time, a horizon — so there
is no calendar to drift. A taken slot is simply **absent** from the list, which
is why `GET /v1/booking/availability` can be public: the response cannot be read
as a diary of who the company is meeting. `book()` re-checks the slot at the
moment of writing and refuses `SLOT_TAKEN`, so two people on the page at once
cannot both take it.

The form is plain markup posting to `POST /demo`, with slots as radio buttons.
The public site's only script opens the mobile menu; a booking form that needed
JavaScript would be the first thing on these pages that did. The fortnight of
slots folds into a native `<details>` after the first three days — every slot is
still in the markup, so nothing is hidden from a keyboard or a screen reader.

Its schema checks the envelope only — no unknown field, nothing that is not a
string, nothing unbounded — and deliberately carries no `required` or
`minLength`. A schema failure is answered with problem+json, and the person on
the other end of this route is looking at a page in a browser: a blank name has
to come back as a sentence on the form, not as a JSON document filling the
window. The domain refuses each field with a message written to be read.

**Only the JSON route sent a confirmation.** `POST /v1/booking` notified;
`POST /demo` — the route essentially everybody uses — recorded the booking in
silence and left somebody expecting a call nobody knew to make. Both now go
through one `takeBooking` helper that books and notifies through the outbox.

`bookings.js` is the operator's diary, and it leads with **whether a
confirmation can be sent at all**: with no SMTP host the record is still correct
and the person has been told nothing, and that is stated on the screen rather
than discovered by a no-show.

### The page offered a demonstration that had not been built yet

The seeded programme is created lazily, on the first call to
`POST /v1/console/identities`. That was fine while the sign-in screen was the
only thing listing identities — it *asked* for the list and got a seeded one.
`/demo` is a page: it reads what is there. The first visitor to a fresh process
would have been told the demonstration was switched off, on the page whose whole
job is to offer it, and the second visitor would have seen it work. `GET /demo`
and `POST /demo` now await `ensureDemonstrationSeeded` first, memoised per
process by `getOrCreateConsoleSession`.

The unavailable branch distinguishes the two cases, because they need different
sentences: **switched off** names `DEMO_TENANCY_ENABLED` and says nothing is
broken; **not seeded** says the opposite — it is on and it is not there, which is
a fault. Telling somebody a setting is off when it is on wastes the time of
whoever goes to check it.

### The breadcrumb said "undefined › undefined"

`signInWithCredentials` — the path every real customer takes, and now every
demonstration link — never set the enterprise and portfolio names. Only the
demonstration bootstrap did. Two ordinary tenant-scoped reads now supply them,
and a tenancy that has neither yet reads *"no portfolio yet › no project yet"*
rather than a word that means nothing.

**Verified in a browser against a running server**, not only under test: the
clean workspace signs in and lands on the enterprise screen with no project; a
seeded identity lands on the overview with the full crumb; switching between
them works; an address that is not a demonstration identity is refused on the
form with the URL cleaned; a booking confirms with its reference on the page; the
same slot booked twice is refused, and so is a blank name — each as a sentence on
the form rather than as JSON.

---

## Worldwide, multi-project: the hierarchy that makes it true

### Portfolios were attached to nowhere

CONSTRUX is a worldwide platform and `continentCode` on a portfolio was
**optional**. So a portfolio could exist attached to no region at all, and every
view that groups an estate by region had to cope with a blank. A field that is
usually empty is not a region model; it is a column, and nothing can aggregate
on it.

It is now required, from the shared `CONTINENT` vocabulary — the same six
regions the route schema validates against and the picker offers. `countryCode`
stays optional, and the distinction is the load-bearing part: **a portfolio
scoped to one country is a promise that contract law, tax and the working
calendar are common to everything inside it.** One with no country is regional
on purpose and takes any country in its region.

### A project's location was never checked against its portfolio's

The hierarchy is Enterprise → Portfolio → Programme → Project and the portfolio
is the level that carries the geography, so a project's location is a claim
about where in the portfolio's world it is. Nothing enforced it. A portfolio for
Europe would accept a project in Kenya without a word, and every regional rollup
after that — cost by region, risk by region, which jurisdiction's contract law
applies — is wrong in the way that is hardest to find: each record is
individually correct and only the relationship between them is false.

`createProject` now refuses `PROJECT_OUTSIDE_PORTFOLIO_REGION` and
`PROJECT_OUTSIDE_PORTFOLIO_COUNTRY`, both naming the two places involved so the
refusal can be acted on. A portfolio recorded before the region was required
carries none, and is not rewritten: the ledger is append-only and a project
creation is the wrong event to correct a portfolio with.

`geography.test.ts` pins all of it, including the two cases that matter most —
that a regional portfolio accepts Kenya *and* Tanzania, and that a national one
refuses the second.

### "Where you operate"

The enterprise screen had a Region column showing the city and the country code,
which is an address rather than a region: an estate of forty portfolios could
not be read as "we are in four regions and two of them are one project deep".

`enterpriseCommand` now returns `byRegion` — portfolios, projects, countries and
committed value per region, largest commitment first. **A project's region comes
from its portfolio, not from its own location**, because that is the direction
the hierarchy runs and the project's own location is the derived value.

It was first written in the browser, joining `/v1/portfolios` to the estate
rows, and it did not work: a project row carried no portfolio to join on, so
every project landed under "Not stated" while the regions that held them read
zero. Found by looking at the rendered table rather than by any test. The
rollup is a rule about the estate rather than a way of drawing it, so it moved
to the server, where the console's standing rule puts it.

### The demonstration estate spans two regions

One portfolio in one country makes every regional view a view of a single row.
The seed now also builds **East Africa Water Security** (AF, no country — it is
regional on purpose) with the Northern Collector Tunnel at Concept, beside the
European portfolio's two projects. Europe: 1 portfolio, 2 projects, £27.90M.
Africa: 1 portfolio, 1 project, £12.60M. Verified in a browser.

---

## The site: a Construction Manager, a project on site, and traffic management

### There was no Construction Manager

The role did not exist. `SUPERVISOR` records what happened and `PM` runs the
programme, and between them sat nothing — so on a live project a **Project
Manager could see the permit register and issue nothing into it** (the PM holds
read-only on `SAFETY_RAMS`), and the only seat that could was the supervisor.

`CONSTRUCTION_MANAGER` is now a role. It creates *and approves* on safety,
quality and field execution, because issuing a permit and accepting an
inspection are this seat's daily work rather than an escalation; it holds
create on work packages and lookahead, because sequencing the next three weeks
is the job and nothing in the model gave that authority to anybody on site; and
it holds no approval on the programme baseline or on change, because the person
under pressure to hit a date must not be the person who moves it.

It is separate from `SAFETY` deliberately: the construction manager approves the
method statement for the works they are running, and the safety lead approves
the plans that govern the site and holds the CDM duty. One person doing both is
a site where somebody signs off their own controls.

**The seat already existed and the role did not.** `billing/seats.ts` has had a
`CONSTRUCTION_MANAGER` seat at £180/month since the pricing work — a seat priced
and sold for a person the permission model had no role for. `authority.test.ts`
and `billing.test.ts` both caught it the moment the role appeared, which is the
invariant doing exactly its job.

### Traffic management did not exist anywhere

Four site-management documents were absent from the CDM catalogue, and the first
is not a fringe case: the platform could hold a **lifting plan** and not a
**traffic management plan**, on a site where being struck by a vehicle is a far
commoner way to be killed than a dropped load.

- **Traffic management plan** — vehicle and pedestrian segregation first,
  because it is the single control that prevents the commonest fatal site
  accident, and a plan describing routes without the separation between them has
  not addressed the hazard it exists for.
- **Site logistics plan** — compound, storage, craneage, waste, welfare.
- **Underground services plan** — HSG47, sections in the order the controls run:
  records, then locate, then dig safely.
- **Excavation plan** — support, edge protection, surcharge, permit to enter.

They are **authored, not generated**. These carry a site's specific
arrangements — which gate, which route, whose banksman, which utility's records
— and a model does not know any of them. The required sections are the floor the
document is not valid without; the content is a person's.

### The door and the catalogue disagreed

Adding them exposed a second defect: `POST /v1/projects/:projectId/cdm/documents`
carried a **hand-written copy** of the twelve document types, and the two agreed
only because nobody had added a document since it was written. The domain knew
the traffic management plan and the gateway refused it — a document the platform
could produce, unreachable through the only door that reaches it. The enum is
derived from `CDM_DOCUMENTS` now, and `geography.test.ts` fails if the door and
the catalogue ever disagree again.

### A contract that was not won at a tender could never be signed

A contract could only reach `EXECUTED` through `convertBidToContract`, which
needs a locked bid pack. So a **negotiated contract, a framework call-off or a
two-stage deal could be created and never signed** — and the project it governed
could never pass the tender gate into construction. That is a large share of
real work, and the gap was invisible because the demonstration project happened
to come from a tender.

`executeContract` takes `A` on `CONTRACTS_CLAIMS` rather than `C` — signing is
the act that binds the business, and the seat that drafts an agreement must not
be the seat that commits to it — requires the signed instrument as evidence, and
refuses a second execution rather than leaving two signing dates on one
agreement with no way to say which the obligations run from.

### Rossendale: a project actually on site

Field execution, quality and the safety file are gated to CONSTRUCTION and
COMMISSIONING. With Ashworth in Operations and Calderdale at Tender there was no
project on which anybody could issue a permit, approve a method statement or
record a diary — for any role, however senior.

**Rossendale Trunk Main Diversion** is walked to CONSTRUCTION through the real
gates: a scope package, a design maturity assessment, a take-off against a real
drawing, an estimate frozen at settlement, and a negotiated contract signed as a
deed. Nothing is asserted that the platform would have refused — the first
attempt was refused with `PHASE_NO_CHANGE` for asking for the phase it was
already in, which is correct: a transition that moves nothing is a record of a
decision nobody took.

It carries no site history on purpose. The empty diary, the empty permit
register and the empty inspection log are what somebody walking in has come to
fill.

Measured in a browser, on Rossendale against the same screens:

| Role | Field execution | Construction |
|---|---|---|
| Construction Manager | **11/11** | 5/9 |
| Supervisor | 11/11 (was 6/11) | 5/9 (was 3/9) |
| Safety | 7/11 (was 2/11) | 3/9 |
| PM | 6/11 (was 1/11) | 0/9 — correctly: the PM holds read-only on the safety file |

Four projects now: Ashworth (Operations), Calderdale (Tender), Rossendale
(Construction) and Northern Collector (Concept, Africa).

---

## Why none of it appeared on the live site

Two separate causes, and only one of them was in the code.

### The seed adopted and stopped

`getOrCreateConsoleSession` **adopts** an existing demonstration tenancy rather
than seeding a second one — correct, because the memo lives in the process and
the ledger lives on disk, so seeding unconditionally would build a second
Meridian on every restart. But adoption **returned immediately**, so anything
added to the seed after a deployment first ran was never created there.

The asymmetry is what made it invisible. A laptop throws its journal away, so it
reseeds from scratch and shows every addition on the next run. The one
deployment that keeps its journal — the live one — adopts, returns, and shows
none of them. **Development is the environment that cannot reproduce it**, and
both paths look like they worked.

So every addition of the last several commits — the tender project, the site
project, the second region, the Construction Manager — was correct in the repo,
correct in the tests, and would never have appeared on construxvg.com no matter
how well the deploy ran.

`ensureDemonstrationExtras` is now a separate, **idempotent** function: every
block asks whether the thing already exists, by the name or address it would
have been created under, and does nothing if it is there. It runs on both paths
— at the end of a fresh seed, and immediately after an adoption — so a
deployment converges on the same estate whichever way it got there. Anything
added to the demonstration from now on belongs there rather than in
`seedDemoProjectInner`, for the same reason.

**Proven against the actual failure**, not a reconstruction of it: a journal was
seeded with `be28948` — the commit the VPS pulled — producing thirteen
identities and one project. The current build was then started against that same
journal, and it topped up to fourteen identities and four projects across three
lifecycle phases and two regions, without duplicating anything. `seedtopup.test.ts`
holds both halves: it adds what is missing, and a second run adds nothing.

### The live site cannot be reached from the build environment

`construxvg.com` is refused by this environment's egress proxy with a **403
organisation policy denial**, on every request. That is a hard limit, not a
transient failure.

It means **every verification recorded in this document was performed against a
local server in the build sandbox, never against the live deployment.** Where
this file says "verified in a browser", that is what it means. Nothing here
establishes that any of it is live, and it was wrong to let those two things
read as the same claim.

### The Agent Contract, enforced rather than declared

The specification requires every agent to publish twelve fields. Six of them had
nowhere to live: `active_in_states`, `triggers`, `emits`, `confidence_floor`,
`acu_tier` and `memory_access`. They are now on `AgentDefinition`, and two of
them are enforced by the runtime rather than being documentation:

- **The state gate.** An agent whose `activeIn` excludes the project's lifecycle
  phase is skipped and says so in the run report. A tender agent waking on a job
  whose tender closed three years ago reads a dead record and reports whatever it
  concludes with the same confidence as a live finding.
- **The confidence floor.** A finding that states a confidence below the agent's
  own floor keeps the finding and **drops the proposal**. The observation is
  still worth a person's attention; the recommendation is not worth acting on,
  and the run report counts how many were held back.

`emits`, `triggers`, `acuTier` and `memory` are declared and checked but not yet
routed on — trigger-driven wake-up, per-tier ACU metering and memory-scope
enforcement are **not built**, and the fields exist so those can be built against
a declaration rather than a guess.

**Twenty-five lifecycle agents** were added in `agents/lifecycle.ts`, taking the
fleet to fifty-seven. Every agent the specification names by id now exists;
seven of the new ones are `DECLARED` rather than deployed, each naming what it is
waiting on, because an agent that cannot see its inputs is a stub, and a stub
that raises findings is worse than nothing.

`agentcontract.test.ts` is what makes the contract real. It holds every agent to
a lifecycle state that exists, a trigger and an emit that resolve against the
**closed** event catalogue, a confidence floor inside 0–1, no memory layer
written that is not also read, at most three writers of organisation memory,
approval required wherever the output binds the business, and proposals never
wider than reads. The list of agents eligible to act unattended is pinned at one
— the platform-health agent, whose envelope carries a value ceiling of zero —
so widening it is an edit to a test rather than a quiet change.

**What the state gate found immediately.** Six agents were declared out of
lifecycle phases they belong in, and the flagship demonstration project sits in
OPERATIONS, so the gate silenced twenty-eight agents on it at once. The
declarations were wrong, not the gate:

- The **market radar** and the **pipeline** agent are business-level. Gating
  what is out there to win on the phase of whichever project the reader happens
  to have open is simply the wrong axis; both are now `ANY`.
- **Commercial**, **contracts**, **payment**, **claims** and **quality** were
  stopped at handover. The final account is settled after the works finish,
  retention is released in two halves with the second at the end of the defects
  period, latent-defect claims run for years, and the defects liability period is
  precisely when defects appear. Stopping there switched them off exactly where
  the remaining money and the remaining risk are. All five now reach OPERATIONS.
- **HSEQ** and **supply chain** likewise: an operating asset still carries a
  health and safety file and still needs spares.

### The AI Output Standard

The specification states it as a hard requirement and states its enforcement in
the same sentence: *"Responses failing schema validation are rejected and
retried; never shown raw to the user."* Ten fields — summary, evidence, risk
level, commercial impact, programme impact, contract impact, recommended action,
confidence, source references and whether approval is required.

`backend/src/ai/outputstandard.ts` holds all of it, and `runAI` enforces it —
the same choke point that already stamps provenance and refuses AI in the wrong
lifecycle phase. A task declaring `outputStandard: true` gets the instruction
and the response schema built from the field list the validator reads, so a
prompt asking for nine fields against a validator requiring ten is not
expressible.

Three decisions in it are load-bearing:

- **Every impact is a quantity or an explicit null, and always a statement.** "No
  commercial impact: the work falls inside the existing provisional sum" is a
  real finding. A null with no statement is refused, because *"there is no
  commercial impact"* and *"I did not consider the commercial impact"* are
  different answers that become the same record the moment the statement is
  missing. This is the field a model most reliably fills with confident-sounding
  nothing.
- **Source references are records, not prose,** and the resolver is scoped to the
  project's own ledger. "As per the contract" is refused; so is a well-formed
  citation of a record that does not exist. A link that resolves to nothing is
  worse than no link, because it looks checked.
- **Nothing raw escapes.** A first failure is rejected — the hold released
  without charge — and retried once with the failing fields named. A second
  failure raises `AI_OUTPUT_STANDARD_FAILED` carrying the field problems and
  never the model's text; leaking it inside the error would be the same failure
  through another door. One retry, not a loop: each attempt is a charge against
  a customer's wallet.

**Bound to a real command, not left as a library.** `assessImpact` — the
entitlement assessment behind every variation — stored its AI answer as
`String(output.narrative ?? '')`: one unchecked paragraph, on a record somebody
prices a variation off, displayed nowhere. It now runs to the standard and
stores the whole validated answer as `aiAssessment` beside the assessor's own
figures, which are untouched. The provenance stamp records that it was held to
the standard and whether a correction was needed.

**The local stand-in answers honestly rather than refusing.** A deployment with
no reasoning provider configured would otherwise find every advisory task
unreachable. The stand-in answers in the standard's shape with every quantity
null, zero confidence, statements saying plainly that no model was called, and
source references taken from the records the engine declared it was reading — it
will not invent a source. Marked `synthetic` all the way to the screen.

Twenty-two tests in `outputstandard.test.ts`, written against *plausible* bad
answers rather than broken ones: the impact with a figure and no statement, the
amount with no currency, `approvalRequired: "Y"`, the source reference that is a
sentence, the citation that does not resolve, the confidence of 100.

**What is not done.** Only `assessImpact` is held to the standard so far. Every
other advisory task still writes its narrative unchecked, and moving each one
across is a per-task decision — an extraction must not be forced into these ten
fields, or a model will invent a commercial impact for a drawing revision, which
is the failure the standard exists to prevent.

### The thirty-five "missing" events, answered once

The specification's workflow sections name event codes this platform does not
emit, and the count was thirty-five. Adding thirty-five event types would have
been the wrong answer to that number: the Golden Thread catalogue is **closed**
and is the single source of truth for what can happen on a project, so a synonym
in it is not a new capability — it is two codes for one fact, which is how a
register ends up disagreeing with itself.

Each of the thirty-five was checked against the 517 codes already in the
catalogue **and against the code that emits them**, not against the names alone.
Thirty-three were the same capability under a different name. Two were real, and
both had the same shape — a register that could be added to and never closed.

**The two that were real, now built:**

| Spec code | What was missing |
|---|---|
| `RFI_CLOSED` | An RFI went RAISED → ANSWERED and stopped. The register could say a question had been answered and never whether the asker got what they needed |
| `ITP_APPROVED` | A plan could be written and inspected against in the same minute, so an inspection recorded one party checking its own work against its own criteria |

**The thirty-three that already exist, with the code that carries them:**

| Spec code | This platform |
|---|---|
| `DELAY_EVENT_RECORDED` | `DELAYEVENT_RECORDED` |
| `CLAIM_EVIDENCE_PACK_BUILT` | `CLAIM_EVIDENCEPACK_BUILT` |
| `TENDER_SUBMISSION_LOCKED` | `BID_PACK_LOCKED` |
| `TAKEOFF_CAPTURED` | `TAKEOFF_COMPLETED` |
| `SUBMITTAL_SUBMITTED` · `SUBMITTAL_DECIDED` | `SUBMITTAL_RAISED` · `SUBMITTAL_REVIEWED` |
| `RISK_CREATED` · `RISK_ASSESSED` | `RISK_REGISTERED` · `RISK_SCORED` |
| `CONSTRAINT_ADDED` | `CONSTRAINT_RAISED` / `CONSTRAINT_IDENTIFIED` |
| `LOOKAHEAD_CREATED` | `LOOKAHEAD_PUBLISHED` |
| `MEETING_RECORDED` | `MEETING_HELD` |
| `FILE_UPLOADED` | `FILE_INGESTED` |
| `ASSET_CREATED` | `ASSET_REGISTERED` |
| `REVISION_SUPERSEDED` | `DRAWING_SUPERSEDED` |
| `CERTIFICATE_RECORDED` | `PAYMENT_CERTIFIED` / `COMPLETION_CERTIFICATE_RECEIVED` |
| `ADDENDUM_RECEIVED` | `TENDER_ADDENDUM_ISSUED` |
| `CVR_SNAPSHOT_APPROVED` | `CVR_PUBLISHED` |
| `TECHNICAL_RESPONSE_ISSUED` | `RFI_ANSWERED` |
| `TECHNICAL_DECISION_ACCEPTED` | `DECISION_RECORDED` / `DESIGN_ACCEPTED` |
| `STAGE_VALIDATED` | `STAGE_GATE_DECIDED` |
| `CHANGE_EVENT_CREATED` | `CHANGE_REQUEST_SUBMITTED` |
| `WORKFORCE_BRIEFED` | `TOOLBOX_TALK_DELIVERED` |
| `TRAINING_SCHEDULED` | `TRAINING_NEEDS_DEFINED` / `TRAINING_GAP_PLANNED` |
| `WARRANTY_ACTIVATED` | `WARRANTY_REGISTERED` |
| `READINESS_UPDATED` | `COMPLETION_READINESS_CHECKED` / `TEST_READINESS_CHECKED` |
| `ACTION_ASSIGNED` | The specific ones: `MEETING_ACTION_CLOSED`, `INVESTIGATION_ASSIGNED`, `DELIVERABLE_ASSIGNED`, `COORDINATION_ISSUE_ASSIGNED` |
| `COMPLIANCE_MATRIX_CREATED` | `ITT_ANALYSED` — the matrix is the analysis |
| `TRANSMITTAL_ISSUED` | Built: `informationcontrol.issueTransmittal`, `POST /v1/projects/:projectId/transmittals` |
| `INFORMATION_VALIDATED` · `CDE_WORKFLOW_APPROVED` | The CDE ladder in `domain/designplan.ts` — WIP → Shared → Published → Archived, with the check rule beneath it |
| `PAYMENT_RECONCILED` | `cost.postPayment` posts against the certificate; the Construction Act engine derives paid-versus-notified, late payment and the s.112 suspension right from it |
| `PRODUCTIVITY_ANALYSED` | Derived in `planning.ts` against the baseline rather than stored — a figure that recomputes cannot go stale |
| `RESOURCE_DEMAND_UPDATED` | The procurement schedule in `domain/conceptstrategy.ts`: lead time against the required-on-site milestone |

This is recorded as a table rather than a sentence so the question is settled.
Re-deriving it costs half a day and produces the same answer.

### The screen that refused the person whose registers it holds

Found by signing in as each demonstration role in turn and walking the product,
which is the only way this class of defect surfaces — every test passed, and
still does.

A navigation entry declared **one** capability area, and the shell refused the
whole screen to anybody without read on it. The Construction screen holds the
five registers a site runs on — permits, method statements, inductions,
inspection plans, non-conformances — and was gated on `SAFETY_RAMS` alone. So
the **QA/QC engineer**, who owns the quality half of that screen and holds
create, update *and approve* on `QUALITY_COMMISSIONING`, was refused the entire
page, with a reason naming an area they have no business holding. The comment
above the entry already said "the quality half of the screen authorises itself
separately, panel by panel" — the panels did; the door did not.

A nav entry may now declare `alsoArea`, and the rule is **any, not all**: a
screen is reachable by anybody who can read any part of it, and each panel
inside authorises itself as it already did. The lock reason names every area
that would have opened the screen rather than only the first, because "no read
access to SAFETY_RAMS" sends somebody to ask for the wrong thing.

**Verified in a browser, per role, on two projects.** As the QA/QC engineer on
the Operations flagship every quality action is locked and says *"Quality
commissioning cannot be written during the Operations phase"* — a phase reason,
not a role reason. Switching to Rossendale, which is in Construction, opens
"Create an ITP" and "Raise a non-conformance", while "Record an inspection"
stays shut and says why: nothing can be inspected against a plan the other side
has not agreed. That is the whole point of the ITP approval built above, and it
is now the difference between a locked button and an explained one.

**Six more of the same, found by sweeping rather than by looking.** Once the
Construction case was understood it became checkable, so every role was run
against every screen, reading the areas each screen actually gates its panels on
out of the screen's own source. Six more screens refused one of their own
writers:

| Who | Could not open | Holds writes on |
|---|---|---|
| Site supervisor | Programme | Work packages and the lookahead — Last Planner is their tool |
| Principal designer | Field Execution | RAMS. CDM duties do not stop at the design |
| Principal designer · designer · BIM | Change & Claims | Design information — the half of that screen that *starts* a change |
| BIM manager | Tender & Procurement | Take-off. Measuring quantities from the model is the job |
| Supplier | Tender & Procurement | Their own submission — the screen that takes their return |

All six now declare the areas they serve. **Reachability is a floor, not an
authority**: every panel and every action still authorises itself against the
matrix, which is what makes widening a gate safe rather than a way round the
permission model.

`navreach.test.ts` holds it closed. For every role and every screen: if the
reader holds a write on an area the screen offers actions in, the gate must let
them in. The areas are read from each screen's own `can('AREA'` calls rather
than a list maintained beside them, because a hand-maintained list is what would
drift back into the bug. The one exemption is named and argued: platform
operators are barred from customer delivery data by construction, so being
refused the project Autopilot is the model working.

### One unguarded call, one blank page

Found by the same method: every demonstration role, driven through all
twenty-five screens in a browser — 325 page loads, zero JavaScript errors.

`enterprise.js` fetched eight things and caught seven of them. The eighth,
`/v1/enterprise/command`, is *correctly* refused to any role below enterprise
level, so for a project manager, planner, QS, engineer or supervisor the refusal
threw before the first element was drawn and the Enterprise & Portfolio screen
rendered as an empty page. No error, no explanation, nothing — on the screen
that carries the enterprise → portfolio → region → project structure this
platform is built on.

It now catches, and renders what the reader can legitimately see: where the
business operates by region, the portfolios and which enterprise each belongs
to, and the lifecycle gates every project is held to. None of it is commercial.
The refusal is shown as a refusal, naming the authority that would open the rest
— which is what `frontend/lib/command.js` has always done for a write, applied
at last to a read.

**Verified per role in a browser.** As the project manager the page goes from
773 characters of nothing to the full structure: two regions, both portfolios
with their enterprise and country scope, and all seven gates with their exit
criteria.

### Trigger routing, enforced

The Agent Contract's `triggers` was the last of the twelve fields that was
declared and read by nothing. Every agent said what wakes it, and the fleet had
exactly one mode: run all forty-eight and see what they say. An agent whose
whole purpose is to answer `DELAYEVENT_RECORDED` woke on the same schedule as
one watching the market, and the only way to ask *something just happened, who
cares about it* was to ask everybody.

Three modes now, and the distinction between the first two is the whole design:

- **`SWEEP` still runs the entire deployed fleet.** It is a person, or the
  morning briefing, saying *look at everything now*, and that is what the
  request means. Narrowing a sweep to `CONTINUOUS` agents was the obvious
  implementation and would have silently switched eighteen agents off the one
  path the console and the briefing both use — a regression dressed as a
  feature. A test pins it.
- **`EVENT` is the new capability.** Only agents that declared the code run.
  Measured on the demonstration estate: a delay event wakes 2 agents of 48, a
  CVR publication wakes 1, a submitted application wakes 1. An event nobody
  declared wakes nothing at all, and costs nothing.
- **`SCHEDULE`** matches the hour an agent named, and the days where it named
  any. A tick that does not say which day it is runs every agent for that hour
  rather than guessing — guessing there means a Monday agent that silently never
  runs.

A person naming agents is never routed. The contract lists `ON_DEMAND` so the
declaration is complete, not so the runtime can refuse somebody who asked.

**`runAgentsForChanges` is what makes it a behaviour rather than a parameter
nobody passes.** It reads the events since the last agent run on the project and
routes on them, so "what has changed, and who cares" is derivable rather than a
judgement. The re-entrancy risk is real and closed twice: a run writes
`AGENT_RUN_COMPLETED` and one `AGENT_PROPOSAL_RAISED` per finding, so every
`AGENT_*` code is excluded from the window, **and** a test asserts no agent
anywhere declares a trigger on one — a filter is easier to relax than a test is
to delete. Proved rather than asserted: a second pass immediately after a first
finds an empty window and runs nothing.

Every agent in a report now says *why* it is there. A run listing four names out
of forty-eight has to read as a deliberate selection rather than a fleet that
mostly failed to appear, and an agent the event woke that the lifecycle gate
then declined is counted separately — "the event happened and the agent for it
cannot run in this phase" is a gap somebody may need to close; "no agent watches
that event" is not.

Reachable at `POST /v1/projects/:projectId/agents/run` with an optional
`trigger`, and `POST /v1/projects/:projectId/agents/run-changes`.

### The AI rate is 5×

Stated by the business as two halves of one rule: **provider cost is charged at
five times, and every £1 the platform spends with a provider must produce £5.**
It was 4×.

One value moved — `ACU_MARKUP_MULTIPLIER` — and everything downstream followed
without an edit, which is what deriving rather than hardcoding bought: the
wallet's charge, the quote a screen shows before spending, the invoice line, and
the ACU bundle catalogue (£300 now buys 6,000 ACUs, £1,000 buys 20,000, £2,500
buys 50,000). The volume band table is flat at 5× for the same reason it was
flat at 4×: there is no rate below the headline anywhere in the platform.

**The loss floor is the price too**, at 400% required profit: there is no case
in which £1 of provider cost produces less than £5. That was queried before it
was set, because it costs the estimate cap — `settle` capped an overrun at the
disclosed hold unless the cap would sell below the floor, and with floor equal
to price the cap can never win. Confirmed as intended, so an execution that
costs more than its estimate is charged for what it cost and the entry says so
in those words. Disclosure replaces the cap; `billing.test.ts` asserts the note
rather than treating it as decoration.

### ACU tier metering, and the memory boundary

The last two contract fields that nothing read.

**`acu_tier`.** Five agents carried hand-written estimates — 40, 50, 60, 75 —
chosen individually, unrelated to each other and unrelated to the rate the
platform actually charges. An approver comparing two proposals was comparing two
guesses, and the figure on the approval screen was one nothing else in the
platform agreed with. It was also a hardcoded business value, which the standing
rule forbids.

A tier is now a claim about what class of thinking a run is; the price of that
claim lives in `billing/acu.ts` with the rest of the money model and is
`tierCost(tier)` — provider cost from configuration, multiplied by the same 5×
markup as every other AI charge, so a tier cannot become a second pricing model.
The runtime **overwrites** what an agent wrote rather than defaulting it, because
an agent that could fill the field in would be quoting an approver a number of
its own choosing. At the current rate: LOW 10, MED 50, HIGH 150, PREMIUM 450.

Each run now reports what the queue it just built would cost, broken down by
tier, against the wallet's available balance. **Reported, not charged** —
evaluating an agent calls no provider and costs nothing, and inventing a charge
for it would be inventing revenue. What costs money is the command an approved
proposal runs, and this is that bill before anybody presses it.

**`memory_access`.** The three layers differ in blast radius rather than in
shape: project memory is this job, organisation memory is every job the business
has ever run, and what an agent learns from the second it applies to jobs whose
teams never chose to share anything with it. Crossing between them means leaving
`projectId` behind, so the boundary is exactly the ledger calls that do —
`listByTenant`, `entitiesOfType`, and a tenant-wide event read. An agent that has
not declared `ORGANISATION` now gets a refusal naming what it declared.

**Stated plainly: today this constrains nothing.** No deployed agent reads across
projects — every one works from `list(ctx.projectId, …)`. The guard is here so
the first agent that does meets a refusal it has to declare its way past, rather
than finding the door open. Thirty lines now against a retrofit after an agent
depends on the access.

Both controls were verified by mutation rather than by watching them pass:
disabling the memory guard fails three tests, and disabling tier pricing fails
four.

**What is still not enforced, and why.** `memory.writes` is declared and checked
for consistency — no agent writes a layer it cannot read, at most three write
organisation memory — but not enforced at runtime, because **an agent cannot
write at all**. Rule 1 of the runtime is that an agent returns findings and the
runtime records them. Enforcing a write scope over a thing that cannot write
would be building for a requirement that does not exist.

### Five packages, and a trial that ends

**Solo, £100 a month.** The entry package between a trial and Core Project: one
identity, 30 GB, 2,000 ACUs a month, branded export, no API. There was nothing
between free and £950, which is a long way to ask a sole trader to jump.

Export is on, and that is a judgement rather than something the price dictates: a
sole trader paying every month whose output cannot leave the platform has bought
a filing cabinet, because the branded document *is* the product. What separates
Solo from Core Project is seats, storage and AI — one person against ten, 30 GB
against 100, 2,000 ACUs against 19,000 — which are the axes a growing business
actually crosses.

**The trial is one identity and 1 GB**, down from three and 5 GB. A trial is one
person deciding whether to buy; three seats is a small team working for free, and
the seat count is what separates the two.

**And it now ends.** *"Once"* was already enforced — one grant per email address,
at registration — and *"thirty days"* was enforced nowhere. `renewsAt` was set
thirty days out, the operator's forecast **warned** that a trial was ending, and
nothing ever ended it: an ACTIVE trial stayed active for ever, so a free tenancy
could run the platform indefinitely on a warning nobody had to act on.

`standing()` now derives `EXPIRED` for a trial past its renewal date. Derived
rather than written back onto the subscription, because writing it back needs a
clock somewhere flipping records, and a scheduled job that fails silently gives
exactly the behaviour being fixed. The record stays **readable** — the evaluation
was real work, and taking it away at the moment somebody is deciding whether to
buy is how they decide not to — while writes, AI and export close. Topping up
stays open: refusing a customer's money as they decide to buy is the one refusal
in that file with nothing behind it.

`renewsAt` means different things on a trial and on a paid package, so the gate
is on `tier === 'FREE_TRIAL'` and a test asserts a paid subscription is untouched
on its renewal date — reading the field the same way for both would cancel every
paying customer monthly.

**20% of the price as monthly ACUs, on every package.** Already the rule and now
asserted per package rather than in general: Solo 2,000 · Core Project 19,000 ·
Professional Delivery 44,000 · Enterprise 130,000, with the test covering every
key of `PACKAGES` so a new package cannot arrive without a figure. One ACU is one
minor unit, so the ACU count is exactly 20% of the price and does not move when
the markup does — what the markup changes is how much provider work those ACUs
buy, not how many there are. The trial's 500 is a one-off grant, not an
allowance: 20% of nothing is nothing, and a monthly allowance on a free package
is a free platform.

Two figures on the public pricing page said "1 seats" and "1 identities" the
moment a one-seat package existed. Both fixed — it is the page where somebody
decides whether this is a serious product — and the trial card now states its own
material terms: one per account, 30 days.

### Four top-ups, and a published figure that was wrong

**A fourth bundle, at £50.** The ladder started at £300 and was built when the
cheapest package was £950. With the cheapest now £100, a Solo customer who ran
out of AI in week three had to spend three times their monthly subscription to
carry on — which is not a top-up, it is a reason to stop using the product. £50
credits 5,000 ACUs, two and a half times a Solo month's allowance.

**And the figure the bundles published was measuring the wrong thing.** A
package advertises "19,000 ACUs of AI included each month", which is the wallet
credit: 20% of £950 is £190, and one ACU is one minor unit. A bundle advertised
"£300 (6,000 ACUs)" — which was the *provider work* that credit funds, price
divided by the markup. Both were called ACUs, on the same site, next to each
other.

So a £300 bundle credits **30,000** ACUs and said 6,000, understating itself
fivefold against the package beside it. A customer comparing the two would
conclude a £300 top-up buys less than a third of a Core Project month when it
actually buys more.

The two only ever looked consistent because the allocation is 20% and the markup
is 5×, so both worked out at price ÷ 5 — the coincidence is what hid it, and it
survived the 3×→4× correction and the 4×→5× move untouched because deriving the
*wrong quantity* correctly still gives the wrong answer.

`usableAcus` is now the credit, on the same basis as every other ACU figure the
platform publishes. What the credit funds in provider work is a real number and
is kept as `providerCostMinor`, under a name that says what it is rather than
borrowing one that means something else.

| Top-up | Price | Credits | Funds |
|---|---|---|---|
| Solo | £50 | 5,000 ACUs | £10 of provider work |
| Starter | £300 | 30,000 ACUs | £60 |
| Growth | £1,000 | 100,000 ACUs | £200 |
| Scale | £2,500 | 250,000 ACUs | £500 |

Every bundle is the same value per pound — the multiplier is flat — so a bundle
is a convenience rather than a discount, and nothing in the product implies
otherwise.

### Inviting somebody onto a project

A construction project is not staffed by one organisation. The designer, the
temporary works engineer, the client's representative, a specialist
subcontractor's own QS — every one of them needs to be on the job, and the
person who knows they are needed is the project manager working beside them, not
the enterprise administrator at head office who has never heard of them.

Only `ENTERPRISE_ADMIN` and `OWNER` could create a person at all, so adding a
designer for two weeks meant a request up the chain. That friction has a known
workaround and it is the failure this exists to prevent: one login, several
people, and an audit trail that attributes every act to whoever the account is
named after. On a platform whose whole claim is that the record says who decided
what, a shared credential is not an inconvenience — it is the product not
working.

Three rules, each tested by the case that breaks it.

**Who may invite is "somebody working on this project", not "somebody who can
see it".** A regulator reads more of the project than most of the delivery team
and delivers none of it; a supplier answers an enquiry. Neither should be able
to add people to a contractor's tenancy. The test is whether the inviter holds a
*write* on any delivery area — derived from the permission matrix rather than a
second list of "roles that may invite", which would disagree with it the first
time a role changed.

**A seat is held from the moment the invitation is sent, not when it is
accepted.** Otherwise ten seats absorb fifty invitations, everybody is told they
are on the project, and the eleventh person to click the link is refused — by
which point a person outside the business has been promised something the
business cannot give them. The cap is checked against assigned identities *plus*
outstanding invitations, and withdrawing one gives the seat back.

That rule is the reason this section exists, and the first version of the test
did not prove it: the one-seat case refuses because the seat is already
*assigned*, which would still refuse if invitations held nothing. Caught by
mutation — removing the pending count left all seventeen tests passing. The test
now fills a ten-seat package with one identity and nine invitations and asserts
the eleventh is refused, which fails the moment the rule is removed.

**An external invitee can never be granted administration of the tenancy.**
Inviting a subcontractor's engineer onto a job is normal; making them an
administrator of the main contractor's platform is a takeover, and it is the
kind of thing that happens by picking the wrong item in a list. `ENTERPRISE_ADMIN`
and `OWNER` are refused for anyone marked external — the same roles are fine
internally, because that is an ordinary appointment.

An invitation lapses after fourteen days and gives its seat back. One that stood
for ever would be a seat nobody can account for and a link that still works a
year after somebody left.

Reachable on the Enterprise & Portfolio screen, which shows who has been invited,
by whom, from which organisation, and the seat position beside it — assigned,
held by invitations, and how many are left. The invite button is shut with that
arithmetic in the reason when the package is full.

### Taking the subscription, and stopping when it does not arrive

`renewsAt` was set thirty days out at signup and moved by nothing. The
operator's forecast **warned** that a renewal was approaching;
`monthlySubscriptionCharge` could state what a period was worth; and no code
anywhere raised the charge, took the money, or noticed it had not arrived. A
customer could sign up, use the platform for a year, and never be asked for a
penny — the only signal a warning nobody had to act on. It is the same shape as
the trial that never ended, one level up.

Four steps, each a separate recorded fact, because collapsing them is what makes
a billing dispute unanswerable:

1. **Raise.** The period falls due, the charge is written with what is owed and
   when, and `renewsAt` advances. Idempotent per period — a scheduler that fires
   twice must not bill twice, and the renewal moves whether or not the money
   arrives, or the debt would be the number of times the scheduler ran rather
   than the number of months owed.
2. **Attempt.** Collection is tried, and the outcome is recorded either way.
3. **Grace.** Seven days, configurable. Most late payments are not refusals — a
   card expires, a finance team is on holiday, a bank holds a transfer — and
   cutting a customer off the hour a payment is late costs more than it saves.
4. **Stop.** Past grace, the subscription is suspended through the same governed
   path an operator's decision takes: evidence, a reason, a named decider. A
   test asserts the suspension actually reaches `standing()` and closes writes,
   AI and export, rather than trusting the two are wired together.

Paying puts it back automatically — but **only when nothing else is
outstanding**. A tenancy two periods behind that settles one has not caught up,
and reinstating it there would let somebody stay live for ever by always paying
the oldest invoice.

**What is not built, stated rather than implied.** There is no stored payment
method and no off-session charge: this platform holds no card. `attemptCollection`
therefore cannot debit anybody and does not pretend to — it asks the configured
collector, and the default answers *"no payment method is held for this
tenancy"*, which is the truth and is what lands on the record. What settles a
charge today is a payment recorded against it, by the Stripe webhook or by an
operator recording a transfer. Everything after that point is real: the charge is
raised automatically, the clock runs, and the tenancy stops. Wiring a card is
replacing one function — the `Collector` port exists for exactly that — not
building the cycle.

**The platform is not its own customer.** The operator tenancy exists from
process construction, before any `createTenant`, so it has an in-memory
subscription and no `Subscription` entity in the ledger. A run iterating every
tenancy would have raised a charge against the company itself and, seven days
later, suspended the platform for not paying itself. The ledger record is what
tells a tenancy somebody signed up for from the one the process was born with.

The timer is **off by default** (`SUBSCRIPTION_COLLECTION_ENABLED`). A billing
cycle that starts itself on a laptop, or on a staging box restored from a
production journal, raises charges against real tenancies, so arming it is a
deliberate act on a deployment. It runs hourly rather than daily because of the
grace window rather than the billing: a tenancy whose grace ended at 09:00 should
not keep working until midnight, and a customer who paid at 09:05 should not wait
a day to get their platform back.

### The common data environment

The platform could plan information, review it, issue it and store its bytes,
and it could not say which revision of a drawing was current. Every part
existed except the thing they were all about:

- a **deliverable** (`domain/designplan.ts`) is a promise that a drawing will
  exist by a date;
- a **review cycle** (`engines/designreview.ts`) is a decision about one;
- a **transmittal** (`domain/informationcontrol.ts`) is a record that documents
  were sent to named people;
- the **evidence store** holds the bytes against a hash.

None of them is the drawing. What was missing was the **container** — this
file, at this revision, at this state, superseding that one — and without it
"the current revision" was whatever the last person to email one believed.

`domain/cde.ts` is that record. Four rules make it a single source of truth
rather than a shared folder, and each has a test that fails when the rule is
removed — verified by mutation, not by watching the suite go green.

**A new revision supersedes the old, in the same act.** Not a tidy-up somebody
does afterwards. `publishContainer` writes `CONTAINER_PUBLISHED` and
`CONTAINER_SUPERSEDED` together, so at the instant it returns there is exactly
one current revision of a reference and every older one says what replaced it.
There is no window in which two are both current, which is the whole mechanism
behind everyone working from the same file.

**Three roles, three people.** Nothing is shared without a checker who is not
the author, and nothing is published without an approver who is neither. A
ladder one person can climb alone is a folder with extra steps, and "published"
would then mean only that the author had stopped working on it.

**A container holds a file.** The evidence hash is required at deposit and
filed through `registerEvidence`. A container with no file is a promise, which
is what a deliverable already is — two records for the promise and none for the
document is how a register comes to show a hundred per cent against an empty
folder.

**Suitability is not state.** ISO 19650 suitability says what a container may
be *used* for, and it is separate from where the container sits. S3 — issued
for review and comment — and A1 — authorised for construction — look identical
on a title block, and a revision published at S3 is current, approved, and not
something to build from. `buildableFrom` answers the foreman's question as one
thing rather than two: the current revision *and* whether its code authorises
building, with the reason in a sentence.

Deposit enters at `WIP` and `S0` whatever anybody asks for; nothing arrives in
the environment already authorised.

**Published here, and never sent to anybody.** The join that neither register
could make alone. Publishing changes the environment; a transmittal is what
reaches the person in the cabin. A revision approved and never issued appears
in neither register on its own — the transmittal record has no row for a
document nobody sent — so `register()` reads the transmittals and names them.
Derived rather than flagged on the container, so it cannot drift from the
issuing record it is a statement about.

Reachable on Design & BIM, above the issuing and acknowledgement panels so the
screen reads environment → issue → receipt. Four commands (deposit, check and
share, approve and publish, withdraw) and one chooser for the buildable
question. The demonstration project carries four containers in three positions
deliberately — C-1001 P03 at A1 with P02 superseded beneath it, M-2100
published at S3, S-3000 still with its checker — because a register where
everything is published demonstrates nothing.

Three things this closed on the way, each a defect rather than a feature:

- **Two definitions of the CDE states.** `engines/designreview.ts` declared its
  own `['WORK_IN_PROGRESS', …]` beside `domain/designplan.ts`'s
  `['WIP', …]`, with a note saying it stood in "until containers carry their
  own". They now do, so the engine re-exports the canonical one. Two
  vocabularies for one ladder inside a CDE would be a poor joke.
- **The Design & BIM screen was gated on `BIM_TWIN` alone.** The CDE, the
  review cycle, the RFI register, submittals and the drawing register are all
  `DESIGN_INFORMATION` — so the architect who authors every container on the
  project could not open the screen holding them, while the BIM coordinator
  could. Found by opening the console, not by a test.
- **`positionReport` rendered a string section as nothing.** A string fell
  through to the table branch, `columnsOf` found no keys on it, and the panel
  showed a label, a count of one and an empty body. Live on Project Control's
  reconcile lookup, where the two hashes a person is there to compare were both
  blank. Handled beside the number and the boolean, where it belonged.

### Counting failed sign-ins against the identity, not the connection

Between an attacker and an account there was one control: a rate limit of
twenty auth requests a minute, keyed by remote address for anybody not yet
holding a token. Against one machine hammering the door that is a real control
— it caught a single-host run when this was tried against a live server.
Against the thing it is usually facing it is none at all, because rotating
addresses is not an evasion of an address-keyed limit; it is the entire design
of the equipment being used.

Underneath it, worse, and measured rather than assumed:

```
wrong codes accepted without the challenge dying: 100000
the real code still works afterwards: true
```

A one-time code is six hex characters — sixteen million of them — and its
challenge accepted unlimited free guesses for its whole five-minute life.
Sixteen million codes with unlimited free attempts is not sixteen million
codes.

`identity/lockout.ts` and the attempt cap in `verifyMfaChallenge` close it.

**A challenge dies after five wrong codes.** Past what a person mistyping will
do, short of anything useful to a machine. The honest answer for the sixth is
a fresh code: one click for the person, the whole run for the attacker.

**The identity is counted, not the connection.** A per-challenge cap alone is
beaten by asking for a new challenge, so the count is keyed to the account and
survives across challenges — and across addresses, which is the point. A run
spread over a thousand addresses is a thousand unremarkable rate-limit keys and
one account being attacked, and only the second of those is worth counting.
Ten failures in fifteen minutes and the account stops answering, correct code
included. Through the gateway, the whole run now gets ten guesses out of
sixteen million.

**The lock is silent.** `identity/signup.ts` returns an identical receipt
whether or not an address is in use, and login answers an unknown address with
a decoy challenge, both so nobody can sort a leaked address list into customers
and strangers by asking. A refusal that said "locked" would hand that back,
because only a real account can be locked — so a locked identity fails with the
same `MFA_FAILED` body a wrong code produces, asserted field by field against
a stranger's address. The person who owns the account is told through the one
channel that reaches them and nobody else: `account.locked`, which had been in
the notification catalogue since the engine was built with nothing raising it.
Once, on the transition — otherwise the lock becomes a way of posting a
thousand emails at the person it is protecting.

**The lock lifts by itself, and lifts clean.** A lock somebody has to clear is
a denial of service anybody can perform on anybody by failing their sign-in ten
times, and a locked project manager cannot approve a payment. Fifteen minutes
takes a sixteen-million-code space from days to centuries. It lifts with the
count at zero rather than at the threshold, which would otherwise re-lock on
the next single mistake — a permanent lock with extra steps. A successful
sign-in clears the count too, since proving you hold the account is the
strongest evidence the failures before it were your own typing.

Every one of these was mutation-tested: removing the attempt cap, the lock
check, the clear-on-success, the expiry, the window, the once-only transition,
or the identical refusal each fails a test.

Operator-visible on Audit logs, above the security stream: who is locked right
now, how many attempts, and how long until it lifts — because "somebody rings
up unable to sign in" is the question actually asked, and reading it backwards
out of a scrolling stream means hoping nothing expired in between. Locks are
process memory, like the rate limiter's buckets: operational state about the
last few minutes, not a fact about the business, so a restart forgives
everybody. Stated rather than hidden — what a restart must never forgive is a
ledger entry, and none of this is one.

**What this is not.** It is credential-stuffing and brute-force defence at the
sign-in step. Device binding, risk-based step-up and passkeys are still not
built (item #116), there is no proof-of-work or CAPTCHA on the public signup
surface, and the address-keyed limit remains in-process unless a shared store
is configured. Naming them here rather than letting "enterprise-grade access"
stand for more than was built.

### Reading the invitation to tender

`analyseITT` could produce a compliance matrix, a term assessment, a quantified
exposure and the questions worth putting to the buyer — from a requirement list
handed to it **as an argument**. So the platform could analyse an invitation it
had never seen, and somebody had to type ninety numbered clauses out of a PDF
before any of it ran.

That is the half-day the bid team actually loses, and it is the half where
things get missed. The requirement nobody typed is the requirement nobody
answers, and it surfaces at the evaluation as a non-compliance.

`ITT_REQUIREMENTS` is a perception task, which puts the boundary in the right
place rather than adding a second way into the tender register.

**The model reads; it does not judge.** Requirements come back as the document
states them — reference, category, mandatory or scored, weighting, the evidence
demanded, any date earlier than the return. Whether the business can meet one
stays with `analyseITT` and the company profile; whether to chase the job at
all stays with the bid/no-bid algorithm. One model asked to do all three would
produce a confident recommendation with no working behind it.

**What the document does not state is not invented.** An ITT names its return
date and its contract form. It does not name what this business expects to
price the job at, or over what duration — those are commercial judgement and
they are supplied by the person confirming. Refusing without them is tested:
the same division `VOICE_NOTE` draws when it will not let a transcript name its
own observer.

**A reading is a draft.** Confirming runs `analyseITT` and then
`extractRequirements`, which is exactly what a person typing the clauses would
have run — same authorisation, same ACU cost, same events. Machine-read data
still gets no private door into the register.

The confirmation answers what a bid manager asks first rather than reporting
that a matrix exists: which mandatory requirements have no evidence behind
them, which terms are a **bar** rather than a negotiation, the quantified
exposure, and whether the thing is ready to price at all. On the test
invitation — NEC4 Option A with fitness-for-purpose design liability and
unlimited consequential loss under a Z-clause — it comes back `readyToPrice:
false` with the bars named.

Every control is mutation-tested: dropping the commercial figures, loosening
the empty-reading guard, or short-circuiting the deliverable register each
fails a test.

**It refuses where nothing can see the document.** The local adapter declares
`multimodal = false`, so in a deployment with no vision provider the task is
refused rather than answered from a hash — a true statement about the
deployment instead of a false one about the tender. That refusal is tested too.
The remote adapters are written to both vendors' documented multimodal shapes
and exercised here against a stub; no call to a live provider has been made
from this environment, and nothing above should be read as saying one has.

### Word as well as PDF, and both metered

A PDF is the right thing to **issue** and the wrong thing to receive when the
next step is somebody's tracked changes. A quality plan a client comments on, a
contract a solicitor marks up, a method statement a subcontractor adds their
own sequence to — every one of those left this platform as a PDF and came back
as a retyped copy, and the retyped copy is the one that goes out of step with
the record.

So the choice is the customer's, per document: `format: 'PDF' | 'DOCX'`.

**Both render from one `ExportDocument`.** The blocks, the branding, the
redaction notice and the attestation are fixed before either renderer sees
them, so a Word file and a PDF of the same document carry the same
`contentHash` and are provably the same instrument in two forms. A second
document model per format would have been two chances to disagree.

**It is a real Word package, not HTML with a `.docx` extension.** That trick
renders in Word, fails in Google Docs, and produces a file whose tracked
changes nothing can merge. `export/docx.ts` writes WordprocessingML: styled
paragraphs, real tables with borders and a repeating header row, a numbering
definition for lists, and images as `w:drawing` with their own relationships.
Written by hand because zero runtime dependencies is settled — `node:zlib`
deflates and the ZIP headers are a few dozen bytes of little-endian fields,
the same argument that produced `export/pdf.ts`.

Verified by reading the package back apart rather than by trusting the writer:
the required parts are present, every `r:embed` resolves to a relationship,
every `w:numId` has a numbering definition, every `w:pStyle` has a style, and
`w:sectPr` is the last child of the body with the page size inside it — which
is what stops Word showing a client the "this document is damaged" repair
dialog. An independent reader (`python-docx`) opens the output and reads back
the headings, the styles and a 3×3 table.

LibreOffice is installed in the build container and is broken — it cannot
convert a plain text file — so it was used for nothing here, and no claim above
rests on it.

**Rendering is charged, in either form.** Generation was metered and *issuing*
was free, so a tenancy could take five hundred branded reports out and the ACU
statement would show the writing and none of the leaving. That is the wrong way
round for the thing that actually leaves the building: a rendered document
carries the customer's branding, their client's name, the redaction decision
and the attestation hash, and it is the artefact a dispute is argued over.

- **One price for both forms**, from `config.billing.documentRenderRawCostMinor`.
  Charging differently would be charging for the file extension, and it would
  push people towards the form that suits the bill rather than the job. The
  hold *and* the settlement are asserted equal — comparing only the final
  charge let a mutation that tripled the Word hold pass, and the hold is what
  refuses a render.
- **Reserved and settled**, through the same wallet path every other charge
  takes, so a render appears in the statement with `module: 'EXPORT'` and
  `feature: 'document_render_docx'` beside everything else.
- **A failed render bills nothing.** The hold is released and nothing settles,
  so a customer is never charged for a document they did not receive.
- **Quoted before the button.** `GET /v1/exports/render-quote` gives the price
  and the balance, and the Golden Thread screen shows it beside the format
  chooser — the rule that nothing spends a balance without showing the cost
  first does not stop being true because the work is local.

### An incoming tender on the demonstration, and a chain defect found doing it

The demonstration could show a contractor **buying** — twenty-six events of
take-off, estimate, RFQ, evaluation and award to subcontractors, all on
Ashworth. It could not show a business **receiving a client's invitation and
responding to it**, because nothing ever exercised that half. A fleet run on
the tender project bore it out: thirty agents active, three findings, zero
proposals.

Calderdale now carries the front half: an opportunity registered off the AMP8
civils framework, qualified on the ten factors at **76% — BID**, and a bid
decision taken with its conditions ("drawdown window confirmed in writing
before the return", "valve gallery carried as a provisional sum"), followed by
the invitation as it arrived — reference, issue date, return deadline in its
stated time zone, clarification deadline, site visit, and the five documents
the transmittal contained.

The estimating and procurement registers stay empty. That was already a
deliberate decision and it still is: this is the project somebody puts the
first record into. What was missing was the *reason* it exists — a project
sitting at TENDER with no invitation behind it is a tender nobody was invited
to.

**`AGT-TENDER-INTEL` could not raise a finding, and nothing said so.** Its only
branch read `analysis.missingInformation` — a field `analyseITT` has never
written, absent from `domain/itt.ts` entirely. The read returned `undefined`,
the length check fell through, and an agent with a HIGH ACU tier and four named
approvers was structurally incapable of ever speaking. A silent agent and an
agent with nothing to report are indistinguishable from outside, which is why
it survived.

It now reads what the analysis carries and answers what a bid manager asks
first: terms that are a **bar** rather than a negotiation, mandatory
requirements with no evidence behind them, whether the thing is priceable at
all, the questions that must reach the buyer before the clarification deadline,
and the exposure as a figure. Both forms of the original defect — the agent
going silent, and the agent reading a field that does not exist — now fail a
test.

**The chain divergence in `analyseITT`: found, root-caused and fixed.**

It was recorded here as found and not fixed, with the reproduction. The cause
was one line, and it was not where the evidence pointed.

`analyseITT` built its list of assessed commercial terms, wrote it to the
ledger, and then sorted the list worst-term-first before returning it:

```js
terms: terms.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]),
```

A patch operation carries its value **by reference**. The array that sort
reordered was the same array the committed event's own patch pointed at, and the
event had already been hashed. Every analysis carrying more than one assessed
term produced a chain that would not verify — which is exactly why sparse terms
were fine, why each term added on its own was fine, and why the mismatch was
present the instant `commit` returned. The one honest conclusion in the original
entry — that the fault was not in the state — was right, and misleading: the
state at hash time was correct and the state a moment later was not.

Fixed in two places, because the caller was only where it happened to surface:

- **`domain/itt.ts`** builds the ordered list *before* the write, and writes and
  returns the same ordering. The stored matrix is now the document the analyst
  was shown, which is the thing argued over later.
- **`goldenthread/ledger.ts`** takes its own copy of the proposed state, the
  actor, the entity reference and the evidence, AI and policy blocks before it
  derives anything from them. A ledger that keeps live references to the
  contents of an append-only record makes that mistake available to every
  command in the system, and this would not have been the last one.

`goldenthread.test.ts` pins the rule as a property of the ledger — "a committed
event is nobody else's to change" — by doing the worst thing a caller plausibly
can afterwards: sorting the array it submitted, and pushing into the state it
read back. Both tests fail against the pre-fix ledger.

Found alongside it and fixed in the same pass: `addDeliverable` in
`domain/tenderintake.ts` appended a clarification **in place** to
`record.state.clarifications`. That mutates the before-state as well as the
after-state, so the diff between them showed nothing and the clarification was
visible in memory and absent on replay.

The compliance matrix is now seeded on Calderdale — twelve requirements read off
the instructions to tenderers, the full commercial terms, and the six-item
return register with its internal dates. `sweep()` over the seeded estate
reports **4 checked, 4 intact, 0 diverged**.

### The compliance matrix has a screen

A read-side gap, found while checking that the seeded matrix was worth seeding:
`analyseITT` wrote a full compliance matrix into the ledger and returned it in
the response body, and that was the only time anybody could see it. The record
was hashed into the chain, woke `AGT-TENDER-INTEL`, and had no screen. A bid
manager asking on the Monday which mandatory requirement had nothing behind it
would have had to run the analysis again — spending AI budget to re-derive a
record the platform already held, and writing a second `ITT_ANALYSED` event
saying the same thing about the same invitation.

**Two reads, matching the tender board beside them.** `analysisBoard` lists
every matrix the tenancy holds, worst news on each row — mandatory gaps, bars,
questions outstanding, quantified exposure and the worst term severity, so the
list can be read at a glance. `complianceMatrix` returns one whole. Both are
`ESTIMATE_TENDER` `R` at `COMMERCIAL_L3` and both are tenant-scoped: a matrix
carries the buyer, the contract value and the exposure arithmetic, and is
refused across a tenancy as "no such matrix" rather than "not yours", because
the distinction is itself information about what another contractor is bidding.

**Two fields are re-derived rather than widened into the event.** The stored
state writes `mandatoryGaps` as references and does not write
`weightings.declared` at all. Both are rebuilt from the matrix on read, by the
same `declaredWeightings` helper `analyseITT` now uses on the way in — one rule,
so the figure a reader sees months later is arrived at the way the analyst's
was. Widening the event instead would have changed the shape of a record that
already verifies, and would not have helped a single analysis already written.

**On the Pipeline screen**, "Compliance matrices on file" lists them and the
invitations table gained a Matrix column, so the analysis is reachable both from
the list and from the invitation it describes. Opening one renders the whole
thing: the four headline figures, any bar as a refusal rather than a row, every
commercial term with its severity and what it means for this business, every
requirement with an owner and a status, the buyer's marking scheme with whether
it totals 100%, and the questions to put before the clarification deadline.

`SATISFIED`, `GAP` and `UNKNOWN` are shown as three states with their meanings
spelled out, not as a tick and a cross. `UNKNOWN` means the platform holds no
probe for that requirement, which is not the same as holding one that found
nothing — collapsing them would bury the real gaps under everything nobody
automated.

Verified in a browser against the seeded Calderdale matrix, not only in tests:
twelve requirements, four SATISFIED from the company profile, the
fitness-for-purpose clause named SEVERE with the PI limit it is measured
against, weightings totalling 100%, and one clarification. Each new control was
mutation-tested — dropping the authorisation, dropping the tenant check,
widening the board past the tenancy, reading back every mandatory line instead
of the gaps, and taking the mildest term as the worst all fail a test.

**One thing was found and not changed.** A performance bond sets
`exposureMinor` on its term but is not added to `quantifiedExposureMinor`, so
the exposure column can total more than the headline. That looks deliberate —
bonding is facility committed rather than money at risk — but it is nowhere
stated, and the headline is a financial figure on a record that already
verifies. The panel now says which of the two it is showing; the arithmetic is
untouched.

### The AI reading of an invitation had no door

`ITT_REQUIREMENTS` was built end to end on the platform side and could not be
reached from the product. The prompt that tells the model to quote the document
rather than summarise it, the response schema, `POST
/v1/projects/:projectId/perception/itt`, the confirm branch that runs
`analyseITT` and then `extractRequirements`, and `ittreading.test.ts` over all
of it — and no page in `frontend/` ever called the route. The whole of "an ITT
arrived, read it" existed in the platform and was absent from the console, while
every invariant passed.

**Why it passed.** The doors invariant treats the generated command catalogue as
a door for any write, which is right for most writes: `GET /v1/commands`
publishes the schema and the console renders a form from it, so the door and the
rule come from one place. It is wrong for perception. Every one of these routes
takes a single field, `hash` — the sha256 of a file the platform already holds —
and a generated form asks for it in a text box. Nobody has an evidence hash to
hand. The catalogue's door was a bricked-up arch.

**The door.** "Read an invitation with AI" on Pipeline & Bids, which is where
the bid team already works and where the tender board and the compliance
matrices sit. It lists the invitation documents the project holds, reads one on
a button, shows what the model read — reference, client, return date, the
requirement table, its confidence, and what it says it left out and why — and
then either confirms or rejects it. Confirming asks for the three figures no
invitation states because none of them is about the buyer: what this business
expects to price, over how long, at what margin. Every exposure in the matrix is
computed against them, so they are asked rather than guessed.

Three refusals, each with its own sentence, because collapsing them into one
"unavailable" is how somebody spends an afternoon fixing the wrong thing:

- **No project open.** A reading is filed against one; the panel says so.
- **Wrong phase.** Taken from `blockedReason`, which reads the *published*
  permission matrix and phase gates rather than a rule copied into the browser.
  The panel then lists the projects the platform will accept a tender analysis
  on and switches to one through the console's own project switcher.
- **No multimodal provider.** The deployment's own words. An invitation is not
  read at all rather than read badly and filed as fact — a fabricated
  requirement is a bid disqualified.

**A new invariant, in `doors.test.ts`.** Every perception task must be offered
from a page that knows which files it can read, with no exemption list, and the
readings must be spread across pages rather than gathered onto one — a drawing
is read where drawings are managed, a photograph where the field is, an
invitation where the bid team works, because the person holding the document is
the person on that screen. All eight tasks pass; ITT was the only one missing.
Both halves fail under mutation (removing the door, and moving it to another
page).

**`projectscope.test.ts` caught this work and was right to.** Pipeline & Bids is
marked tenant-scoped because the bid pipeline exists before any project, and the
reader is project-scoped. It is admitted as the second named exception, argued in
the test: it degrades rather than crashes — with no project the panel renders a
card saying so and makes no call, and every other call on the screen is
tenant-scoped. The same test's notion of "guarded" was widened from `.catch(`
alone to also recognise a `try` opened immediately above the call, because that
is the idiom a *button* uses: there the refusal has to be shown to the person who
pressed it, and `.catch(() => null)` would swallow the sentence the platform
wrote for them. It still fails under mutation when a genuine guard is removed.

**What was verified, and what was not.** The panel, both refusal states and the
project switch were driven in a browser. The available branch — the evidence
table, the draft, the requirement table and the confirm form — was driven with
the capability response stubbed in the browser, so the rendering is real and the
model is not: no key was used and nothing was sent to a provider. The extraction
itself, and the confirm path through `analyseITT` and `extractRequirements`,
are covered server-side by `ittreading.test.ts`. **A click against a live
multimodal provider has not been exercised in this environment** and is not
claimed.

**The issuing side already exists** and is not part of this gap: `enquiry.ts`
opens an enquiry against a package, composes and approves revisions, issues to a
bidder list that refuses anyone unprequalified, and tracks who holds a superseded
pack — with its door on the Procurement screen.

### The ACT rung now runs, and the first thing it runs is a return register

A decision taken by the owner and recorded here as one: **an agent may file the
ITT return register unattended from a high-confidence reading; the compliance
matrix and the commercial assessment stay human.**

**What the ladder was.** OBSERVE → DRAFT → PROPOSE → ACT, with the top rung a
declaration and nothing under it. `registry.ts` could declare an agent eligible,
`mandate.ts` could grant an envelope with a command list, a value ceiling and an
end date, and `runtime.ts` checked the grant and degraded to a proposal when
there was none — and when there *was* one it raised a proposal anyway, because
nothing anywhere executed a command. An envelope granted an agent permission to
do something the platform had no way to do. That half is now built.

**Where the line falls, and why there.** Reading an invitation is two jobs under
one name. Transcription — forty return items with formats, page limits,
channels, signature and bond requirements and dates — is slow, is what a machine
is good at, and a mistake in it is visible and fixable on a screen the bid team
opens daily. Judgement — is this requirement really pass/fail, is fitness for
purpose acceptable against the cover this business holds, is the job worth
chasing — is where a mistake becomes a bid submitted on terms nobody checked.

The line is drawn in the event catalogue rather than in the agent:
`TENDER_REQUIREMENTS_EXTRACTED` is `aiAllowed`, `ITT_ANALYSED` is not. So the
agent can only ever reach the register, whatever it or a future envelope tries.
Three independent refusals stand behind that, and each fails a test on its own:
`assertCommandMayBeAutomated` refuses the analyst at grant time; the agent's
declared envelope names one command and a grant may only narrow it; and the
ledger refuses an AI author on the event outright.

**What was built.**

- `AGENT_ACT_EXECUTED` in the catalogue, `aiAllowed`, distinct from
  `AGENT_PROPOSAL_EXECUTED`. The question asked of an unattended act is *who
  allowed this and when did that authority start*, which has no meaning for a
  proposal a person approved; the event names the envelope and its grantor.
- `agents/acts.ts` — a hand-written map from command to executor. A dispatcher
  resolving `module:function` by name would be a hole through the safety model:
  any function that later took that name would become machine-reachable, and
  whether it was safe would be decided by a naming convention. Every executor
  must also appear in `AUTOMATABLE_COMMANDS`, and a test fails if one does not.
- `EngineContext.actingAs`, honoured by the single `write` path. It changes only
  the *author*: without it the register would read "extracted by Jane" for work
  Jane never did. Authority is untouched — `authorise` still reads the human's
  roles, so an agent can never reach past the identity whose session ran it.
- `AGT-ITT-REGISTER`, the second agent ever eligible to act and the first whose
  acts write governed state. Confidence floor 0.8, higher than the analyst's,
  because the whole argument for acting rests on the transcription being
  reliable. Below it the finding is raised with no proposal attached.
- `extractRequirements` takes `analysisId` optionally. Requiring it would have
  coupled the register to the matrix, forcing either both automated or neither —
  which is the coupling that would have made this unsafe. A later analysis links
  itself, and a re-filed register never unlinks one already there.

**Still true after all of it.** Eligibility is not authority. Without an envelope
granted by a person holding governance authority, with an end date and
revocable, `AGT-ITT-REGISTER` behaves like every other agent: it proposes, and
the proposal says "queued rather than run". The pinned list of ACT-eligible
agents in `agentcontract.test.ts` went from one entry to two, and the argument
for the second is written into the test rather than left to a commit message.

**Verified, and the caveat withdrawn.** The fleet wiring was first left unproven
on the reasoning that the reading needed a multimodal provider and stubbing one
would be testing the stub. That reasoning was wrong: a stubbed *provider* stands
in for one thing only, the words a model returns, and everything between that and
the register is the platform's own. `ittreading.test.ts` now drives the whole
path — a real file into a real `extract`, a real `PERCEPTION_DRAFT_PRODUCED`, the
trigger routing that wakes the agent, the mandate check, the envelope lookup, the
executor, the attribution, and the catalogue's refusal — against the multimodal
stub that file already had.

Two defects came out of doing it, both of which had made the feature
non-functional and neither of which any existing test could have caught:

- **The agent looked for the invitation on the project.** An invitation is
  recorded against the opportunity, in the tenancy scope the bid pipeline lives
  in, because a tender exists before the job does. The agent read the project
  scope, found nothing, and reported no findings while a good reading sat
  waiting — the exact shape of the dead-agent defect `agentcontract.test.ts` was
  written about. It now reads through `tenderBoard`, the domain's own reader,
  so moving an invitation cannot silently strand it again.
- **The value ceiling measured the price of thinking.** The runtime passed
  `estimatedAcuMinor` — what the agent's *run* cost — as the value of the act.
  Every declared ceiling is zero and no ACU tier is free, so the top rung was
  unreachable for any agent: this one was refused permission to file a document
  because thinking about it had cost ten minor units. `ProposedCommand` now
  carries `valueMinor`, what the act *commits*, and the ceiling is measured
  against that. It still bites — an act declaring any value at all is refused
  under a zero ceiling, and automating one would mean raising a ceiling, which
  fails `agentcontract.test.ts`.

Six mutations fail a test: dropping the `AUTOMATABLE_COMMANDS` check in the
executor, falling attribution back to the human, opening `ITT_ANALYSED` to
machines, pointing the agent back at the project scope, stopping the runtime
executing a granted act, and removing the guard against re-filing a register
that is already there.

**What is still not claimed:** whether a particular model reads a particular PDF
correctly. That is a question about a model, not about this platform, and no
test here answers it.


### The page was the customer's and the file was not

Every visible surface was already white-labelled — the customer's mark, their
primary colour, their registered office in the footer, and nothing of this
platform's on the page. The **file properties** told a different story, and that
is the first place anybody looks to ask where a document came from.

- A PDF carried `Producer: CONSTRUX` in its Info dictionary, and named
  `clientName` — who the document was prepared *for* — as its `Author`.
- A Word package carried **no properties at all**: no `docProps/core.xml`, no
  `docProps/app.xml`. That is not white-labelling, it is a blank Author and a
  blank Company on an instrument the customer stands behind. Blank is what an
  untitled draft looks like.

Both now carry the issuing entity, from one shared `documentOrigin(branding)` so
a Word file and a PDF of the same document cannot disagree about who issued it.
`issuingEntity` first, because that is the party carrying the duty under the
document — the one a regulator writes to about a permit, the one named on a
method statement a subcontractor works to. `clientName` is the fallback, because
a tenancy that has not separated the two still has to have a name on its files.

The PDF sets `Author`, `Creator` and `Producer`; some readers fall back to the
producer when the creator is unset. The Word package gains `core.xml`
(`dc:title`, `dc:subject`, `dc:creator`, `cp:lastModifiedBy`, and the document's
own reference and content hash in `cp:category` / `cp:contentStatus`, so a file
separated from its covering email still says what it is) and `app.xml`
(`Application`, `Company`, `Manager`), both declared in the content types and
related from the package rels — a part the package does not point at is a part
Word ignores, which looks identical to not writing it.

`dc:creator` is the organisation rather than a person. A document produced from
a project record is issued by the company carrying the duty under it; naming an
individual there would put one person's name on something their whole firm
stands behind. Who pressed the button is on the page, under "Generated by".

**Verified by an independent reader**, not only by tests: `python-docx` opens
the file and reports the issuer as author, and a byte scan of both the `.docx`
package and the `.pdf` finds no occurrence of this platform's name. Four
mutations fail a test — restoring the platform as producer, falling the origin
back to the client, dropping the docProps parts, and writing them without
declaring them. A whole-package assertion covers every part rather than the ones
a test happens to name.

One thing that was *not* a defect: the exporter's attestation instructions
explain how to recompute the chain and name no address. A test fixture had put
this platform's domain there, which was the only reason a rendered document ever
mentioned it; the fixture now carries the wording the exporter actually
produces.


### The division of responsibility, between the client and every contractor

The platform knew which firm held which package — an award records that. It
could not answer the question actually argued about on site, which is not
*whose package is this* but **whose duty is this**, and the two come apart in
exactly the places that cost money.

`domain/responsibility.ts` records who carries each obligation across three
kinds of party. The client is not a contractor with another name: nothing is
awarded to them, no subcontract binds them, and their obligations are the ones
this business claims *against* rather than manages. A subcontractor is named
from the supply chain register by id, never typed — two spellings of one firm
are two parties on a matrix and one firm on the job.

**The table is the smaller half.** What the module exists for is the four ways a
project argues with itself, each reported with what goes wrong if it stays:

- **Scope in nobody's package.** Between the piling and the substructure there
  is a pile trim in neither. Both firms priced without it, both are right, and
  the argument happens with the excavation open. Derived from the project's own
  packages, so a matrix that simply omitted one still cannot look complete.
- **Scope in two packages.** Worse commercially: two firms priced the same
  works, one will be paid for doing it and the other has a claim for being
  prevented from it.
- **A design responsibility marked SHARED and never split.** `SHARED` is a real
  answer to who pays and never one to who draws it. Somebody has to produce
  each drawing, and the gap is found at the point the drawing is needed.
- **A client obligation past its date.** Free issue, access, permits, existing
  services, a decision — the most common root of a contractor delay claim there
  is, usually with the notice clock already running. The consequence is written
  differently for a party this business answers for, because that one is this
  business's own delay rather than a claim it makes.

**It refuses a line that would protect nobody.** A client-side obligation with
no date is rejected outright: nobody can be late on it, so it cannot be chased
and cannot be claimed against, and recording it undated produces a matrix that
looks complete.

**Moving a duty is a separate command and a separate event.** "It was always
theirs" and "we moved it to them in March" are different positions, and a matrix
that overwrote the first with the second could not tell them apart. The
reassignment carries the party it moved from and the reason, and both stay on
the record.

**Owned by the project manager and the construction manager.** Both hold `C`,
`U` and `A` on `WORKPACKAGES_TASKS` and between them answer for the interface —
the PM to the client and the contract, the construction manager to the sequence
and the site. `ResponsibilityItem` is classified `COMMERCIAL_L3`: the matrix
states what this business has and has not accepted, and a subcontractor reading
the line that says a duty is theirs is reading a negotiating position on a claim
they have not made yet.

The panel is on Project Control, where both roles already work. Five mutations
fail a test — suppressing each of the four concerns, and dropping the date
requirement. Driven in a browser against the seeded estate, where it immediately
reported two real things about Ashworth: a scope package with no party against
it, and a shared design responsibility never split.

`identity.test.ts` caught the new entity type before it shipped unclassified,
which is the guard working: an entity the catalogue can produce and the access
model has never heard of has no rules at all.


### Running an integrated appointment without a finance team

A business that takes every site service under one appointment — the temporary
offices, the power, the roads, the security, the accommodation — is not doing
harder work than a specialist. It is doing the same work with a different
exposure: it pays fifteen suppliers monthly and is paid by one client monthly,
and nothing synchronises those two facts. A large firm answers that with a
finance function and a credit line. A new entrant, or a small business taking
its first integrated appointment, has neither, and everything else on this
platform is useless to them if they are wound up in month four.

`domain/integrator.ts` answers the two questions that decide it, and refuses to
answer either vaguely.

**What the price is made of.** The industry habit is a single "overhead and
profit" percentage, and it is the number clients push back on hardest because it
cannot be argued with: twenty per cent of what, for what? Split into its parts
each one is defensible on its own — the cost of managing the interface, what the
business costs to keep open, the return for carrying the risk, and money held
against things going wrong. Each component carries the sentence it would be
defended in; a component with no basis is the single "overhead" figure again
with more rows, and a test fails if one is dropped. The four rates live in
`config.ts`, because a business bidding against a framework rate has to move
them without a code change.

**Contingency is not profit, and the module will not let it become profit
quietly.** It is priced separately and excluded from `marginMinor` by
construction; drawing it needs `A` on `BUDGET_COST` — the authority that
approves a budget, not the quantity surveyor who maintains it — and a draw that
names no risk is refused, because money spent on something nobody identified is
an underestimate or a scope change and both have their own route. A draw beyond
what was priced is refused rather than allowed to eat the margin silently. A
business that treats unused contingency as margin has mispriced every job after
the first one.

**Whether the money will be there.** The client advance is not a deposit but a
rolling reserve, replenished at each valuation so the business always holds the
next period's committed spend. The mobilisation advance and every top-up take
one command, because recording them separately would produce two numbers and no
answer to how much is held. The position states cover in **days**, against the
outflow rate measured from certificates issued down the chain — not as a
balance, which means nothing without knowing what it is against.

**Where it refuses to answer.** With nothing certified down the chain there is
no outflow to cover, so `coverDays` is `undefined` with a sentence saying why,
rather than a large number. "Infinite cover" is the most dangerous possible
answer on a project that has not started paying anybody — it says *safe* at
exactly the point there is still time to act. The summary and the panel's
all-clear notice carry the same restraint: an empty concern list is the absence
of a measurement, not an assurance, and both say so.

Four concerns, each a specific way an integrator fails, each stated with what
happens if it is left: the reserve short of one payment cycle; more certified
down the chain than is owed up it and held, which is the business funding the
client; a contingency draw naming no risk; and nothing priced at all. Everything
is read from what the platform already holds — `forwardCashflow` and
`ledgerPosition` — rather than from a second set of figures.

Panel and three commands on Cost & Value, under the roles that already work
there. `IntegrationAccount` is classified `COMMERCIAL_L3`. Sixteen mutations
fail a test, including suppressing either cash concern, folding contingency back
into margin, dropping the approval authority on a draw, reporting cover against
an outflow of zero, and swapping the receivable and payable sides. Driven in a
browser across two identities: the QS priced the appointment and recorded the
advance, found `Draw contingency` locked, and the owner drew £8.0K against
RR-014 with the contingency falling from £50.0K to £42.0K on the panel.

Two defects were found by driving it rather than by the tests. A stray double
comma in the page's `Promise.all` left an array hole, so the panel rendered its
own defaults instead of the API's answer; and the summary reported money as a
count of minor units, on the one screen written to be read at eleven at night.
Both are fixed and both now have a test.

**What this does not do.** The Construction Act payment cycle, its notices and
its dates are the platform's own and are not restated here. CIS deduction,
verification and monthly returns are not built; nor is the retention release
model (a half at practical completion, a half after the defects period); nor a
service taxonomy for site services or workforce accommodation. Those are named
here so the absence is not mistaken for coverage.


### Running a real business through the platform, and what it found

The Groupe Nseya case study — a business taking every site service under one
appointment — was walked end to end over HTTP as a new tenant: public signup,
enterprise and portfolio, the appointment as a project, the price build-up, the
mobilisation advance, a scope package, the design gate, the supply chain
register, prequalification, RFQ, award, subcontract, and the payment cycle in
both directions. Not a test fixture; the same routes a customer hits.

Most of it works, and several refusals were exactly right: an enquiry to a
supplier who is registered but not prequalified is refused with that reason; a
supplier with no employers liability cover is barred; procurement during
`CONCEPT` is refused by the phase gate; an identity cannot change its own roles.
The trade catalogue already carries the case study's own service taxonomy —
`WELFARE` (welfare and site accommodation), `SECURITY`, `LOGISTICS`, `CLEANING`,
`TEMPORARY_WORKS_SUPPLY` under `PLANT_AND_SITE`.

Three defects came out of it that no amount of reading the code had produced.

**A project-scoped path never had to name a project.** `projectContext` checked
that the path carried a project segment, never that it named one. So
`POST /v1/projects/undefined/integration` returned **201** and wrote a priced
commercial account — contract sum, margin, contingency — into a ledger scope no
project owns. The ledger is append-only, so such a record cannot afterwards be
removed; it is invisible to every project listing and readable only by repeating
the same wrong URL. Handlers that happened to call `ledger.require` themselves
were safe and the rest were not, which is not a property anything could rely on.
The check now sits at the funnel all 565 project-scoped routes pass through, and
verifies tenancy in the same breath — naming another tenant's project id would
otherwise have opened a scope under this tenant carrying their identifier.

**A route schema disagreed with the command behind it.** `enforcementNotices`
was declared `integer` on the prequalification route while
`assessPrequalification` reads each notice's type, date and whether it was
resolved. Sending the field as documented produced `500 INTERNAL_ERROR`; sending
what the command reads was refused at the door. Either way an unresolved HSE
prohibition notice — a bar, and the most serious thing on the assessment — could
not be recorded at all. Both directions are now tested, because fixing only the
crash would have left the bar unreachable and the route would still have looked
like it worked.

**Separation of duties is enforced between roles, not between people.**
`certifyApplication` checks `A` on `PAYMENT_APPLICATIONS` and never that the
certifying actor differs from the applying one. One identity holding `QS` and
`OWNER` submitted a payment application and certified it, in sequence, with
nothing on the record to show it. The pattern exists elsewhere in the codebase —
`assignRoles` refuses `SELF_ROLE_CHANGE` — so the absence here is an omission
rather than a decision. **Not fixed**, because it is a change to a settled
control model rather than a defect in a path: it needs a decision about whether
a single-operator business is permitted to self-certify with the fact recorded,
or refused outright. Recorded here so it is not mistaken for coverage.

**And the platform cannot be operated by one person.** Public signup grants the
founder `ENTERPRISE_ADMIN`, which holds no `C` or `U` on `BUDGET_COST`,
`WORKPACKAGES_TASKS` or `DESIGN_INFORMATION` — so the person who just created
the company can create projects and nothing else. They cannot promote themselves
(`SELF_ROLE_CHANGE`, correctly), so the only route is to create a second
identity and sign in as it. Running one appointment took the founder plus one
operator holding `QS`, `PM`, `OWNER` and `DESIGNER` together. That works and
costs nothing extra on a package with ten included seats, but it means the
audit trail shows two people where there is one, and stacking those roles is
what defeats the certification separation above. The seat model already prices
a sole trader; the permission model does not yet describe one.


### SiteCapture: three minutes on site, and what may honestly be claimed

Two specifications describe one module — CX-SCAP and the Site Spatial Twin —
and both target a stack this repository settled against: NestJS, Kafka, PostGIS,
GCS, Vertex AI GPU pools, COLMAP/OpenMVS, CesiumJS, Expo React Native.
Photogrammetry, 3D Tiles, orthomosaics and GPU segmentation cannot live here;
that follows from the zero-runtime-dependency decision, not from a preference.

What the two documents agree on is the part that never needed pixels, and it is
the part with the commercial proposition in it: *scan for three minutes, and the
platform tells the construction manager what the constraints are and what to do
about each.* The constraints come from the person standing there in the last
thirty seconds, not from reconstruction. The responses are ordinary practice.
Neither needs a GPU.

`domain/sitecapture.ts` builds that, around the rule both specifications call
non-negotiable.

**The class is derived, never declared.** Four classes — conceptual, measured
reconnaissance, project controlled, approved baseline — computed from the device
tier and the control points on the record. A video-only walk is `CONCEPTUAL`
however it is labelled, and six control points observed on video do not promote
it, because a device that cannot measure did not measure them. Three control
points is the floor for `PROJECT_CONTROLLED`: two fit a transform with nothing
left to check it against. Every brief leads with what may and may not be claimed
— *"nothing here may be scaled or built to"* — because a report that buries its
accuracy class is read as a survey, and somebody sets a compound out against it.

**Every constraint carries a response.** Twenty-one constraint types, each with
at least two practical answers in the manager's own idiom: a narrow gate gets
widening, timed deliveries or smaller vehicles; weak ground gets geotextile and
a stone platform, a load restriction, or a different laydown. A rulepack rather
than a prompt, because the answer to a narrow entrance does not vary by site and
a model asked to invent one would sometimes invent a wrong one. The responses
come back at the moment the constraint is recorded, not in a report later — the
cheapest moment to act on it is while somebody is still on the ground.

**A stage not walked is not a lower-confidence answer.** The brief names each
uncovered stage, what is therefore unanswerable, and the directions to close it
on the next burst. A hard constraint with nothing that would verify it is
refused outright: "the ground is weak" with no trial hole named is an opinion
that gets treated as a fact later.

**What it does not do, said in the brief rather than left out.** No 3D model, no
orthomosaic, no dimensioned drawing, no positioned layout. `sitevisit.ts`
already refuses to draw a logistics plan without the geometry behind it, and
that decision stands; SiteCapture is the missing input to it, not a replacement.
A brief that simply omitted the site model would be read as "there wasn't one
worth showing" rather than "the platform does not make one".

**Reuse rather than a parallel model.** The constraints are `LOOKAHEAD_CONSTRAINTS`
— the same register, reached from a phone. The authority split falls out of the
existing role matrix and matches the specification's own: the construction
manager opens the mission on `FIELD_EXECUTION`, records constraints on
`LOOKAHEAD_CONSTRAINTS` `C`, and setting the baseline needs `A`. The protocol
and the constraint catalogue are published from `/v1/site-capture/protocol`, on
the same argument as the permission matrix: the browser holds no list the API
does not publish.

Panel and four commands on Field Execution. Fourteen mutations fail a test.
Driven in a browser as the construction manager: a video-only walk with four
control points came back `CONCEPTUAL`, the baseline was refused with *"a
comparison with a guess"*, a hard constraint with no verification was refused,
and the brief listed both constraints with their responses, the one unreached
stage with its next-burst directions, and the verification schedule.

**What is not built.** Reconstruction, semantic segmentation, vectorisation, the
2D/3D deliverables, change detection and the layout optimiser. The provider
interface for reconstruction is *not* built either — deliberately, so nothing
declares a seam before there is something to put behind it. The Zone Taxonomy
overlaps `LOGISTICS_ELEMENT` nine ways and must extend it rather than sit beside
it; that merge is not done.


### Site geometry, computed rather than described

A correction to what this file said one section earlier. It claimed the spatial
specifications "cannot live here". That was too broad, and the narrower
statement is the true one: **two** things need compute this platform does not
have — reconstructing geometry from raw video pixels, and classifying a region
as "road" from imagery. Everything downstream of geometry is deterministic
arithmetic with no dependency at all, and the specifications themselves say the
device does the reconstruction: ARKit and ARCore already produce depth, per-frame
poses and mesh anchors on the handset. The platform does not need to run
structure-from-motion. It needs to receive what the phone computed.

`domain/geometry.ts` is the arithmetic everything above it was faking without:

- area, perimeter and the **area** centroid — not the vertex mean, which is
  wrong for any ring a person traces because they put more points on the
  interesting side
- point-in-polygon, distance to a segment rather than to the line it lies on
- ear-clipping triangulation for any simple polygon, convex or not
- **exact** intersection area, by triangulating both polygons and clipping
  triangle against triangle — correct for concave shapes, where the ordinary
  Sutherland–Hodgman answer is wrong
- mitred buffers, which is what a crane exclusion, a root protection area and an
  excavation setback all are
- cut and fill between a triangulated surface and a level, in closed form rather
  than sampled — a spoil heap measured by sampling gives a different figure every
  time the grid moves, and that figure is invoiced
- slope and aspect, and the steepest triangle, which is what decides access
- swept paths for six design vehicles, and whether a manoeuvring area is the
  right **shape** rather than merely large enough
- shortest route on the site road graph, refusing an edge narrower than the
  vehicle rather than routing an artic down a two-metre gap

Every test checks against a figure worked out by hand and written into the
comment, because a geometry suite that only checks a function against itself
proves consistency rather than correctness.

Sixteen mutations were run; fifteen fail a test. Three survived the first pass
and each taught something:

- **Winding normalisation** was untested. A boundary traced clockwise on a phone
  buffered *inward* — an exclusion zone that shrinks instead of growing, which is
  the most dangerous possible direction for that error.
- **The reflex-vertex check in ear clipping** was untested, and the obvious
  shape did not expose it: for an L, the bad ears happen to contain another
  vertex and get rejected anyway. It takes a notch whose reflex ear is empty —
  and the ring listed starting at that apex — to show it. Then 125m² of
  triangles cover a 75m² shape, two of them in the notch. The vertex somebody
  started tracing from decided whether the answer was right.
- **The ray-casting rule** is an *equivalent* mutant, established rather than
  assumed: 200,000 differential point/polygon pairs, with the point's y landing
  on vertex lines, found `>` and `>=` disagreeing only where the point sits on
  the boundary and never where the answer is defined. The comment in the source
  claimed more than that and has been corrected; the absent test is recorded in
  the suite as a finding rather than a gap.

One naming defect fixed on the way: the volume result used `cutMinor` /
`fillMinor`, and `Minor` means minor currency units everywhere else in this
codebase. They are cubic metres and now say so.

**What this unblocks and what is still not built.** `sitevisit.ts` refuses to
draw a logistics plan without geometry behind it; that geometry now exists, but
the two are not yet joined. Zones still carry no polygons, so the capture brief
still reports no areas. The layout planner, the scenario scoring, the 2D drawing
output, change detection and the ingestion of a device mesh are all still to
build. None of them now needs anything this repository does not have.


### The site as geometry, and the layout designed on it

The geometry core had nothing above it using it. Now it does, and the sentence
`sitevisit.ts` has carried since it was written — that it will not draw a
logistics plan without the geometry behind it — is no longer a limit the
platform has to live with.

**`domain/sitemodel.ts`** holds the site as shapes. A boundary, an optional
triangulated surface taken from the device rather than reconstructed here, and
zones carrying the ground they actually occupy. Everything is measured from the
polygon: areas, perimeters, slope, cut and fill, and a label point guaranteed to
be *inside* its zone, which the centroid is not for a concave one.

Conflicts are computed on every read rather than stored, so a layout cannot be
edited into correctness on paper while a stored finding says otherwise. Six
kinds, and the distinctions matter: a laydown inside an exclusion is `CRITICAL`
and reported as a keep-clear breach, not as an ordinary overlap; a gate inside
the hoarding line is not reported at all, because some things belong inside
others and a rule that flagged every nesting would bury the breach. A zone that
leaves the site is **refused rather than clipped** — trimming it would decide
whether the boundary or the zone was wrong, without telling anybody.

Where there is no surface it says so rather than reporting a flat one, because
zero slope and zero cut are measurements nobody made.

**`domain/sitelayout.ts`** designs the setup. Three strategies — welfare near
the work, shortest delivery run, compact compound — each producing a genuinely
different layout by search over real candidate positions, not by asking a model
to imagine a compound. Areas are sized from the workforce at published rates, so
a manager states people and gets a compound. Every placement carries the reason
it is where it is, and nothing overlaps anything by construction.

A scenario that could not place everything is `INFEASIBLE` and names what would
not fit. Nothing is shrunk to make it fit, and an infeasible scenario cannot be
adopted: a compound sized to the space rather than the workforce fails its first
inspection, and leaving an area out ought to be a decision on the record.

Eighteen mutations were run against both modules; all eighteen fail a test.
Three needed real work to catch:

- **Placing areas smallest first** survived until a site was found where the
  order changes the answer. A 40×40 site with a 560m² laydown fits all three
  strategies placing biggest first, and only two placing smallest first — the
  small areas land in the middle of the only ground large enough to take the
  laydown.
- **Ranking infeasible layouts alongside feasible ones** survived because the
  first version of that test compared a sorted array against itself and asserted
  nothing. A 60×50 site produces a genuine mix, and the test now uses it.
- **A defect in the scoring, found by reading the output rather than by a test.**
  Free ground was credited at a tenth of a metre per square and the comment
  called it a tie-breaker. On a two-hectare site that term is about 1,840
  against distance differences of around 16 — it outweighed what it was meant to
  break ties in by a hundred to one, and the score printed as an unreadable
  negative number. The score is now metres of daily travel, which a person can
  check by pacing it, and free ground breaks a tie and only a tie.

Panel on Field Execution: the measured model, the conflicts, and the change
between any two captures of the same site. Driven in a browser as the
construction manager, with a 200×100m site, a wedge surface rising 12m, an
overhead-line corridor and a laydown breaching it by 375m².

**Still not built.** The 2D drawing output and the 3D view. Neither needs
anything this repository lacks — the PDF renderer and the geometry both exist —
and the taxonomy merge with `LOGISTICS_ELEMENT` is done, so a drawing has one
legend to render from.


### The drawing and the view, which were the last two things missing

The section above ended: *"Still not built. The 2D drawing output and the 3D
view."* Both are built now, and both are honest about what they are.

**The drawing is a drawing, not a picture of one.** The difference is whether a
scale rule laid on the paper reads true. `export/siteplan.ts` chooses a scale
from the ordinary drawing scales — 1:50 through 1:2500 — and refuses a site too
large for A4 at any of them rather than inventing a ratio like 1:173 that nobody
can measure against. The renderer then applies exactly that ratio and nothing
else, so the plotted geometry and the printed "1:500" cannot disagree. Verified
by reading the PDF's own content stream: a 60m × 40m site plots at 120.00mm ×
80.00mm, the scale bar measures 40.00mm and is labelled 20m, and every zone's
plotted rectangle reproduces the area its schedule row quotes — the laydown at
44 × 28mm is the 308m² the table states.

The sheet carries a north arrow, a scale bar, a zone schedule and a legend drawn
from the element catalogue. Colour comes from the element code and never from
draw order, so a laydown is the same colour on every sheet the business issues.
The DXF is the same geometry as R12 ASCII, one layer per element code, in real
site coordinates — which is what a client's drawing office can overlay on their
own, and a PDF is not. It goes through the ordinary exporter, so it inherits the
branding, the audience redaction, the content hash and the attestation; a
parallel renderer would have been a second document engine with none of that.

The sheet says on its own face that it is not a survey and may not be used for
setting out without verification. A drawing leaves the platform, and whoever
opens it cannot see the accuracy class beside it.

**The 3D view is WebGL with no library** — `frontend/lib/sitetwin.js`, a few
hundred lines of matrix arithmetic and two shaders, because a 3D dependency to
draw a mesh and some extruded polygons would break the one decision this
platform has kept throughout. Where no surface was captured it draws **no
ground at all**, rather than a flat plane: a plane is a measurement nobody made,
and on a screen it reads as a level site that nobody would question.

**Three defects that only rendering the output could find.** All of the
arithmetic above was already correct and every test passed when each of these
was present.

- **Zone names printed on top of each other.** "Walkway" over "Muster point",
  and "Perimeter hoarding" struck through by the boundary line it crossed. Names
  are now placed on a ladder of positions, masked behind, and a name that still
  cannot be placed is dropped rather than overprinted — two names on top of each
  other read as neither, and the schedule names every zone regardless. Ordering
  is by the zone's own area, so when a name gives way it is the sliver's.
- **The north arrow sat inside the frame**, printed over whatever occupied the
  corner — which on the first real site was the overhead-line exclusion, the one
  thing on the sheet nobody should read through an arrow. It now goes in the
  gutter, or on the scale-bar row when there is no gutter.
- **Seven of nine zones were invisible in the 3D view.** The ground rose three
  metres across the site and every zone was extruded from a fixed zero, so the
  terrain buried them. Every triangle was present and correct and simply behind
  the ground — which is why the vertex-count tests could not see it. Zones and
  the boundary wall are now draped on the captured surface, interpolated
  barycentrically so the ground reads as a slope rather than as terracing.

The tests that now hold these were written after the defects, and each was
mutation-checked: eleven mutations across the label placement, the north arrow
and the draping, all eleven caught. Two of those tests were wrong on the first
attempt and said so — one placed its zones at a shared *corner* rather than a
shared *centre*, which left the collision ladder enough room that nothing was
ever contested; the other checked only the highest point of the boundary wall,
which passes while any individual corner still sits at a fixed level.

One false claim was removed from the source on the way: the label ordering
sorted by the *label's* width while its comment claimed it protected the larger
*zone*. Those are different things — "Gate 1" is a long name on one of the
smallest things on any site — and it now sorts by the shape's area.

**Still not built**, and unchanged by this: semantic segmentation, the
reconstruction-provider interface (deliberately deferred rather than stubbed),
change-detection *volumes* as opposed to areas, and ACU metering for the spatial
stages.


### The four that were listed as not built

The section above closed with a list: semantic segmentation, the
reconstruction-provider interface, change-detection *volumes* as opposed to
areas, and ACU metering for the spatial stages. All four are built. None needed
a runtime dependency, and the reason is the same in each case — the hard part
was already done on the handset or was arithmetic nobody had written down.

**Semantic segmentation** — `domain/segmentation.ts`. The captured surface is
classified triangle by triangle into six ground forms whose thresholds are the
ones that actually govern site work (1 in 12 is the limit for a route people and
plant share; 1 in 4 is roughly where tracked plant stops working across a face),
then triangles of the same class sharing an edge are grown into regions, and
each region's outline is the set of edges belonging to exactly one of its
triangles. That outline is a real polygon in site metres and goes to the
drawing, the DXF and the viewer through the same taxonomy as everything else.

Ponding is found separately and by the thing that defines it: a region whose
lowest point sits below the lowest point on its own outline has nowhere for
water to leave. That is a genuine hydrological test rather than a threshold on
steepness, and it is why standing water is reported on ground every slope rule
calls good. The discriminating test in the suite is a ramp and a bowl with
identical gradients reaching identical low levels — one drains, one does not, and
anything keying off steepness reports them the same.

**It classifies form, not material**, and says so on every region rather than
only in the summary: `classifies: 'FORM'` is on the record, because a consumer
reading regions through the API never sees the summary. A 2% plane is level
ground whether it is tarmac or wet clay, and no bearing capacity may be inferred
from any of it.

**The reconstruction-provider interface** — `domain/reconstruction.ts`, and it
is a real interface with a working implementation rather than a seam with
nothing behind it. The insight is that the hard part of photogrammetry —
matching features between frames and knowing where the camera was — is already
done by the AR session: ARKit and ARCore expose a tracked camera transform and
tracked feature points per frame as a normal part of running. What arrives is
therefore poses and 2D tracks, not pixels, and recovering the 3D point from
those is a least-squares problem in three unknowns with a closed form. It is
solved exactly: `(Σ (I − dᵢdᵢᵀ)) X = Σ (I − dᵢdᵢᵀ)oᵢ`, a 3×3 system by Cramer's
rule, with no optimiser and no iteration. The points are then meshed by
Bowyer–Watson Delaunay in plan with heights carried through — Delaunay rather
than any triangulation because slivers between distant points produce gradients
that are artefacts of the meshing, and gradient is what the segmentation
classifies on.

Every point carries the reprojection residual it was solved to, and points that
do not converge are **dropped rather than kept with a large error** — a bad
point in a surface is worse than a missing one, because the surface interpolates
through it and a volume is computed over the result. Four rejection paths are
counted separately: too few views, no baseline between the frames that saw it,
a solve behind a camera, and a residual too large.

The registry publishes all three capabilities including the two nothing serves —
dense stereo and material classification — with what each needs and what each
would give. Asked for one of those the platform **refuses**, naming what is
absent, rather than returning a coarser answer that is indistinguishable from a
good one once it reaches a drawing. An empty slot stated plainly is more useful
than a capability list that only names what happens to work: somebody deciding
what to walk a site with needs to know before the walk.

**Change-detection volumes** — `geo.volumeBetween`. `volumeAboveLevel` answers
cut and fill against a datum, which is all one capture supports. This answers it
against an *earlier capture*, which is the question a progress claim and a
muck-away invoice both turn on. Exact: each triangle of the later surface is
clipped against each triangle of the earlier one, so over every resulting piece
both surfaces are planar, their difference is a plane, and the exact mean of a
plane over a polygon is its value at that polygon's area centroid. Nothing is
sampled, so nothing changes when a grid moves — which matters because the figure
is paid against.

It reports the footprint the two captures actually shared and the footprint they
did not, separately. A volume over 900m² of a 2,400m² site is a different number
from a volume over the whole site, and a report that does not say which invites
the reader to assume the second. Where either capture has no surface the volume
is **absent with a reason naming which capture is missing it**, never zero —
zero says the ground is exactly as it was, which nobody measured.

**ACU metering for the spatial stages** — `billing/spatial.ts`. Charged like a
document render and not like an AI call, because that is what they are: compute
the platform performs rather than compute it buys. Reserve, work, settle, with
`LOCAL` as the provider and the same markup, so a spatial stage appears on the
statement beside an AI call in units the customer already reads. A base per
stage plus a rate per thousand primitives, because four hundred feature tracks
and forty thousand are not the same job and a flat fee makes the small site pay
for the large one. The reservation happens **before** the compute — a balance
checked afterwards has already spent it — and a stage that throws releases its
hold without charge.

**What the tests caught, and what only reading the output caught.** Thirty-three
mutations were run across the four verticals and all thirty-three now fail a
test, but six of them survived the first pass and two pieces of dead code were
found by chasing survivors that turned out to be equivalent mutants:

- **Every test camera had a *symmetric* rotation matrix**, and a symmetric
  matrix is its own transpose — so whether the code used R or Rᵀ to turn a pixel
  into a world ray was invisible to all of them. Get it the wrong way round and
  a site reconstructs mirrored about a diagonal. Two yawed cameras now cover it.
- **A point above two downward-looking cameras reprojects onto both perfectly**,
  because the projection is symmetric about the focal point. Residual zero, and
  nothing but an explicit check on which side of the lens it landed rejects it.
  It has its own rejection counter now rather than being filed as a large
  residual, which it was not.
- **The mesh test checked total area**, which any triangulation of those points
  satisfies. It now checks the empty-circumcircle property, which is what
  Delaunay actually means.
- **The winding branch in the in-circle predicate was unreachable.** Measured
  rather than assumed: 49 counter-clockwise triangles and zero clockwise, and
  the induction is in the comment — the super-triangle is counter-clockwise and
  every replacement takes a hole-boundary edge in its counter-clockwise
  direction plus an interior point. The branch has been removed and the
  invariant is asserted by a test instead, because code that cannot run asserts
  a robustness it does not have.
- **The `Number.isFinite` guard on slope was unreachable too**, for the same
  kind of reason: infinite gradient and zero plan area are the same condition,
  and the plan-area filter already dropped those. Established empirically —
  200,000 random triangles produced 303 with infinite gradient and none with a
  footprint. The ordering is now structural, and the case that made it
  load-bearing is tested: a vertical panel adjacent to a steep face merges into
  its region and turns an area-weighted mean into `Infinity × 0`, which is NaN.
- **Two of the new tests were wrong and passed anyway.** One placed its zones at
  a shared *corner* rather than a shared *centre*, so the ladder was never
  contested; one hung its strips off a vertex rather than an edge, so region
  growing never joined them and the area-weighting was never exercised.

Two defects that only reading the output could find, both while every test
passed:

- **`volumeBetween` silently lost most of its footprint.** Sutherland–Hodgman
  returns a ring with a repeated vertex whenever the subject and the clip share
  a corner — which adjacent mesh triangles do constantly — and `triangulate`
  rejects such a ring and returns nothing. A 40m² comparison came back as 8m².
  The fix removed the triangulation entirely in favour of the centroid identity,
  which is both simpler and exact. `intersectionArea` never hit this because it
  calls `area()` on the piece rather than triangulating it.
- **The absent-volume message said the opposite of the truth**: "The later
  capture *recorded* a ground surface, so no volume can be measured." The test
  matched the fragment "The later capture" and passed. It now asserts the whole
  sentence, and a second test checks that each of the three cases names the
  right capture — the reader's next action is to go and re-walk one of them.

**Recorded, not fixed.** `geo.triangulate` returns an empty array for a ring
whose first and last vertices coincide, rather than treating it as the closed
ring it is. Nothing in the platform now depends on that behaviour — the one
caller that did has been changed — but it is a trap for the next caller, and
changing a function eleven things already use is not in scope for this work.

**A defect the metering created, found by driving the console.** The ACU
attribution panel was headed "Cost attribution by engine", its column was
"Engine", and its empty state read "No AI usage recorded yet". That was true
when every line in it was an AI engine. It stopped being true when document
rendering started billing through the same wallet, and adding the spatial stages
made it worse and more visible: a customer reading "Engine: Site capture, 5
executions" beside "Engine: BIM twin" would reasonably conclude a model had been
run over their site capture. That is a statement about where their data went,
not a caption.

`attributionByModule` now returns `basis` — `MODEL`, `LOCAL` or `MIXED`, derived
from whether the debits settled against a named vendor or against `LOCAL` — and
the panel is "Where the spend went", with a "Ran on" column reading *A model* or
*This platform*. A module that did both is `MIXED` rather than rounded to
either: rounding to `MODEL` overstates where the data went, and rounding to
`LOCAL` understates it, which is worse. The route description said "AI cost
attribution by engine" and now says what it does.

Verified on the running console, not only in a test: `SITE_CAPTURE` appears on
the owner's statement at 4 runs and £2.00 billed, marked *This platform*, beside
seven AI modules marked *A model*.

**Recorded, not fixed (cosmetic).** `humanise` renders an underscore as " and ",
which is right for `RISK_SAFETY` and `HANDOVER_OM` and gives "BIM and twin" for
`BIM_TWIN`. Pre-existing and P4.

**Still not built.** A dense-stereo provider and a material-classification
provider, both declared and both unserved: they need hardware and a trained
model, and the registry says so rather than pretending otherwise.


### Clearing the recorded-but-not-fixed list

Four things carried forward as recorded and unfixed. Two were real and are now
fixed; two were **not defects at all**, and the notes calling them defects were
wrong. Stating that plainly, because a wrong entry on this list costs somebody a
day finding out.

**Fixed: `triangulate` on a ring that states its own closure.** Every ring in
`geometry.ts` is implicitly closed, so `[a, b, c, a]` is the same three-sided
shape written a different way. Ear clipping could not see that — it compared
vertices by reference, so the repeated `a` was a different object at the same
coordinates, sat on the boundary of every candidate ear, and rejected all of
them. The function returned nothing for a perfectly good triangle. Rings are now
normalised on entry: the trailing repeat goes, and so does any consecutive
duplicate, which is a zero-length edge and breaks the same comparison. A ring
that is only a repeated point now refuses as degenerate rather than returning a
triangle of zero area, which is what it used to do and is worse.

**Fixed: certification could be self-approved.** `certifyApplication`'s own
comment has always claimed it "is separated from whoever submitted the
application". Nothing enforced it. The application recorded `submittedBy` and
certification never read it, so one identity could apply for a payment and turn
it into a debt with nobody else in the loop.

The permission matrix does not close this and cannot: a plain QS has no approve
verb and is stopped, but separation between *roles* is not separation between
*people*, and a small business stacks roles on one person as a matter of course
— which is the business this platform is built for, and exactly why the control
has to sit on the identity. It is a hard refusal matching `REVIEW_SELF_APPROVAL`
on design deliverables, which is the platform's settled convention. No disclosed
override: an override on a money control would be taken every time by the person
the control exists to stop.

**Not a defect: the performance bond is absent from `quantifiedExposureMinor`
on purpose.** A bond is bonding *capacity* committed — finite, shared across
every live job, and not cash going anywhere. Retention is cash the business
funds. Adding them produces a number that is neither, and there was already a
test saying so: *"only retention is exposure; a bond is capacity"*.

What was genuinely wrong was the shape rather than the answer. `exposureMinor`
meant two different things depending on the term, and the totals were
accumulated by hand at two of the three places a term carries a figure — so a
reader could not tell whether the third was excluded deliberately or forgotten.
Terms now declare `exposureKind: 'CASH' | 'CAPACITY'`, both totals are derived
from that, and `committedCapacityMinor` is reported beside the cash so the bond
reaches the headline as its own quantity instead of vanishing. A fourth term
carrying a figure has to say which kind it is; it cannot land in one total or
neither by accident. The settled decision is unchanged and now enforced by
construction rather than by two `+=` lines somebody has to remember.

**Not a defect: the console's 403 prefetches are the mechanism, not a fault.**
The shell asks for `CVR`, `Claim`, `Variation` and the rest and is refused for a
role that may not see them. That is deliberate and load-bearing: `entityBundle`
catches the 403 and records the type as *withheld*, and the overview then says
"commercial position is not visible to your role" rather than "no CVR
published". Predicting the answer client-side instead of asking would replace a
truthful denial with a false statement about the project. A 403 in the network
log is the expected signal here, not an error to design away.

**Also corrected: "BIM and twin".** Not a `humanise` bug — an explicit entry in
the display-name table, which is where `RISK_SAFETY` and `HANDOVER_OM` are
handled too. The engine is BIM and the digital twin, and the label now says so.


### CIS: verification, deduction and the monthly return

Named as absent when the Groupe Nseya case study was assessed, and the largest
remaining gap in the payment chain: the platform ran the Construction Act cycle,
paid subcontractors, and said nothing about the tax it was legally required to
withhold from them.

Every contractor paying a subcontractor for construction work in the UK operates
CIS, at every size. A sole trader with one labour-only subcontractor has the same
obligations as a national contractor — verify before the first payment, deduct at
the right rate, give the subcontractor a statement, and file a return every
month including the months with nothing in them. That is exactly the burden this
platform exists to carry for a business with no finance department.

**The three rules that cost people money, each with its own test.**

*The deduction is on labour only.* Materials the subcontractor bought, and VAT,
come out of the gross before the rate applies. On £10,000 with £3,000 of
materials and £1,400 of VAT, 20% of the £5,600 labour is £1,120 — deducting from
the whole invoice takes £2,000, and £880 of that is somebody else's money.

*An unverified subcontractor is 30%, not 20%.* The rate is derived from the
verification on file and never accepted from the caller, because a contractor
who assumes 20% and is wrong pays the difference themselves. Where nothing is on
file the higher rate applies and the record says whose liability the shortfall
would have been. `UNVERIFIED` and `UNREGISTERED` are kept apart despite sharing
a rate: one is a subcontractor HMRC does not hold, the other is one nobody has
asked about, and the second is a job for this afternoon.

*A nil month still has a return.* Filing nothing because nothing was paid is the
most common penalty under the scheme — £100 the day after the 19th, and it
compounds to £200 at two months and the higher of £300 and 5% at six. A month
with no payments produces a return that says so.

**The tax month is the 6th to the 5th**, which is the trap underneath all of it.
A payment on 3 June belongs to the month that began on 6 May; on the wrong return
that is an amendment and a penalty rather than a rounding difference. Verification
validity runs from the April tax-year start plus two years, so a verification on
1 March 2026 expires a year earlier than a calendar reading gives.

**Rated as at the payment date, not as at now.** A subcontractor who gains gross
status in August does not retrospectively re-rate a June payment on a return that
has already been filed.

**It does not talk to HMRC, and says so on the return.** Verification is
*recorded* — the number and rate HMRC gave, with the date — rather than obtained,
and the return is *prepared* rather than filed. The Government Gateway is a
credential and an integration, not arithmetic, and a prepared return that read as
a filed one would be the worst thing in the module to fake.

Eight mutations, all caught. Driven end to end through the API and the console.

### Every console module parses, and has no array holes

Two invariants, because the same `Promise.all` broke a page twice in one working
session and nothing in the suite could see either.

Once with a **missing** comma, which is a syntax error: the module failed to
load, the view stayed empty, and the only trace was a line in a browser console
nobody was reading. Once with a **doubled** comma, which leaves an array hole —
valid JavaScript that shifts every destructured result after it by one, so a page
renders another endpoint's answer under this endpoint's heading.

`node --check` on every console module catches the first: the same parser the
browser uses, with real module semantics, so a multi-line import or a re-export
is not a false positive, and it parses without executing. It cannot catch the
second, because `[a, , b]` is legal — that one is a text check for a doubled
comma, stated as a text check rather than dressed up as analysis. Both were
verified by re-introducing the exact defects.

Neither replaces driving the page. The array hole rendered a page that looked
fine and was wrong, and only reading the output caught it.


### Retention released, and pay-when-paid named as void

Two more items from the case-study assessment's "not built" list.

**Retention.** The platform has always *withheld* it — every certificate carries
a retention figure and the commercial position sums them — and there was no way
to ever get it back. That is 3 to 5% of the contract sum: cash the contractor
already earned and funded, whose second half is often years away, and which for
a small business is frequently the difference between the job having been worth
doing and not.

**The dates are not computed here, and that is the point.** The first draft of
this module derived them from the contract's defects period, which would have
been a second answer to a question the platform already answers. The completion
certificate *already* sets `RETENTION_FIRST_RELEASE` and
`RETENTION_FINAL_RELEASE`, derived from the contract's clause register, each
carrying the clause it came from, frozen under a hash, and gated on a human
having reviewed the register — the command refuses outright while the clauses
are "awaiting legal review", on the grounds that a defects period nobody checked
is not a date to start a liability running from. This module reads that
certificate and does the money. A parallel derivation would have disagreed with
the certificate the moment a reviewer corrected a clause, and it would have been
computed from unvalidated data.

Finding that out cost three failed test runs against gates that turned out to be
right, and every one of them was the platform refusing to let a shortcut
through. The `addMonths` clamping code that first draft needed is gone.

**What is held is what was withheld**, certificate by certificate — not a
percentage of the contract sum, because the two differ the moment the final
account differs from the contract, which is most of the time. Releasing before
the date is refused, releasing more than the tranche holds is refused, and a
part-release reduces what the next one is measured against. A **sectional**
completion does not start the clock: a car park handed over early is not the
contract complete, and taking it would release the balance of the whole
contract's retention on the strength of it.

The number the module exists for is on the panel first: money that has fallen
due and nobody has claimed. Retention is lost by nobody watching a date a year
out, not by anybody disputing it.

Seven mutations, all caught.

**Pay when paid.** Section 113 of the Construction Act makes a clause
conditioning payment on the payer being paid by a third party ineffective,
except on that party's insolvency. The ITT term assessment now flags it — as a
`MATERIAL` term and deliberately **not** a bar, because the clause does not stop
the bid and does not need negotiating out to make the job safe. It is already
void. What it does is tell the bidder something about the buyer, and stop them
pricing a cash risk they do not carry — which is the expensive mistake, because
the money goes in the price and the competitor who read the Act does not put it
there.


### The two unserved capability slots, resolved

The reconstruction registry declared three capabilities and served one. Both
gaps are now closed, and closed differently — which is the honest answer rather
than a tidy one.

**Material classification is served by the pipeline that already existed.** It
is a vision task, and `engines/perception.ts` is the platform's vision pipeline:
it routes to a multimodal provider, refuses outright when none is configured
rather than letting a text model answer confidently and fictionally, charges the
call, stamps the provenance, and holds the answer as a draft somebody confirms.
Registering a second path under the reconstruction registry would have been a
parallel implementation of that — and it would have skipped draft-then-confirm,
which is exactly the discipline that matters when a model is saying what the
ground is made of.

So `GROUND_MATERIAL` is a ninth perception task, and the routes derive from the
task table, so it got its endpoint from one line. It reports the material, the
share of frame, and whether the ground looks trafficable by tracked plant, by
wheeled plant, or by neither — and it is told not to estimate bearing capacity
and to answer `UNCERTAIN` rather than guess. It carries `conditionsLimiting`,
said by the model rather than assumed by the platform: a photograph taken into
the sun is not a classification, and the model is better placed to say so.

The registry now reports it as available, served by `PERCEPTION_PIPELINE`, and a
caller who asks the reconstruction registry for it is redirected by name to the
route that actually serves it.

**Dense depth is served for the device that measured it, and refused for the
device that did not.** The original slot said "dense depth from imagery", which
conflated two different things. A phone with a depth sensor hands over a depth
*image* — ARKit's `sceneDepth`, the ARCore Depth API — and there is nothing to
solve: every pixel already carries a distance. That is now `DEVICE_DEPTH_MAP`,
and it is real arithmetic: unproject each sample through the lens and the pose,
and mesh by **image adjacency** rather than by Delaunay. That last part is the
whole trick — a depth image is already a grid, so the mesh is O(n) where running
the general triangulator over fifty thousand points would be quadratic, and it
keeps the sensor's own topology instead of approximating it.

A cell with a missing return at any corner is left out. A hole in a depth image
is a place the sensor could not see, and bridging it invents ground.

`DENSE_STEREO` — depth *computed* from imagery, for a device with no depth
sensor at all — stays declared and unserved. It needs a GPU, the register says
so, and it does not quietly redirect to the depth-map provider, which answers a
different question.

**Two mutations survived the first pass and both were the same blind spot
again**: every camera in the suite looked straight down with a *symmetric*
rotation matrix and a flat floor at uniform depth, so neither the intrinsic
scaling nor the R-versus-Rᵀ question changed anything asserted. A site
unprojected with the wrong transpose is mirrored about a diagonal at the right
height with the right extent; a site unprojected without scaling the depth grid
onto the colour intrinsics collapses to a patch the size of a hand, also at the
right height. Both are now caught by asserting the ground footprint — worked out
by hand — from a yawed camera.

One design fix fell out of it: the "two camera positions minimum" guard lived on
the general `reconstruct` path, where it refused a perfectly valid one-frame
depth-map job. It is a requirement of *solving* depth from parallax, not of
reconstruction, and it now sits on the provider that needs it.


### A capability with a provider and no door, and the crash behind it

The section above left `DEVICE_DEPTH_MAP` implemented, mutation-tested and
registered as available. Driving the running console found it was reachable from
nowhere: no route called the provider. A capability register advertising a
capability nothing can invoke is worse than an empty slot, because the empty
slot at least tells the truth.

**`POST /v1/projects/:projectId/site-model/:modelId/reconstruct-depth`** now
serves it, through `sitemodel.reconstructFromDepth`. It writes
`SITE_SURFACE_RECONSTRUCTED` beside the mesh exactly as the feature-track path
does, so slope, segmentation, volumes, the drawing and the viewer read a
depth-sensor capture and a solved one identically. It is metered on the samples
through `meterSpatialStage`, and the charge lands on the ACU statement under
`SITE_CAPTURE` with basis `LOCAL`.

It is a **separate entry point** rather than an optional field on
`reconstructSurface`. One frame is enough here because the distances were
measured; the two-frame minimum that protects the feature-track solve would be
wrong on this path, and relaxing it there would let a one-frame photogrammetry
job succeed at inventing a site.

`noReturnSamples` is reported under its own name rather than as the provider's
`rejected.degenerate`. On this path that counter holds pixels the sensor got
nothing back from, which is not the degeneracy the feature-track solve means by
the word.

#### The defect the small fixtures could never have shown

The first real capture through the new route — a 256 × 192 frame, which is what
ARKit's `sceneDepth` actually produces — built its 92,900 triangles correctly
and then **segmentation returned a 500**.

`Math.min(...levels)` passes one argument per element. At 278,700 levels the
engine's stack is exhausted and the call throws `RangeError: Maximum call stack
size exceeded`. Not slow — dead. Five call sites were written that way: three in
`segmentation.ts` and two in `reconstruction.ts`, and every one was correct on
the two-to-thirty-triangle fixtures they were tested against.

Root cause fixed once, in `geometry.extent`, which finds both ends in one pass
over an iterable of any size. `geometry.bounds` already did this for rings; the
number case had no equivalent and so was rewritten by hand each time, wrongly.

The regression tests pin it at both levels. `geometry.test.ts` asserts that the
array is genuinely past the spread limit — `assert.throws(() =>
Math.min(...many), RangeError)` — before asserting `extent` handles it, so if a
future engine raises the cap the test says it no longer covers what it was
written for. `segmentation.test.ts` segments a 50,562-triangle mesh end to end
and checks the figures by hand, because the unit test alone would not have
noticed the segmenter reverting to a spread.

This is the second time this session that reading real output caught something
the whole test suite was blind to, and the pattern is the same both times: every
fixture was small enough to be checked by hand, which is exactly what made them
unable to find it.

#### One console correction

The field page's capability panel was headed "Reconstruction from a device with
no depth sensor". True when the only provider was the feature-track solve; with
`DEVICE_DEPTH_MAP` in the same table the heading contradicted a row beneath it.
It now names both.

**Verified over HTTP**, not inferred: 201 with 92,900 triangles and 2,255
no-return samples held as holes, `chargedMinor` 555; segmentation 200 reading
95.59m² of workable ground off it; the charge on the QS's bill under
`SITE_CAPTURE`/`LOCAL`; the door present in `GET /v1/commands`; and a frame the
sensor reached nothing on refused 422 `RECONSTRUCTION_EMPTY` with no surface
written. The construction manager is refused the bill — 403 — which is the
commercial scope working, not a fault.


### The invitation-to-tender input, validated at the boundary on both routes

Probing the s.113 pay-when-paid finding over HTTP found the term working exactly
as designed — MATERIAL, no exposure figure because the Act has already voided
it, not a bar, and a clarification asking the buyer to confirm or delete the
clause. It also found that the probe's *other* terms had been silently ignored,
because they were spelled wrong.

**`terms` was `{ type: 'object' }`.** Open, on the reasoning that an absent field
is meaningful — no stated bond is not a bond of zero — which is right. But
optional properties already carry that, and openness bought nothing while
costing this: a payload sending `paymentTermsDays` instead of `paymentDays`
returned 201, `readyToPrice: true`, and the payment period never assessed.
Silence from a mistyped field and silence from a buyer who said nothing are
opposite facts, and on a £4.8m invitation the analysis could not tell them apart.

**`/v1/pipeline/tenders/:invitationId/requirements` was worse.** It passed the
analyser's *entire* input as `{ type: 'object' }`, with a comment saying the
shape "has its own schema on `/v1/projects/:id/itt`" — true, and worth nothing,
because a schema on one route validates nothing on another. That route accepted
any object at all.

Both now reference one `ITT_ANALYSIS_SCHEMA`, with the commercial terms closed
against `CommercialTerms`. A mistyped field is a 400 naming it —
`terms.paymentTermsDays — is not a permitted property` — and absence is still
absence.

**Verified over HTTP**: the typo refused by name; the same invitation spelled
correctly returning six term assessments including the 60-day payment finding
that had been missing, £1,790,000 of cash exposure and £480,000 of bonding
capacity kept apart, no bars, and three clarifications.

**Considered and not built**: a register of terms the invitation was silent on.
The route comment used to claim the analyser "reports what was not stated" and
it does not. With the schema closed, silence now genuinely means the buyer said
nothing, which is the precondition for reporting it — but which absences are
worth raising is a product judgement, not a defect, so the false claim is
removed rather than a feature invented to justify it.


### The self-certification refusal, proved through the socket

The control that stops one identity certifying its own payment application was
built and unit-tested. What had not been shown was that it is the refusal a
caller actually *gets*, and the earlier HTTP probe could not show it: a plain QS
is stopped by the permission matrix with `ACCESS_DENIED` before the handler runs,
because it has no approve verb on payment applications. A test that saw only
that would prove RBAC works and say nothing about the control.

`api.test.ts` now applies and then certifies over real HTTP with a **role-stacked
token** — QS and Owner on one identity, which is what a small business does as a
matter of course, and the exact case separation between *roles* cannot see. The
gateway returns **409 `CERTIFICATION_SELF_APPROVAL`**, and the test asserts that
title specifically: `ACCESS_DENIED` there would mean the matrix stopped it and
the control was never consulted.

Two mutations confirm the test is load-bearing. Removing the control fails it;
so does dropping the second role, which is the failure that documents why the
stack is there.


### The two commercial risks of standing between a client and a panel

A question about whether the platform supports coordinating suppliers at every
business size, and it exposed a stored label that changed nothing plus a legal
point the platform already knew and was not applying where it mattered.

#### "Back-to-back terms" is two arrangements, and only one of them works

The mitigation usually proposed for the cash trap is back-to-back payment terms.
The phrase covers two things that behave completely differently.

**Conditional** — pay the supplier when the client pays — is of no effect under
**HGCRA 1996 s.113**, except on the third party's insolvency. A business relying
on it has no mitigation: the supplier's money falls due on the contract date
regardless, and an adjudicator says so in weeks.

`itt.ts` has always said exactly this to a bidder reading somebody *else's*
invitation. Nothing said it about the subcontracts this business issues, which
is the one place the business would be relying on the clause.

**Timing** — pay the supplier later than the client pays this business — is a
payment period, which s.110 requires the contract to state and nothing
prohibits. It is the mitigation, and it is arithmetic rather than a clause that
will not survive contact with an adjudicator.

`recordTradingTerms` holds both payment periods and `assessTerms` derives the
gap in days, prices it at the current rate of supplier spend, and states what
the law says about how it was arrived at: the s.113 finding as a **BAR**, the
**PCR 2015 reg 113** 30-day flow-down on public work as a **BAR**, and a period
beyond `grosslyUnfairPaymentDays` as **MATERIAL** under the Late Payment of
Commercial Debts (Interest) Act 1998. The conditional clause is *recorded* rather
than refused — it is void, not criminal, it is in standard documents across the
industry, and a business needs to know it is there and worthless.

#### The trading model was a label that changed nothing

`ADVISORY | MANAGEMENT_INTEGRATOR | PRINCIPAL_SERVICE_CONTRACTOR` was stored on
the account and never read. A pure fee appointment was priced as a percentage on
top of supplier cost — reporting £6.25M of contract value where the business
will only ever invoice £1.25M — and then measured against a reserve for supplier
payments it does not make. Both answers were wrong in the same direction: they
described a business carrying an exposure it had deliberately arranged not to
carry.

`TRADING_MODEL` now turns on one question — **whose money pays the supplier** —
and the rest follows. On a fee model the contract price is the fee alone,
contingency is nil because the supplier contracts are the client's, and the
reserve, funding-gap and paying-out-faster concerns do not arise. The catalogue
is **published on the position** so the console's model picker renders from it;
two of the three descriptions the console carried had drifted into saying the
opposite of what the platform now does.

It also names what the fee model *costs*: never funding supplier cost is a real
mitigation with a real price, which is that every supplier holds its own contract
and its own invoice line with the client — the position a supplier needs to be in
to take the appointment itself next time.

#### Two things reading the rendered panel caught

**The concern count was swallowing the reserve position.** `reserveVerdict`
returned the count *instead of* the reserve sentence, so the moment anything
needed attention the reader lost the answer this screen exists for. "3 things
need attention" says nothing about whether there is money in the account.

**No gap was being reported as unmeasured.** Three cases, not two: a gap with no
rate of spend to price it is genuinely unmeasured; a gap of zero or less is a
*measurement* of nil, because the money arrives before it leaves whatever the
rate turns out to be. The panel was showing a business that had got its terms
right and telling it the answer was still pending.

**Verified over HTTP**: the model catalogue; a fee appointment on £5m returning
£1M of fee, £0 passing through and £0 contingency with no supplier-cash concerns;
the same £5m as principal at £6.25M with £250K contingency; pay-when-paid on a
public contract returning `lawful: false` with the s.113 finding; and the
corrected 30/45-day terms returning a −15 day position and no concerns at all.

#### Still not built: protecting the client relationship

The second half of the question — panel suppliers approaching the client
directly — has **nothing behind it**. `framework.ts` builds frameworks, lots and
call-offs, but there is no record of who owns the client specification, whether
the relationship is single-invoice, what share of contract value sits with one
supplier, or any non-circumvention term. `TRADING_MODEL` now states the margin
exposure of each model in words; nothing measures it. Recorded here rather than
implied by the section above, which is about cash.


### Protecting the position: panel suppliers going direct

The half of the integrator's exposure that had nothing behind it. `TRADING_MODEL`
states each model's margin risk in words; `domain/intermediation.ts` measures it.

#### Five defences, and what each one does not do

`DEFENCE` holds specification ownership, the single invoice, a framework term, a
non-circumvention clause and the performance record. Each carries **`holds` and
`doesNotHold`**, and the second is the more useful half. A business with three of
these that believes it therefore cannot be displaced has stopped doing the thing
that keeps it there. The register says in as many words that a non-circumvention
term **binds the supplier and not the client** — a client that appoints the
supplier directly is not a party to it — and that this is the defence most often
relied on and the weakest of the five.

**Never assessed and assessed as absent are kept apart.** Only one of them is
somebody's decision, and collapsing them reports a business that has not looked
at this as one that has looked and found nothing.

A defence claimed as in place with no evidence is refused: that is the belief the
register exists to test, written down as a fact.

#### The refusal that matters

This is the one place a margin-defence feature can do real harm, so the
distinction is in the command rather than in a note.

A non-circumvention term between this business and **its own subcontractor** is a
vertical restraint and ordinarily lawful. An arrangement with a **competitor** not
to approach each other's clients — or the **panel agreeing among itself** not to
bid, which is the same cartel with this business in the middle — is customer
allocation: a *by object* infringement of the Chapter I prohibition of the
Competition Act 1998, with no effects analysis, no small-agreements exclusion,
and director disqualification and the cartel offence behind it.

`recordDefence` asks what the counterparty is, refuses the horizontal case by
name with a **409**, says what *is* recordable instead of only refusing, and
records the declared answer. It cannot stop somebody describing a competitor as a
supplier; the record then shows what was declared, by whom and when.

#### Concentration, measured off the subcontracts

`sharesOf` groups committed value by supplier, largest first, and marks the ones
recorded approaching the client. Judged against the business's **own framework
target** where it has set one — a firm that has said "no supplier above 30% of
this framework" has answered with more care than a platform default can, and
measuring against 40% would tell it it was fine while it breached its own policy.

The acute case has its own concern: a supplier over the threshold **that has
already approached the client**. That is where the appointment is lost, and it is
lost between two renewals rather than at one.

#### Two hollow tests, found by mutation

Both were written against the demonstration seed and both were vacuous:

- The seed lets **exactly one package**, so the ordering assertion looped over a
  list of one. Reversing the sort and deleting it entirely both survived. The
  share arithmetic is now `sharesOf`, tested against three suppliers with
  hand-checked figures — 50/30/20 on £10m — plus packages summed per supplier, a
  subcontract with nobody on it, and a total of zero.
- The seed creates **no framework**, so both clock tests were `if (!framework)
  return` — a guard that reports success for the absence of its own subject. A
  mutation counting an expired framework as still running survived. The tests
  now build a real framework and assert the days remaining, the notice boundary
  in both directions, and the threshold coming from the framework's own target.

Eleven mutations run; all eleven now caught.

#### Two defects reading the rendered panel caught

`It binds the supplier, not the client` was written with markdown emphasis and
printed **as literal asterisks** — the console does not render markdown and
should not have to. An invariant now refuses markdown in any of these strings.
And the evidence was appended to the sentence before it, so the panel read
"…the easiest line on the account to question. One consolidated application per
month". It has its own line now.

**Verified over HTTP**: the competitor and panel-to-panel restraints refused 409
`RESTRAINT_UNLAWFUL` naming the Act; a missing relation refused 422; the same
term with an own supplier accepted 201; a defence claimed with no evidence
refused 422; `RELYING_ON_THE_WEAKEST` raised when the clause was the only one in
place and cleared by a second defence; and a direct approach by the 100% supplier
raising `CONCENTRATED_AND_APPROACHING`.


### The same supplier across every job, and who at the client we know

Two gaps recorded as not built at the end of the margin-defence work, now built.

#### Cross-project exposure, and a finding that could not fire

`supplierExposure` is tenant-scoped: every supplier, across every appointment,
with the share of the business beside the largest share on any single job.

**The first definition of the headline finding was arithmetically impossible.**
It flagged a supplier whose tenancy share was above the threshold while every
project share was below it — and a tenancy share is the value-weighted *mean* of
the project shares, so it can never exceed the largest of them. The condition
could not fire; a mutation switching the whole finding off passed every test.

The real phenomenon is the one the question described: a supplier at a fifth of
five jobs is unremarkable on each and is the largest single thing the business
depends on. `hiddenByProjectView` now means **the largest counterparty in the
business, on more than one appointment, breaching nothing on any of them** —
every project review says "unremarkable" and none of them is asked whether the
same firm said it five times. The impossible shape is pinned as an arithmetic
invariant, because the next person to tighten this rule will reach for it again.

Two more findings only this scope can produce: a supplier **on every appointment**
(a different fact from a large share — it is about how replaceable the
relationship is), and one that has **approached the client on more than one job**,
which says something about the supplier rather than about a job.

`exposureOf` is separated from the ledger read for the same reason `sharesOf`
was: the demonstration seed lets one package on one project, so nothing built
from it can exercise the case the view exists for.

#### Who at the client this business actually knows

A name, their part in the decision, and who here holds the relationship. Three
findings: **nobody who decides** (knowing four people who run the job and none
who signs the next appointment feels like a strong relationship right up to the
renewal), **the whole relationship held by one employee** (it belongs to them
rather than to the business, and leaves when they do), and **a counterpart who
has gone** — marked rather than deleted, because at a renewal that is the single
most useful row on the register.

A departed contact stops counting as able to decide. Data minimisation is the
schema rather than a policy: there is nowhere to put a personal number, a private
address or a note about what somebody is like, and `additionalProperties: false`
refuses one at the boundary — `personalMobile` comes back 400 *is not a permitted
property*.

#### Found by running the walkthrough twice

The contacts table showed six rows for three people. Not a rendering bug — two
runs — but it exposed a real defect: nothing stopped the same person being
recorded twice, and both the contact count and the owner count drive findings, so
duplicates report a business as knowing six people when it knows three. Recording
a contact is exactly the command somebody runs again because they are unsure it
took. It is now refused with a 409 naming who holds the existing entry and
pointing at the update path; correcting a row by its own id is unaffected.

**Fourteen mutations run across this work; all fourteen caught.** Three survived
the first pass and each was a hollow test written against seed happenstance —
one project, one supplier, no framework — which is the same failure mode as the
two found in the previous section.

**Verified over HTTP**: the exposure view at 200 with the threshold and its
source; the relationship raising `NOBODY_WHO_DECIDES` on two operational
contacts, clearing on a sponsor and returning when she leaves; and the three
refusals — no owner 422, an invented role 400, a personal mobile 400.


### The programme in dates: a calendar-aware scheduler

The platform had a correct CPM engine — FS/SS/FF/SF, lag, total and free float,
cycle detection — that schedules in **abstract working-day indices**. That is the
right shape for the Monte Carlo simulation and it is not a programme: it has no
dates, no calendars, no data date and one constraint type.

`engines/maths/calendar.ts` and `engines/maths/schedule.ts` are the programme.

**A calendar per activity.** Working weekdays plus exceptions in both directions
— a bank holiday out, a Saturday pour in. Compiled once into an ordered list of
working dates plus a date-to-ordinal map, so every question is an index lookup
rather than a day-by-day loop; on a three-year programme with six hundred
activities and two passes, the loop version is tens of millions of date
constructions per reschedule. A date outside the compiled span is refused rather
than answered, because answering means guessing which days were working days.

**A data date**, with the three states derived rather than asserted: nothing
unstarted is forecast before it, completed work is pinned to its actual dates
whatever the logic says, and running work is forecast from the data date on its
*remaining* duration rather than on the duration it was planned at.

**Out-of-sequence progress, both ways.** Retained logic holds an out-of-sequence
activity's remainder behind its unfinished predecessor; progress override lets it
run. On the worked example they differ by a week, and the result carries which
setting produced it — a tool that silently picks one is hiding the assumption
that moved the date.

**Nine constraint types**, and a constraint that contradicts the logic is *not*
refused: it is scheduled and reported as negative float, which is what a planner
needs to see. **Longest path** is traced back through driving relationships from
whatever finishes last, kept separate from float ≤ 0 because with multiple
calendars and constraints they are not the same set.

**WBS roll-up** weights progress by duration. Counting activities makes a two-day
snagging item worth as much as a forty-day pour, and a branch is reported as
half done when a tenth of the work is.

#### Three defects, all caught by hand-worked dates

**The finish-to-start step was conflated with the lag.** A successor may begin
the *calendar* day after its predecessor finishes — a turn of the calendar, not a
day of anybody's work — and the lag on top of that is working days. Taken as one
working-day step on the predecessor's calendar, a concrete cure running through
the weekend waited until Monday for a pour that finished on Friday: two invented
days on every such pair.

**Running work was pinned to the data date unconditionally**, discarding the
retained-logic hold. That made retained logic and progress override give the same
answer, silently, on the one case they exist to distinguish.

**A cycle crashed instead of being reported.** Activities inside one never reach
the topological order, so the pass read `undefined` out of the date maps. They are
now scheduled after everything reachable and the cycle is the finding.

Eight mutations run; one survived because every backward move in the suite
started from a working day, where the roll direction cannot matter. The case that
discriminates — one working day back from a Saturday — is now asserted.

#### Not yet built, so it is not mistaken for done

Resources and resource levelling, activity codes, multiple float paths, and the
domain, routes and console door for any of this: the engine exists and nothing
reaches it yet.


### Charts the platform's own data needed and nothing drew

The console had two chart types — a line and a ranked bar — on six pages, none
of them a delivery or commercial page. Every figure elsewhere was a number,
which answers "what is it" and never "which way is it going" or "what is it made
of".

Six added to the chart kit (then `frontend/lib/chart.js`, since merged into
`frontend/lib/charts.js`), all inline SVG on the settled
zero-dependency decision, all holding to the three rules the file already had:
no invented axis, an empty series draws its empty state rather than an axis
around blank space, and nothing is smoothed.

**`sparkline`** is the one that makes "everywhere" possible: a shape small enough
to sit beside a number in a metric card or a table cell, with no axis, no grid
and no labels, because at that size they are illegible. Fewer than two points
draws a dash — one point is not a trend, and drawing a dot and calling it one
makes every other chart on the page less trusted.

**`ganttChart`** draws the data date as a line, the baseline as a rule *under*
the bar rather than over it, milestones as diamonds (a zero-duration bar is
invisible and widening it states a duration the activity does not have), and the
**longest path** in the accent rather than "critical" — with calendars and
constraints those are different sets and the driving chain is the one worth the
colour.

**`histogram`** counts what a simulation produced rather than fitting a curve
through it, because a fitted curve puts probability on outcomes the model never
generated. **`stackedBarChart`** holds segment order constant across columns, or
the stack cannot be read across. **`waterfall`** shows how a total was arrived at
step by step — the shape a price build-up and a variance bridge both want.
**`donut`** is capped and every slice carries its figure, because a ring is poor
at comparing similar slices and nobody should have to judge an angle.

Placed so far: the waterfall on the integrator price build-up — a client arguing
about "twenty per cent" is arguing about a total, and this is the only view that
shows which step they object to — and the donut on cross-project supplier
exposure.

**Verified in a browser**, which is the only place a chart can be: six waterfall
bars in the right classes, the donut rendering with its figures, no collapsed
SVG, no `NaN` in any attribute, no page errors. A chart that computes `NaN` still
renders an element and simply shows nothing, so the check is for the attribute
rather than for the exception.

**Not yet placed**: the sparkline, histogram and stacked bar have no callers, and
the Gantt has nothing to draw until the schedule engine has a domain record and a
route. Named here rather than implied by the section above.


### The programme gets a door, a screen and a Gantt

The dated scheduler had no way in. `domain/programme.ts` is the way in, and it is
built on the records the platform already has rather than a parallel activity
model: `WorkPackage` and `ScopePackage` are the breakdown, `Task` is the
activity, `Dependency` is the relationship. What was missing from a `Task` was
the half-dozen fields that make it schedulable in dates — a calendar, a type, a
constraint, actual dates and a remaining duration — and those are **added to it**
rather than copied into a second table that would immediately start to disagree.

Genuinely new: the **calendar**, which nothing owned, and the **schedule run**.

**A run is a record.** A programme is not a calculation, it is the statement the
team works to and the one an extension of time is argued against. Recomputing on
every read would mean the dates changed under whoever was reading them, and "what
did the programme say on the 15th" would have no answer. The run stores its dates,
its data date and the options it used — two runs of the same network under
different out-of-sequence settings are two different statements.

The view is **live** and reports the last run beside it. Both are needed: the run
to argue against, the live one to decide what to do this week.

Four commands, four doors on the Programme page: schedule the programme, set an
activity's calendar and constraint, update its status, define a calendar. Plus
the **Gantt** — bars on a date axis with the data date, the baseline underneath,
milestones as diamonds and the longest path in the accent.

#### Two defects the walkthrough found that no test would have

**The breakdown was empty on real data.** The platform has *two* package concepts
— `WorkPackage` with a code and `ScopePackage` with a name — and the demonstration
project's activities reference the second. Reading only the first left every
activity with no breakdown path and the roll-up table blank. Both are resolved
now, and activities under neither are **counted**, because an empty breakdown and
a project whose activities were never filed under anything look identical on
screen and only one is somebody's job to fix.

**Two records of "done" that disagree, with nothing saying so.** Every seeded
activity is 100% complete in the field and has no actual dates. `recordProgress`
is the field record — a foreman claiming against evidence — and it writes a
percentage; the schedule needs a *date*. Without one the programme forecasts work
that has already happened, and the roll-up rendered it as **"0 of 8 complete,
100% done"** — the shape of the disagreement rather than a report of it.

It is now a named finding with the consequence spelt out: every date after those
activities is pessimistic, and an extension of time argued off this programme is
unarguable in the wrong direction. It clears when the dates are recorded, so it
is a thing to fix rather than a permanent scold.

**Verified over HTTP and in a browser**: 8 activities dated on the flagship
project with 7 on the longest path; two bank holidays moving the finish from
2027-11-30 to **2027-12-02**, which is the entire point of calendars; F9 storing
the run; all four refusals firing; and the Gantt rendering 8 bars, 7 driving, a
data-date line, no `NaN` in any attribute and no page errors.

#### Still not built

The charts remain fitted to a handful of panels rather than across the console.


### Multiple float paths, and what is actually holding each activity

`floatPaths()` in `engines/maths/schedule.ts`, published through the programme
view and the Programme screen.

One critical path answers what is driving the finish date **today** and nothing
else. The question a planner has is what drives it **next**: a chain with three
days in hand becomes the critical path on the fourth day of a delay, and by then
the argument about who caused it has been had. This is what planners move tools
to get.

Three decisions worth stating:

- **Path 1 is the driving chain, not every activity at zero float.** With
  calendars or constraints in play those are different sets — an activity
  constrained to finish on the day it finishes reads as critical and delaying it
  moves nothing. Ranking off the float column puts that activity in the middle of
  the answer to "what is holding the job".
- **A path is a chain, not a bag of activities sharing a float value.** It is
  traced through *driving* relationships, so it reads as a sequence of work that
  can be walked through with a subcontractor. Where a chain forks it follows the
  tighter branch; the branch not taken comes back at the rank its own float
  earns rather than being dropped.
- **Where a chain merges is the number that matters.** Four days of float feeding
  the critical path next month and four days feeding nothing until handover are
  different risks, and a float column cannot tell them apart. The merge point is
  by definition a *non*-driving link — if it were driving, the chain would be
  part of the path it merges into — so it is found through the relationships
  rather than the driving map.

The forward pass already knew which predecessor set each activity's early start
and threw it away. It is now published as `drivingPredecessorId` and rendered as
a **"Held by"** column: the single most-asked question in front of a Gantt chart,
answered without a second lookup.

**Verified**: 33 unit tests on hand-worked dates, **nine mutations all caught** —
including two that survived the first fixture (path 1 taken from the float column
rather than the driving chain, and chains never extending forwards) and were only
killed once fixtures existed that could tell the difference. Driven over HTTP and
read in a browser on the flagship project: seven activities on path 1, the filter
gallery on path 2 with 50 days in hand, merging into the process pipework.


### Review and comment on the programme, for everybody it lands on

`domain/programmereview.ts`. Two disciplines, and both are about what a register
may not claim.

**A review is of a run, not of "the programme".** Every comment is anchored to
the version it was made about, so it can be read back in two years as an
objection to something reconstructable. Rescheduling deliberately does **not**
close or move an open review — that would silently reattach comments to a version
nobody made them about, and discard the objections to the version somebody would
later want to point at — but `supersededByLaterRun` is reported on the position
and said in as many words on the screen.

**Silence is never agreement.** Three participation states are kept apart:
objected, reviewed-without-objection, did-not-respond.
`reviewedWithoutObjection` is **always empty** and that is the design: this
platform has no way for a party to say "I read it and have no objection", so
nobody can be recorded as having said it. Filling it from the invitation list
would be exactly the deeming the module exists to refuse. The summary says the
number who did not respond, says it is not agreement, and says that whether it
becomes acceptance is a question about the contract rather than about the
register.

Commenting is authorised on `PROGRAMME_BASELINES` **R**, not `U` — the objection
worth having comes from the party who has to do the work, and requiring the
authority to change a programme in order to say something about it would leave
only the planner able to comment. Issuing, answering and closing are on **A**.
Every disposition but a plain acceptance carries a reason, and `NOTED` is a real
answer rather than a synonym for accepted. A review will not close while any
comment is unanswered; an answer once given cannot be rewritten.

**The boundary, stated rather than quietly widened**: 14 roles hold
`PROGRAMME_BASELINES` R and can therefore comment. `SUPPLIER` does not, so a
supplier cannot comment on the programme. Widening the permission matrix is a
security decision and is not made here.

#### A defect the rendering found and no test could have

The invitation list held free text while a comment recorded the actor id that
made it. The two halves of the participation split were in different
vocabularies, so **a party who had objected was still reported as having said
nothing** — a register producing a false silence, which is the one thing it
exists not to do. It is only visible when the register is read: every test
passed, because every test invited the same strings it then asserted on.

An invitation now carries the identity **and** the name: the id is what a
comment's author is matched against, the name is what keeps the closed record
readable once the person has left. The console door is a multi-select of real
people from `/v1/users` rather than a box to type names into. `invitedCount` is
published because objectors are not a subset of the invited — a review is open to
anybody who can read the programme — so adding the two lists together overstates
who was asked.

**Verified**: 22 unit tests, and **nine mutations of the original module plus
five of the fix, all fourteen caught**. Driven over HTTP end to end — run, issue,
three comments of three kinds, two dispositions, the refusal to close over an
unanswered comment — and **read in a browser**, where the register shows five
named people, one objector, four silent, and "of 5 invited".


### Resources, the histogram and levelling

`engines/maths/resources.ts` and `domain/resources.ts`, with a route, a door and
a panel on Programme.

A critical path assumes infinite resource. It will put two pours side by side
that need the same gang and report a date nobody on site can hit — which is why
the resource histogram is the second thing any planner opens after the Gantt.

Three things kept deliberately separate, because merging them is how a resource
tool comes to lie:

- **The histogram** is demand against availability, and it **never smooths the
  curve to the limit**. A demand line drawn at the availability line is a
  programme made to *look* achievable rather than made achievable, and the person
  it fools is whoever has to build it. Availability is a limit, not a plan.
- **Levelling** delays work into its own float until the demand fits. It never
  moves an activity past its late finish: levelling inside float rearranges work,
  levelling beyond it changes the completion date, and that is a commercial
  decision rather than an arithmetic one.
- **What levelling could not fix** is the answer that matters. A leveller that
  always succeeds has either extended the programme without saying so or lifted
  the limit. What will not fit is reported with the number of days it would take,
  and placed at its late start anyway — over the limit — because dropping it
  would understate every resource day after it.

Two further decisions stated rather than buried:

- **Demand is counted on each activity's own calendar.** A cure on a seven-day
  calendar puts demand on a Saturday and a pour on a five-day one does not.
  Rolling both onto one project calendar either invents weekend labour or hides
  it, and those are the two ways a resource histogram lies.
- **The priority rule is published** — least total float first, then earliest
  start, then id. Two levellers with different priority rules give different
  programmes from the same inputs, and a tool that will not say which it used has
  made the choice on the planner's behalf.

The console histogram is **weekly and carries the peak inside each week, not the
average**: an average smooths away the Tuesday that needs three gangs, which is
the only day on that bar anybody can act on. The chart component gained a
**limit line** — a demand curve without the line it is judged against is a
picture of some bars, and the reader cannot tell a comfortable week from an
impossible one.

#### Two defects found by running it, not by testing it

**Started work was competing for its own resource.** Activities with an actual
start sat in the same priority queue as everything else, so an unstarted activity
sorted ahead of one already under way could be given the days that work was
physically using. Started and complete work is now committed *first* and the rest
of the programme arranged around it — levelling an actual date would be rewriting
history to make an arithmetic problem go away.

**A forced placement read as a success.** An activity that would not fit inside
its float appeared in both `levelled` and `unresolved`, so a programme that had
not levelled looked as though it had. Forced placements now appear only in
`unresolved`, carrying `placedAt`.

**Verified**: 11 engine tests and 6 domain tests on hand-worked dates, **seven
mutations all caught**. Driven over HTTP and read in a browser on the flagship
project: 45 weekly bars, 15 of them over the line, the dashed availability line
drawn, no `NaN` in any attribute, and one activity reported as unfittable with 50
days of float and 70 days of shortfall behind it.

Two rendering defects the browser caught and no test would have: the histogram's
empty state read *"A distribution appears once the simulation has been run"* on a
labour chart — a Monte Carlo assumption left in a component that now draws two
different things — and the crane with no demand needed an empty state that said
it was defined and unused rather than one that explained nothing.

#### Where this deliberately stops

Resource **cost** is recorded (`dayRateMinor`) and not yet rolled into a
resource-loaded cost curve; the cash-flow model is built from the commercial
records instead. Levelling smooths against availability and does not attempt
resource **smoothing to a target profile**, which is a different problem and one
no measured requirement here calls for.


### Activity codes: grouping the same work a way that is not the breakdown

`rollUpCode()` in the engine, `defineActivityCode` and code values on
`setActivityAttributes` in the domain, a panel and two doors on Programme.

The WBS answers "what is this job made of" and every activity sits in exactly one
place in it. A code answers a different question — everything the M&E
subcontractor owns, everything in the north basin, everything in commissioning —
and that work is scattered through six branches of the breakdown, which is
precisely why the breakdown cannot produce the view. It is the view somebody
takes into a subcontractor meeting.

Decisions worth stating:

- **Values are a closed list.** The use of a code is that it can be counted, and
  one activity coded `M+E` against nine coded `MECHANICAL` is a group of nine and
  a mystery. A value off the list is refused.
- **Codes merge rather than replace.** Setting the discipline does not silently
  drop the area somebody else coded — the same rule as a constraint, where an
  explicit null clears and an omission leaves alone.
- **What nobody has coded is counted**, for the reason unassigned activities are:
  an empty group and a programme nobody has coded look identical on screen.
- **Rows come out in the order the code declares its values**, not
  alphabetically. A code is usually a sequence — civils, mechanical,
  commissioning — and sorting by the value's own spelling turns that into civils,
  commissioning, mechanical, which reads as no order at all. Found by reading the
  rendered table; the first fixture could not catch it because its two values
  happened to be in alphabetical order already.
- **The console offers every value a code can take**, not only the values
  something already carries — a door built from the groups could never code the
  first activity against a new code.

**Verified**: 6 domain tests, driven over HTTP and read in a browser — two codes
across seven activities, a refused value, codes surviving an unrelated calendar
change, and the door offering both codes with all their values.


### Making it look like a product somebody built

Three changes, in descending order of how much they mattered.

**A real typeface, self-hosted.** The stylesheet said there could be no webfont
because the server sends `font-src 'self'` and a font CDN would be blocked. The
first half was right and the conclusion was one step short: **a file served from
this origin is `'self'`.** Nothing about the header changed, no third party is
contacted, and no security posture was traded for it.

IBM Plex — sans, condensed and mono — is now served from `/fonts`, 130KB for the
whole family (the sans is one variable file covering 100–700). Plex rather than
Inter or Space Grotesk, which are the two faces every generated interface reaches
for and which therefore read as one; Plex was drawn for an engineering company
and looks it. Three roles: `--sans` for what is read, `--display` (Condensed) for
headings, `--mono` for every number in a column. Both stylesheets declare the
faces, because the site and the console are independent files that already
restate the palette for the same reason. Every stack still ends in the native
faces — a font that fails to load should degrade to the interface it replaced.

**The demonstration team has names.** The seeded identities were called after
their own job titles: `Project Manager`, `Quantity Surveyor`, `Site Manager`. The
role is already carried separately and rendered beside the name wherever the
console shows one, so the name said nothing twice and left every screen — owner
of a decision, author of a comment, who signed the permit — reading like an org
chart with nobody in it. The morning briefing made it plainest: it greeted the
signed-in user by first name and said **"Good morning, Project."** It now says
"Good morning, Tom." Roles, permissions and every assertion that turns on them
are untouched.

**The landing page's generated gestures, removed.**

- The headline put its second and third lines in Signal Orange. That is the most
  recognisable machine-made-landing-page move after the gradient fill, and it
  broke the rule the palette is built on — orange means something on every other
  screen, and a headline wearing it teaches the reader it means nothing. The
  emphasis is now typographic, which is what typography is for.
- Seven rounded chips in a wrapping row became a **drawn spine**: a rule with a
  tick at each stage and the last one marked, because the claim is a
  thirty-year sequence with no break at handover and the form should carry the
  argument. The first attempt divided it into seven equal columns, which broke
  COMMISSIONING across two lines; distributing the ticks and letting each label
  take the width it needs reads as a scale, which is what it is.
- The mock console wore macOS red-amber-green window buttons. It shows the
  product's own chrome now — a breadcrumb and a verification state — because
  three coloured dots are a costume every mocked-up panel on the internet wears.
- Four enormous numerals across the foot of the hero became a **specification
  strip**: label, then value in mono, hairline between each. These are not a
  growth metric, they are the dimensions of a system, and a dimension is read
  after the thing it dimensions. Three of them, not four: the
  communication-event count was dropped — a number that means nothing to a buyer
  and competes with the three that do.

**A documentary spine on the prose pages.** A centred 760px column of headings
and paragraphs is what every generated documentation page looks like, and it is
the same page whatever it is about. There is now a hairline down the left with
each section marked against it — how a standard, a specification or a contract
is set, which is what this product is about, so the page is set the way the
thing it describes is set. Running text stops at 68 characters, and the rule
goes on a phone where it would cost a word a line.

**Verified**: the faces load and the variable weight axis measurably works (400
and 700 render at different widths); the landing, how-it-works, developers, demo
and get-started pages plus the console render with no console error; the full
suite is green at 4,532.

#### The console, and the charts that had no callers

**The figure strip.** The briefing opened with four numbers floating in a grid,
two of them accent-coloured. It is now a `.figure-strip` component — hairline
between each cell, label first, then the figure — for the same reason the hero's
was: nothing said the four belonged to one statement, and the whitespace read as
four unrelated boasts. Only the two that carry a condition keep their colour;
the count of opportunities recommended lost its orange, because spending the
accent on a neutral figure is how the accent stops meaning anything. Built as a
reusable class rather than a fourth hand-rolled row.

**Percent Plan Complete was a chart drawn by hand.** Twelve inline-styled divs
with a gradient background, sitting on a page that imports a chart library. It
is now the histogram, measured against the 85% line Last Planner is judged by —
the same threshold the panel already colours its headline figure on, rather than
a second number nobody reconciled. The component gained `markPast`, because
demand *over* an availability is a problem and reliability *under* a target is a
problem, and only the caller knows which way round it is.

**The sparkline has a home.** The forward cashflow's cumulative position, above
the table it summarises: a table of twelve periods answers "what happens in
period 7" and hides the only question anybody opens the panel with, which is
whether the line goes under and roughly when.

**`stackedBarChart` still has no caller, deliberately.** No screen currently
holds a composition-over-time series. The nearest candidate — several resources'
demand across the same weeks — is in different units, and stacking gangs on
cranes would produce a total that means nothing. Named here rather than forced.


### The agent fleet, at the point somebody is looking at the number

The fleet was already built — **58 agents, 49 deployed**, across nine divisions.
What was missing was reach: the insight panel sat on **10 of 52 console
screens**, and everywhere else the only way to see what the agents found was the
autopilot queue, which is the screen a person opens once they have *already*
decided to look. That is backwards, and it is why a large fleet felt absent.

Three screens gained the panel — the three with agent coverage and no way to see
it:

| Screen | Areas | What watches it |
|---|---|---|
| Concept | `BUDGET_COST`, `PROJECT_SETUP` | the cost-plan agents |
| Construction | `SAFETY_RAMS`, `QUALITY_COMMISSIONING`, `FIELD_EXECUTION` | the HSEQ and field agents |
| Pipeline & Bids | `BUSINESS_DEVELOPMENT`, `ESTIMATE_TENDER` | the 16-agent bid engine, which had no screen of its own at all |

#### A panel that always showed an error

Driving the Concept screen surfaced a 404 on every load:
`GET /concept/options/sensitivity` was called with no criterion, and the handler
refused an unnamed one — so a working panel reported an error on a project with
nothing wrong with it.

Naming no criterion now means *vary the one that matters most*, which is the
**heaviest-weighted** one. Refusing an unspecified question is right only where
there is no sensible default, and here there is an obvious one: the criterion
carrying most of the decision is both the first test anybody runs by hand and
the one most likely to flip the answer. It is weighted **by sum across every
scored option, not by the highest single weight** — a criterion at 0.8 on one
option and 0.05 on two others carries less of the decision than one at 0.5 on
two of three. The result already names what it varied, so nothing is guessed at
by the reader. A criterion nobody scored is still refused.

The first fixture could not catch either mistake: its heaviest criterion was
also the first in the list *and* the per-option maximum. A three-option fixture
where the two rules disagree kills all three mutations.

#### The remaining gap, named

**14 of 25 capability areas have no agent proposing into them** —
`QUALITY_COMMISSIONING`, `CHANGE_VARIATION`, `PAYMENT_APPLICATIONS`,
`LOOKAHEAD_CONSTRAINTS`, `WORKPACKAGES_TASKS`, `DESIGN_INFORMATION`,
`SUPPLIER_SUBMISSION`, `BOQ_TAKEOFF`, `EVIDENCE_AUDIT` among them. The panel is
fitted on every screen where a fleet exists to fill it; the areas above would
need agents built before a panel there would be anything but an empty box, and
an empty panel on a screen nothing watches is worse than none.

> Superseded in part. Every capability area now has an agent *reading* it — see
> *The two capability areas nobody was watching* — which is what fills a panel.
> Proposing into an area is a separate and narrower thing, and several areas
> still have only observers by deliberate choice; the count above is left as
> written because it was true of proposals when it was written.


### A module only some companies can see

A customer asked for capability that exists in this codebase, runs against this
ledger and this permission matrix, and is reachable **only by the tenancies a
platform operator has explicitly granted it to** — invisible to everybody else,
and additive rather than exclusive: a granted company keeps every CONSTRUX
module, function and feature it already had, unchanged.

The first module is **ETABLIX AI Site Services** — temporary infrastructure and
the living environment: welfare, accommodation, temporary MEP, enabling civils,
FM, security and logistics. This commit builds the **entitlement gate only**.
What the module *does* is not built; see "what is not built" below.

#### Why this is not a package tier, and not a standing either

`billing/seats.ts` already has FREE_TRIAL through ENTERPRISE and the obvious
move is a sixth tier. It is the wrong shape twice over. A tier is something a
customer **buys** — it appears on the pricing page, it is self-serve, and its
whole purpose is to be chosen; putting a private module in the tier ladder would
put it in the shop window. And a tier is exclusive, one per tenancy, where a
module is additive: the grant sits *beside* whatever package the tenancy pays
for.

`billing/entitlement.ts` is the other near miss. Every answer `TenancyStanding`
gives is derived from whether the tenancy is paying. A module grant is derived
from nothing — it is an act, by a named operator, with a stated reason, on a
date. So the two are resolved side by side onto the engine context and neither
is expressed in terms of the other. **A granted tenancy that stops paying loses
the platform, not the grant**, so reactivating restores what they had rather
than silently dropping a module nobody remembered to re-add. Pinned by test.

#### What was built

| Piece | Where |
|---|---|
| Closed module catalogue, `requireModule`, `grantRef` | `backend/src/identity/modules.ts` |
| `MODULE_GRANTED` / `MODULE_REVOKED`, on the operator's accountability list | `backend/src/goldenthread/eventTypes.ts` |
| `ModuleGrant` classified `PLATFORM_ADMINISTRATION` | `backend/src/identity/entityAccess.ts` |
| `setModuleGrant`, `moduleGrants`, `grantedModules`, replay | `backend/src/platform.ts` |
| `grantedModules` on `EngineContext`, beside `standing` | `backend/src/engines/context.ts` |
| `POST /v1/admin/tenants/:tenantId/modules/:moduleId`, `GET /v1/admin/modules` | `backend/src/api/routes.ts` |
| The tenancy's own list, on the matrix publish | `GET /v1/permissions/matrix` |
| Register, per-row badge and the grant/revoke door | `frontend/pages/tenants.js` |
| `modules()` / `hasModule()`, and `forgetPermissions()` | `frontend/app.js` |

**Two properties, and the second is the one that is easy to lose.** A tenancy
without the grant is *refused* — fail-closed, including on a module id that is
not in the catalogue, because a typo in an access check must never resolve to
"allowed". And a tenancy without the grant is **never told the module exists**:
`/v1/permissions/matrix` publishes only what that tenancy holds, so the console
gates its navigation on the server's answer rather than a client-side constant.
Refusing a request is not enough if the catalogue is published to everybody —
the module would then be invisible only in the sense that a locked door is.

`MODULE_NOT_GRANTED` is a **403, deliberately not a 404**. Pretending the route
does not exist is obscurity against somebody who can already read `/v1/routes`,
and it makes a genuine misconfiguration — a company that should hold the module
and does not — indistinguishable from a typo.

#### The operator's own tenancy is not special

ETABLIX will hold the ETABLIX module by the same command, on the same register.
A tenant id in a constant would make revocation a deployment, leave no record of
who decided it, and create exactly one code path the tests for every other
tenancy never cover. **Nothing is seeded** — the catalogue exists, and every
grant is an act taken in the console.

#### Two shapes the ledger forced, and one the browser found

`MODULE_GRANTED` is **UPDATE-with-`creates`, not CREATE**. A company can be
granted a module, have it revoked, and be granted it again; one record has to
carry all three, and CREATE refuses the third. Revocation is a plain UPDATE, and
**revoking a module a tenancy never held is refused** rather than recorded — a
revocation with no grant behind it would have to invent a grantor, and that
fiction would sit on the register looking exactly like a real one. The original
grant survives revocation untouched, because "who had this, and between which
dates" is what an access review asks.

Reading the rendered screen caught two things tests did not: an `[object
Object]` where a `.map()` over `html` templates had been `.join('')`ed instead
of left as an array for `resolve`, and a register that identified the deciding
operator by **ULID**. A register nobody can read is not a register, so
`GET /v1/admin/modules` now resolves the name.

**11 mutations, 11 caught** — 10 by the suite, 1 (`isModuleId` removed from the
route) by the compiler, because dropping it makes a `string` reach a `ModuleId`
parameter. One mutation survived first time round and was a real gap:
`grantRef` reduced to the module id alone left every tenancy sharing one grant
record, and the fixture only ever granted to one company. The test now grants to
two, and revokes one.


### Which of three businesses ETABLIX is on this job

The first vertical of the ETABLIX module, and the one everything after it
depends on. The same welfare, power, roads, cleaning, security and transport is
delivered under three appointments that differ on **every** control point that
matters, and almost every argument on such a job traces back to somebody
assuming one of them while somebody else assumed another.

| | Advisory | Management Integrator | Prime Service Contractor |
|---|---|---|---|
| Holds the supplier contract | Customer | Customer | ETABLIX |
| Pays the supplier | Customer, direct | Customer, on ETABLIX's recommendation | ETABLIX, under its own terms |
| Runs the operation | Customer from handover | ETABLIX | ETABLIX |
| Enforces performance | Not ETABLIX | Administers the customer's remedies | Directly and contractually |
| Exposed to | Professional liability | A management duty | Supplier default, cashflow, performance |
| Paid | A fixed professional fee | Mobilisation + monthly management fee | An integrated price, allowances disclosed |
| Customer receives | Professional milestones | A fee invoice + payment recommendations | One invoice, supplier liabilities behind it |

**Not a second copy of `TRADING_MODEL`.** `domain/integrator.ts` already holds
the three models and the *commercial* consequence of each — whether supplier
cost passes through the account, the cash risk, the margin risk — and stays the
source of truth for all of it; `profileFor` reads it rather than restating it,
pinned by a test. What is new is the layer it deliberately does not have: who
contracts, who pays, who coordinates, who may enforce, and what has to be true
before a model may be chosen at all. The spec writes the third model as "Prime
Service Contractor" and this codebase already calls it
`PRINCIPAL_SERVICE_CONTRACTOR`; it keeps one name, because a synonym splits
every query over this decision in half.

**The distinction the module exists to keep** is Management. ETABLIX runs the
operation and *still cannot enforce* — it is not a party to the contract — so
`mayInstructSupplier` and `mayEnforceDirectly` are separate flags with different
answers. A platform that let Management act as though it could enforce would be
manufacturing an authority that does not exist.

**Changing the model is a transition, not a toggle.** Before baseline it is an
ordinary correction. After baseline it is ETABLIX taking on — or putting down —
a supply chain, a cash exposure and a liability it did not have that morning, so
the commercial basis is required and the change is refused without it. The
earlier appointment stays on the record: what ETABLIX *used to be* answerable
for is the first thing asked when something goes wrong.

#### The Model Fit agent, and the recommendation it refuses to make

Ten factors, each scored 0–4 against evidence, each with a stated coefficient
per model in the range −2..2. The coefficients are ETABLIX's judgement about
what those facts mean and they sit in the source where a recommendation can be
argued with, rather than inside an arithmetic expression. Every factor's
contribution to every model is on the screen.

Two rules do the real work:

- **No recommendation at all where the contracting entity or the funding source
  is unknown.** Not a low-confidence answer — no answer, because both decide
  which appointments are even legally available. It still scores every model: a
  refusal to recommend is not a refusal to analyse, and the paper is what tells
  somebody what to go and find out.
- **A blocked model is never recommended, however well it scores.** Nine
  viability gates across the three models — treasury, mobilisation cash,
  insurance, bonds; delegated authority and payment workflow; deliverables,
  procurement owner, handover date and post-award responsibilities. The
  recommendation that puts a business into an appointment it cannot fund is
  exactly the one a fit percentage makes persuasive, and the test that pins this
  asserts the blocked model *out-scored* the recommended one — otherwise it
  would prove nothing.

"None required" is an answer on bonds; **silence is not**, and it blocks. So
does an unstated post-award responsibility on Advisory: advisory ends at award
unless it says otherwise, and that is exactly what gets assumed either way.

#### What this added to the platform's own machinery

`SITE_SERVICES` joins the capability matrix as the twenty-sixth area, with its
own scope pair (`siteservices:read`/`siteservices:write`) rather than reusing
`field:*` — a token integrating with the permanent-works programme should not,
by holding it, reach the welfare village's occupancy. Nineteen of the
twenty-three roles hold something on it; `PLATFORM_ADMIN` holds nothing, being
blind to delivery, and `SUPPLIER` reaches its own lane through
`SUPPLIER_SUBMISSION` as before.

The area exists in the matrix for every tenancy, because the matrix is one
published document. **Holding a permission on it does nothing without the
grant** — every route calls `requireModule` beside `authorise`, and the two ask
different questions: whether the *company* holds the module, and whether this
*person* may do this thing within it. Both are tested, including the case where
the answer to the second is yes and the first still refuses.

The console screen is gated by `module: 'ETABLIX'` on the navigation entry,
which makes it **absent rather than locked**. A padlock reading "ETABLIX AI Site
Services" would tell a company the module exists, which is the one thing it must
never learn.

**23 mutations, 23 caught.** Four survived the first pass and every one was the
same gap: only one viability gate per model had a test, so four of the nine
could be deleted outright with the suite green. They are now a table — one case
per gate, asserting the right model is blocked, the blocker names the right
thing, and *the other two models stay viable*, because one missing document must
not block every route out of the job.

Reading the rendered screen caught two more. A badge was carrying a full
sentence — the model label is `"Principal — one price to the client, and every
supplier is this business's"` and a badge is not a paragraph. And a model the
evidence argues *against* rendered as "viable, 0.0% fit", identical to one
nothing had been said about, because the bar clamps at zero and the raw score
does not. The score is now stated beside it: **−28 across the ten factors**
reads as the opposite of neutral, which is what it is.


### The twenty-five numbers a site is designed from

§3, the Customer Brief Intelligence Gateway. A customer hands over a programme,
a layout, an employer's requirements and a workforce curve, and somewhere in
them are the figures that decide how many WCs, how much power, how many buses
and how many beds. They are never all there, and the missing ones are never the
ones anybody notices.

**`conceptbrief.ts` is the requirements register and stays it.** It holds
requirement *statements* with source, confidence, author, supersession and
verification method, refuses to baseline one with no verification method, and
makes an AI-extracted requirement visibly unaccepted. None of that is rebuilt.
What it cannot hold is a **number with a unit**: "welfare shall comply with
Schedule 1" is a requirement, "the peak is 164 across two shifts" is a fact, and
it is the fact that decides whether five WCs is enough. A `SiteServiceFact`
carries a `requirementId` where it was read off an accepted requirement — the
link between the two registers rather than a merge of them.

Twenty-five items across the seven service families, each one an input to a
demand calculation in §4.1. That is what makes the list load-bearing rather than
a questionnaire: **an item is missing exactly when a calculation cannot run.**

#### "A percentage alone is forbidden"

The specification's rule, and the reason is visible the moment you try: 72%
reads as *mostly fine*, which is the opposite of true when the missing 28% is
the electrical load and the water storage. Every gap carries four things — what
it decides, the date the answer arrives too late, what is assumed meanwhile, and
whose answer it is.

**An assumption is not an answer.** A provisional value is a distinct status,
not a value with a flag; it does not count toward the percentage, and it stays
in the interview queue. If it counted, a brief nobody has answered would report
as complete, which is the reading the whole structure exists to prevent. It is
refused outright without a basis, a decision date and a named owner: an
assumption nobody owns and nothing expires is a wrong number that has stopped
being questioned.

#### Eight cross-checks with real arithmetic

Each runs only where both its inputs exist — a check against an absent value
compares against zero and produces a false alarm with arithmetic on it, and the
missing value is already reported as a gap.

| Check | The failure it catches |
|---|---|
| Concurrent occupancy vs WCs | Welfare sized on the headcount rather than the changeover |
| Changeover vs daily peak | Two figures that cannot both be true |
| Operating hours vs security cover | A site live 24 hours and guarded for 12 |
| Water storage vs tanker interval | Running dry on the first missed slot |
| Maximum demand vs secured supply | A grid connection nobody ordered |
| Accommodated workers vs beds | More people than rooms × occupancy |
| Travelling workforce vs bus seats | People with no way to site |
| Waste produced vs removed | A compound that fills up over weeks |
| Gate throughput vs changeover | A shift that loses ninety minutes a day |

The sanitary check uses **Schedule 1 of the Workplace (Health, Safety and
Welfare) Regulations 1992** — 1 WC to 5 people, then one more at 25, 50, 75 and
100, then one per 25 or part thereof. A real rule with a citation, because an
inspector arrives with these numbers and a platform that invented its own would
be wrong in the one conversation it exists to be right in.

Driven live, it reproduces the specification's own worked example from recorded
facts: *"Concurrent occupancy is 142 people at changeover (120 on shift plus 22
visitors), which needs 7 WCs under Schedule 1. The layout provides 5. Confirm
the peak concurrent occupancy, or accept a provisional design basis of 164
persons — 142 plus 15% resilience — and provide 8 WCs."* Every resolution ends
in a choice, as the spec's example does, not a warning.

#### The offer, folded into the appointment

The three models now carry what ETABLIX actually undertakes — four named pillars
each, the fee logic, and the "choose this when" sentence — in ETABLIX's own
words rather than the platform's. Plus the two things §2 named and the first
pass did not instantiate: **approval thresholds** (nothing delegated under
Advisory or Management, because it is the customer's money on the customer's
contract; a £50k instruction limit under Prime, because a business that referred
every purchase upward could not run a site) and **required insurance evidence**,
which follows the exposure. The seven acts that are never delegated under any
model — award, signature, energisation, certification, contingency, termination,
regulatory submission — are the specification's Class C, held once rather than
per model because they do not vary.

**20 mutations, 19 caught.** One survivor was a real finding rather than a gap:
a second filter in the interview for "only questions that change something"
never removed anything, because the catalogue invariant already refuses an item
that changes nothing. Two statements of one rule, and the two would eventually
disagree about which was in force. Deleted; the invariant carries it.

One guard is deliberately **not** claimed as tested. `liveFacts` excludes
superseded records, and no mutation of that exclusion fails the suite, because
`list` sorts by ULID so the newest record wins either way. It is kept because it
is the rule that is actually true and the ordering is not — the day anything
supersedes a fact without replacing it, "newest wins" alone would resurrect the
figure that was retired.


### Sixteen specialists, and the authority none of them has

§5. The product mandate is to automate at least 90% of the repeatable
coordination, analysis, documentation, monitoring and administration work
**while retaining explicit human authority over legal commitment,
safety-critical acceptance, supplier award, payment certification and
contingency release.** The second half is the part that needed building.

**Built on the fleet that already exists.** `agents/runtime.ts` is already a
governed framework — mandate, autonomy ladder, confidence floor, ACU tier,
trigger routing, proposal queue, approval by a named role, and the rule that an
agent never writes project state. None of it is rebuilt. These are sixteen
`AgentDefinition`s in the same registry, so they appear in the same manifest,
the same autopilot queue and the same audit trail as everything else.

They carry one thing no CONSTRUX agent does: `module: 'ETABLIX'`.

#### The automation boundary maps onto the ladder that already enforces it

| Spec class | Ladder level |
|---|---|
| A — autonomous, inside an approved baseline | `ACT`, inside a granted envelope |
| B — supervised: prepare, a role approves, then execute | `PROPOSE` |
| C — human-controlled: AI advises, a named authority decides | `OBSERVE` / `DRAFT` |

No new mechanism was needed, and **no ETABLIX agent exceeds `OBSERVE`.** Every
one has `proposes: []` — they report, and the commands that follow are somebody
recording a fact or placing a package. An agent proposing "record this figure"
would be an agent inventing the figure.

#### The gate had to move, and the invariant caught it

The first version checked the module inside the run loop and `continue`d. The
existing invariant — *a sweep runs the whole deployed fleet* — failed
immediately at 49 against 60, and it was right to: the loop **reports every
agent it considered**, including the ones it skipped for the lifecycle phase,
and that report goes to the customer. A module agent reported as "skipped" tells
a company the module exists.

So the fleet is narrowed **before** the loop by `runnableAgents(granted)`, and
the invariant now reads *a sweep runs everything this tenancy may run* — which
preserves the property that mattered (a sweep does not route by trigger) while
making the absence total. A test asserts the run report of an ungranted tenancy
contains the string "ETABLIX" nowhere at all.

#### One problem, one agent

The obvious failure of a sixteen-agent fleet is five of them reporting the same
contradiction from five angles, which trains everybody to stop reading all five.
The cross-checks live in `domain/etablix/brief.ts`, each tagged with the service
families it sits between, and **each specialist reports only the conflicts
belonging to its own family**. A check added there appears under its owner with
nobody wiring it up.

HSE reads across families and reports **only the two exposures that carry a
statutory consequence** — welfare below Schedule 1, and a site operating
unguarded — and says them differently from the family agent. Welfare says *seven
WCs are needed and five exist*; HSE says *the site cannot be occupied at this
headcount*, and cites Regulation 20. Two readers, two acts, one arithmetic.

Severity carries through from the check rather than being re-graded by the
agent: a shortfall that stops the site on day one and one that degrades over
weeks are different things, and grading them the same trains people to ignore
both.

#### Eleven run, five are declared

| Running | Declared, and what it waits on |
|---|---|
| Orchestrator, Brief Intelligence, Site Layout, Temporary Civils, Temporary MEP, Welfare & Village, FM & Living Services, Security & Logistics, Procurement, Commercial, HSE & Compliance | Supplier Assurance (§7.3), Mobilisation (§8), Operations Sentinel (§9), Change & Claims (§11), Demobilisation (§12) |

Each declared agent names the specification section that must exist before it
has anything to read, and the test asserts it does — a manifest listing sixteen
running agents when five read from records that do not exist would be a lie told
in a table.

**An agent with nothing to read reports nothing.** The first version raised "N
unanswered" on every project the moment the module was granted — seven agents,
seven findings, on a job nobody had started. A specialist now returns nothing at
all until there is an appointment or at least one recorded fact.

**9 mutations, 9 caught.** Two survived first: severity flattening, and HSE
restating every shortfall rather than the two it owns. Both were single-conflict
fixtures where the wrong behaviour and the right one produce the same output; a
fixture with a blocking conflict *and* a material one in different families
kills both.

#### What §5.1's execution contract carries, and what it does not

Recorded on every agent action: tenant and project (the event), role
(`roleAtAction`), objective (`purpose`), authorised tools (`mandate.proposes`),
input evidence ids (`finding.evidence`), confidence (`confidenceFloor`),
cost budget (`acuTier`), approval class (`maxUnattended`) and the audit event
itself. **Not yet carried: the appointment model and the baseline version on
the finding record**, and the versioned prompt/rule identity — the last needs
model governance that is a separate piece of work. Stated rather than implied.


### Capacity that keeps its working

§4, the Site-Service System Composer, and §4.1, the demand and capacity engine.
The specification's own sentence is the design: **"the engine stores formulas
and assumptions, not just final quantities."** A platform that recorded "seven
WCs" cannot answer the only two questions asked six months later — seven from
what, and does it still hold.

So nothing in `engines/maths/demand.ts` returns a number. Every calculation
returns a **derivation**: the formula as a person would check it, every input
with its value, unit, source and whether it was a fact or an assumption, every
rate with the basis it rests on, and three capacities rather than one.

#### Three capacities, and resilience by consequence

| Control | What it answers |
|---|---|
| Base demand × concurrency × utilisation | Normal operating capacity |
| Peak factor + planned growth | Peak design capacity |
| Resilience, N+1 or autonomy hours | Continuity capacity |

The third is the one that changes what gets built. **"Add 15% for resilience"
is wrong in both directions at once** — it buys a spare canteen nobody needs
and leaves the potable water on a single tank. Every derivation declares what
happens *when this service fails*, and the reserve follows:

- **The site stops** (potable water, electrical supply) — N+1 and 48 hours of
  stored autonomy, enough for a missed delivery and the slot after it.
- **The site is in breach** (WCs, showers) — one spare unit, so a single failure
  cannot drop provision below the statutory minimum.
- **The shift is degraded** (waste, cleaning, gate) — nothing held; a same-day
  response obligation instead, because duplicating the asset costs more than
  the loss.

A test asserts the reserves are **not a constant fraction of demand**, which is
what "not a blanket percentage" has to mean to be checkable.

#### The five calculation controls, with their exceptions

- **Only a total headcount** → concurrency is assumed at 100% and *says so*.
  The safe assumption and usually the wrong one.
- **Event peak vs sustained** → a peak lasting two days is managed, not designed
  for. Sizing permanent welfare to it is hire nobody needed for the other fifty
  weeks. Unstated is treated as sustained and flagged as the expensive
  assumption.
- **Resilience by consequence** — above.
- **Stranded hire and premature removal** — read from the deployment windows and
  the physical dependencies between families. The last service off site is not
  called stranded, because something has to be last.
- **Observed vs basis** → a reduction is a **proposal with an approval
  attached**; an increase is an alert that the basis, not the usage, is wrong.
  The asymmetry is the rule: a design basis is not a forecast corrected downward
  as the meters come in.

Every rate is a named assumption with a stated basis — 50 litres per person per
day, 0.7 diversity, 200 m² per cleaning hour, one shower per fifteen — because a
demand engine whose rates are unexplained magic numbers is a spreadsheet with
better error handling. The statutory sanitary table now lives once, in the
demand engine, and `brief.ts` re-exports it.

#### Composing freezes a design basis

The compound was ordered against the numbers as they stood on a particular
Tuesday, and the brief has not stopped. A `ServiceSystem` carries the
derivations *as they were when it was composed*, every read re-derives from the
live brief, and the difference is reported as **drift** — which is the question
that decides whether an order is still right.

Driven live: welfare composed at 142 concurrent needing 7 WCs; the shift plan
then moved to 180 and the screen reads *"Sanitary conveniences required: 7 → 10
WCs (+42.9%). Whatever was ordered against the frozen basis is short."*

Composing also raises the **interface matrix** — one record per non-negotiable
interface from §4's table, **open and unowned**, each carrying what happens if it
is never closed. An interface with no owner is the definition of the gap that
turns up on site, and it has to be visible as a gap rather than absent. Taking
one needs a person *and* a date together: an owner with no date cannot be late,
and a date with no owner is nobody's. Closing one needs evidence, because
"accepted" on its own proves nothing later.

What a brief cannot supply — assets, operating tasks, the supplier package, KPIs
and cost — is listed per system with the section that fills it, because "assets:
none" and "assets: not built yet" are opposite statements.

**24 mutations, 22 caught.** One survivor was found by driving it rather than by
mutation: the reforecast compared a meter reading against the **live**
re-derivation, so the variance moved every time the brief did. Against a basis
that had grown, 4,000 litres read as 60% below; against the frozen basis it is
44%, and only the second is what "observed versus basis" means. Fixed, and the
fix is pinned by a mutation of its own.

The two remaining survivors are the pair of ordering guards in `factsFor` —
excluding superseded records, and taking the later ULID. Each is individually
redundant given the other, because `list` sorts by refId; both are kept because
each is a rule that is true independently of how the ledger happens to order a
result. Stated rather than claimed as tested.

### Mobilisation is a dependency network, not a percentage complete

§8, the Mobilisation Control Tower. Seven gates per service system —
`backend/src/domain/etablix/mobilisation.ts`, with its own tests in
`backend/tests/etablix.mobilisation.test.ts` and a panel on the Site Services
screen.

Not to be confused with `backend/src/domain/mobilisation.ts`, which is
CONSTRUX's CN-WF-01 start-work authorisation for the main works. Different
subject, same word: this one is about a service system reaching operational
readiness, gate by gate.

| Gate | Passes when |
|---|---|
| G0 Contract effective | Correct contracting party and authority confirmed |
| G1 Design basis | Design responsibility and review status accepted |
| G2 Off-site readiness | No unresolved critical nonconformance |
| G3 Site ready | Access, ground and services verified — **safety-critical** |
| G4 Install complete | Installed to the approved design |
| G5 Integrated test | Tested and safely energised — **safety-critical** |
| G6 Operational ready | Operating regime, people and reporting in place |

Four properties, and the first is the specification's own hard stop.

**A supplier reporting 100% moves nothing.** `declareProgress` records the
declaration and returns, on the record itself, the sentence *"Nothing. Readiness
is calculated from prerequisite evidence and interface tests, and every gate is
approved by a named role."* It is recorded rather than refused because the
difference between what the supplier said in week six and what the evidence
showed is the entire mobilisation dispute, and a platform that discarded the
first half could not settle it. Driven live: a declaration of 100% against a
tower reading 13.2%, at G0, and no gate moved.

**Evidence is a reference, not a tick** — the certificate number, the drawing
revision, the test sheet — and anything that lapses is refused without the date
it lapses on. The commonest mobilisation failure is not that evidence was never
provided; it is that everything was in place once. Expired evidence is reported
as *expired*, never as missing: "it lapsed" and "it never existed" are different
conversations with different people. A renewed attestation supersedes the lapsed
one rather than sitting beside it. Evidence within 30 days of expiry is on the
tower as a warning, which is §7.3's expiry monitoring at the one place the
evidence actually lives.

**Derived items cannot be attested away.** Five of them are answered from the
platform's own records — the approved requirements, the calculations behind the
demand basis, the interface matrix, the contracting party from the appointment,
and whether temporary MEP is composed *and closed* for the zone. An interface
matrix with three open interfaces is not closed because somebody typed a
certificate number against it. A derived item with no rule behind it fails
closed and says so, which is why `deriveEvidence` is exported: a guarantee that
cannot be proven is not worth stating.

**Only the named role passes a gate.** Holding `A` on `SITE_SERVICES` is not
enough. Driven live, a project manager at G0 is refused with *"G0 Contract
effective is approved by COMMERCIAL_MANAGER, PROJECT_DIRECTOR … You hold PM"*,
and the same manager at G5 is told *"This is a safety-critical hold point and it
fails closed: it is a competent person's act, not a manager's."* The roles the
gates name — principal designer, designer, EPC, safety, QAQC, supervisor — were
given `A` on `SITE_SERVICES` in the same change, because a gate whose named
approver cannot approve is a gate nobody can pass.

A gate is a conclusion the platform reaches, not a status somebody sets:
refused while any prior gate is unpassed, refused while any evidence item is
outstanding (naming which), refused with an empty note, and idempotent once
passed. G6 writes `MOBILISATION_ACCEPTED` rather than another gate approval, so
"which packages are accepted" is a query rather than a filter. Withdrawing
evidence re-opens the gate it satisfied, and is itself written once however many
times it is called.

**26 mutations, 26 caught.** Four survived the first pass and each named a real
gap rather than a redundant guard: the utilities item was satisfied by a
temporary MEP system whose own interfaces were still open, the fail-closed
default on an underived item was unreachable from the tests, withdrawal was not
proven to be written once, and the evidence percentage was never checked against
anything but 100. All four are now covered by tests.

### Packaging is an argument, not a preference

§7, the procurement and supplier-control factory —
`backend/src/domain/etablix/procurement.ts`, its tests in
`backend/tests/etablix.procurement.test.ts`, and a panel on the Site Services
screen with eleven doors.

Named `sitePackages` at the route layer, for the same reason `siteMobilisation`
is: CONSTRUX has its own `domain/procurement.ts` for the main works, and the two
answer different questions.

**What is reused rather than rebuilt.** The tender event itself — controlled
recipients, acknowledgement, addenda, return completeness, late-return
treatment, audit log — is `domain/enquiry.ts` and is *called*, not copied:
`openPackageTender` opens a real `Enquiry` and stores its id on the package.
Whether a firm may be used at all is `domain/supplychain.ts`, and is read rather
than duplicated: a firm that register holds as barred or suspended is not a
bidder here, whatever its price. §7's own contribution is the two things neither
of them does — the packaging argument and the normalisation.

The join between the two vocabularies is `FAMILY_TRADES`: ETABLIX's seven
service families mapped to the closed trade catalogue firms are registered
against. Declared rather than string-matched, and pinned by a test that every
code in it is in the catalogue — a code that drifted out would silently return
no bidders, and no bidders reads as "no market" rather than as a bug.

#### §7.1 The argument, and the twelve fields

The specification's rule is the sharp part: a recommendation *must show* why
bundling reduces interfaces, or why disaggregation protects competition and
specialist performance. So the argument is built from counted evidence and
cannot be produced without one. Driven live on a real supply chain:

> **Bundling reduces interfaces:** Cleaning, Occupancy, Room status stop being
> interfaces between two firms and become internal matters for one. 12
> interfaces remain external either way, and 3 firms can still price it — which
> meets the floor of 3, so the saving costs no competition.

> **Disaggregation protects competition:** no firm on the register can deliver
> both families. Split, 4 can price welfare and accommodation and 3 can price
> enabling civils and reinstatement. A bundle nobody can price is a negotiation,
> not a tender.

The interface arithmetic needs one thing §4 does not carry: which family each
non-negotiable interface is *with*. `INTERFACE_COUNTERPART` declares it. Welfare
carries an interface called "Cleaning"; cleaning carries "Occupancy" and "Room
status" — three names for two firms having the same three conversations. A
string match would have found the first and missed the other two, and an
argument that undercounts the interfaces is an argument for the wrong answer.

`COMPETITION_FLOOR` is three, stated with its basis: with two returns a single
withdrawal leaves a negotiation, and a negotiation with the only firm that can
do the work is not a price.

**Twelve minimum fields, five of them derived.** The interfaces, quantities,
programme and removal obligation come from the linked systems and are never
retyped — a package retyped from the design is a package that will disagree with
it. The other seven have to be stated. A package can be created incomplete,
because a half-drafted package is a real thing, and it **cannot be issued** while
any of the twelve is silent: the refusal names each one and what its absence
causes, because the moment of issue is the last moment they are free to fix.
After issue the scope is frozen — a change is an addendum every bidder
re-acknowledges, not an edit.

One system, one package. A system in two packages is a system paid for twice.

#### §7.2 An exclusion is priced, visibly, never scored

Six steps, and the third is the one that matters. Recomputed on every read
rather than stored, because returns keep changing until they are locked.

1. **Map** every line to the issued schedule — omissions, duplicates,
   unsolicited lines and qualifications, each named. A schedule item neither
   priced nor excluded is reported: *silence is not a zero*.
2. **Normalise** the eleven bases, each adjustment carrying what was declared and
   why it is worth what it is worth. A basis the bidder said nothing about is
   *unknown*, not included.
3. **Price the exclusions** at the median compliant rate — the median of the
   firms that actually priced it, because a firm that excluded an item has no
   opinion about what it costs. An exclusion nobody in the field priced is
   carried at zero and named, never scored.
4. **Evaluate** across the duration and five sensitivity scenarios: mobilisation
   delay, peak workforce, extension, energy variance, early termination.
5. **Clarify**, ranked award-blocking first and then by what it is worth being
   wrong about.
6. **Lock** the clarified return with the supplier's acknowledgement.

Driven live, four returns against one welfare schedule:

| | Submitted | Normalised |
|---|---|---|
| Halcyon Welfare Systems | 308,000 | 308,000 |
| Brightpath Site Services | 369,600 | 369,600 |
| **Carrick Camp and Care** | **141,300** | **383,730** |
| Lowfield Integrated Services | 492,800 | 492,800 |

The cheapest submitted price was cheapest because it priced one item and
declared the other three out. Priced at the median compliant rate they become
the most expensive return in the field, and `orderChanged` says so.

Two things are refused rather than guessed: a return in another currency is
marked incomparable because no exchange rate is held and an invented one
produces a comparison that looks right and is not; a tax-inclusive return is
reported rather than silently stripped.

The award recommendation refuses on three grounds — an unlocked return, an
award-blocking clarification, or no eligible bidder — and each refusal says
which. It is a recommendation, never an award: placing the contract is
CONSTRUX's own award machinery.

#### §7.3 A control state is a conclusion, not a click

Nine states, and the entry criteria are read from the platform's own records
rather than asserted by whoever is doing the moving. Tendering needs the package
issued; Preferred needs a *locked* return; Contracted needs an award
recommendation naming that firm; Mobilising needs gate evidence attested against
the package's systems; Operational needs every system past G6. A skipped state
is refused, naming the control it skips.

This is not `SupplierStatus` from the corporate register and does not replace it.
That is a tenant-wide standing — approved, conditional, barred. This is where a
firm stands on *one package*: the same supplier can be Operational on welfare and
Tendering on cleaning on the same Tuesday, and a single status field cannot say
so.

`SUSPENDED_RECOVERY` is out of the linear order deliberately. It is entered from
any live state on a material failure or an evidence lapse, it blocks new work,
and it needs the cause named — a suspension with no cause cannot be recovered
from because nobody can say what would fix it. §7.3's evidence-expiry control is
real: a prequalification that has run out is not a prequalification, and
`entryCheck` takes a date so that rule can be exercised rather than waited for.

**46 mutations, 46 caught.** Six survivors on the first pass, each a real gap:
the median counted a nil line from a firm that had excluded the item, the
even-length median took the wrong element, an award-blocking clarification was
never proven to block, a suspended firm on the register was never proven
ineligible, the standstill note was never checked, and the singular case of the
bundling sentence read as a mail merge. All six now have tests.

#### Whose window the enquiry is opened under

`openEnquiry` now takes the capability area whose authority the enquiry is
raised under, defaulting to `PROCUREMENT_AWARD` so every existing caller is
unchanged, and recording it on the enquiry so a reader can tell one kind from
the other.

The first version of §7 inherited the main-works window, and a package on a
project in Operations was refused with "PROCUREMENT_AWARD cannot be written
during the OPERATIONS phase" — a true sentence about an area the buyer never
chose. The gate itself is right for what it gates: buying the frame in O&M is a
process error. Site services are not that. Welfare is bought before the first
pour, cleaning is re-let in month twenty, security runs past practical
completion and the whole compound is demobilised after handover, so a window
drawn around the main works closes the wrong door on all four.

So the ETABLIX package raises its enquiry under `SITE_SERVICES`, which has no
phase gate because site services span every phase. The machinery is identical —
controlled recipients, addenda, acknowledgement, audit log — and only the
authority to buy differs. A package can now be issued on a project in Operations,
which is proven by a test against the demonstration flagship, and the main-works
window is untouched.

### Verify is a step, not a formality

§9, live operations and service assurance —
`backend/src/domain/etablix/operations.ts`, its tests in
`backend/tests/etablix.operations.test.ts`, and a panel on the Site Services
screen with eight doors.

Not CONSTRUX's quality control or its incident register. Those are the permanent
works and people getting hurt. This is the service position: whether the welfare
block had hot water this morning, whether the bus ran, whether the gate cleared
120 people an hour.

**The loop is five steps and the fourth is the one everybody skips.** Sense,
interpret, act, verify, learn. Every helpdesk does sense and act; almost none
verify, because verification means refusing to close a ticket somebody has
already said is finished. Twelve defect types each declare the closure evidence
they demand and why that evidence and not something cheaper — a hot-water loss
closes on a *test result*, because a photograph of a tap proves nothing about
what came out of it; a cleaning failure closes on a *reinspection*, because
cleaning is the one service where the supplier marking their own homework is
standard practice. Evidence of a kind the defect does not close on is refused,
and the register shows what is blocking each closure before anybody tries.

A P1 additionally cannot be closed without a temporary control on the record. A
critical event closed with no interim measure is a critical event nobody
controlled, and the closure is the last moment that is cheap to notice.

**§9.2's second column is the load-bearing one.** Each of the seven KPI families
carries its anti-gaming control, and each says honestly whether the platform
*enforces* it or only reports it — a screen implying enforcement the code does
not do is worse than no screen. Five are enforced:

- **Availability.** A planned exclusion approved after the outage began is
  refused: *"an exclusion approved after the event is not a planned exclusion —
  it is a failure with a note on it"*. Degraded minutes are a separate field and
  are never counted as available. The screen shows the figure net of approved
  exclusions and the raw figure beside it, because the gap between the two is
  the size of the argument about what was planned.
- **Response and restoration.** A clock pause needs a reason *and* a named
  customer approval, because the clock is what the service credit is calculated
  from. A **P1 clock does not pause at all** — the pause on a critical event is
  always agreed in the room where the pressure is, and recording it would
  measure the pressure rather than the response. An event cannot be closed with
  its clock still stopped.
- Attendance recorded before acknowledgement is refused, because a response
  measure whose clock starts at attendance measures nothing.

Two are reported rather than enforced and say so: security and access needs a
roster feed to reconcile against invoiced staffing, and transport needs booking
or positional evidence. Neither exists on this platform yet.

**P4 is a request, not a failure.** A move-add-change routed as a defect is
scope delivered for nothing, and it does not belong in the availability figure.
Routing a P2 to change control is refused — *"a defect routed to change control
is a defect nobody fixed"*.

**Learn** is the second occurrence: a failure of one thing in one place twice is
a question about the regime or the asset, not about the last repair.

**30 mutations, 30 caught.** Eight survived the first pass and each named a real
gap rather than a redundant guard — idempotence on acknowledgement, attendance
and closure was asserted on a timestamp two calls in the same millisecond would
share rather than counted in the ledger; the acknowledgement breach was never
checked while an event was still unacknowledged, which is the only time it
matters; and the paused-clock blocker never appeared in a test. All eight now
have tests.

### An invoice is not proof of value

§10, commercial control and earned value —
`backend/src/domain/etablix/commercial.ts`, tested in
`backend/tests/etablix.commercial.test.ts`.

The specification's own sentence, enforced. A supplier **application** is a
claim; what is **earned** is the budgeted value of accepted progress; what is
**actual** is what somebody certified. Three numbers every commercial system on
the market collapses into one, and the collapse is why a job can be 40% paid,
25% delivered and reported as on track. The eight records are kept apart, and
the console shows budget, committed, earned and certified as four separate
figures rather than one percentage.

**The earned-value method is chosen per line, not assumed.** A welfare hire
earns by *time* and cannot go faster by working harder; a compound earns by
*milestone* and earns nothing until it is accepted; cleaning earns by *weighted
evidence* against the inspection sample. A line whose method has nothing to
measure against — a time line with no duration, a quantity line with no
quantity — is refused, because progress against nothing is a percentage of
nothing.

Earned value is a **position, not a sum**: three readings of 40%, 60% and 80%
are one line at 80%, and adding them is how earned value passes 100. A
certificate pays the **movement** between two positions, not the position.

The reconciliation finds six exceptions, each carrying what it is worth —
overclaim, unsupported, premature, prior drift, KPI deduction, and the one
nobody looks for: **work earned and never claimed**, which is a liability
whether it is on the application or not. Certification is refused while any line
claims more than the evidence supports, which is the moment a claim would
otherwise become an actual. Driven live: a claim of sixteen weeks against ten
weeks of dockets refused at *"1 line claims more than the accepted evidence
supports"*, then certified at £50,000 once corrected.

Service credits are a **separate transparent adjustment**, never netted into a
rate. They must arise from a recorded KPI event, quote the contract formula,
respect the cap, and cannot be approved inside the cure period — that period is
the supplier's contractual chance to put it right.

**20 mutations, 20 caught.** One exposed a genuinely unreachable branch: the
premature-claim exception checked the already-filtered set and could never fire,
which made the exception decorative. It now looks at the whole record and is
pinned by a test.

### No change becomes forecast-neutral because it lacks a quotation

§11, change, early warning and recovery — `backend/src/domain/etablix/change.ts`.
The golden rule, verbatim, and the module is that rule enforced.

A job carrying three hundred thousand pounds of instructed-but-unpriced work
reports itself on budget right up until somebody agrees a number. So
**entitlement, probability and value are three separate fields** — collapsed
into one expected value, nobody can see which of the three is the weak one, and
it is always a different one — and the risk-adjusted exposure is on the forecast
from the day the change is raised. Driven live: a £40,000 arguable instruction
at 75% shows as *£30,000 on the forecast today*, with no quotation anywhere near
it.

A change with no probability or no value is refused, because both become zero
silently. An **agreed** change is certain by definition: agreeing one still
carrying a probability is refused with *"it has been quoted, and the forecast
should carry it as exposure rather than as value"*.

Six triggers, each asking a different question, and four of them start a
contract clock. A notice is a separate act with a reference and a date — the
commonest way an entitlement is lost is that everybody assumed somebody had sent
one — and the register flags a notice period that has passed with nothing sent.

**13 mutations, 13 caught.**

### Demobilisation begins at design

§12 — `backend/src/domain/etablix/demobilisation.ts`. Every temporary asset must
have an owner, a removal method, a trigger, a cost, a waste route and a
reinstatement criterion *before it is installed*, because the moment to agree who
breaks out a hardstanding is the moment before it is poured, when somebody still
wants something from you. A plan missing any of the six is refused and names
them; "removed" is not a method and "off site" is not a waste route.

**The refusal that matters** is §12's first workstream: *prevent premature loss
of statutory welfare*. This is the phase where the last WCs go back because the
compound is "finishing" and there are still forty people working. A run-down
that would take provision below the statutory minimum is refused with the
arithmetic in it — *"40 people still on site require 3 WCs under Schedule 1
Table 1, and this run-down leaves 1"* — using the same `statutoryWcs` table §4
sizes the welfare from, read in reverse. Naming a successor facility permits it;
the register still shows it as below the minimum, because the successor is the
reason it is acceptable rather than a reason it stops being true.

The seven workstreams each close on the acceptance evidence they declare, and
none closes on a narrative. The demand run-down cannot be accepted with no
run-down behind it, and an asset removal cannot be accepted with no plan behind
it — that would accept whatever was done, at whatever cost, to whatever
standard.

**13 mutations, 13 caught.**

#### What driving §9–§12 in a browser found

Two defects the tests could not see, both fixed:

- The page named its commercial-position variable `money`, shadowing the shared
  currency formatter imported from `lib/ui.js`. Every panel below it rendered as
  `TypeError: money is not a function` — a blank screen, with the console
  bindings invariant satisfied, because the name *was* bound. It is now
  `commercial`, and the hand-rolled decimal helper written around the shadow was
  deleted in favour of the real `money()`.
- A certified valuation was labelled **not certifiable**, which reads as a
  problem when it is the opposite. `certifiable` means "can be certified now";
  once it has been, the honest word is the past tense.

And three domain sentences carried bare minor units to a reader — *"worth
4000000 at face"* for a £40,000 change. A minor-unit integer in a sentence gets
misread by a factor of a hundred exactly once, expensively.

### The command centre answers questions, and says which it cannot

§13 and §17 — `backend/src/domain/etablix/commandcentre.ts`, `GET
/v1/projects/:id/site-services/command-centre/:workspaceId` and
`.../site-services/automation`, both on the Site Services screen.

§13's table is eight *questions*, not eight route names. "Which projects are
unsafe, late, under-capacity, overspending or cash-exposed?" is a question a
dashboard either answers or does not, and a wall of coloured tiles that looks
like an answer is worse than an empty screen — an empty screen sends somebody to
find out. So each workspace decomposes its §13 sentence into the individual
questions inside it, and every question declares either the position it is
answered from or exactly what is not built. **`answered: false` is a first-class
result**, rendered on the screen under *what this workspace cannot answer*.

Five of the eight carry a real gap, and each is an entity family that does not
exist rather than a screen nobody drew:

| Workspace | What it cannot answer |
|---|---|
| Accommodation Desk | Room and bed inventory, allocations, arrivals, housekeeping. §4 sizes an accommodation system against demand; there is no room, bed or allocation record beneath it. Also transport: a service family with a reported KPI, no journey or booking record. |
| Field Mobile | QR asset scan (no per-asset register under a composed system), delivery check, individual occupancy. |
| Supplier Portal | Valuation and payment state. There is no supplier account layer with its own authentication, so this is an internal view of one supplier's obligations, not a portal that supplier logs into. |
| Commercial | Paid, accrual and cash — §10 certifies value and does not record payment against a certificate. Contingency and EAC — change exposure is an input to an EAC, not an EAC. |
| Executive Portfolio | The cross-project roll-up. Every position is project-scoped by construction. |

**§13.1 read properly.** "NOW / NEXT / WHY / ACTION" looks like four lists and is
not. NOW and NEXT are the two lists — what is true today, and what falls due in
2, 7 or 30 days. WHY and ACTION are *required fields on every entry in both*:
the rule that produced the status, the record it can be opened at, and the owner,
decision, deadline and consequence attached to it. That reading is the one that
costs something to implement, which is why it is the right one — it makes it
impossible to add a signal to this panel without saying which rule produced it
and who has to do something about it. §13.1's own words, *"users can open the
source, not merely trust a coloured tile"*, are an instruction to whoever builds
the panel.

Where no deadline exists, the panel says so and says why: *"No date can exist: an
unowned interface has nobody to owe one."* A blank date and a date that cannot
exist look identical and mean opposite things.

**One derivation, eight views.** Every entry is derived once from the positions
§2–§12 already publish, and tagged with the workspaces it belongs on — eight
separate assemblers would be eight places for the same signal to be phrased
differently, and the first time the control tower and the customer project
disagreed about a gate, both would be believed by somebody. Each entry records
the position it came from, and a test proves no entry is listed on a workspace
whose declared sources do not include it: a tag with no fetch behind it is dead
code that looks like a feature.

#### §17: ninety percent, measured rather than claimed

*"90% AI-driven" is measured by workflow touch, not by claiming 90% of
decisions.* The measure is read from the ledger rather than from entities,
because the events say who did each thing and in what order, and that is the only
version that cannot be improved by editing a record.

All 54 ETABLIX activities are classified into §1.2's three classes — A
autonomous, B supervised, C human-controlled — and into the nine workflows.
Two invariants keep the classification honest against the event catalogue: **no
Class A activity may sit on an event an agent is forbidden to author**, and **no
Class C activity may sit on one an agent is permitted to author**. A test parses
the catalogue's own ETABLIX block and fails if a code is classified twice, not at
all, or invented — a §6 event added later with no class would otherwise fall
silently out of the denominator, which is exactly how an automation metric
becomes marketing.

Class C is excluded from the denominator and the screen says so. Counting the
supplier award, the payment certificate and the mobilisation acceptance
certificate would make 90% unreachable by construction rather than by
performance, and would also imply the platform decides things the governance
model says it never will.

The ten metrics each report a figure or say what record is missing. **A metric
with no records behind it never reports zero**: zero and "nothing has happened
yet" look identical on a gauge and mean opposite things. Forecast accuracy is
declared not measurable on a live project at all — it compares a prior estimate
at completion against a final outturn, and reporting it before close-out would be
reporting the forecast against itself, which is always 100%.

**22 of 27 mutations caught.** Three of the five survivors are equivalent
mutants; two are the module and commercial gates at each entry point, which are
deliberately the same checks the positions underneath make — they sit at the top
so a refusal happens before any position is read, and removing either still
refuses because every position repeats it.

#### A confidentiality gate that never fired

Found while building this, fixed at the root: `assertAccess` threw on a `REDACT`
decision only for a *write* code. So a **read** that asked to be gated at
Commercial-L3 or Legal-L4 — forty-six call sites across estimating, claims,
tendering and every ETABLIX commercial position — evaluated the gate, produced a
REDACT, and returned it to a caller that ignored it. Every one of those reads
looked classified in the source and was open in fact.

The redaction path that genuinely wants a non-throwing answer already calls
`evaluateAccess` directly — that is why the two functions are separate: one
asserts, the other decides. `assertAccess` now refuses on REDACT for any code.

Two things surfaced the moment it started refusing, and both were themselves
defects:

- **`COMMERCIAL_MANAGER` was not in `COMMERCIAL_L3_ROLES`.** The person whose
  whole function is the commercial position was excluded from it on paper and
  admitted in practice. Added.
- **§2's appointment position was classified Commercial-L3 and holds no money.**
  It carries the model, the RACI and the seven control points — who contracts,
  who pays, who may enforce — and no price, margin or bid comparison anywhere in
  it. Classifying it as commercial shut the planner, the safety lead and the site
  manager out of the one answer every discipline on the job works from. Now an
  ordinary read.

#### What driving §13 and §17 in a browser found

Five things, all fixed:

- **A P1 could never breach its acknowledgement window.** §9 guarded the check
  with `acknowledgeWithinMinutes > 0`, and P1's window is zero — acknowledge on
  receipt. Reading zero as "no window" made the one severity with no grace the
  only one that could never be late, and §17's service-restoration metric then
  reported **100%** against an unacknowledged P1 an hour old. Zero now means what
  it says.
- **A change under a notice-bearing trigger with no date recorded** said *"this
  trigger bears no contractual notice period"*. It bears one; nobody had recorded
  the date. The two sentences send a reader to opposite places, and the wrong one
  loses the entitlement.
- **Eight identical paragraphs** — one per unowned interface, each saying "name
  the counterparty" — collapsed into the one decision they actually are, with
  every name still in it.
- **A P1 showed "By: no date"** on the one thing with no grace period at all. It
  is now dated to the day it was raised, which is when it was due.
- **"The brief opened -1 days ago"** — elapsed time measured against midnight of
  the current day put the reference point before events recorded that morning. A
  negative elapsed time reads as a broken clock rather than as a new project.

Plus two plural mismatches — *"1 further activities are Class C"*, *"1 of this
workspace's questions are not answerable"* — which are the kind of thing that
makes a reader stop trusting the numbers beside them.

### The ten acceptance scenarios, executed

§19 — `backend/tests/etablix.acceptance.test.ts`. Each of the ten is the
specification's own *test action* run against the real commands, asserting the
specification's own *pass condition*, written so a reader with the spec open can
check it line for line.

They exist because a module can pass every test it wrote for itself and still
fail the thing the customer bought. **Three of the ten did exactly that**, and
the behaviour that makes them pass was built because they refused to.

#### Whose contract, and whose money

The platform had no answer to the question §20's third rule turns on: *ETABLIX
coordinates, ETABLIX contracts and ETABLIX pays are three different things.* A
supplier could be moved to Contracted under Advisory, where ETABLIX is not a
party to any supplier contract at all, and a Prime award could be placed with no
customer instruction and no facility behind it. Three things now close it:

- **The Contracted entry check consults the appointment.** Under Advisory and
  Management the state records the customer's contract and says so in the basis
  written onto the engagement history — *"the customer holds this contract and
  pays this supplier direct; ETABLIX carries no payment liability against it"* —
  because a register showing a contracted supplier with no holder reads as
  ETABLIX's supplier to everybody who opens it afterwards. Under no appointment
  at all it refuses: a contracted supplier under no appointment is a liability
  with no owner.
- **Under Prime it requires the customer's authority to proceed.**
  `recordAuthorityToProceed` takes the instruction reference, who at the customer
  gave it, the date, and the credit facility that funds the supply chain until
  the first customer payment — all four, because an instruction with no funding
  cannot be carried out and a facility with no instruction is money against work
  nobody asked for. Refused under the other two models rather than stored and
  ignored: there the customer's own purchase order is the authority, and a second
  record would be a second answer to who authorised the work.
- **The payment certificate names its payer.** Recorded on the certificate rather
  than derived when somebody reads it, because a certificate outlives the
  appointment and a document extracted into a final account two years later has
  to carry whose obligation it was on the day it was issued.

#### Two answers to one question, in one file

Making §19.2 pass surfaced a defect in §2 itself. `AppointmentProfile.fundsSupplierCost`
was copied from `TRADING_MODEL`, and the two disagree about Management because
they are **different arrangements that share a name**. CONSTRUX's
`MANAGEMENT_INTEGRATOR` is *"supplier cost passes through at cost, plus a fee"* —
the integrator pays the suppliers and recovers it. ETABLIX's Management
Integrator appointment is the opposite on this point, and §2's own control-point
table in the same file says so: the customer holds the contracts and pays the
suppliers, and ETABLIX values, recommends and administers the customer's
remedies.

The copy made the platform believe ETABLIX funded a supply chain it is not a
party to — the exact confusion §20's third rule exists to prevent — and it
reached §7's packaging argument as well, which told a buyer that a bundle under
Management was ETABLIX's own cash exposure. The profile now answers from §2's
table; `TRADING_MODEL` is untouched, because it is CONSTRUX's integrator model
and other code correctly depends on it. A test checks the profile against the
control-point table so they cannot drift apart again.

#### A P1 that could never be late

§19.7 also found that §9 guarded its acknowledgement check with
`acknowledgeWithinMinutes > 0`. P1's window is zero — acknowledge on receipt —
so reading zero as "no window" made the one severity with no grace the only one
that could never breach. Fixed with §13's work, and asserted here from the
scenario as well as from the unit.

#### What §19.10 can and cannot do

Stated rather than dressed up. The platform holds the whole mechanism the
scenario needs: `engines/perception.ts` turns a file into a `PerceptionDraft`
that changes nothing until a person confirms it, refuses a provider that cannot
actually see the file rather than asking it anyway, and refuses to confirm an
extraction the model could not read — all proved in `tests/perception.test.ts`
and not repeated. What does not exist is an ETABLIX-specific extraction task:
**no perception task reads a workforce curve or a welfare schedule into the brief
register.** So the scenario's trigger cannot be run end to end, and its pass
condition — the baseline is unchanged — holds by construction rather than by
behaviour. The test asserts the fact that makes it true, so the day somebody adds
the task it fails and has to be rewritten against the real path.

The nearest thing the module does have is §3's provisional value: a figure
nobody has confirmed carries its basis, its owner and the date after which it is
too late to change, and it sits on the command centre's NEXT list until then.

**10 mutations, 10 caught**, after two survivors named real gaps: an authority
missing its reference was accepted, and a certificate could be issued under no
appointment at all.

### The nine stages, derived rather than declared

§6 — `backend/src/domain/etablix/workflow.ts`, `GET
/v1/projects/:id/site-services/workflow`, on the Site Services screen.

Nine stages, each with an entry gate, the agent-driven work, and an exit gate
naming an authoritative record. The table is in the specification; what makes it
an engine rather than a diagram is one rule:

**A gate is derived, never set.** There is no command to move a project to a
stage and no stage field on any record. Every gate is a question asked of the
records §2–§12 already hold, answered fresh on every read. A test asserts against
the module's own source that it contains no `write(` and no `eventType:` at all —
because a command to declare a stage reached is exactly the failure §6 exists to
prevent, and the first serious argument on a job is about whether something had
been done or merely marked done.

The console panel therefore has **no controls on it**, and says so: there is
nothing to click because there is no way to move a stage other than by making the
records behind it true.

#### Three answers, not two

A condition is **satisfied**, **outstanding**, or **not derivable**, and the
third is what keeps it honest.

Stage 8's exit is "sanitised knowledge promoted to the ETABLIX library", and
there is no library: no site-services supplier score is written back from an
engagement, no price benchmark is promoted out of a normalisation, no reusable
package template exists. §7 normalises bids inside a project and nothing carries
the result forward. Reporting that as outstanding would tell somebody they have
work to do; *not derivable* tells them the platform cannot answer the question.
**It is the one stage of the nine with no authoritative record behind it**, and a
test asserts it is the only one — so building the library makes that assertion
fail and forces the count down.

The same distinction carries the commercial gates. A site manager reading the
workflow gets "the month is commercially accepted" as withheld rather than as
passed, and the stage is correctly reported as not complete: telling somebody the
month is closed on the strength of a gate they may not read is worse than telling
them they may not read it.

#### Stage 6 is a loop, not a step

The specification numbers Change/Recover between Operate and Demobilise, and on a
real job it is neither: it runs whenever a variance is detected, alongside
whatever else is happening. It is marked `concurrent` and excluded from the
furthest-stage calculation, so a project at Operate with three live changes is
reported as at Operate with change running — not as having left Operate.

The furthest-stage rule is strictly sequential for the other eight. A later gate
that happens to pass while an earlier one has not does not move the project
forward: Demobilise's entry passes on a project where every composed system has a
removal plan, and if nothing has been packaged that project is at Define, because
the records Demobilise is about were never built.

**11 of 13 mutations caught.** The two survivors are the module gate, which every
position underneath repeats, and a comparison that only differs once a withheld
condition appears on an *entry* gate, which none does today.

The end-to-end test walks a real project the whole way — brief answered, both a
welfare system and the temporary MEP that supplies it composed in the same zone,
one package let to a prequalified firm under a recorded authority to proceed,
both systems taken through G0 to G6, a service period measured, removal plans
agreed and all seven demobilisation workstreams accepted. Written out rather than
shortcut, because a project jumped to that state would prove the later gates
against a fiction. It also found that a welfare compound alone cannot pass G3 —
"utilities available at the boundary" derives from a composed MEP system in the
same zone — which is correct, and is the kind of thing a shortcut fixture hides.


### The two capability areas nobody was watching

The fleet is organised so that every agent declares, in `mandate.reads`, the
capability areas it watches. Counting those declarations against the permission
matrix found **24 of 26 areas covered** and two with nobody at all:
`LOOKAHEAD_CONSTRAINTS` and `SUPPLIER_SUBMISSION`. Both are now watched, taking
the fleet to **76 agents** and coverage to **26 of 26**.

The gap mattered more than an even distribution would suggest, because both are
areas where the record going stale is **silent by construction** rather than
visible. A stale delay forecast reads as stale. These do not:

- PPC is the mean across *reviewed* weeks. A week that ends without its promises
  being reviewed does not lower the figure — it vanishes from it, along with the
  reasons the promises were missed, which are the part that makes the next plan
  better.
- A return arriving after the deadline is refused outright, correctly, because
  accepting one is how an award gets overturned. So the only moment anybody can
  act on a thin enquiry is *before* it closes. After that the position is fixed.

**`AGT-LOOKAHEAD`** raises four things: an open constraint past the date it was
needed by (urgent where any of them sits on the critical path); a task blocked on
site with no constraint raised against it; a week that ended unreviewed; and a
project in construction that has never published a lookahead at all. The second
is the one a screen cannot show — `updateTaskStatus` refuses `BLOCKED` without a
reason, an owner, an impact and a next action, so the block *is* recorded, but
only the constraint log carries a need-by date and only the constraint log stops
the work being promised next week.

**`AGT-RETURNS`** sweeps every open enquiry: one closing inside five days with
fewer than three returns, one whose deadline passed without a competition, a
return that never resolved to the supplier register, and returns carrying
exclusions or contract exceptions that were never levelled.
`reconcileTenderResponses` already derives all of this for one RFQ and is a good
screen. Nobody opens forty of them; that sweep is the whole job.

#### Both observe, and neither proposes

The obvious proposal on a blocked task is to raise a constraint from it. It is
not made, and the reason is worth stating: a constraint needs a `needByDate`, and
nothing in a blocked task says when the block has to be gone by. An agent that
invented one would be putting a date into the constraint log that no person
chose, and the whole Last Planner measurement then runs against it. The action on
a thin enquiry is to phone three firms, and there is no command for that either.
An agent whose only honest output is a finding gets `proposes: []` and an
`OBSERVE` ceiling rather than a proposal built on a guess.

#### A defect the first draft carried

The levelling finding was suppressed by checking for an `Adjudication` carrying
the RFQ's id. `Adjudication` carries `evaluationId` and `selectedSubmissionId`
and **no `rfqId` at all**, so the guard never fired once — the agent reported the
flagship's settled, awarded enquiry as an open exposure. Fixed at the source by
reading the RFQ's own status, which is the fact that actually settles it. The
test that pins it asserts the agent says nothing about the awarded enquiry.

**13 of 13 mutations caught**, including every threshold, every comparison
direction and every suppression rule. The tests build their conditions through
the ordinary domain commands on the seeded tender and construction projects — the
flagship is in operations, where the phase gates close planning and procurement
to everybody — so what the agents find is something a project could actually get
itself into. Publishing a lookahead against constrained work was refused by the
platform mid-writing, which is Last Planner working exactly as intended.


### Security: device binding, risk-based step-up and passkeys

Three controls the register listed as absent, built as one vertical: a device
register, a risk model that decides when to interrupt somebody, and WebAuthn.
Each is reachable from a **Security** screen every role can open.

#### Device binding, and what it actually defeats

Stated first because a control whose limits are not written down is one people
over-trust.

A session may be **bound** to an enrolled device. The device holds a secret shown
exactly once and stored only as a SHA-256 digest, and every request must carry
`x-device-proof: HMAC(secret, tokenId)` alongside the token.

- **It defeats a leaked token.** An access token in a log, a proxy, a screenshot
  or a support ticket is not enough on its own: the proof travels in a header
  the token does not travel in, and it is bound to that one token id, so a proof
  lifted from one session is worthless against another.
- **It defeats a session that outlives its machine.** Revoking a device refuses
  every token bound to it, at the gateway, on the next request. That is the
  control behind "sign my lost laptop out" — and without a device register there
  is no such instruction to give, because there is no password here to change.
- **It does not defeat malware on the enrolled device.** Something with the
  browser's own storage has both halves. What it buys against that attacker is
  attribution and a kill switch, and nothing here claims more.
- **It does not defeat a stolen database.** The stored verifier can forge a
  proof. This is written down in `verifyProof` rather than left implied: a
  database that yields the verifier has already yielded every user record and
  the whole ledger, and storing the raw secret to close it would trade a defence
  against the attacker who has everything for a gift to the one who has a table.

`GATEWAY_AUTH_REQUIRE_DEVICE_BINDING` is **off by default**, and that is a
migration decision rather than a security opinion: turning it on refuses every
session minted before a device existed, which signs a live deployment out all at
once. With it off an unbound session is not refused — it is **scored**.

#### The risk model, published rather than described

Nine signals, each worth points and a full sentence. Bands at **35** and **60**,
set by the cases they must catch and the cases they must not:

- **No single signal reaches HIGH.** The heaviest is 35. A person on a new
  network is not a threat, and interrupting them there is how people learn to
  click through prompts without reading them.
- **Two heavy signals do.** An unbound session certifying £840,000 scores 65; a
  governance change from an unbound session scores 60. A first calibration at 70
  let the first of those through as merely "worth noting", which is the failure
  that matters — a threshold nothing trips is one nobody notices is broken.

A step-up is a fresh verification that holds for fifteen minutes. It is **not** a
lock and not something an administrator clears: a control somebody else has to
unblock is a denial of service anybody can perform on anybody by travelling. An
API key is never asked to step up, because it cannot — an integration that may
not do something is told it may not, rather than being refused under a
misleading name.

Nothing here calls a model, calls a reputation service, or fingerprints a
browser. A fingerprint is a tracking identifier that would have to be disclosed,
retained and defended, and it buys less than the device register already gives.
Networks are remembered coarsely — the /24 or the /48 — which is the coarsest
thing still useful as "somewhere this device has been" and the finest thing that
is not a location history of a named employee.

#### Passkeys, verified here rather than by a library

Zero runtime dependencies is settled, and what a WebAuthn library does is three
things this does in about four hundred lines: decode a small CBOR structure,
read a COSE key out of it, and check one signature with primitives `node:crypto`
already ships. Seven checks, in order, each of which is a real attack if skipped:
challenge issued-by-us and now spent; ceremony type; **origin, compared exactly**;
RP ID hash; user presence; the signature; and the counter, which never goes
backwards.

Two things are deliberately **not** done and are stated rather than implied:

- **Attestation is not requested.** A certificate chain with no root store to
  verify against and no metadata service to resolve the AAGUID would be stored,
  shown and believed without ever being checked. Asking for evidence nobody
  verifies is worse than not asking.
- **`allowCredentials` is always empty.** A list keyed off an email address is
  precisely the account-enumeration oracle `POST /v1/auth/login` goes to such
  lengths to close.

The tests build **real ceremonies** — a real P-256 key pair, real CBOR, real
authenticator data, a real ECDSA signature over the bytes WebAuthn defines — so
every refusal is a real attack with one byte changed, not a malformed blob.

#### What driving it over HTTP found

Three defects the module tests could not see:

- **A step-up wrote against the `User` entity**, which already lives in the
  tenancy's own project, and the ledger correctly refuses to move an entity
  between projects. `STEP_UP_SATISFIED` now has its own `StepUp` entity.
- **The tenancy view was gated on `PLATFORM_ADMINISTRATION`**, which an
  enterprise administrator does not hold — so the one person who should see
  their company's exposure was the one person refused it. Now
  `ENTERPRISE_STRUCTURE`, the same authority that issues API keys.
- **Enrolment did not bind the session it was performed from.** A person enrolled
  a device and stayed unbound until their next sign-in, so the control looked as
  though it had not worked and the risk model went on charging them thirty points
  for a device sitting in the register. Enrolment now re-mints the pair with the
  `did` claim — the only moment a live session can be bound, because a claim can
  only enter a token as it is signed. `authenticatedAt` is carried across rather
  than reset, so nobody can refresh their way out of a stale sign-in.

**All 40 mutations caught** across the three modules, the gateway wiring and the
routes — including every skipped check, every reversed comparison and every
threshold. 69 tests, of which 30 are real WebAuthn ceremonies and 13 go through
the socket.

### A chart kit, and the defect it was built with

Fifteen chart types as inline SVG — bar, line, area, pie, donut, histogram,
scatter, bubble, box plot, gauge, KPI card, sparkline, heatmap, funnel,
waterfall, treemap, Gantt and a proportion bar. No library, for the same reason
there is no WebAuthn library: what it would buy is a few hundred lines of
arithmetic, and what it would cost is a bundle, a theming layer fighting this
one, and an upgrade treadmill on a product whose premise is an auditable record.

Four rules every chart keeps, and each is a way a chart lies:

- **A chart with no data is not a blank box.** It returns the design system's
  empty state with the caller's own sentence. An axis drawn over nothing reads
  as "zero", and zero and "never measured" are different facts.
- **A chart never invents a number.** No interpolation across gaps, no smoothing
  that moves a point. A line with a hole in it is drawn with a hole in it.
- **A value axis includes zero.** An axis starting at 4,000 makes 4,100 look
  twice 4,050, which is the commonest way a chart lies without a wrong number.
- **Colour is never the only channel.** Roughly one man in twelve cannot
  separate the red from the green.

**The kit shipped with the exact defect its own rules forbid, and the tests
found it.** `Number(null)` is `0`, `Number('')` is `0` and `Number(true)` is `1`,
so a week nobody measured, a blank heatmap cell and a boolean were all plotted as
real values — a gap in a line drawn as a drop to zero, and an unrecorded cell
drawn as a recorded zero. Fixed at the root in one predicate.

**19 of 19 mutations caught**, 74 tests. The tests read the geometry rather than
checking something was returned, because a chart defect produces a picture that
looks entirely correct and says something false — a wrong scale, a dropped point,
a bubble sized by radius instead of area, a treemap of slivers, a subtotal drawn
from the running position instead of the axis.


### All fifteen site documents, and the sixteen CDM duty documents

The Site Documents screen reported **7 of 15 generatable**, with eight types
"waiting on a record". The document engine was entirely right about all eight:
each declares the records it is composed from and refuses by name where one is
absent, rather than filling the section in from an assumption. What was missing
was **the records**, not the engine — and the CDM duty set was worse: sixteen
document types were declared with their approvers and required sections, and
exactly one of them had a record behind it, which made that table a list of
things that did not exist.

Both are closed in the seed, through the ordinary domain commands. That matters
twice over. A record written straight into the ledger would skip every rule the
command enforces — a permit checks each named operative's ticket against the
**permit's own end date**, an induction is refused without an approved
Construction Phase Plan behind it — so the demonstration would show documents
composed from records the platform itself would never have accepted. And several
of these commands are phase-gated, so they had to be created at the point in the
project's history where they really would have been.

The phase gates did their job while this was being written. `BOQ_TAKEOFF` refuses
a measurement schedule during construction — correctly, because a bill measured
after the works started is measured against what was built rather than against
what was priced — so the schedule moved to the tender stretch. `LOOKAHEAD_CONSTRAINTS`
refused the PM the authority to open a meeting record, so the planner opens it
and the PM still chairs it: who acts and who chairs are different facts and the
minutes record both.

#### The duty set is complete, and six documents are unsigned

Drafting fifteen skeleton documents would have been worse than leaving them
absent. `principalContractorPosition` reports an unfilled section as a **named
breach**, so fifteen empty documents meant ninety-three breaches on a project
whose paperwork was supposed to be in order. Every section a record cannot answer
is therefore written out in `seed/dutydocuments.ts`, and each is specific to this
site — the historic culvert of unknown location, the live plant 18m away, the
inlet chamber the emergency services cannot effect a rescue from inside the
exposure window. A COSHH assessment that says "wear appropriate PPE" is the thing
this platform exists to stop being produced.

**Nine are approved and six are not**, and that is the honest state rather than a
tidier one. Six types are signed off by `EPC` rather than by `SAFETY` —
temporary works, lifting, logistics, underground services, excavation and the
equipment register — and `approveDocument` refuses an approver who does not hold
that role, because competence under CDM is a legal requirement and not a routing
preference. This tenancy has no EPC representative, so those six sit complete and
awaiting signature, which is where a real project's paperwork spends most of its
life. Approving them under the safety lead's name would have been recording a
signature the platform had just refused.

Zero breaches. All fifteen site document types generate — verified by generating
all fifteen and reading back a reference, a section count and a content hash for
each, not by reading the catalogue's own summary.

#### Two defects the seed exposed

Both are the same shape: a document that renders the *first* matching record
rather than the right one, which is correct exactly once — on a project that has
only ever had one.

- **The Construction Phase Plan rendered the earliest plan ever drafted.** On a
  project whose plan has been revised that issues last year's arrangements under
  this year's date, over the current approver's name, with the current document
  reference on it. Every field populated, every field real, and the whole thing
  superseded. Now the latest **approved** plan, falling back to the latest draft
  where none is approved — and the fallback matters as much as the rule, because
  a project that has drafted a plan and not approved it must still be able to
  produce it.

- **The Bill of Quantities was project-scoped** and composed from whichever
  measurement schedule came first. The moment a second package is measured, the
  platform silently picks one and issues it to a client titled "Bill of
  Quantities" with the wrong package on the page — and nobody downstream can
  tell, because a civils bill and a mechanical bill look identical in structure.
  It is now **record-scoped**, like Meeting Minutes and the Material Approval
  Submittal: the caller names the schedule, the console offers only measurement
  schedules, and a project with one behaves exactly as before.

#### What the seeded records broke, and why each was the test's premise

Six suites failed on the richer seed, and every one of them had been asserting a
project-wide absolute that was only ever true of a thinner project — "exactly one
open NCR", "the plan starts at version 1", "one site meeting". Each was corrected
to assert what the test actually owns: the NCR *it* raised, the version *relative*
to what was there, every subject offered rather than a count of them.

One was different and is worth naming. `refuses construction-phase work while no
plan is approved` is a real safety test, and the seed destroyed its premise by
approving a plan. It now runs against the sibling project that is in construction
and has drafted nothing — which is more honest anyway: the refusal is about a
project that has not done the paperwork, and the flagship has.

---

## Data protection: keys at rest, transport posture, and a document that verifies without us

Three separate protections, each answering a threat the platform could previously
only describe.

### Evidence at rest — `backend/src/evidence/envelope.ts`

Envelope encryption over the whole evidence store, wired into all four paths of
`backend/src/evidence/store.ts` (filesystem write and read, object-store write
and read). AES-256-GCM, format `CXE1 ‖ version ‖ iv ‖ tag ‖ ciphertext`. Data
keys are **derived, not stored** — HKDF-SHA256 from the master with the tenancy
as the info parameter and the key version in the salt — so the key register is
empty and there is nothing extra to back up, lose or leak.

Two properties are load-bearing and both are tested:

- **The tenancy is bound in as additional authenticated data.** The store is
  content-addressed and its paths are predictable, so moving a file between
  customers' prefixes is a copy command. With AAD, such a file fails to
  authenticate instead of decrypting into the wrong customer's evidence.
- **Turning encryption on is a non-event.** A file that is not an envelope passes
  through `decrypt` untouched, so files written before the key existed stay
  readable and new ones are encrypted. There is no migration and no window in
  which the store is half readable. Turning it *off* is the asymmetric direction
  and `posture()` says so rather than implying otherwise.

Plaintext hashing is unchanged: the hash remains the address, so nothing about
content addressing or evidence linking moves.

### Transport — `backend/src/ops/transport.ts`

A report, not an implementation, and the file says why: this process serves
plain HTTP by design because it runs behind a load balancer, and from inside the
process both arrangements look like a socket. So it checks what is checkable —
whether the public address is https, whether HSTS is sent and for how long,
whether cookies are Secure, whether a forwarded-protocol header is trusted and
from where — and **names what it cannot see** rather than inventing an answer.
Cipher suites, protocol versions and the certificate chain belong to whatever
terminates TLS and are listed as not visible from here.

A declaration of `TLS_TERMINATION=THIS_PROCESS` is reported as CRITICAL, because
this process has never been given a certificate and a false declaration is worse
than none — it is the answer somebody will give an auditor.

### A document that proves itself to somebody with no access

`sha256:…` on a document proves nothing to a recipient. It is a hash of the
document computed from the document, so anyone who alters a page recomputes it,
prints the new value in the footer, and a reader comparing the two finds them
agreeing on a forgery.

Every export now carries `CXV1:<issuer>:<tag>` — an HMAC over the tenancy, the
reference and the content hash, keyed to this deployment. It is printed on the
PDF cover, in the HTML footer, on the last page of a Word file and in its
document properties.

- `GET|POST /verify-document` — public, server-rendered, three fields, no account.
  The audience is a solicitor, an adjudicator or an insurer holding a PDF: a check
  behind a login is a check nobody performs, and a check nobody performs is not a
  control.
- `POST /v1/verify/document` — the same answer for an integrator. `readOnly`, so
  it answers 200: it creates nothing.
- Both call one `verifyDocument` helper. Two implementations would eventually
  disagree, and on this question disagreeing means one of them calling a genuine
  document a forgery.

**Every failure returns one identical sentence.** A mistyped code, an invented
tenancy, an altered figure and an unknown reference are indistinguishable in the
response, because grading an attempt tells a forger which half of it was right.
Nothing is disclosed until a valid tag has been presented; past that, the reply
carries what the holder is already looking at, confirmed against the register.

What a verification establishes, and what it does not, is stated on the page and
in the API: it proves **issuance and integrity**, not that the document is the
current revision or that its contents are true.

### Where it is visible

`GET /v1/admin/data-protection` returns both postures plus the verification
position, gated on `ENTERPRISE_STRUCTURE:R` — read by the enterprise admin,
because the question it answers ("what do we tell our client's security team") is
asked of the customer, not of the operator. Its console door is a third tab on
the existing **Security** screen, with KPI cards, a severity gauge and a bar
chart, and with the non-claims given the same weight as the claims.

`standing` is the **worse** of the two legs, never an average: a customer's data
is as protected as its weakest one.

### Two defects found by mutation testing, not by the suite

- **The verification tag's field separators were NUL bytes**, invisible in the
  source. Functionally sound, but any tool that normalised them would silently
  invalidate every code ever issued — and the failure would present as genuine
  documents being reported as forgeries. Replaced with `|`, which cannot occur in
  a ULID, a document reference or a `sha256:` hash.
- **The disclosed detail was not pinned to the matching record.** A mutant that
  returned the *first* export in the tenancy survived the suite, which means a
  recipient could have been shown another document's issue date beside a
  "genuine" verdict. Now tested against two documents issued in sequence.

Twenty mutants across the envelope, the transport report, the routes and the
exporter; all twenty killed after these two fixes.

### What this does not do, recorded so it is not mistaken for compliance

- **A live process is not protected.** Anything that can call the decrypt path
  reads plaintext, because it must. This is encryption at rest and nothing else.
- **A stolen master key is a stolen archive.** Where `EVIDENCE_MASTER_KEY` is set
  from a file on the same volume as the evidence, this control does nothing at
  all, and `posture()` says that rather than reporting "encryption: on".
- **Metadata is not hidden.** File sizes, content hashes and which tenancy holds
  how many objects are visible without the key.
- **No key is generated at boot.** A deployment with no master key behaves
  exactly as it did before this existed. Generating one would produce a system
  whose evidence becomes unreadable on the next restart.

---

## The public argument: what a buyer sees before they see the product

The site was arguing from the product outwards — hash-chained, append-only,
closed catalogue, replay — which is the answer to "can this be trusted". That is
the *second* question a managing director asks. The first is what any of it is
worth, and the site never answered it.

### What changed on the landing page

- **The lede leads with consequence.** A missed pay less notice, an
  unsubstantiated extension of time, margin eroding between the event and the
  review that finds it. The architecture is still there, one paragraph down and
  quieter, where it belongs.
- **One primary call to action** instead of three of equal weight, and it says
  what the visitor will see rather than "Try it now".
- **A money section, above the proof sections.** The s.111 scenario in the terms
  somebody feels it: an application, a valuation, a notice two days late, and the
  whole application payable in full. Explicitly labelled as running on the seeded
  demonstration project rather than dressed as a customer outcome.
- **"It refuses"** — six behaviours that are in the codebase with tests behind
  them: no double certification, no approval of a plan with gaps, no signature in
  a name that is not competent, no AI spend without a ledger entry, no agent
  above `PROPOSE`, and authorship marked on every AI-written line. Every
  competitor in this market sells generation; the useful moments here are the
  declines, and none of them were on the site.
- **An exit section.** The objection nobody in this market answers out loud is
  "will you exist in three years". The answer is not a reassurance, it is three
  testable properties: exports leave whole, documents verify without us, and the
  log verifies on its own terms. The middle one only became true today.

### `/exposure` — arithmetic on the reader's own numbers

Five inputs, five outputs, and the working shown on every line.
`backend/src/site/exposure.ts` holds the arithmetic; the page is a form POST
because the CSP admits no inline script and a browser copy would be a second
implementation.

The discipline that makes it worth having rather than a lead magnet:

- **No industry average, no assumed miss rate, no "companies like yours
  typically recover".** One invented number would be the largest figure on the
  page and would make a reader discount every real one beside it. A test asserts
  that doubling turnover doubles every money figure exactly, which is what makes
  "nothing is smuggled into the sums" checkable rather than claimed.
- **It does not claim a saving.** It sizes the exposure the Act creates and
  leaves the reader to judge how often it bites them, because only they know.
- **Nothing is stored and nothing is sent anywhere.** A page that asked a
  managing director for their turnover and kept it would be a lead-capture form
  wearing a calculator's clothes.
- The three things it will not claim are printed on the page itself.

One defect found by testing: an empty field became zero rather than falling back,
so a visitor who cleared a box would have been shown a page of £0 figures and
would reasonably have concluded the calculator was broken.

### `/verify-document`, promoted from a utility to a proof

Linked from the footer and from the landing page's exit section, and made
indexable — it is a public utility a recipient may search for, unlike the
unsubscribe and signup-confirmation pages that share its renderer and correctly
stay out of the index. Its `default-src 'none'` policy is unchanged.

### What only a human can supply, and what its absence costs

Recorded because the gap is real and no amount of building closes it:

- **No customer reference, logo, quote or case study exists on the site.**
  Construction is the most reference-driven industry there is, and a contractor
  will not be the first onto an unproven system that holds the record they defend
  themselves with. This is the single largest remaining obstacle to conversion
  and it cannot be built — it has to be earned, or reframed honestly as founding
  terms for the first customers.
- **No named founder, address or company history.** A buyer is being asked to
  trust an anonymous supplier with their evidence.
- **No video.** The strongest asset here is a live £17.6M job somebody can walk
  through, and it is currently described rather than shown.

Nothing invented has been put in their place.

---

## Commercial: transaction revenue, consented benchmarking, expansion and engagement

Four things, in `backend/src/commercial/`. The three engines are pure — numbers
in, findings out — and `position.ts` is the only seam that knows where a seat
count or an event timestamp actually lives.

### Transaction revenue — `settlement.ts`

A fourth money path, deliberately not folded into the three that existed. A
subscription charge is what a tenancy pays to hold the platform; ACU consumption
is what they pay for AI; a payment certificate is the customer's own money moving
to their supply chain. Transaction revenue is a fee on that third one **where the
platform actually carried the money**.

- **`RECORDED` earns nothing, and says so.** Recording a payment the parties made
  directly is what the subscription buys. Those settlements exist with a zero fee
  and a stated reason rather than not existing, because a silent absence is
  indistinguishable from a bug.
- **The fee is banded down and capped absolutely.** `FEE_CAP_MINOR` is the most
  important number in the file: without it, revenue scales with the customer's
  contract value rather than with what the platform did, and the first customer
  to run a £20M certificate through it meets a five-figure fee for a bank
  transfer. There is a floor for the mirror reason — a fee that loses money on
  small transactions makes the platform hostile to small subcontractors.
- **A reversal returns the fee.** Keeping a cut of a payment that was reversed is
  charging for a service that did not complete, and the customer finds out from
  their bank rather than from us.
- Settling twice is refused in the domain, not the route, so a second door cannot
  reintroduce it.

### Benchmarking — `benchmark.ts`

The most dangerous file in the module, and written that way: a benchmark is a
disclosure mechanism wearing a statistic's clothes.

- **Consent is filtered first.** Checking k against everybody and then averaging
  only those who agreed reports a cohort of forty resting on three — the failure
  that looks safest in review.
- **k alone is not enough.** A cohort of five where one member is 94% of the
  total is a cohort of one wearing a five, and k-anonymity says nothing about it.
  `MAXIMUM_DOMINANCE` is checked separately, against **magnitude** rather than the
  signed total — mutation testing found that a signed total lets an all-negative
  cohort (every project loss-making, which is ordinary) produce a negative ratio
  that walks straight through the check.
- **No minimum, no maximum, and no median below twice k.** Each would be one
  company's own figure; calling it "the lowest in the cohort" does not change
  what it is.
- **A cohort defined by more than three characteristics is refused.** "Water
  contractors in Rochdale turning over £8–9m" names one company without using its
  name and passes every count-based check.
- **A non-contributing company is still told where it stands.** Withholding a
  reading to extract a contribution would be a dark pattern.

### Expansion — `expansion.ts`

An expansion engine is a machine for generating reasons to charge more, so every
proposal is derived from a limit the customer is **actually against** and carries
the measurement that produced it.

- On the largest package, hitting a ceiling produces `NOTHING_TO_PROPOSE`, not an
  upsell for a package that does not exist.
- **Downgrades are proposed too.** A tenancy paying for what it does not use is an
  unhappy customer who has not noticed, and this is the cheapest retention there
  is. An engine that only ever pointed upward would have told the reader what it
  was for.
- A company three weeks in is never told to downgrade — they have not finished
  onboarding, and telling them to spend less is telling them to give up.

### Engagement — `churn.ts`

**No score, no probability, no model.** There is no cohort of past churn to have
trained on, and a percentage produced without one is a decimal point with nothing
behind it. What it produces is a decay measurement against the tenancy's *own*
prior period, which is scale-free — a company that wrote 400 events a week and now
writes 40 is in trouble at a volume another company thrives at.

What was measured is kept apart from what it might mean, and the seasonal reading
is always offered: a company between projects looks identical to a company
leaving, and sending an account manager to ask an unhappy question of a customer
who is simply quiet is itself a reason to leave.

### Two name collisions the invariants caught

`Settlement` already meant a tender settlement meeting, and
`POST /v1/projects/:projectId/settlements` was already its route. Both are now
`PlatformSettlement` / `/platform-settlements`. One entity type or one path
carrying two concepts is how a permission written for one ends up granting the
other.

The console screen is `frontend/pages/platformcommercial.js` — **"Your account
with us"** — named apart from the existing `commercial.js`, which is Cost & Value
and is the customer's money on their own jobs.

The screen is shown to the **customer**, not only the operator. A platform that
computes "this account is decaying, propose an upgrade" and shows it only to its
own sales team has built a file on somebody; the same reading handed to the
customer names what they pay for and do not use.

25 mutants across all four files, all killed after the two defects above were
fixed. 5,262 tests pass.

---

## The data layer: change feed, projected graph, and retrieval that refuses

Three things in `backend/src/datalayer/`, and one of them is mostly a refusal.

### The change feed — `changefeed.ts`

`GET /v1/changes`. Ordered, resumable, at least once, with an idempotency key on
every entry.

Not the notification outbox (push to a person) and not the webhook register
(push to a system). **Pull** is what an integrator actually needs: a webhook that
failed while their server was down is a hole nobody can fill, and asking a
customer to reconcile from a dashboard is asking them to write this file
themselves.

- **Ordered by `(timestamp, eventId)`** — the ledger's own total order. Mutation
  testing showed why the id tiebreak is load-bearing: a command writes several
  events in one millisecond, and a cursor comparing timestamps alone resumes
  past all of them. A consumer would never learn they existed.
- **At least once, said out loud.** Read a page, crash before storing the
  cursor, read again, and you see it twice. That is inherent to a pull feed and
  cannot be engineered away, so the contract names it rather than claiming
  exactly-once — a promise a customer would design against and be burnt by.
- **No entity state.** Each entry says what changed and where to read it. A
  snapshot in the feed is stale on arrival, and streaming state past the
  per-entity check is how a feed becomes the widest hole in the platform.
- **Access per entry, not once at the feed**, using the same fallback `lineage`
  uses so the two cannot disagree about the same record. Withheld entries are
  counted, so a count that does not reconcile has a visible reason.
- **A malformed cursor is refused**, never treated as "start from the
  beginning" — a consumer silently sent back to the start reprocesses its whole
  history and, unless their idempotency is perfect, acts on all of it again.

### The projected graph — `graph.ts`

`GET /v1/projects/:projectId/graph`. The same typed edges `lineage.ts` walks,
projected across a whole project instead of outward from one record — which is
what answers "what is everything hanging off" and "what is floating
unconnected", neither of which a walk from a root can see.

`buildIdIndex`, `referencesIn` and `labelOf` are **imported from lineage**, not
reimplemented. Two derivations of "what caused this" would disagree the first
time either was touched, and on a graph that means the platform giving two
answers to one question. Still no graph store, for lineage's reason.

**`declaredShare` is the number that matters**: the proportion of edges somebody
declared (evidence, AI inputs) rather than the platform inferring from a field
that happened to contain an id. A project at 5% declared has a graph assembled
by pattern matching, and arguing a dispute from it would be a mistake. Presenting
inferred and declared edges as the same line is the whole problem with knowledge
graphs nobody can audit.

### Retrieval — `vectorindex.ts` and `embedding.ts`

`POST /v1/projects/:projectId/semantic-search`, and today it **refuses**.

A vector index always returns neighbours. There is no such thing as an empty
result unless something refuses to produce one — so the refusals are the design:

- **No embeddings, no retrieval.** It never falls back to keyword matching
  dressed as semantic search. A cheaper answer wearing the expensive one's
  clothes is the worst outcome available, because nobody can tell which they got.
- **Below `MINIMUM_SIMILARITY`, nothing is returned.** That floor is what turns
  "here are the four closest things in the corpus" into "there is nothing here
  about that" — a true and useful answer an unfiltered index can never give.
- **Every passage keeps its record.** A retrieved sentence with no `refType`/
  `refId` is unverifiable, which is what this platform exists not to produce.
- **Retrieval is not an answer.** Passages come back as they stand. A summary of
  retrieved passages is a new claim with nobody's name on it.
- **A provider returning the wrong number of vectors is refused**, because
  scoring passages against vectors that may belong to different text produces
  plausible rankings out of nothing.

**There is deliberately no local stand-in**, and `embedding.ts` exists to say so
in one place. Every other stand-in here is visibly a stand-in on its output. A
stand-in *embedding* is a vector, which nobody can read, and hashed tokens rank
and score exactly like real ones — the one stand-in in this codebase that could
not be labelled honestly enough to be safe. Wiring a real one up changes one
function; the refusal discipline does not move.

The endpoint answers **200 with `answered: false`** — it worked and declined,
which is a different thing from failing.

### Where it is visible

Two panels on the Golden Thread screen, which already hosts the lineage walk:
how the project is connected (with the declared-share gauge) and what an
integration would receive.

21 mutants; 20 killed. The survivor — taking the cursor from the last returned
entry rather than the last examined one — was verified as **equivalent**: a page
is only ever entirely withheld at the tail, where `more` is already false, so
nothing is lost or repeated either way. The stronger version is kept and the
reasoning is recorded in the file, because the equivalence depends on the scan
reaching the end, and a future change that bounded it would turn the weaker
version into a stall with no test standing against it. A contrived test was
written and then removed rather than left asserting something untrue.


---

## The launch audit and its verdict

`docs/LAUNCH_AUDIT.md`. Sixteen attacks against a running server rather than a
reading of the code that implements the controls.

**Controlled pilot: GO. General availability: NO-GO.** The product is not the
risk; the deployment is.

Every authentication, isolation, authorisation and financial control held: 401
on seven anonymous and forged-token attempts including `alg=none`, 403 on two
privilege attempts, 409 on a double settlement, £750 on a £20M transaction
against the cap, 429 under 400 rapid logins, and a document verification that
discloses nothing to an invented code.

One finding was graded a breach by the probe and disproved on inspection: a
cross-tenancy read returned **200 with zero events**, which is the tenancy filter
holding and returning an empty set rather than a 403 that would confirm the
project exists. It is recorded in the audit along with why it was not a breach,
because an audit that quietly drops its false positives is one nobody can check.

Two real gaps, both correct behaviour and both open: `EVIDENCE_MASTER_KEY` is
unset and TLS termination is undeclared in the shipped configuration. The
platform refuses to generate a key at boot or claim a certificate it has not been
given, and reports the tenancy's standing as WEAK rather than "encryption: on".
Until an operator sets both, a stolen volume is a readable archive.

The blocking item for general availability is that the ledger is in-process. The
schema and the client are both verified against a real Postgres 16, so it is
wiring rather than design — but it is wiring nobody has done, and one process
holding several customers' records is a risk nobody can watch.


---

## The blueprint, strengthened where it was weakest

`docs/ai-os-blueprint.md` described what the platform is and where the market
fails, and had no section saying where **this** fails. A market analysis with no
losing column is marketing, so three were added.

- **§2.1 the beachhead, named.** UK water framework contractors under AMP8: the
  frameworks are finite and countable, the duty-holder regime is heaviest there,
  the payment regime is the one this platform computes, and the flagship
  demonstration project is a water treatment works — so a prospect walks through
  their own kind of job rather than a generic one. Expansion is by adjacency of
  contract form, not by sector noun.
- **§2.2 where CONSTRUX loses.** Six situations where a real contractor rightly
  picks somebody else: an incumbent document control system mid-framework, a
  buyer whose actual problem is document management, portfolio resource
  levelling, an ERP requirement, the absence of a reference to call, and a
  procurement gate that wants an ISO 27001 certificate rather than the controls
  the certificate attests to.
- **§2.3 the three honest weaknesses.** The record's value is back-loaded and the
  costs are all in month one. The refusals will cost deals — and softening them
  under sales pressure leaves nothing worth buying. One process holds the record
  today.
- **§17.1 how a well-funded competitor attacks.** Not by copying the ledger: by
  shipping "audit trail" as a checkbox feature, by bundling it free inside a
  suite already deployed, and by waiting, since the value is back-loaded.
- **§17.2 what the moat does not cover.** It is not a moat on day one, it does
  not stop a customer leaving — by design, since the record verifies without us —
  and it is not a network effect. The benchmark is the only candidate and is
  deliberately capped by k-anonymity and consent.

The appendix now points at `docs/LAUNCH_AUDIT.md`, so the document that makes the
claims and the document that attacked them are linked in both directions.

---

## Charts on the screens that had data and no picture

Five screens gained a chart, and each was chosen because it answers a question
the table beside it does not.

- **Risk** — the three contingency positions as bars (expected, P80, worst case)
  and the top drivers as horizontal bars. The point of the first is the *gap*
  between P80 and worst case, which is the part nobody has priced and which
  three numbers in a row do not show.
- **Pipeline** — bid decisions as a donut. Deliberately **not** a funnel:
  `byStage` is `{BID, NO_BID}`, two outcomes of one decision rather than stages
  an opportunity passes through, and a narrowing funnel would draw a sequence
  that does not exist.
- **Billing** — billed spend by module as a donut, with the footnote naming it
  as billed rather than provider cost, since the difference is the platform's
  margin and has its own column below.
- **Handover** — requirement completeness as a gauge, by weight rather than
  count. On the flagship project it renders **nothing**, because `weightTotal`
  is zero: a gauge at 0 of 0 is a dial pointing at nothing, and the existing
  "—" is the honest answer.
- **Construction** — stages passed as a gauge, stating that a stage not yet
  reached counts the same as one that failed.

### A chart-kit defect the screenshot found

Horizontal bars clipped any label wider than the 168px gutter — drawn at a
negative x and cut off by the viewBox edge, which loses the *beginning* of the
label, the part that identifies the row. Long labels are exactly why anybody
reaches for horizontal bars, so this was broken for its main use.

`fitLabel` now cuts the label to its gutter and puts the whole string in a
`<title>`, so nothing is lost to a hover or a screen reader. Four tests cover
it, and reverting the fix fails three of them.

### Four options that were being silently dropped

Found by checking every option passed against the kit's actual signatures rather
than by anything failing:

- **`kpiCard` takes `sub`, not `detail`.** Seven KPI cards across Security, Your
  account with us and Golden Thread were rendering with no explanatory line at
  all. Nothing errored; the text simply never appeared.
- **`gauge` takes `footnote`, not `caption`.** Three gauges the same.
- **`labelKey` / `valueKey` are not options anywhere** — `barChart` reads
  `row.label` and `row.value` directly. Six ignored props removed.

All of them rendered without a console error, which is why a browser walk that
only counts errors is not a check. Reading the page is.

### The adversarial launch audit, and what it changed

`docs/LAUNCH_VERDICT.md` is the record: 112 probes against running servers, 25
phases, and a **CONDITIONAL GO** — restricted launch only, general availability
refused. Three mandatory gates fail or are partial (reliability, observability,
operational readiness) and no score offsets a failed gate.

The verdict is not about the code. Every authentication, authorisation,
tenant-isolation and financial control that was attacked held: 24 auth attacks,
24 held; ten concurrent attempts to settle one settlement produced one 201 and
nine 409s; a £20,000,000 carried transaction was charged exactly the cap; the
reconciliation difference is zero. It is about the half of production nobody has
rehearsed — one process holding the record, a deployment nobody can reproduce,
and nothing watching.

Three defects were found by attacking rather than reading, and all three shared
a shape: **nothing failed.**

- **`POST /exposure` rendered unstyled.** It returns a full site page and
  declared no `htmlPolicy`, so it fell to `SELF_CONTAINED`, whose
  `default-src 'none'` blocks `/site.css`. The route answered 200 with correct
  arithmetic and every markup assertion passed, because they read the HTML
  rather than the rendering. The GET was fine, so the only person who saw it
  broken was a visitor who pressed the button. Now covered by an invariant that
  refuses any HTML route emitting a stylesheet or script under a policy that
  blocks it.
- **The orchestrator probes shared the request budget.** 400 calls to
  `/healthz` spent the anonymous bucket and 195 of the next 200 calls to
  `/readyz` came back 429 — and the container HEALTHCHECK polls `/readyz` and
  treats non-2xx as failure. A burst of ordinary traffic would have restarted
  healthy containers at the worst possible moment. Both probes are now exempt.
  The regression test took three attempts to kill its mutant: the obvious
  version passed with the fix reverted, and so did the version that flooded
  `/v1/auth/*`, because limiter buckets are per-group and that is a bucket the
  probes never touch.
- **Every production-safety warning was gated on being production.** With
  `NODE_ENV` unset the platform stops warning about the published development
  signing secret and about an in-memory ledger, at exactly the moment it also
  returns the live one-time sign-in code to any anonymous caller and hands out
  an access token with no credential. Both gates were correct; nothing said
  they were open. Verified against two servers: production answers 403
  DEMO_DISABLED with identical login shapes, non-production returned
  `"devCode":"A777DF"` and a working token with zero warnings.

**Recovery is now proven rather than asserted.** A server with a durable
journal, five identifiable records, SIGKILL, restore from a backup copy alone,
fresh process: 600 events replayed, all five records intact, fee+net unbroken,
reconciliation still zero, **RTO about 12 seconds**. It also surfaced a property
worth knowing: after an unclean kill the replacement refuses to start until the
dead writer's heartbeat ages out — up to 30 seconds — which is the right trade
and is a floor under the recovery time.

**One finding was deliberately not fixed.** Rate-limit buckets key on the socket
address, so behind a reverse proxy every anonymous request shares one bucket.
Closing it means resolving the client IP from `X-Forwarded-For` against a
trusted CIDR list; `TRUSTED_PROXY_CIDRS` exists in config but no matcher does,
and trusting a forwarded header without one lets any caller bypass the limiter
by forging a header. Writing a new IP-trust parser into the security path during
an audit is how an audit introduces the vulnerability it was meant to find. It
is recorded with two remedies instead.

---

### Two chart libraries became one

`frontend/lib/chart.js` (8 types, 8 screens) predated `frontend/lib/charts.js`
(24 exports). An earlier entry here recorded a decision to keep both, on the
grounds that rewriting working screens to change which module draws the same
picture is the refactor rule 3 exists to prevent. That decision was overturned
deliberately: one concept with two implementations is what rule 6 forbids, and
the cost was already visible — a page importing the wrong one silently dropped
props, which is how seven KPI cards lost their explanatory line.

The merge was done capability-first, so nothing was lost in it. Three things the
old library could do and the new one could not were **ported and tested before a
single call site moved**:

- **Pre-binned histogram buckets.** `histogram` now takes either `buckets`
  (already counted) or `values` (raw). The two carry *different* limit
  semantics and conflating them was caught in review: against pre-binned
  buckets `limit` is a ceiling on `bucket.count` and draws a horizontal line;
  against raw values it is a threshold on the measured quantity and draws a
  vertical one. Marking uses `to > limit`, not `from >= limit` — a limit falling
  inside a bucket marked nothing under the old test, so a reader saw a line with
  nothing past it and concluded, wrongly, that nothing was past it.
- **Gantt baselines and critical path.** `ganttChart` accepts `name`/`finish`
  as well as `label`/`end`, plus `baselineStart`/`baselineFinish`, `critical`,
  `longestPath` and `dataDate`. The drawing extent includes the baselines: a
  slipped task's baseline sits before the whole current programme, and leaving
  it out of the extent drew the one bar the reader opened the chart for off the
  left edge.
- **Per-row captions on horizontal bars**, and a label that fits. `fitLabel`
  truncates to the gutter with the full text in a `<title>`. Previously a long
  row label overflowed the viewBox and lost its *beginning* — the part that says
  which row it is.

`frontend/lib/chart.js` is deleted. Every one of its 17 call sites across
`admin`, `blog`, `commercial`, `economy`, `eventstore`, `performance`,
`programme` and `value` now imports `charts.js`, all eight were walked in a
browser under an identity that can actually see them, and `stackedBarChart` —
its one export nothing called — went with it. The capability register above is
what survived; the file was the duplicate.

93 tests in `backend/tests/charts.test.ts`, 15 of them written against the
ported behaviour specifically, so a regression in any of the three shows up as a
failure rather than as a picture nobody looks at.


---

## Why CONSTRUX exists, on the site

The launch audit and the landing-page critique both named the same gap and
neither could close it: **no named founder**. A buyer was being asked to trust
the record they defend themselves with to an anonymous supplier.

That is now answered in two places, at two depths.

**`/about` leads with it**, ahead of "what we build", because in this market the
question comes first. Justin Nseya, twenty years, MCIOB. The section is built
around the failure rather than the CV — design, programme, cost, procurement,
contracts, delivery, commissioning and handover each managed competently and each
in a different system, with nobody owning the join — and then the three symptoms
that produces: information late rather than missing, risks found after they had
become variations, and the most expensive people on the project reduced to a
human integration layer.

Two arguments are developed there that the source material implies and does not
state:

- **The gaps between stages are where projects fail**, because a project is a
  sequence of handovers and each one loses context that has to be rebuilt from
  memory. Every gap is survivable alone; together, over two years, they are where
  the margin goes — and they are invisible on any one team's dashboard, because
  no team owns a gap.
- **`PROPOSE` follows from the diagnosis rather than being a policy bolted on.**
  The failure was never that decisions were made badly. It was that the people
  making them did not have what they needed in front of them. So the system's
  job is to put it there, and the decision stays with whoever carries the duty.

**The landing page carries the short form**, placed between "It refuses" and the
exit guarantee — the reader has just been told what the platform declines to do,
and who decided that is the next question. It leads with the failure and keeps
the CV to one line, because an "about us" written in adjectives answers nothing.
