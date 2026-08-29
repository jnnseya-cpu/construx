# CONSTRUX — GO-TO-MARKET

**Greater Manchester launch · 90-day programme · first 100 customers**

> Sell the thing the law *already forces them to buy*.

Most construction software is a productivity argument. CONSTRUX is a compliance one. The Building Safety Act made an immutable, attributable building record a statutory duty — and almost every vendor claiming to meet it is storing documents in a folder. That gap is the entire go-to-market.

| | |
|---|---|
| **Target** | 100 customers — ~£2.7m ARR |
| **Blended ACV** | £23,310 — + ACU attach |
| **Blended CAC** | £5,700 — 3.6-month payback |
| **90-day budget** | £162,750 — quoted 2026 rates |
| **Wedge** | HRB duty — ~12,500 buildings |
| **Launch city** | Manchester — locked until day 90 |
| **Status** | Blocked — see Gate 0 |

---

## 00 · Start here: you cannot sell this yet

*Everything below is worthless until one thing is fixed. Say it out loud before the plan, not inside it.*

> 🛑 **The ledger is in-process. There is no database.**
>
> Restart the server and every project, event and hash chain is gone. The Golden Thread — the entire product claim — currently survives exactly as long as the process does. Selling a statutory building record that evaporates on deploy is not a rough edge; it is a liability with a regulator attached.
>
> **No paid contract is signed until Gate 0 clears.** Design-partner work on non-production data can start immediately and should. That distinction is the difference between a fast start and a mis-sold product.

### Gate 0 exit criteria

| Requirement | Why it gates the sale | Owner | Days |
|---|---|---|---|
| **Postgres persistence** with append-only constraints and row-level security | The ledger must outlive the process. RLS enforces the tenant isolation the code already assumes. | Eng | 15 |
| **Object store with WORM** (S3 Object Lock, compliance mode) | Evidence files must be immutable in storage, not just referenced by an immutable hash. | Eng | 5 |
| **UK data residency** — eu-west-2 / UK South, no cross-border sub-processing | Named in buyers' procurement checklists for HRB information. Fails the first security review without it. | Eng | 7 |
| **Cyber Essentials Plus** | The floor for public-sector and housing-association procurement. Cheap and fast. | Ops | 21 |
| **DPA + sub-processor register + no-training clauses** on every AI provider | Customer project data must not train a foundation model. Buyers now ask this in writing. | Legal | 10 |
| **Independent penetration test** (CREST-accredited) | Annual pen testing is an explicit expectation for safety-critical residential information. | Ops | 14 |
| **Backup, restore and replay drill** — proven, timed, documented | "Can you restore our golden thread?" is a question you answer with a stopwatch, not a policy. | Eng | 5 |
| Critical path, run in parallel | ~30 days |

ISO 27001 takes longer than 90 days and should start now in the background — but it is a Gate 2 unlock, not a Gate 0 blocker. Cyber Essentials Plus plus a clean pen-test report will get you through most Tier 2 and housing-association reviews in the meantime.

---

## 01 · The wedge: compelled, deadlined, and badly served

*Pick the buyer who has no choice, a date, and no good option. In England, that buyer exists by statute.*

The Building Safety Act 2022 made the golden thread a legal duty for higher-risk buildings — broadly, residential buildings at least 18 metres or seven storeys with two or more units, plus care homes and hospitals in scope at design and construction. There are roughly **12,500 HRBs in England**. Duty-holders must produce the golden thread at each Gateway, and it must be digital, structured, attributable and immutable.

> ▶ **The sentence that sells the product**
>
> Industry guidance on what the Act requires *of the software itself* is explicit: the record must show who did what, when and why — every entry attributable to a named user, timestamped, and immutable so historical states are preserved. Procurement should demand ISO 27001 alignment, Cyber Essentials, documented encryption, UK data residency, tenant isolation and annual independent penetration testing. **That is a specification of CONSTRUX's architecture, published by someone else.**

### Why the incumbents cannot simply answer it

A document management system with version history is not an immutable attributable record — it is a mutable record with a change log, and the distinction is exactly what a coroner or a regulator will probe. Retrofitting a hash-chained append-only ledger under a CDE built on mutable documents is not a feature; it is a rewrite. CONSTRUX started there.

| Claim | Typical vendor | CONSTRUX | Proof you can show in a demo |
|---|---|---|---|
| Attributable | User stamped on a document version | **Every state change is an event with a named actor** | Audit feed, per-event actor and correlation id |
| Immutable | Version history you can delete | **Hash-chained append-only ledger** | Replay reconstructs the project and reports a root hash |
| Tamper-evident | Not claimed | **Replay detects alteration** | The demo tampers with a record on purpose and the replay catches it |
| Tenant isolated | Configured per-project permissions | **Enforced server-side on every read** | Sign in as the regulator; write controls disappear |
| Separation of duties | Advisory workflow | **Refused, not warned** | Applicant cannot certify their own application |
| AI governance | "AI-powered" | **No agent can approve anything** | Autopilot raises; a nominated human decides; the catalogue refuses AI-authored approvals |

### The second wedge: getting paid

Late and disputed payment is endemic in UK construction, and the statutory payment regime is date-driven and unforgiving. CONSTRUX computes the statutory dates, refuses over-certification, double certification and overpayment, and makes every withheld sum carry a reason. This is the wedge for the commercial director who does not care about the Act. **Compliance opens the door; cashflow closes the deal.**

---

## 02 · Launch city: Greater Manchester

*Locked. One city until day 90. No London prospecting, no opportunistic out-of-region deals, no national campaigns.*

**Launching "in the UK" is not a plan; it is the absence of one.** The constraint is the point: a city is small enough to saturate, and saturation is what produces referrals. Greater Manchester is chosen on evidence, not affection.

| Factor | Greater Manchester | London |
|---|---|---|
| **Concentration** | One of four national concentrations of monitored remediation, with Greater London, West Yorkshire and the south coast | Largest absolute stock, spread across 32 boroughs |
| **Convening body** | **Greater Manchester High Rise Task Force** — one body convening the whole buyer set | No single equivalent; fragmented across boroughs and bodies |
| **Buyer mix** | Tier 2/3 principal contractors dominate — exactly the ICP | Tier 1 dominated: 12–18 month procurement, architecture review |
| **AE base salary** | £42,000–£60,000 | £55,000–£80,000 |
| **SDR base salary** | £28,000–£38,000 | £35,000–£45,000 |
| **Density** | Deansgate, Castlefield, Ancoats, Salford Quays, MediaCity — four site visits in a day, on foot and tram | Four site visits is four days |
| **Community effect** | Small, networked NW construction community; reputation compounds inside 90 days | Too large for word-of-mouth to compound at this scale |
| **Fallback** | 2h07 to London Euston when a deal requires it | — |

> ▶ **The 28% argument**
>
> Manchester salaries for the two most expensive GTM hires run roughly 25–30% below London. On an AE and an SDR that is about **£23,000 a year of runway** bought for nothing but a postcode decision — and the buyers are easier to reach.

### The five target clusters, in order

Each is a walkable or single-tram cluster of in-scope buildings and the contractors working on them.

1. **Deansgate Square, Castlefield and the Great Jackson Street corridor** — the densest concentration of new-build high-rise residential in the city.
2. **Salford Quays and MediaCity** — mixed new-build and occupied stock, with registered providers as Accountable Persons.
3. **Ancoats and New Islington** — active mid- and high-rise residential delivery.
4. **Manchester city centre core** — occupation-phase duties on completed towers.
5. **Trafford and Stretford** — regeneration schemes entering scope.

### The institutions to be known by

- **Greater Manchester High Rise Task Force** — the single most valuable relationship in this plan. Convened by the Combined Authority; it puts the whole buyer set in one room. Target a briefing slot by day 60.
- **Greater Manchester Fire and Rescue Service** — protection teams see the evidence-quality problem first-hand and are credible referrers.
- **Manchester City Council and Salford City Council building control** — route to Gateway applicants.
- **Registered providers operating in Greater Manchester** — Accountable Persons with occupation-phase duties and, unlike contractors, a permanent obligation.
- **Place North West** — the regional title your buyers actually read. Target three placements in 90 days.

### Tactics that only work at city scale

- **Two hosted roundtable dinners, twelve seats each.** Invite by building, not by job title: "you are responsible for [building]; six other people in this city are in the same position." £2,500 each.
- **The Greater Manchester Golden Thread Index.** A regional benchmark on evidence completeness, published quarterly. First-mover regional data becomes press coverage and gives the Task Force a reason to cite you.
- **Walk-in site visits.** In a walkable cluster, "I am ten minutes away, can I show you ninety seconds of something" converts at a rate no email sequence matches.
- **One regional sponsorship, not a national trade show.** A £3,500 regional slot reaches the same buyers a £14,000 London stand would, minus the noise.

> 🛑 **Exit condition for the city constraint**
>
> Open a second city only when Greater Manchester has produced **25 paying customers and at least two channel partners generating referrals unprompted**. Expanding earlier converts a focused motion into a thin national one — the most common way a good wedge is wasted.
>
> Second city: **Leeds and West Yorkshire**, on the same evidence — a named national concentration, adjacent geography, shared consultancy channel.

---

## 03 · Who buys, and what makes them move

*Six segments, ranked by how quickly they sign. Ignore the bottom two until Gate 3.*

| Segment | Economic buyer | Trigger event | Entry | ACV | Priority |
|---|---|---|---|---|---|
| **Tier 2/3 principal contractors** £10m–£150m turnover, HRB residential | Commercial Director or MD | Gateway 2 application; a Tier 1 client demanding evidence | Professional Delivery | £26.4k | 1 |
| **Housing associations & registered providers** Accountable Person duty | Director of Building Safety / Assets | Occupation-phase duties; a BSR information request | Enterprise | £78k | 1 |
| **Remediation specialists** Cladding & fire safety works | Contracts Director | BSF or CSS award with reporting obligations | Professional Delivery | £26.4k | 1 |
| **QS, PM and BIM consultancies** Sold as a channel, not an end user | Partner / Head of Digital | Client asks them to hold the golden thread | Core Project ×N | £11.4k | 2 |
| **Regional developers** 7+ storey residential | Development Director | Planning consent on an in-scope scheme | Core Project | £11.4k | 3 |
| **Asset & facilities managers** Taking handover of HRBs | Head of FM | Practical completion of an in-scope building | Enterprise | £78k | 3 |

### The ideal first customer, precisely

> A principal contractor turning over **£25m–£80m**, running **two to five live packages**, with **at least one HRB going through Gateway 2 in the next six months**, currently managing the golden thread in **SharePoint plus a spreadsheet**, that has **already lost an argument about a payment notice** in the last year. They have the pain twice over, the deadline is external, and nobody in the building loves the incumbent tool.

**Who to walk away from in the first 100**

- **Tier 1 contractors.** 12–18 month procurement, enterprise architecture review, and they will ask for ISO 27001 you do not have. Court them; do not count on them.
- **Anything outside England.** The compliance wedge is jurisdictional. Scotland, Wales and Ireland have different regimes; sell there deliberately later, not opportunistically now.
- **Sub-£5m contractors.** They will buy Core Project, churn in seven months, and consume the same support as an Enterprise logo.

---

## 04 · Positioning and the words that do the work

*One line, three proofs, and an answer to every objection you will actually hear.*

> ▶ **The one-liner**

### Three proofs, in demo order

1. **Tamper, then catch it.** Alter a record in front of them. Run the replay. The root hash moves and the platform names the event. Nobody else can do this on stage.
2. **Sign in as the regulator.** Every write control disappears; the export still works. Read-only oversight is architectural, not a checkbox.
3. **Try to certify your own application.** The platform refuses. Separation of duties is enforced, not advised.

Then, and only then, show Autopilot: eight agents that read the project and propose, with a nominated human deciding. Lead with AI and you are one of forty vendors. Lead with the ledger and the AI becomes credible *because* it cannot act alone.

### Objection handling

| They say | You say |
|---|---|
| "We already have Procore / Asite / Viewpoint." | "Keep it. We are not your CDE. We are the governed record underneath it — and we can start on one HRB without touching the rest of your estate." |
| "Our SharePoint *is* the golden thread." | "Can you prove no one edited a document last March? The Act asks for an immutable record with preserved historical states. Version history is a change log on a mutable file." |
| "You're a startup. What if you disappear?" | "Your record is exportable as a signed, hash-verified event log at any time, and escrow is in the contract. You are not renting your compliance evidence from us." |
| "Do you have ISO 27001?" | "Cyber Essentials Plus today, independent pen test report available, ISO 27001 in progress with certification targeted for *[quarter]*. Here is the Statement of Applicability draft." Do not bluff this |
| "AI in a safety-critical record? Absolutely not." | "Agreed. No agent can approve anything here — the event catalogue refuses an AI-authored approval outright. Agents propose; a nominated human decides. Show them." |
| "Too expensive for one project." | "Core Project is £950 a month. One disputed payment notice costs more than a year of it." |
| "Our site teams won't use it." | "It installs to the home screen, works with no signal, and the site diary is four fields. Supervisor seats are £70." |

---

## 05 · Pricing, packaging and the unit economics

*These are the numbers already implemented in the platform, not proposed ones.*

The tenant pays the package, not the sum of seats — the seat prices exist so an enterprise admin can see what the package is worth. **Free regulator access is a sales weapon, not a giveaway:** it means the buyer can hand their regulator a login without a purchase order, which removes the last procurement objection from the person with the deadline.

**AI is metered, never bundled**

Prepaid ACU bundles at a 5× markup on provider cost: **Starter £300** (6,000 ACUs), **Growth £1,000** (20,000), **Scale £2,500** (50,000). Hard caps, per-engine attribution, and no provider call on an empty wallet. Sell this as budget control, because that is what a commercial director hears: *"your AI spend cannot surprise you."*

### Unit economics at 100 customers

| Package | Logos | ACV | Subscription ARR | CAC target | Payback |
|---|---|---|---|---|---|
| **Core Project** | 55 | £11,400 | £627,000 | £3,200 | 4.1 mo |
| **Professional Delivery** | 35 | £26,400 | £924,000 | £7,500 | 4.2 mo |
| **Enterprise** | 10 | £78,000 | £780,000 | £18,000 | 3.4 mo |
| Subscription | 100 | £23,310 | £2,331,000 | £5,700 | 3.6 mo |
| + ACU attach (55% at ~£8k) | 55 | — | £440,000 | £0 | — |
| **Total** | **100** | **£27,710** | **£2,771,000** | **£5,700** | **3.6 mo** |

Assumes 82% gross margin after AI cost-of-goods, 85% gross logo retention and 112% net revenue retention from project-to-portfolio expansion. Payback is on gross profit, not revenue. Every one of these is an assumption to be replaced with measurement by day 90 — they are stated so they can be falsified, not defended.

---

## 06 · The first 100 customers, by name and by number

*Five motions. Each one has a list you can actually build this week.*

| Motion | Where the list comes from | Logos | CAC | Cycle | Spend |
|---|---|---|---|---|---|
| **1 · Founding partners** | Hand-sourced from the founding team's own Greater Manchester network | 10 | £1,000 | 3 wk | £10k |
| **2 · Gateway-compelled outbound** | BSR approval data, HRB register, Gateway 2 applicants — filtered to Greater Manchester | 25 | £9,000 | 10 wk | £225k |
| **3 · Consultancy channel** | NW-based QS, PM and BIM practices reselling into their client base | 30 | £4,500 | 12 wk | £135k |
| **4 · Remediation programme** | Funded remediation buildings in Greater Manchester and their contractors | 20 | £8,500 | 14 wk | £170k |
| **5 · Land and expand** | Existing logos: one project → portfolio → O&M | 15 | £2,000 | 6 wk | £30k |
| **Total** |   | **100** | **£5,700** | — | **£570k** |

### Motion 1 — Ten founding partners, in three weeks

Free for twelve months. In exchange, contractually: a named reference, a logo, a recorded 20-minute case interview, and a quarterly product session. Not a pilot — a partnership with obligations on both sides. **Write the exchange into the agreement** or you will end up with ten free users and no evidence.

- Target mix: 5 principal contractors, 2 housing associations, 2 consultancies, 1 remediation specialist.
- Recruit by direct approach only. No form, no waiting list, no "request a demo".
- Qualify hard: *no live HRB, no partnership.* A design partner without the deadline gives you feedback about a product nobody is forced to buy.

### Motion 2 — Outbound to people with a statutory date

Build the list from public and paid sources, in this order:

| Source | What it gives you | Cost |
|---|---|---|
| BSR building-control approval application data (GOV.UK) | Who is applying at Gateway 2, and when | Free |
| HRB register (HSE / BSR) | Registered higher-risk buildings and responsible entities | Free |
| Companies House API | Turnover band, filing health, directors, group structure | Free |
| Barbour ABI / Glenigan | Contract awards, project pipeline, contractor by scheme | £8k–£15k/yr |
| Construction Enquirer & Construction News award feeds | Daily trigger events, free, and read by the buyer too | Free |
| Planning portals — 7+ storey residential consents | Schemes entering scope 12–24 months ahead | Free |

**The sequence that gets replies**

Trigger-based, never volume-based. The opening line names *their* building. Six touches over 18 days, then stop and recycle in 90.

1. **Day 1 — email.** Subject: the building's address. "You registered [building] with the BSR in [month]. One question: if the regulator asked you to prove no one edited the fire strategy since Gateway 2, how long would that take?"
2. **Day 3 — LinkedIn connect,** no pitch, referencing the same scheme.
3. **Day 6 — email.** The 90-second tamper-detection video. Nothing else in the message.
4. **Day 10 — phone.** The only goal is to learn who owns the golden thread internally.
5. **Day 14 — email to that person,** referencing the first conversation.
6. **Day 18 — break-up email** with the regulator-access point: "your BSR login costs you nothing on our platform."

### Motion 3 — The consultancy channel is the cheapest logo you will buy

A QS or BIM practice with 30 clients is 30 warm introductions from one relationship. Structure it properly:

- **20% of first-year subscription** on referred logos, paid quarterly, 24-month tail.
- **Free Professional Delivery tenancy** for the practice's own use — they must live in it to sell it.
- **Co-branded golden-thread readiness assessment** they deliver as a paid service. You supply the template; they keep the fee. This is the hook — it makes you part of their revenue, not their software stack.
- **Named partner manager from day 45.** Channel without a human owner decays to a logo on a slide.

### Motion 5 — Expansion is a product motion, not a sales one

The land-and-expand path is built into the platform: a customer starts on one project (Core Project), adds packages and API access (Professional Delivery), then rolls up to portfolio and isolated tenancy (Enterprise), and finally carries the same record into 30-year O&M. Instrument the moment they hit the seat cap or the second project and trigger the conversation automatically. Expansion revenue at £2,000 CAC is the best money in this plan.

---

## 07 · The acquisition engine

*Ranked by cost per qualified opportunity. Fund the top three; test the rest with a fixed budget and a kill date.*

| Channel | Why it works here | Cost/SQL | Verdict |
|---|---|---|---|
| **Trigger-based outbound** | The buyer has a statutory date. You know the date. | £450 | Fund |
| **Consultancy channel** | Borrowed trust, warm intros, no cold start | £280 | Fund |
| **Founder-led content on LinkedIn** | UK construction leadership genuinely lives there | £310 | Fund |
| **Trade press & earned media** | Construction News, Building, Construction Enquirer, Inside Housing carry real authority | £520 | Fund |
| Search — "golden thread software", "Building Safety Act software" | Small volume, extremely high intent | £600 | Test £3k |
| Events — Digital Construction Week, UK Construction Week, Futurebuild | Dense buyer concentration; expensive and slow to convert | £1,400 | One stand |
| Professional bodies — CIOB, RICS, ICE, Build UK | CPD webinars put you in front of duty-holders as an educator | £380 | Fund |
| Paid LinkedIn ABM | Precise targeting, expensive, works only with the content engine behind it | £950 | Test £5k/mo |
| Generic construction SaaS review sites | Traffic is procurement-led and price-shopping | £2,100 | Skip |

### The content that actually converts here

Not thought leadership. **Operational artefacts a duty-holder can use on Monday.** Each one is gated only by an email address and is designed to be forwarded internally to the person who owns the problem.

- **The Golden Thread Readiness Assessment** — 40 questions, scored, produces a PDF a Building Safety Director can take to their board. The single highest-value asset in the plan.
- **"What the Act requires of your software"** — a procurement checklist covering immutability, attribution, residency, isolation and pen testing. You will win on this document because you wrote it against the architecture you already have.
- **The tamper demo, 90 seconds, no narration.** Alter a record; run the replay; the hash moves. Put it on the site unlisted, send it as touch three.
- **Statutory payment date calculator** — free, no login, genuinely useful, embeds your name in a QS's browser bookmarks.
- **A quarterly Golden Thread Index** — anonymised benchmark from your own customers on evidence completeness. This becomes press coverage in year two.

### Activation is where deals are actually won or lost

> Instrument these five, and treat any miss as a churn signal, not a support ticket:

> - **Day 0:** tenant live, three seats assigned.
> - **Day 2:** first governed event committed against a real project.
> - **Day 7:** first evidence file hashed and attached.
> - **Day 14:** first Golden Thread export produced.
> - **Day 21:** first agent proposal approved by a named human.
That last one matters more than it looks. A customer who has approved an Autopilot proposal has accepted the platform's authority model. They do not churn.

---

## 08 · Marketing, and the agency brief

*What you run in-house, what you buy, and how to hold the agency to a number.*

> 🛑 **On `marketwaros.com` — verify before you sign**
>
> I could not reach this site: it is blocked by this environment's network egress, and it returns no results in search. **I will not write claims about what they do or recommend them on capabilities I have not seen.** Everything below is the brief you should put to them — or to any agency — and the terms that make the engagement accountable. Step one is a 45-minute call and two referenceable B2B construction or regulated-industry case studies. If those do not exist, run the shortlist in the table below instead.

### The brief — hand this over verbatim

> - **Positioning is not in scope.** It is set in section 03 of this document and is not open. The agency executes it; they do not rediscover it.
> - **Category:** UK construction compliance software. Buyer: Commercial Director, Building Safety Director, Head of Digital. Not "construction tech buyers".
> - **Deliverables, first 90 days:** brand system extension from the existing CONSTRUX identity; the Readiness Assessment as an interactive tool; four operational artefacts; the 90-second tamper film; LinkedIn ABM setup and management; PR placement in at least two named trade titles.
> - **Explicitly excluded:** logo redesign, brand repositioning, "awareness" campaigns, impression-based reporting.
> - Primary metric: **cost per sales-qualified lead**, target under £600 by day 90.
> - Secondary: assessment completions, trade-press placements, ABM engaged-account rate.
> - **No impressions, no reach, no "engagement" in the reporting pack.** Say this in the first meeting.
> - Monthly retainer with a 30-day termination right for the first two quarters. Retain ownership of all accounts, pixels, lists and creative files — in the contract, not in good faith.

**If the reference check fails — shortlist criteria for a replacement**

| Test | Pass looks like |
|---|---|
| Sector fluency | They can explain what Gateway 2 is without you prompting |
| Named references | Two B2B construction or regulated-industry clients you can phone |
| Reporting | They volunteer pipeline metrics before you ask for them |
| Team | The people in the pitch are the people on the account, named in the SOW |
| Commercials | Rolling monthly after an initial 90 days; no 12-month lock |
| Ownership | You own the ad accounts, the CRM data and the creative source files |

### In-house, never outsourced

- **Founder LinkedIn.** Ghost-written founder content is obvious to this audience and costs you credibility with exactly the people you need.
- **The tamper demo.** An agency cannot narrate a hash chain convincingly. Record it yourself.
- **The procurement checklist.** It is a technical document that must be exactly true.
- **Customer conversations.** Every one, for the first 100. No exceptions and no delegation.

---

## 09 · Suppliers: what to buy, and how to source it

*In a compliance product, your suppliers are inside your compliance claim. Source them like it.*

| Category | Candidates | Non-negotiable term | Cost/mo | Gate |
|---|---|---|---|---|
| **Cloud + residency** | AWS eu-west-2 (London), Azure UK South, GCP europe-west2 | UK region only; no cross-border replication of tenant data | £1,500 | 0 |
| **Database** | Aurora PostgreSQL, Neon, Supabase | PITR, RLS support, documented restore time | £400 | 0 |
| **Evidence store** | S3 with Object Lock (compliance mode) | WORM immutability; retention lock the vendor cannot lift | £250 | 0 |
| **AI providers** | OpenAI, Google Gemini, Anthropic, Mistral (EU) | **No training on customer data**, in writing; UK/EU processing; two providers minimum | £3,000 | 0 |
| **Email relay** | Postmark, AWS SES, Mailgun | Dedicated IP, DKIM/SPF/DMARC, EU region | £120 | 1 |
| **SMS / MFA** | Twilio, Vonage, Bird | UK sender ID, delivery receipts | £150 | 1 |
| **Security certification** | BSI, NQA, Alcumus (ISO 27001); IASME (Cyber Essentials) | Fixed-fee scope; surveillance audit costs disclosed up front | £1,800 | 0 |
| **Penetration testing** | Any CREST-accredited firm | Annual retest included; report shareable with customers under NDA | £900 | 0 |
| **Project data** | Barbour ABI, Glenigan | CRM export rights; seat count that covers the whole sales team | £1,000 | 1 |
| **Cost indices** | BCIS (RICS) | Redistribution rights inside the product — check carefully, this is often excluded | £450 | 2 |
| **Credit & entity data** | Companies House API (free), Creditsafe, Experian | Per-lookup pricing, not per-seat | £350 | 2 |
| **Legal** | Construction-specialist UK firm | Duty-holder liability review of your terms — generic SaaS terms are wrong here | £2,000 | 0 |

### How to source, in six steps

1. **Write the requirement before you look.** One page: what it must do, the compliance clause it sits inside, and the failure you are insuring against. Vendors will otherwise sell you their roadmap.
2. **Three-way RFI, never fewer.** A second quote is a negotiating position; a third is a sanity check on the category.
3. **Security and DPA review before commercials.** Ask for the sub-processor list, data residency map, breach-notification window and deletion SLA. If they cannot produce these quickly, they are not enterprise-ready and neither are you if you buy them.
4. **Commercials with an exit.** Monthly or annual, never multi-year, until you have run a full year. Committed-spend discounts on AI are worth taking only once your usage curve is measured.
5. **Pilot against a real workload.** Two weeks, with a defined pass mark written down beforehand.
6. **Document the exit before you sign the entry.** How do you get your data out, in what format, how fast, and at what cost? For the evidence store, this is a customer-facing answer.

> ▶ **Two supplier decisions that are actually product decisions**
>
> **Never single-source AI.** The orchestrator already routes to a healthy provider and falls back. Keep two contracted at all times — a provider outage must degrade a feature, not the platform, and a provider price rise must not be a repricing event for you.
>
> **WORM storage is not optional.** A hash chain proves a file was not altered. Object Lock proves it was not deleted. A golden thread needs both, and a buyer's security reviewer will know the difference.

### Implementation and channel partners

Distinct from suppliers, and sourced differently: recruit from the consultancies already in Motion 3. Certify them — a two-day accreditation, a public partner register, and a rule that only accredited partners may configure a tenant. This protects delivery quality and makes the partnership feel like status rather than a discount.

---

## 10 · The 90-day programme

*Four gates. Each has an owner, an exit criterion and a number. You do not pass a gate because time elapsed.*

### GATE 0 — Make it sellable

`Days −14 → 30 · Owner: Engineering`

**Do**

- Postgres persistence with append-only constraints and row-level security; migrate the in-process ledger.
- S3 Object Lock evidence store. Backup, restore and replay drill — timed and written down.
- Deploy to a UK region. Infrastructure as code, so the topology is reproducible rather than remembered.
- Cyber Essentials Plus submitted. Pen test booked. ISO 27001 gap analysis started.
- DPAs and no-training clauses signed with two AI providers.
- Terms of service reviewed by a construction-specialist firm for duty-holder liability.
- Recruit and sign ten Greater Manchester founding partners. Non-production data only until this gate clears.

**Exit criteria — all must be true**

### GATE 1 — Prove it on real buildings

`Days 31 → 60 · Owner: Founder / Sales`

**Do**

- Move all ten founding partners onto production data and real Greater Manchester HRBs.
- Ship the Golden Thread Readiness Assessment as an interactive tool. This is the quarter's most important marketing asset.
- Publish the procurement checklist and the 90-second tamper film.
- Build the outbound list — BSR approval data, HRB register, Companies House, Barbour ABI. Filtered to Greater Manchester. Target 300 qualified in-region accounts.
- Hire one AE and one SDR, both Manchester-based. Founder still runs every first call.
- Recruit five North West consultancy channel partners; give each a free tenancy and the co-branded assessment.
- Instrument the five activation milestones and review them weekly.
- Agency engaged against the brief in section 07, after the reference check.

**Exit criteria**

### GATE 2 — Make it repeatable

`Days 61 → 90 · Owner: Sales / Marketing`

**Do**

- Outbound sequences live across all 300 in-region accounts; SDR at 40 qualified conversations a month.
- First channel-referred logos closing. Appoint a named partner manager.
- Open the remediation motion: Funded remediation buildings in Greater Manchester and their contractors.
- Second roundtable dinner. One regional event sponsorship with the tamper demo running live.
- Two CPD webinars with professional bodies. You are the educator, not the vendor.
- Land-and-expand triggers instrumented: seat cap reached, second project created.
- ISO 27001 Stage 1 audit booked.
- Pricing reviewed against real win/loss data — not against the original assumptions.

**Exit criteria**

### GATE 3 — Scale to 100

`Days 91 → 270 · Owner: Sales leadership`

Beyond the 90 days, stated so the plan has somewhere to go rather than stopping at a cliff.

---

## 11 · Team and 90-day budget

*Built from quoted 2026 UK market rates. Deliberately thin on sales headcount until the motion is proven — founder-led selling is not a cost saving, it is the research.*

Every figure is sourced from published 2026 UK pricing or salary benchmarks rather than estimated. Where a range exists the mid-point is taken and the range is shown. Salaries are Greater Manchester rates, which is a material part of why the city was chosen.

| Line | Basis | 90-day cost |
|---|---|---|
| **Engineering — Gate 0** | 2 contract engineers × 6 weeks (30 working days) at £550/day | £33,000 |
| AE — 2 months | Manchester mid-market base £50,000 (range £42k–£60k), plus 15% employer NI and pension | £9,600 |
| SDR — 2 months | Manchester base £32,000 (range £28k–£38k), plus 15% employer NI and pension | £6,150 |
| Sales commission | Ramp period only; minimal attainment expected in the window | £2,000 |
| Recruitment fee | One agency placement (AE) at 18% of base; SDR hired direct | £9,000 |
| Cyber Essentials Plus | From £1,399+VAT for a micro organisation; UK government data puts average total cost including consultancy and technical remediation at ~£4,941 | £4,950 |
| Penetration test | External infrastructure and web application test, small business: quoted range £4,000–£8,000 | £6,500 |
| ISO 27001 — gap analysis | Year-one total for a small organisation is £6,000–£15,000 at ~£1,500 per auditor day; only gap analysis and Stage 1 prep fall inside 90 days | £3,500 |
| Legal | Construction-specialist review of terms and duty-holder liability, plus DPAs, channel agreement, partner accreditation | £12,000 |
| Cloud and AI | AWS eu-west-2 production and staging with multi-AZ, backups and logging (~£600/mo); two AI providers (~£800/mo); monitoring (~£200/mo) | £5,400 |
| Data and sales tooling | Barbour ABI or Glenigan pro-rata (£8k–£15k/yr), CRM, sales engagement, Sales Navigator | £5,700 |
| Content production | Readiness Assessment interactive build (£6,000), tamper film (£4,500), four operational artefacts (£4,000) | £14,500 |
| Agency retainer | 2 months at £6,000/mo against the section 08 brief | £12,000 |
| Paid media | LinkedIn ABM test £3,000/mo × 2; search £750/mo × 2 | £7,500 |
| Events and roundtables | Two hosted dinners in Manchester at £2,500 each; one regional sponsorship at £3,500 | £8,500 |
| Manchester base and travel | 4 co-working desks at ~£250/desk/mo × 3 months; travel to site and London | £5,000 |
| Contingency | 12% — the pen test will find something | £17,450 |
| **Total, 90 days** | Producing 20 paying customers and £400,000+ ARR at Gate 2 | **£162,750** |

> ▶ **What the real numbers changed**
>
> An earlier draft carried **£242,300**, built on estimated engineering day rates and inflated cloud costs. Sourcing actual 2026 UK market rates took roughly a third out of it — the largest corrections were engineering (£72,000 estimated against **£33,000** at real contract rates) and infrastructure (£16,000 against **£5,400**).
>
> This matters beyond accuracy. £162,750 is a smaller, more defensible ask, and every line traces to a quote.

### Ongoing run rate from day 91

| Line | Monthly |
|---|---|
| AE and SDR, fully loaded, plus commission at target | £9,900 |
| Agency retainer | £6,000 |
| Paid media | £3,750 |
| Data and sales tooling | £1,900 |
| Cloud, AI and monitoring (scaling with customers) | £1,800 |
| ISO 27001 continuation and surveillance provision | £1,000 |
| **Monthly run rate at Gate 3 entry** | **£24,350** |

**Hire in this order, and not before**

1. **SDR before AE.** The founder can close; nobody else will build the list.
2. **Customer Success at customer 25,** not before. Until then the founder does onboarding and learns more from it than any report.
3. **Partner Manager at five active partners.** Channel without an owner decays quietly.
4. **Head of Security & Compliance at customer 50.** By then, security questionnaires are a full-time job and a bottleneck on every deal.

---

## 12 · What kills this, and when to stop

*Written down in advance, because the point of a kill criterion is that it is inconvenient when it triggers.*

| Risk | Early signal | Response |
|---|---|---|
| **Gate 0 overruns** | Persistence not done by day 30 | Stop all paid acquisition. Every pound spent selling an unsellable product is wasted twice. |
| **Incumbent adds a credible ledger** | A major CDE announces immutability at a trade show | Move fast to depth — payment cycle, delay attribution, Autopilot. The ledger is the wedge, not the moat. |
| **Sales cycles longer than modelled** | Median above 120 days at Gate 2 | Shift weight to the consultancy channel and Core Project entry pricing; extend the runway assumption. |
| **Security review failures** | Two deals lost on ISO 27001 | Accelerate certification and pre-empt with the pen test report and SOA in the first meeting. |
| **AI cost exceeds the 5× markup** | Gross margin below 80% | The ACU model already caps exposure per tenant. Reprice bundles, do not absorb it. |
| **Regulatory timetable slips** | Enforcement deferred | Pivot the lead message to the payment wedge, which has no regulatory dependency. Keep the compliance proof as the differentiator. |
| **Manchester is too small** | Fewer than 40 qualified in-region accounts after list build | Extend to the North West — Liverpool, Leeds — before extending nationally. Keep the density principle. |
| **Design partners never convert** | Fewer than 5 paying at day 60 | The problem is value, not price. Stop selling and go and watch three of them work for a day each. |

### Kill criteria

> 🛑 **Note**
>
> - **Under 5 paying customers at day 90** — the wedge is wrong, not the execution. Re-segment before spending more.
> - **Blended CAC above £25,000 at day 120** — the economics do not work at this ACV. Move upmarket to Enterprise-only or rebuild the channel motion.
> - **Activation below 40%** — customers are buying and not using. Fix onboarding before acquiring another logo; you are filling a leaking bucket.
> - **Any customer data loss event** — stop selling, fix, and tell every customer before they find out. In a compliance product this is existential and there is no version of concealing it that survives.

### The single number to run the company on

Not ARR. **Governed events committed per customer per week.** It is the only metric that captures whether the golden thread is actually being built rather than bought. It predicts renewal, it predicts expansion, and it is the number a customer's regulator would care about too. Put it on the wall.

---

## Sources and honesty notes

**Sources and honesty notes.** Pricing, packaging, seat rates and ACU bundles are read directly from the CONSTRUX implementation, not proposed. HRB scale (~12,500 buildings in England), the 1 October 2023 registration deadline, and remediation figures (640 Building Safety Fund buildings proceeding, 307 transferred to the Cladding Safety Scheme, 500 of 516 ACM buildings started or completed, as at 25 June 2026) are from GOV.UK and UK trade and legal sources. The software procurement requirements quoted in section 01 are from published industry guidance on what the Act requires of software. Manchester and London salary benchmarks, Cyber Essentials Plus pricing (from £1,399+VAT, ~£4,941 average total), ISO 27001 year-one cost (£6,000–£15,000 at ~£1,500 per auditor day) and penetration test pricing (£4,000–£8,000) are from published 2026 UK guides.

Conversion rates, CAC, cycle lengths, retention and cost-per-SQL figures are **modelled assumptions**, stated explicitly so they can be replaced by measurement — they are not benchmarks and should not be presented to an investor as such. `marketwaros.com` could not be reached or verified from this environment; section 07 gives the brief and the terms rather than a recommendation.
