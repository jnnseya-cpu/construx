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
| Tests | 1,862 passing, 0 failing, 0 skipped, across 96 files |
| Typecheck | clean |
| Backend | 121 TypeScript files, 61,355 lines |
| Application | 39 ES modules, 14,226 lines (including a service worker) |
| API routes | 336 (34 of them public) |
| Event types | 222 Golden Thread (closed) · 178 communication events (closed) |
| Entity types | 130, all classified for access |
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
cannot disagree again: £300 buys 7,500 ACUs, £1,000 buys 25,000, £2,500 buys
62,500.

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

The console reads it through `frontend/lib/chart.js` — inline SVG, no library,
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

## What is partial

Implemented in a form that works, with a stated part missing. The missing part is
named so it is not mistaken for finished.

| Area | Built | Missing |
|---|---|---|
| Take-off | Governs, evidences and prices measured items, traced to sheet and revision. Quantities can be read off a held drawing by a multimodal provider and confirmed before they become BoQ items | No provider call has been made from this environment, so the extraction path is verified against a stub rather than against a live model |
| Drawing register | Title-block reading from the held drawing itself or from supplied text, supersession, markup→RFI carrying the activity it blocks | Same: the reading path is exercised against a stub, not a live provider |
| Model ingestion | Records the model, hash, discipline, LOD, element count as a governed event | IFC parsing, geometry hash, model diffing |
| Digital twin | Reconciles observed against expected element status | Observations are structured input, not derived from imagery |
| Evidence capture | Real SHA-256 over the real file, recorded against the event, and the file itself held in a tenant-scoped content-addressed store | Retention and deletion policy; no antivirus scan on upload |
| Clause extraction | From supplied text | OCR and table extraction |
| 4D scheduling | Twin states link to task ids | No visualisation |
| Newsletter delivery | SMTP submission verified against a socket, per-recipient outcomes recorded | No bounce processing or suppression list; DKIM belongs at the relay, where the key should live |

---

## What is not built

Specified in the source documents, deliberately absent, and **not to be claimed
as present**. Most of it is perception and ingestion infrastructure — real ML and
parsing work, not wiring.

- **File ingestion pipeline** — virus scan, ML file classifier with confidence,
  OCR, table extraction, vector embedding, `FILE_EXTRACTED`. Upload and storage
  themselves are built: `backend/src/evidence/store.ts` holds the bytes, and the
  content type is recorded as the label it is rather than validated, because the
  address is the hash and the store never trusts the declaration
- **Vision pipeline** — progress estimation, PPE compliance, equipment
  recognition, defect detection, `PROGRESS_EXTRACTED_FROM_IMAGES`
- **Audio and communication intelligence** — commitment and deadline extraction,
  `COMMITMENT_REGISTERED`, `DEADLINE_TRACKED`. Transcription of a site voice note
  into a confirmed observation is built, through the perception pipeline; what is
  absent is reading obligations out of correspondence
- **Deployment topology** — Terraform, Kong, MSK, RDS, S3
- **Native Android and iOS clients** — the installed PWA covers the field case
  today, including offline capture, and the `ANDROID`/`IOS` event sources exist
  server-side for when a native client arrives. Two things a PWA cannot do that
  a store app can, and neither is worked around here: background sync while the
  application is closed, and camera or location capture beyond what the browser
  grants
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
