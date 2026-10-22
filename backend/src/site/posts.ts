/**
 * The blog posts themselves, as data.
 *
 * A module of its own, and not because pages.ts was long. `pages.ts` reads the
 * route table to build the developers page, and the route table has to read
 * this list to register a route per post — so leaving the posts in pages.ts
 * makes routes.ts depend on a module that depends on routes.ts. That cycle is
 * not theoretical: it throws `Cannot access POST_PAGES before initialization`
 * at import, before a single test runs.
 *
 * This file imports nothing, which is what makes it safe for both sides to
 * read. It is the same reason SITE_PAGES lives in layout.ts rather than here.
 */

type Post = {
  /**
   * The URL. Explicit rather than derived from the title, because a slug is a
   * promise: it is what gets linked, shared and indexed, and retitling a post
   * must not break every link to it.
   */
  slug: string;
  title: string;
  standfirst: string;
  /**
   * The `<meta name="description">`, where the standfirst is too long to be one.
   *
   * Optional and not retrofitted. A standfirst is a deck written to be read on
   * the page and runs past the hundred and sixty characters a result shows
   * whole, so the earlier notes — written before this field — are cut mid
   * sentence in a search result. That is a real cost and not one worth
   * rewriting their decks to fix. It is worth not repeating on a post written
   * to sell something, which is why the Bid-On set carries one and the rest
   * fall back to the standfirst, exactly as before.
   */
  metaDescription?: string;
  date: string;
  tag: string;
  /** Paragraphs. Trusted markup produced here, never user input. */
  body: string[];
};

/**
 * Posts are the engineering notes this project actually produced, not invented
 * thought leadership. Each one corresponds to work recorded in docs/STATE.md.
 *
 * Two kinds, and the rule is the same for both. The earlier ones are defect
 * notes: something broke, here is what it cost. The Bid-On set sells a feature
 * on the thing that distinguishes it — which here means the refusal underneath
 * it, because every one of those posts argues that the valuable half of a
 * capability is what it will not do. That makes them marketing copy, so they
 * are held to the stricter rule rather than the looser one: a post may only
 * claim behaviour that is built and covered by a test. No roadmap, no "will
 * soon", and no typed figure that the code could later disagree with — the
 * lesson of `the-number-on-our-own-landing-page` applies hardest to the posts
 * written to sell something.
 *
 * Each has its own address, which is not decoration. A post that exists only as
 * a card on a list page cannot be linked to, cannot be shared with a preview,
 * cannot be indexed as a document in its own right — and cannot be counted,
 * because every measurement tool in existence counts URLs.
 */
export const POSTS: Post[] = [
  {
    slug: 'a-pay-less-notice-with-no-way-to-give-one',
    title: 'A pay less notice the platform said was overdue, and no way to give one',
    standfirst:
      'Building the Construction Act engine found the hole: the event existed, the position read it, and no command could emit one — so "pay in full" was the only advice the platform could ever offer.',
    date: '2026-07-02',
    tag: 'Engineering',
    body: [
      'The Housing Grants, Construction and Regeneration Act says that where a payer gives no payment notice and no pay less notice, the sum applied for becomes the notified sum and falls due in full. That is the rule the engine exists to compute, and it computed it correctly.',
      'What it could not do was the other half. <code>PAY_LESS_NOTICE_GIVEN</code> was in the closed event catalogue. The payment position read it. The compliance engine counted the days to the deadline and reported the notice overdue. And no command anywhere in the platform could emit one.',
      'This is the specific and dangerous shape of hole, because it reads as capability from every direction at once. The catalogue lists the event. Entity access classifies it. The control standard can require evidence of it. A user looking at the screen sees the platform tracking a deadline it has no way to let them meet — so the only advice it could ever give was "pay in full", forever.',
      'It had been found by hand three times by then: this, a snag that could be raised and never closed, and a daily diary the control standard demanded of every project and reported missing forever. Finding it a fourth time by hand is not a plan.',
      'So the check became a test. <code>tests/catalogue.test.ts</code> scans every source file for what is actually emitted and fails on any event that is neither emitted nor named in a list stating why not. It found twenty-three. Three were real capability and are now built; the rest are named with their reason, and every line of that list is a debt rather than a feature.',
      'The test also fails on a stale excuse — an entry claiming something is missing when it has since been built — because a list that overstates the gaps is a list people stop reading.',
    ],
  },
  {
    slug: 'a-minor-unit-is-not-always-a-hundredth',
    title: 'Why a minor unit is not always a hundredth',
    standfirst:
      'Money in minor units is a correct decision. Dividing by 100 in five places is not: a yen has no minor unit and a dinar has three, so a JPY figure displayed a hundred times too small.',
    date: '2026-07-18',
    tag: 'Engineering',
    body: [
      'Holding money in minor units — pence, cents — rather than decimals is a settled decision here and a correct one. Floating point cannot represent a tenth, and a payment certificate that is out by a rounding error is a payment certificate somebody disputes.',
      'What was missing is that a minor unit is not always a hundredth. The Japanese yen has no minor unit at all. The Kuwaiti, Bahraini and Jordanian dinars have three. The platform divided by 100 in five separate places.',
      'A JPY figure would therefore have displayed a hundred times too small. That is an order of magnitude, not a rounding difference — and it would have reached a client before anybody in the building noticed, because a number that looks plausible is the hardest kind of wrong to spot. For a platform aimed at governments, development finance institutions and global contractors, that is a defect rather than a limitation.',
      'The fix was to stop having five answers. <code>backend/src/domain/locale.ts</code> is now the single place the platform knows how to count money, and an unknown currency is <em>refused</em> rather than quietly defaulted to two digits — the silent default being exactly the mechanism that produced the bug.',
      'Formatting uses the runtime\'s own <code>Intl</code> data, so a French reader gets a comma decimal point and a space thousands separator without a dependency and without anybody maintaining a symbol table. There were four copies of that logic before; there is one now.',
    ],
  },
  {
    slug: 'the-clause-that-was-never-in-the-specification',
    title: 'The clause that was never in the specification',
    standfirst:
      'Splitting a wrapped specification clause on newlines invented a hold point that did not exist. A register that gains a requirement nobody imposed is worse than one that misses it.',
    date: '2026-08-04',
    tag: 'Engineering',
    body: [
      'Specification intelligence reads a supplied specification and classifies each clause: is this a hold point, a test, a submittal, or an ordinary obligation? Order matters. A clause saying both "inspected" and "shall not be covered" is a hold point, and reading it as a test loses the fact that work stops.',
      'The imperative counts as mandatory, because NBS-style specifications write obligations as instructions — treating <em>Submit the mix design</em> as advisory would let most of a specification through as optional.',
      'The defect was upstream of all that judgement, in deciding where one clause ends and the next begins. Splitting on newlines is the obvious approach and it is wrong: specifications are wrapped text, so a single clause that happened to run over a line became two clauses. The second half, read alone, classified as a hold point.',
      'The register therefore contained a hold point that was never in the specification. That is the worse failure of the two available. A register that misses a requirement is incomplete, and somebody notices when the work arrives. A register that <em>gains</em> one is authoritative and wrong: it stops work that was never required to stop, and the argument about it happens on site.',
      'The classification is deterministic on purpose. The same text gives the same answer twice, and anybody can see why a clause was read the way it was — which is the only property that makes it arguable rather than merely automated.',
      'The part that earns its place is the join. <code>specificationCoverage</code> matches verification clauses against the acceptance criteria in the inspection and test plan, and reports what has no inspection stage against it. That gap is invisible from both sides: the quality manager reads the ITP, the engineer reads the specification, and it exists only between the two.',
    ],
  },
  {
    slug: 'writing-a-pdf-by-hand',
    title: 'Writing a PDF by hand, and what it caught',
    standfirst:
      'Printing a web page is not an answer when the document carries a content hash. Building the writer found the report putting raw minor units in front of an adjudicator.',
    date: '2026-08-19',
    tag: 'Engineering',
    body: [
      'PDF is the format an adjudicator, an insurer or a court asks for, and it was the one thing the exporter could not produce.',
      '"Print the web page" is not an answer when the document carries a content hash. A browser\'s print pipeline re-flows the content — different fonts, different widths, different breaks — so what was hashed and what was printed are not the same artefact. The hash is the whole point of the document; a process that quietly changes the bytes underneath it produces a file that fails its own verification.',
      'So <code>backend/src/export/pdf.ts</code> writes the file directly: objects, content streams, and the byte-offset cross-reference table that is the only part of the format a reader is genuinely strict about.',
      'Text uses the standard 14 fonts, which every reader has and none of which need embedding — that is what makes it possible with no dependency. It is also why Adobe\'s published AFM character widths are in the repository as data. Without real widths, lines break in the wrong place and text runs off the page, and an approximation is not good enough for a document going in front of a tribunal.',
      'Every page carries the client\'s name, the document reference, the page number against the total, and the content hash — so a page separated from its bundle still says what it belongs to.',
      'The thing worth reporting is what building it found. Rendering the payment report properly exposed that it was putting <em>raw minor units</em> in front of the reader: a figure a hundred times too large, in the one document whose whole purpose is to be relied upon. The formatter existed. The report was not calling it.',
    ],
  },
  {
    slug: 'a-demonstration-route-that-handed-out-a-session',
    title: 'A demonstration route that handed out a working session',
    standfirst:
      'One console endpoint was public with no production gate and returned a PM access token to anyone who could reach the origin. Its sibling already carried the gate, which is what made it dangerous.',
    date: '2026-08-21',
    tag: 'Security',
    body: [
      '<code>POST /v1/console/session</code> was marked <code>public: true</code> with no production gate. It seeded a demonstration project and returned a working access token for a project manager identity to any anonymous caller. No credential. No multi-factor step. To anyone who could reach the origin.',
      'It was demonstrated against a running server before it was closed, rather than reasoned about: the token authenticated subsequent requests, and was stopped only by the role check on the particular command tried next. Which is to say it was stopped by luck of which button got pressed first.',
      'The detail that matters is the sibling. <code>/v1/console/identities</code> already carried the production gate. That is what made this the dangerous kind of hole rather than an obvious one — the pattern looked handled. Anyone reviewing the file would see a gated demonstration route and move on.',
      'Nothing in the interface called it at all. The console signs in through <code>/v1/auth/login</code> and <code>/v1/auth/mfa/verify</code> like any other client. The route existed for a demonstration that had long since stopped needing it, which is the usual biography of this kind of defect.',
      'Writing the test found a second problem underneath it. The production check read a value snapshotted at import, so a test could not exercise the gate at all — the branch deciding whether an anonymous caller receives an access token was the one branch nothing could reach. A security gate nobody can test is a security gate nobody has checked.',
      'It now reads the environment fresh, and the test drives both sides of it.',
    ],
  },
  {
    slug: 'every-invitation-bought-a-seat',
    title: 'Every invitation bought a seat, including the ones that should not have',
    standfirst:
      'A construction project is thirty companies. Charging a seat for each person invited onto one made the honest answer to "who should we put on this" be "as few as we can afford" — which puts holes in the record exactly where the work happens.',
    date: '2026-09-05',
    tag: 'Engineering',
    body: [
      'A project invitation created a paid identity. That is the ordinary way this is built, and on a construction project it is wrong in a way that damages the thing the platform exists to produce.',
      'The arithmetic is unforgiving. A main contractor running a mid-sized job has a client, a client\'s representative, a designer, a principal designer, four or five specialist subcontractors and a supply chain behind each of those. Two hundred people is unremarkable. Charging for every one of them means the person deciding who gets an account is choosing between the budget and the completeness of the record — and the record loses, every time, because the budget is this month and the record matters at adjudication in two years.',
      'So the fix was not a discount. It was to separate three things the system had been treating as one: who a person <em>is</em>, what their organisation <em>pays for</em>, and which projects they have been <em>invited onto</em>.',
      'A seat now attaches to authority rather than to access. Of the twenty roles the platform grants, ten hold Controller authority — they approve money, baselines or contracts, administer people, or run the business. The other ten are participants: site, quality, design, supervision, supply. A participant consumes no seat at all, internal or external. The site manager filing a daily diary and the subcontractor closing a snag are the people whose records make the <b>golden thread</b> worth having, and they are now free to add.',
      'The harder half is the Controller who does not work for you. A quantity surveyor invited from the client\'s side already holds a Controller licence — their own firm pays for it. Charging you again for the same person is charging twice for one seat, and it is the specific thing that makes cross-organisation working expensive enough that people avoid it.',
      'Licence resolution therefore looks outward before it looks at your subscription: the person\'s own organisation first, then any company in their group, then a pass you chose to buy, then nothing. Where the answer is nothing, the platform does not refuse the invitation and does not quietly bill you. It admits the person as a participant, withholds the Controller roles, and says which licence would open them. Buying a Project Controller Pass is then a decision somebody takes, for one person, on one project, for a period they set.',
      'The rule underneath all of it is one sentence, and it is worth stating plainly because the code enforces it in the seat count rather than in a policy document: <b>a project invitation must never add somebody to the host organisation\'s paid seats.</b>',
      'AI spend needed the same treatment and did not have it. A guest running an engine was spending somebody\'s money and the platform had one wallet to reach for. Now an execution resolves to an approved sponsor — the guest\'s own organisation under a limit it consented to, or the host under a one-time authorisation it gave — and where neither exists the work is refused rather than charged to whoever happened to be nearest. No automatic billing, and no duplicate.',
      'What this cost to build was mostly the offboarding, which is the half nobody demonstrates: a membership that expires, a licence that lapses when the guest\'s own firm stops paying, roles that come back when it resumes, open AI holds released when access ends, and an external identity deactivated when its last project membership goes. An access model that cannot be ended cleanly is not an access model, it is an accumulation.',
    ],
  },
  {
    slug: 'the-number-the-landing-page-could-not-check',
    title: 'The number on our own landing page that nothing could check',
    standfirst:
      'Our marketing site reads its counts from the running product on purpose. The figures it did not read had drifted: a contract value out by nearly a million, an identity count off by one, and a governance claim in the Terms of Service that the code had stopped honouring.',
    date: '2026-09-06',
    tag: 'Engineering',
    body: [
      'This site has a rule about itself: every count on it is read from the thing it describes rather than typed into the copy. Route totals, the <b>event catalogue</b> size, notification counts. The reasoning is that prose is not tested, so a figure typed into a sentence drifts silently and nobody finds out until a customer does.',
      'The rule was right and the coverage was not. An audit of every public page against the code found four figures that had drifted, and the worst of them was in a contract.',
      'The <b>demonstration project</b> was advertised as a live £17.6M job, in a button, twice on the landing page and once more on the exposure calculator. The seed builds it at £18.5M. A visitor pressing "walk a live £17.6M job" arrived on a project showing a different number — which is the shortest route there is from marketing copy to a reader who stops believing the rest of the page.',
      'The same page introduced its console panel as "drawn to the shape of the real seeded project rather than an invented dashboard with rounder numbers", and then carried a forecast margin, a delay exposure and four progress bars that appear nowhere in the seed. Below it, a payment scenario — application 14 at £1.42M against a valuation of £1.19M — was stated to run on the demonstration project. There is no application 14. The seed builds three cycles, and the third is a genuinely better story: applied £2,248,650, certified £2,129,000, £119,650 withheld for handrail terminations not to detail and dewatering rates not agreed, with a valid <b>pay less notice</b> served inside the window. It is more convincing than the invented one precisely because you can open it and read it.',
      'The demonstration page said twelve identities beside a list of thirteen. That one had a date: a Construction Manager was added to the seed months ago and the sentence beside the list was not.',
      'The serious one was not a number. Four pages and the Terms of Service said no AI agent in the system holds a mandate above <code>PROPOSE</code>. That stopped being true when two of the eighty-one agents were given an ACT ceiling — one that files a tender return register off a reading the platform already holds, one that says the platform itself is unwell. Both were deliberate, both are documented, and neither can reach a governance event, because the catalogue refuses AI authorship on those outright. But "no agent holds a mandate above PROPOSE" in a document a customer contracts on is a different kind of wrong from a stale figure on a marketing page.',
      'What the true version says is stronger, which is usually how this goes. Almost the whole fleet can only propose. The two that may act do so only inside an envelope naming the exact commands, granted by a person holding governance authority, carrying an end date, revocable, recorded on the chain — and both carry a value ceiling of zero. That is a better sentence than the one it replaces, and it has the advantage of being true.',
      'The fix in every case was the same shape as the original rule: read the figure from the thing it describes. The contract value comes off the seed through the platform\'s own money formatter. The identity count is the list\'s own length. The agent counts are computed from the registry, so the day somebody grants a third ACT ceiling the page says three. And the payment figures are pinned by a test that seeds the demonstration project and asserts the page and the record agree.',
      'The lesson is not that we were careless with the copy. It is that a page which derives nine of its figures and types four of them will drift in exactly those four, and nobody will look, because the page has a reputation for being derived.',
    ],
  },
  {
    slug: 'one-provider-two-rivals-one-wall',
    title: 'One provider, two rivals, and the wall between them',
    standfirst:
      'A bid-writing consultancy works for firms that compete with each other. Tenant isolation cannot help: both customers’ evidence sits inside one tenancy, so the wall has to be somewhere else.',
    metaDescription:
      'Two competing contractors, one bid consultancy, one tenancy. The wall between their evidence is in the shape of the record, not in a query.',
    date: '2026-10-17',
    tag: 'Bid-On',
    body: [
      'CONSTRUX Bid-On is for bid work delivered <em>for somebody else</em>. A consultancy writes submissions for several contractors, and sooner or later two of its customers chase the same framework. Both have handed over their accident statistics, their insurance values, their case studies and their people’s CVs.',
      'The usual answer to keeping customer data apart is tenant isolation, and here it is no answer at all. Both firms’ material sits inside one tenancy — the provider’s. If an evidence item hung off the tenant, the retriever would be one missing filter away from citing one electrical contractor’s accident rate in a competitor’s submission to the same buyer. There is no apology for that, and no way to explain it afterwards.',
      'So <code>customerAccountId</code> is on the record — the same golden thread every other module in the platform appends to — and not on a query somebody remembers to write. The retriever takes the customer as an argument it cannot ignore, and it <em>filters before it ranks</em> — not after, and not in the caller. Embedding everything and filtering the results afterwards would mean another customer’s prose had already been sent to a provider before anybody decided the reader could not see it.',
      'Access is per customer and restrictive by default. A new workspace is visible to whoever opened it and to the staff assigned to it, and to nobody else. The opposite default — everybody sees everything unless excluded — is one forgotten exclusion away from a competitor’s evidence on the wrong screen, and nothing about that failure is visible until it matters.',
      'Because access is partial, the register says what it is <em>not</em> showing. “You are seeing four of nine” is a true and useful statement; four rows that look like all of them is not. The same sentence appears wherever the view is narrowed, including on the list of tenders already imported, where a bid reference and a buyer name together would be enough to work out that a rival is bidding the same job.',
      'The wall is then enforced at every door rather than at one. A citation is refused unless it points at this customer’s own evidence. Retrieval refuses a customer this person is not assigned to. A returnable can only cite this customer’s own filed item. Carry-forward offers prior answers only from the same company’s own earlier submissions, however well another firm’s answer happens to match.',
      'That is the whole product claim, and it is a structural one rather than a promise: the separation is in the shape of the record, so there is no code path where forgetting a filter is possible.',
    ],
  },
  {
    slug: 'a-module-you-cannot-switch-on-yourself',
    title: 'A module you cannot switch on yourself',
    standfirst:
      'Bid-On is an allocation with a signed agreement behind it, not a feature flag. A tenancy whose agreement ends keeps the read and loses the write, because the record of what was sent to a buyer has to outlive the subscription.',
    metaDescription:
      'Bid-On is granted against a named agreement, not toggled on. When the agreement ends the write path closes and the read path stays open.',
    date: '2026-10-17',
    tag: 'Bid-On',
    body: [
      'Most software sells a module as a switch. Somebody ticks a box in billing, a flag flips, and the feature appears. That is fine for a reporting add-on and wrong for this one, because what Bid-On holds is other companies’ commercial material — their insurance values, their accident figures, their people’s names.',
      'So it is an <b>allocation</b>. The module is restricted in the catalogue, cannot be self-activated, and is granted to a named tenancy by the platform operator. The grant carries a reason, the person who decided it, and — where the module’s own registry demands one — an <b>agreement reference</b>. Without that reference the allocation is refused outright. A module that holds a third party’s data under a contract should not be reachable by anybody who cannot name the contract.',
      'A grant has a life: scheduled, active, expired, revoked. The interesting part is what happens at the end of it, and it is the part most entitlement systems get wrong by being simple.',
      'When an agreement ends, the write path closes and <em>the read path does not</em>. A provider whose Bid-On agreement lapsed last year may still be asked by an adjudicator, an auditor or their own insurer what exactly they submitted on a customer’s behalf two years ago. A platform that answered “that module is switched off” would be destroying a record it was trusted to keep in order to enforce a billing state. The distinction is held in the code as two separate things — what a tenancy has been <em>granted</em>, and what it still <em>holds</em> — and every read checks the second while every command checks the first.',
      'Revocation is different from expiry on purpose, and both are different from never having held it. A tenancy that was never allocated the module is refused on a read as well, because there is nothing there to read.',
      'The practical effect for a buyer of this software is that turning the module on is a conversation and turning it off is not a cliff. Neither of those is a feature anybody asks for in a demonstration. Both are the reason a contractor’s commercial director will sign the form.',
    ],
  },
  {
    slug: 'a-score-that-refuses',
    title: 'A score that refuses, rather than a score that rounds up',
    standfirst:
      'Five weighted criteria produce a number. Five hard rules stop the number mattering. An answer that scores 86 and cites a certificate lapsing before the return date is red, and no amount of good writing moves it.',
    metaDescription:
      'Five weighted criteria, and five hard rules that override them. A certificate lapsing before the return date is red whatever the prose scored.',
    date: '2026-10-18',
    tag: 'Bid-On',
    body: [
      'Every bid tool scores answers. The scoring is the easy half and the part that sells demonstrations: a number, a traffic light, a dial that moves when you improve a paragraph. The hard half is what the number is not allowed to do.',
      'Bid-On scores an answer on five criteria — compliance, evidence, buyer relevance, specificity, and clarity against the stated limits — weighted so that answering the question actually asked counts for most and writing nicely counts for least. The weights are <em>copied onto the bid when it is created</em>, not read live, so a rubric reversioned next quarter cannot restate what a submission already sent was scored against.',
      'Above eighty is green, above fifty is amber, and below that is red. Then come the five rules that produce a red whatever the prose scored: a mandatory question nobody answered, a pass/fail question answered “no”, a cited certificate or insurance that expires before the deadline, a declaration the customer has not confirmed, and an answer past a word limit the buyer stated.',
      'Each of those is a reason a submission is <em>rejected</em> rather than marked down, and that difference is the whole design. A marked-down answer costs you points. A rejected submission costs you the bid, and everything else in it was spent for nothing.',
      'The expiry rule is judged against <b>the day the buyer reads it</b>, never against today. A certificate that lapses the week before return is not evidence for that submission, and a tool that showed it as current because it is current this morning is a tool that lets a pack go out wrong. On a rolling submission with no return date — a dynamic market, a maintained registration — the judgement day is the day the pack is read, and the position says which day it used, because a readiness figure somebody screenshots is worthless without the date it was true on.',
      'Where a hard rule fires, the screen also shows the band the prose alone would have earned. “This would have been green” is the sentence that tells a reviewer the writing is fine and the problem is a certificate — which is a ten-second fix rather than a rewrite.',
      'And the scorer is a separate act from the writer. The command that records an answer carries no score field at all, so the only way a score exists is a second pass by somebody or something that did not write it. Every criterion needs a reason a reviewer could argue with, recorded beside it.',
    ],
  },
  {
    slug: 'an-agent-that-would-rather-raise-a-gap',
    title: 'An agent that would rather raise a gap than invent a reference',
    standfirst:
      'The drafter is handed this customer’s retrieved passages and nothing else. Where the model writes prose it cannot cite, the prose is discarded and the question goes back to the customer — a worse outcome for the schedule and the only honest one.',
    metaDescription:
      'The drafter writes only from this customer’s retrieved evidence. Uncited prose is discarded and the question goes back to the customer.',
    date: '2026-10-18',
    tag: 'Bid-On',
    body: [
      'Five agents sit behind a bid: one reads the questionnaire, one retrieves the evidence, one drafts, one scores, one writes the request to the customer for what is missing. The selling point is not that they exist. It is what each of them is forbidden to do.',
      'The <b>parser</b> produces a proposal, never the question list. A person confirms the list against the source document, once, while the document is still open in front of them. The reason is unanswerable: a parser that drops one question produces a pack where every answer is good, readiness reads 100%, and the submission is rejected for a missing mandatory response. Nothing downstream can detect that, because what is wrong is the list itself.',
      'Everything works <em>one question at a time</em>. Asking a model for eight answers in one call is cheaper and it has no way to refuse when it runs out of room — it stops mid-pack, looks finished, and the tokens are gone. Eight calls is an orchestration choice a caller makes; one call that returns a hundred answers is a design that cannot fail safely.',
      'The <b>drafter</b> is given the retrieved passages and the question, and told to state nothing the passages do not support. That instruction on its own is worth nothing, so two things enforce it. The command that records an answer refuses a citation that does not point at this customer’s own evidence and at a passage that actually exists. And the drafter’s own output is checked for citations before anything is written: an answer the model returned with no citation at all becomes a <b>gap</b>, not an answer. The prose is thrown away and the question goes back to the customer.',
      'That is a worse outcome for the programme and the only honest one. An uncited paragraph in a submission is a claim the customer cannot stand behind, and an invented reference is a false statement to a buyer and grounds for disqualification. Anything the question asks for that the evidence does not cover is raised as a gap beside the draft, so a partial answer with a known hole beats both a gap that throws away good prose and a draft that hides what is missing.',
      'None of the five can reach a decision, either, and that is a property of the record rather than of a prompt. The closed event catalogue refuses AI authorship on every event that does not explicitly allow it, and nothing that approves, accepts or commits does. So an agent may draft an answer and score it, and cannot approve one, accept an amended contract, or bind the customer’s company to anything at all.',
      'The <b>scorer</b> does not grade its own work — separate call, separate prompt, separate command. The <b>gap writer</b> composes one covering message in plain English for somebody who runs a contracting business and does not write bids: no procurement jargon, no question numbers as the only identifier, and the date each thing is needed by.',
      'Every run is quoted before it starts, held against the wallet, refused on an empty one, and recorded against the customer and the piece of commercial work it was spent on. A provider can read what each customer’s AI actually cost, which is the only way to know whether a fixed fee was a good idea.',
    ],
  },
  {
    slug: 'a-deposit-that-blocks-the-spend',
    title: 'A deposit that blocks the spend and nothing else',
    standfirst:
      'An unpaid deposit stops the agent runs. It does not stop the customer being set up, their evidence being filed, or a question list being confirmed — because what a deposit protects is the money, not the relationship.',
    metaDescription:
      'An unpaid deposit stops the agent runs and nothing else, so a customer can still be set up and their evidence filed while it is chased.',
    date: '2026-10-19',
    tag: 'Bid-On',
    body: [
      'Bid support is sold as a fee, and the fee usually has a deposit in front of it. The software question is what an unpaid deposit should stop.',
      'The easy answer is everything, and it is wrong in a way that costs the provider the engagement. Block everything and the first thing you block is the customer uploading the evidence the work depends on — so the deposit becomes a barrier to getting started, and the provider ends up waiving it in order to make any progress at all.',
      'So the gate is narrow and deliberate: an outstanding deposit blocks <b>agent runs</b>. A person can still open the customer’s workspace, file their policies and certificates, confirm the declarations only they can confirm, and have a question list confirmed. What is blocked is the spend, because an agent run costs the provider real money the moment it runs, and running one against an unpaid deposit is lending money nobody agreed to lend.',
      'The deposit raises itself when the engagement is <em>activated</em>. Not when it is opened, because a draft engagement’s terms are not agreed and billing against terms nobody agreed is how a dispute starts. And not on the first agent run either, because the point of a deposit is that it is paid before the work rather than discovered when somebody presses draft.',
      'A waiver is treated as settled. A provider who knows their customer will sometimes start on a handshake, and a platform that made that impossible is one they would work around. The reason is mandatory and that is the point: a waiver with no reason is indistinguishable from a deposit nobody chased, and the difference matters three months later when somebody asks why this customer never paid one.',
      'The rest of the billing follows the same principle of charging at the moment the thing happened. A stage fee is raised on sign-off, which is when the work is agreed delivered — raising it when a stage opens charges for work not done, and raising it when the next one opens makes the last stage free. A balance is raised on completion only, because a cancelled engagement has not delivered and what is owed on a cancellation is a commercial conversation somebody has, not an invoice software decides to send.',
      'And pausing is a status rather than a type, so any engagement can stop and start. While it is paused nothing is billed, no agent runs, and every bid stays exactly where it was.',
    ],
  },
  {
    slug: 'contribution-not-profit',
    title: 'We call it contribution, because it is not profit',
    standfirst:
      'A statement shows what was invoiced, what arrived, and what the AI cost. It does not call the difference profit, because that would ignore the largest cost in a bid-writing business: the writer’s own time.',
    metaDescription:
      'Received less AI cost, read back from the charge the wallet already moved. Called contribution, because it ignores the writer’s own time.',
    date: '2026-10-19',
    tag: 'Bid-On',
    body: [
      'Every engagement has a statement: the work delivered in the period, what was invoiced, what was received, what is outstanding, what was waived, and what the AI cost. Received less AI cost is the figure a provider actually wants, and the label on it is the thing worth defending.',
      'It is called a <b>contribution</b>, not a profit. It ignores the provider’s own time, which in a bid-writing business is the largest cost by a wide margin. A screen that called it profit would be telling somebody they made £1,420 on a pack that took them three days, and the moment they noticed, nothing else on the screen would be believed either.',
      'The AI figure is <em>not recomputed</em>. It is the charge already settled on each execution record — the same number the wallet moved — read back through the attribution the engine set when the run happened. Recomputing it from tokens and a multiplier would produce a second figure that disagrees with the wallet the day somebody changes the multiplier, and then there are two answers to “what did this customer cost us” and no way to tell which is right.',
      'That attribution is the quiet feature underneath it. Every agent run carries the customer, the engagement and the bid it was spent on. Without it a provider has one number for the month and no idea which customer earned it; with it, margin per customer is a read rather than a spreadsheet exercise.',
      'The honesty that has to hold on every one of these screens: <b>nothing here moves money.</b> There is no payment gateway and no invoicing run. An invoice is a record of what is owed. Recording a payment is somebody saying it arrived. A statement that looked reconciled while nothing had been reconciled is the kind of wrong about money that stops a provider trusting the tool, so the sentence is on the statement and on the register rather than tucked into a release note.',
      'The invoice register says the same thing in a different way: it shows what is past due rather than quietly ageing it, because a deposit nobody chased and a deposit somebody decided to waive look identical on a screen that does not distinguish them.',
    ],
  },
  {
    slug: 'the-customers-own-screen',
    title: 'The customer’s own screen, built from their side of it',
    standfirst:
      'The obvious move is to show a customer the provider’s screen with the other customers filtered out. That shows them your pricing, tells them how many rivals you have, and buries the three things they actually have to do.',
    metaDescription:
      'A Bid-On customer gets their own page, not the provider’s with rows hidden — and it is the only place a declaration can be confirmed.',
    date: '2026-10-19',
    tag: 'Bid-On',
    body: [
      'A Bid-On customer is a guest inside their provider’s tenancy. Giving them the provider’s screen with rows filtered out is the cheap option and it is wrong twice over: it shows them what the provider charges and how many other customers exist, and it buries the three things only they can do.',
      'So they get their own screen, and everything on it is theirs. The documents held for them, with the dates they run out. The statements only their own director can confirm. Everything that has been asked for, from every pack, in one list. And what they are being charged.',
      'The declarations panel is the reason the page exists. Insurance cover, accident figures and legal statements are representations their company makes to a buyer under its own name, so the platform refuses one from the provider’s staff and from every agent. This screen is therefore <em>the only place in the platform where a declaration can be confirmed at all</em>. Whoever confirms it is who the buyer will hold to it, and an answer resting on an unconfirmed declaration is held back from the submission rather than sent.',
      'There is deliberately <b>no readiness percentage</b>. A number that says 68% invites a conversation about the number rather than about the two certificates that are missing, and the list of what is still needed is the useful form of the same fact.',
      'The bid states are in plain words rather than internal ones. “We are checking it” means something to a contractor; “in review” does not. The questions we need answered and the documents the buyer requires are one list, because from their side of the screen they are one errand — a priced cost model and a signed order form are not “gaps in the evidence”, they are two more things to send. Each row says which kind it is, because a question holds up one answer and a required document holds up the whole submission.',
      'Where a buyer has amended a standard contract, the observations go on this page too, because they are the ones who sign it. It says on the page — not in a tooltip — that it is a first pass written by a model for whoever advises them, that it is not legal advice, and that nothing has been accepted on their behalf. The questions that reading raised are not shown here: those go to the buyer, and buyer contact on a live bid is the provider’s to manage rather than something to invite from two directions at once.',
      'No approval and no export. A customer does not approve their own answers — the provider’s reviewer does, because the whole service is somebody competent reading it before it goes.',
    ],
  },
  {
    slug: 'importing-a-tender-without-importing-its-future',
    title: 'Importing a tender, without importing its future',
    standfirst:
      'Bid-On copies what it needs from the standard Tenders section and links back. It never reads it live, because a bid in progress must not change underneath somebody.',
    metaDescription:
      'A standard tender imports into Bid-On one way, copied and hashed. A change at source raises a banner rather than a silent re-parse.',
    date: '2026-10-20',
    tag: 'Bid-On',
    body: [
      'A provider whose customer’s tender is already recorded in CONSTRUX should not have to upload the same questionnaire twice. So a standard tender can be imported into Bid-On as a bid. It is a shortcut and never a requirement — a bid started from a questionnaire needs no tender in the standard section at all, and never appears there.',
      'The load-bearing decision is that the import is <b>one-way</b>. Bid-On copies the fields it needs and links back. It never writes to the source tender, and nothing in the standard section is aware it happened.',
      'The reason is not tidiness. If the bid read the source live, deleting a document there would silently remove the evidence an approved answer cites, and editing a return date would move every certificate-expiry verdict in the pack without anybody touching the bid. So the fields are copied at the moment of import, and any file the standard section registered against that invitation comes over by its <em>content hash</em> — which is what lets the questionnaire be parsed without anybody uploading it again, and what means the bytes cannot change under it afterwards.',
      'When the source does change, the bid says so and waits. <b>A change at source is a banner, not a re-parse.</b> A silent re-parse would overwrite approved answers with drafts, and an approved answer is one somebody put their name to.',
      'The drift is found by comparing a stored reading of the tender against the tender as it stands, on every read — rather than by subscribing to a change event. That is the better mechanism and not merely the available one: a missed event leaves a bid silently stale for ever, while a reading that no longer matches is wrong on every read until somebody acts on it.',
      'Resync is then safe to press, which is the only property that matters about it. Approved answers survive. Only a question whose <em>wording</em> actually changed goes back for review, matched on text against the buyer’s own number, and every version is kept — the answer approved against the old wording is what a dispute about the old wording would turn on. A question whose number moved or whose heading was retyped is the same question, and throwing away a good answer because a buyer fixed a typo is how a resync becomes something nobody dares press.',
      'It takes the new wording as its argument rather than re-reading the documents itself, because re-reading is a paid model call. The sequence a person follows is: see the banner, read the changed document, resync with what it now says. Folding the parse in would make resync a button that silently spends money.',
    ],
  },
  {
    slug: 'a-submission-with-no-closing-date',
    title: 'A submission with no closing date',
    standfirst:
      'A dynamic market accepts applications at any point in its life. A UVDB registration is maintained, not returned. Putting a target date in the deadline field would judge every certificate in the pack against an invention.',
    metaDescription:
      'A dynamic market has no deadline to miss, so a rolling bid carries none and is judged against the day the buyer reads it.',
    date: '2026-10-20',
    tag: 'Bid-On',
    body: [
      'Everything in a bid tool is built around a return date. It is the right assumption for an invitation to tender and wrong for two things a contractor actually chases.',
      'A <b>dynamic market</b> under the Procurement Act accepts applications at any point in its life, obliges the authority to consider them within a reasonable period, and cannot cap its membership. There is no closing date to miss. And a registration — UVDB, Constructionline — is <em>maintained</em> rather than returned: it is live until it lapses.',
      'The available workaround was to put a target date in the deadline field, and that is precisely what this exists to avoid. Every expiry verdict in the pack would then be judged against a date somebody made up, and “this certificate lapses before the deadline” would be a statement about an invention.',
      'So a rolling submission carries <b>no deadline at all</b>, and is judged against the day it is read — every time it is read. One function decides which day that is, because a screen judging against today while the export gate judged against a deadline would disagree about whether a certificate is valid, and that is the only question either of them is being asked.',
      'The consequence is the feature. A rolling pack goes backwards on its own: exportable when read in December, red when read in February because the cited certificate lapsed in January, with no event in between and nobody having touched it. That is the honest behaviour for a membership nobody returns, and it is the thing a dated bid cannot express.',
      'Nothing invents a countdown. Days remaining is absent rather than zero, because a countdown of nought reads as “due today” on something with no due date at all. The register sorts rolling submissions last — they are never the thing with the least time left — and never counts one as late, because a permanent false alarm against every membership a provider maintains is how a register stops being read. The exported pack prints the day it was judged on instead of a return date, so a buyer never reads an invented date off the front page.',
      'The watching agent swaps its finding over, too. A dated bid near its deadline that cannot be exported is urgent. A membership pack that cannot be exported has <em>nothing forcing it</em> — no deadline makes anybody finish it — so it sits unfinished indefinitely while certificates age underneath it, and that is what gets reported instead.',
    ],
  },
  {
    slug: 'two-honest-states-for-a-search',
    title: 'Two honest states for a search, and no third',
    standfirst:
      'With an embedding model configured, a customer’s library is searched by meaning. Without one, it is searched on distinctive words and says so. What it never does is call the second one the first.',
    metaDescription:
      'Semantic search where a model is configured, term overlap where none is, labelled either way — and no stand-in vector, ever.',
    date: '2026-10-21',
    tag: 'Bid-On',
    body: [
      'Every answer Bid-On drafts is drawn from one customer’s own evidence, so finding the right passage is the whole quality of the output. There are two honest ways to do it and the platform does both, labelled.',
      'Where an embedding provider is configured, the question and the passages are embedded and compared by meaning. Where one is not, the search ranks on the share of the question’s distinctive words a passage actually uses. Every result carries which method ran and, on the semantic path, the model whose space the comparison was made in. The note says in words that a term search will miss a passage answering the question in other words.',
      'There is <b>no local stand-in</b> for an embedding, and this is the one capability in the platform with none. Everywhere else a deterministic stand-in exists so a feature works without a provider, and each is marked as the stand-in on its output. A stand-in narrative is <em>visibly</em> a stand-in — somebody reads it and can tell. A stand-in vector is not readable by anybody: hashed tokens in a fixed-width array rank, sort and score exactly like real ones, and the results come back ordered to three decimal places meaning nothing. It is the one fallback that could not be labelled honestly enough to be safe, so a deployment without a provider is told which setting turns semantic search on.',
      'The floor matters more than the method. Nearest-neighbour search <em>always returns neighbours</em>; there is no such thing as an empty result unless something refuses to produce one. And the nearest of several irrelevant passages reads exactly like a relevant one once a model has written a confident paragraph from it. So both paths have a floor below which nothing comes back, and returning nothing is what turns “here are the four closest things in the library” into “there is nothing here about that” — which is a true and useful answer that an unfiltered index can never give.',
      'Nothing is ever compared across two models’ spaces. A cosine between vectors from different models is not a smaller number, it is a number with no meaning that sorts beside the real ones — so a passage embedded by another vendor is <b>skipped and counted</b>, never scored, and the count is on every answer. A library half embedded by one model and half by another is a real state, and a search that silently ignored half of it would look like a library half the size.',
      'Re-reading a document drops its vectors with its passages. An item claiming to be embedded while its passages are not would fall out of every semantic search with nothing to explain why.',
      'And the spend is separated from the read. Filtering on the customer, judging expiry against the deadline and refusing below a floor costs nothing, so a screen may call it freely. Embedding a question is a model call, so it is a command with a quote in front of it — two buttons on the screen rather than one that silently picks the paid path because a library happens to be embedded.',
    ],
  },
  {
    slug: 'the-half-of-a-submission-that-is-not-answers',
    title: 'The half of a submission that is not answers',
    standfirst:
      'A measured term contract arrives as nine documents and three of them carry questions. Readiness read 100% with the order form unsigned, which is the most expensive kind of wrong a bid tool can be.',
    metaDescription:
      'Order forms, cost models and signatures are returnables, not answers. Readiness used to read 100% with the order form unsigned.',
    date: '2026-10-21',
    tag: 'Bid-On',
    body: [
      'An invitation to tender for a measured term contract arrives as nine documents. The questionnaire, an order form to complete and sign, a cost model to price, a schedule of amendments to accept or qualify, a stock list, a specification, a code of conduct. Three of them carry questions. Five are obligations with no question attached.',
      'A submission missing a signed order form is rejected <em>exactly as completely</em> as one missing an answer. And until this was built, readiness on such a pack read 100% with the order form unsigned — because readiness was about answers, and nothing in the module knew those documents existed as obligations. That is the most expensive kind of wrong available to software: confidently wrong at the one moment nobody re-checks.',
      'So a bid now carries a register of what has to be <b>returned</b> rather than answered: the buyer’s own reference, what it is, whether it is mandatory, the format, any page or file-size limit, whether it needs signing, who produces it, and our own internal date — which is earlier than the buyer’s on purpose, because the internal date is the one that actually binds.',
      'The field it turns on is <em>who produces it</em>. The provider writes prose; the customer prices their own rates and signs their own contract. A cost model is the customer’s, so it appears in the request that goes to them rather than on a bid writer’s list of things they have failed to do — and it goes in the <em>same</em> message as the evidence gaps, because asking for it a week later in a second email is how a submission goes out short of the one document the buyer cared about.',
      'It gates through the readiness figure rather than beside it. A separate check at the export would have left the screen saying “ready” while the export refused, and a screen that disagrees with the gate is worse than no screen. The refusal names the documents rather than the answers, because a gate reporting red answers when the real problem is an unsigned order form sends somebody to re-read answers that are fine.',
      'The register appends rather than being confirmed once. A question list is confirmed in one sitting against the source; returnables are found across nine documents over an afternoon, and a register that had to be right in one go is a register nobody fills in. A duplicate reference is refused, and an internal date set after the buyer’s return date is refused — a date that binds nothing is not a date.',
      'A signature is treated as a lead time rather than a task: a mandatory one with no internal date raises a question to put to the buyer, because a wet signature discovered on the last afternoon is the classic way a complete submission misses.',
      'And waiving a returnable takes approval with a mandatory reason, because it removes a gate. A waiver with no reason is indistinguishable from a document nobody chased, and the difference matters when a submission comes back rejected for a missing one.',
    ],
  },
  {
    slug: 'the-deadline-nobody-watches',
    title: 'The deadline nobody watches',
    standfirst:
      'A buyer’s clarification window shuts weeks before the return. A question raised after it is not a question any more — it is a risk that has to be priced or accepted.',
    metaDescription:
      'The buyer’s clarification window shuts weeks before the return date. Bid-On counts down to it and raises most of the questions itself.',
    date: '2026-10-22',
    tag: 'Bid-On',
    body: [
      'Everybody watches the return date. Almost nobody watches the other one, and the other one shuts first.',
      'A buyer stops accepting questions well before they stop accepting submissions. Every point you could have negotiated — a liability cap deleted by amendment, a retention percentage, a parent company guarantee you cannot give, a word limit nobody stated — stops being negotiable on that date and becomes something to price or to accept. Nothing in a bid tool normally tells you it is coming.',
      'So the clarification deadline is on the bid, separate from the return, and one that falls <em>after</em> the return is refused outright: a window for questions that closes after the buyer has read the submission is not a window.',
      'A prequalification and the ITT that follows it are two submissions to one buyer about one job, with separate question sets, separate return dates, separate windows and separate outcomes. Treating them as one bid loses the PQQ’s own result; treating them as unrelated loses the fact that the ITT exists only because the PQQ was won. So the stage is on the record and the ITT holds the link back — on the later bid, because a PQQ exists before anybody knows whether an ITT will follow.',
      'The module raises most clarifications itself. A text question with no stated length limit. A mandatory returnable with no stated format. A signature with no internal date. An amendment that moves a risk a subcontractor cannot price or insure. Those are exactly the things nobody notices until it is too late to ask.',
      'But <b>a note nobody sent is worth nothing</b>, so a clarification has a life: raised, asked, answered — or withdrawn, with a reason, which is also what stops the module raising the same subject again every time a register is added to. The date it went to the buyer is recorded because that is the fact a dispute about a late question turns on, and asking after the window shut is <em>recorded rather than refused</em>: it is a fact, a buyer may answer a late question, and refusing would make the honest entry impossible and leave the question looking un-asked for ever.',
      'The buyer’s answer is kept verbatim. It is part of the tender documents from the moment they give it and is usually issued to every bidder, so a paraphrase of it is a new claim with nobody’s name on it. What the answer <em>changes</em> is a separate act — a stated limit goes on the question, a waived document on the register, a moved date on the bid — so the change and the authority for it are two entries rather than one.',
      'The watching agent counts down to the clarification date where one is recorded, and where none is, it says so — because not knowing when the window shuts is itself the finding.',
    ],
  },
  {
    slug: 'an-amended-contract-is-a-different-contract',
    title: 'An amended standard form is a different contract',
    standfirst:
      'An unamended JCT is a known quantity. The same contract with twenty amendments is not, and the usual way a term contract goes wrong is that nobody read them until the first dispute.',
    metaDescription:
      'A model reads the schedule of amendments and says what to ask the buyer. It accepts nothing, qualifies nothing and advises nothing.',
    date: '2026-10-22',
    tag: 'Bid-On',
    body: [
      'A measured term contract arrives as a standard form plus a schedule of amendments. The standard form is a known quantity — priced, insured and argued over for decades. The amendments are where the risk actually sits, and the commonest way a term contract goes wrong is that nobody read them properly until the first dispute.',
      'So Bid-On will read a schedule of amendments and tell you what it changes compared with the unamended form, and what you would ask the buyer about it. Its value is entirely about <em>timing</em>: the questions are on the table before the clarification window shuts rather than after it, which is the difference between a point that can be negotiated and one that has to be priced.',
      'Three things it is not, and each is enforced rather than promised.',
      'It is <b>not legal advice</b>. It says nothing about whether a clause is enforceable, the instruction forbids it, and the output is phrased as questions and observations. It is a first pass to put in front of whoever advises the customer on contracts — which is the decision it is actually for.',
      'It is <b>not a decision</b>. It accepts nothing, rejects nothing and qualifies nothing. Accepting an amended contract binds a company, and no agent mandate in this platform reaches an act that binds one. A test asserts that the bid’s status, its questions, its answers and its returnables are byte-identical after a reading — the only thing that changes is that some questions now exist to ask.',
      'And it is <b>not a substitute for reading them</b>. It marks a point critical only where an amendment moves a risk a subcontractor cannot price or insure: unlimited liability, a cap deleted, fitness for purpose, pay-when-paid, set-off without notice, a payment period materially extended, termination at will. Where the schedule is short or routine it is told to return few findings or none, because a list of twenty points nobody reads is worse than three that get asked.',
      'A finding whose severity the model mislabelled is kept rather than dropped, at major. A point worth raising is worth asking even where the label was wrong, and discarding it would make the reading look cleaner than it was.',
      'One detail worth reporting because the ledger caught it: re-reading the same schedule produces the same findings, and an append-only record refused a write whose only content was that somebody pressed the button twice. Refusing the command would have lost the caller a result they had already paid for. So nothing is written, the findings come back, and the result says plainly that it found nothing new — because “nothing new” and “nothing read” are different answers.',
    ],
  },
  {
    slug: 'it-offers-and-it-does-not-paste',
    title: 'It offers, and it does not paste',
    standfirst:
      'A PQQ answer reused unchanged in the ITT is boilerplate, and boilerplate is what a buyer marks down. So the platform finds the earlier answer, checks what has gone stale in it, and stops there.',
    metaDescription:
      'Approved prequalification answers are offered against the ITT question with their citations re-checked — and there is no apply button.',
    date: '2026-10-22',
    tag: 'Bid-On',
    body: [
      'A prequalification asks you to describe your health and safety management arrangements. Eight weeks later the ITT for the same job asks you to set out your health and safety management system. It is the same answer, somebody already approved it, and writing it again costs a draft, a review, and a second version of the company’s position that may not match the first. A buyer who reads both documents is entitled to notice.',
      'So Bid-On finds the earlier approved answers and offers them against the new question. What it will not do is put one into the bid.',
      'That restraint is the feature. An answer pasted unchanged into the next submission is boilerplate, and boilerplate is exactly what an evaluator marks down — the reuse that actually works is somebody reading a good answer and writing <em>this</em> buyer’s version of it. The absence is checked against the source: there is no apply, no paste, no insert, no fill, the file writes nothing to the record and emits no event. An absence cannot be exercised by calling it, so it is verified the only way an absence can be.',
      'Reuse therefore goes through the ordinary command that records any answer — the same citation check against this customer’s current evidence, the same versioning, the same review state. What is added is the lineage, <em>verified</em> rather than labelled: it has to be an approved answer, on another bid, of the same customer. A reviewer can then see that an answer came from the prequalification rather than from nowhere, which is the first question anybody asks about a reused one.',
      'And it checks three things that reading an old pack by hand would miss.',
      'The <b>citations, against this bid’s date</b>. An answer approved in March citing an insurance certificate that lapsed in April is not reusable against a June return, and nothing about reading the prose would tell you. Each candidate reports which of its citations are current, lapsed or withdrawn.',
      'The <b>length, against this question’s limit</b>. A five-hundred-word PQQ answer offered against a three-hundred-word ITT question is still worth reading as a starting point; saying so is the difference between a useful offer and a trap. Where the question states no limit the answer is “unknown” rather than “fine”, because those are not the same thing.',
      'And the <b>lineage</b>. An answer from the prequalification this bid actually follows is a different proposition from one out of an unrelated bid two years ago, even where the wording matches better — so those are offered first and marked. The matching floor is deliberately higher than the one retrieval uses: a loosely matched passage is material a drafter may or may not use, but a loosely matched prior answer is a finished, approved, confident-sounding answer to a <em>different</em> question, and the reader’s instinct is to use what is offered. Offering none is better.',
    ],
  },
  {
    slug: 'the-pack-in-the-buyers-own-numbering',
    title: 'The pack, in the buyer’s own numbering',
    standfirst:
      'Nothing is sorted and nothing is renumbered. A pack a buyer has to map back onto their own questionnaire is a pack that loses marks for reasons that have nothing to do with the answers.',
    metaDescription:
      'Export in the buyer’s own sections and numbering, in three formats, gated on red answers and on outstanding mandatory documents.',
    date: '2026-10-22',
    tag: 'Bid-On',
    body: [
      'The last thing a bid tool does is hand over a file, and it is the step where tools usually reveal that they were built around their own data model rather than around the buyer’s document.',
      'A Bid-On pack comes out in the buyer’s own structure: their section headings, their numbering, in their order. Nothing is sorted and nothing is renumbered — a parser that tidied <code>4.1a</code> into <code>4.2</code> produces a pack an evaluator cannot map onto their own questionnaire, and a file somebody has to rebuild by hand is where the numbering stops matching.',
      'Three formats, each for a real destination. <b>DOCX</b> for the submission that gets attached, written through the platform’s own document model so the branding, the hashing and the renderer are the ones every other issued document uses. <b>XLSX</b> with a sheet per section, for the buyers who ask for a response matrix. And copy-ready <b>text</b> per question, because an online portal has a box per question and what somebody actually wants is to paste.',
      'Every page carries the client’s name, the document reference, the page number against the total, and a content hash — so a page separated from its bundle still says what it belongs to, and the file can be verified later as the one that was sent.',
      'The gate in front of it is the part that earns its keep. Export is refused while any <em>mandatory</em> answer is red or unapproved — both, not either, because an approved red is still a rejection at the gate and an unapproved green has had no person’s name on it. And it is refused while any mandatory <em>document</em> is outstanding, because a submission missing a required document is rejected exactly as completely as one missing an answer.',
      'The refusal names what is actually wrong: the questions where answers are the problem, the appendices where documents are. A gate that reported red answers when the real problem was an unsigned order form would send somebody to re-read answers that were fine.',
      'And rendering is refused unless that gate has passed, rather than producing a file with a disclaimer on it. A pack that exists is a pack that gets emailed.',
      'One thing is deliberately absent from the file: the returnables checklist and our own internal dates. They are how the provider runs the job, and a buyer should not read them off the front page of a submission.',
    ],
  },
];

/**
 * Post pages, for the router and the route table.
 *
 * Deliberately not part of `SITE_PAGES`: that list drives the navigation and
 * the footer, and five engineering notes in the footer is not a footer. Posts
 * are reached from the blog index and from links people share.
 */
// The slug travels with the path, so a caller counting a view against a page
// does not have to parse one back out of the other and get it subtly wrong.
export const POST_PAGES = POSTS.map((post) => ({ path: `/blog/${post.slug}`, slug: post.slug, title: post.title }));

/** The one date format the blog uses, in one place. */
export function longDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
