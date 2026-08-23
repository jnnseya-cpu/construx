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
];

/**
 * Post pages, for the router and the route table.
 *
 * Deliberately not part of `SITE_PAGES`: that list drives the navigation and
 * the footer, and five engineering notes in the footer is not a footer. Posts
 * are reached from the blog index and from links people share.
 */
export const POST_PAGES = POSTS.map((post) => ({ path: `/blog/${post.slug}`, title: post.title }));

/** The one date format the blog uses, in one place. */
export function longDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
