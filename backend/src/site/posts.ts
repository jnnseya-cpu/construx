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
  date: string;
  tag: string;
  /** Paragraphs. Trusted markup produced here, never user input. */
  body: string[];
};

/**
 * Posts are the engineering notes this project actually produced, not invented
 * thought leadership. Each one corresponds to work recorded in docs/STATE.md.
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
