/**
 * The CONSTRUX sales deck.
 *
 * Every figure in here is read off the codebase rather than written for effect:
 * the package prices come from `backend/src/billing/seats.ts`, the platform
 * counts from the tables at import (`ROUTES`, `EVENT_TYPES`, `ENTITY_ACCESS`,
 * `AGENTS`), the test count from `npm test`, and the market figure and the
 * competitive comparison from `docs/go-to-market/GO-TO-MARKET.md`. A sales deck
 * that overstates is a deck the first technical buyer dismantles in the room —
 * and this product's entire argument is that it does not overstate.
 *
 *   node docs/go-to-market/brand/build-deck.mjs [output.pptx]
 *
 * Palette and motif are the product's own. The console is a dark interface in
 * Signal Orange, so the deck is too — a deck in some other studio's colours
 * would be selling a thing the buyer does not then see when the demo opens.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/*
 * `pptxgenjs` is deliberately NOT in package.json. Zero runtime dependencies is
 * a settled decision and the dev set is TypeScript and @types/node only; this
 * is a marketing build script rather than part of the platform, so it asks for
 * the package when it needs one — the same arrangement `tools/walk.mjs` uses
 * for its browser driver.
 */
let PptxGenJS;
try {
  PptxGenJS = require('pptxgenjs');
} catch {
  process.stderr.write(
    'This script needs pptxgenjs, which is not a project dependency and must not become one.\n' +
      '  mkdir -p /tmp/deckdeps && cd /tmp/deckdeps && npm init -y && npm install pptxgenjs\n' +
      '  NODE_PATH=/tmp/deckdeps/node_modules node docs/go-to-market/brand/build-deck.mjs\n',
  );
  process.exit(1);
}

// ---------------------------------------------------------------- palette
// Taken from `frontend/app.css`. Names kept so the two stay comparable.
const CORE = '090A0D';
const CARBON = '111317';
const SLATE = '181B21';
const RAISED = '292E37';
const ORANGE = 'FF6A1A';
const GLOW = 'FF853D';
const TEXT = 'EDF1F7';
const MUTED = 'A7AFBD';
const QUIET = '8A96A9';
const SUCCESS = '2EB874';
const CRITICAL = 'FE5D5D';

// Arial throughout: it is metric-safe, so the overflow checks in QA are
// trustworthy. Courier New carries the ledger motif — the product's own face is
// IBM Plex Mono and Courier is the safe-list stand-in that reads the same way.
const SANS = 'Arial';
const MONO = 'Courier New';

const W = 13.333;
const H = 7.5;
const M = 0.72; // the left margin every slide aligns to

const pres = new PptxGenJS();
pres.layout = 'LAYOUT_WIDE';
pres.author = 'CONSTRUX';
pres.company = 'CONSTRUX';
pres.title = 'CONSTRUX — the record that cannot be argued with';

/** A slide on the dark ground, with the recurring ledger line along the foot. */
function slide({ ledger, dark = CARBON } = {}) {
  const s = pres.addSlide();
  s.background = { color: dark };
  if (ledger) {
    // The motif: a real event code and a hash fragment, in mono, quiet enough
    // to be texture rather than content. It is what the product actually
    // writes, which is the point of using it as decoration.
    s.addText(ledger, {
      x: M, y: H - 0.52, w: W - M * 2, h: 0.3,
      fontFace: MONO, fontSize: 9, color: '3A4150', align: 'left',
      valign: 'top', isTextBox: true, margin: 0,
    });
  }
  return s;
}

/** Slide title, one voice everywhere. */
function title(s, text, opts = {}) {
  s.addText(text, {
    x: M, y: opts.y ?? 0.62, w: opts.w ?? W - M * 2, h: opts.h ?? 1.0,
    fontFace: SANS, fontSize: opts.size ?? 38, bold: true, color: opts.color ?? TEXT,
    charSpacing: -0.6, lineSpacing: opts.lineSpacing ?? 42,
    isTextBox: true, margin: 0, valign: 'top',
  });
}

/** The small orange label above a title. */
function eyebrow(s, text, y = 0.34) {
  s.addText(text.toUpperCase(), {
    x: M, y, w: W - M * 2, h: 0.26,
    fontFace: SANS, fontSize: 11, bold: true, color: ORANGE, charSpacing: 2.2,
    valign: 'top', isTextBox: true, margin: 0,
  });
}

/** A raised panel. Tint and shadow, never an edge stripe. */
function card(s, { x, y, w, h, fill = SLATE }) {
  s.addShape(pres.ShapeType.roundRect, {
    x, y, w, h, rectRadius: 0.08,
    fill: { color: fill },
    line: { color: RAISED, width: 0.75 },
    shadow: { type: 'outer', color: '000000', blur: 14, offset: 4, angle: 90, opacity: 0.45 },
  });
}

/** A number in an orange disc — the second motif. */
function disc(s, { x, y, d = 0.52, label, fill = ORANGE, color = CORE }) {
  s.addShape(pres.ShapeType.ellipse, { x, y, w: d, h: d, fill: { color: fill }, line: { color: fill, width: 0 } });
  s.addText(String(label), {
    x, y, w: d, h: d,
    fontFace: SANS, fontSize: 15, bold: true, color, align: 'center', valign: 'middle',
    isTextBox: true, margin: 0,
  });
}

// =========================================================== 1 · the cover
{
  const s = slide({ dark: CORE, ledger: 'PROJECT_CREATED  →  …  →  HANDOVER_ACCEPTED     chain head sha256:4f9c1e…a37b     verified' });

  s.addText([
    { text: 'CONSTRU', options: { color: TEXT } },
    { text: 'X', options: { color: ORANGE } },
  ], {
    x: M, y: 1.55, w: 9.5, h: 1.1,
    fontFace: SANS, fontSize: 54, bold: true, charSpacing: 7,
    valign: 'top', isTextBox: true, margin: 0,
  });

  s.addText('The record that cannot\nbe argued with.', {
    x: M, y: 2.75, w: 9.6, h: 2.0,
    fontFace: SANS, fontSize: 46, bold: true, color: TEXT, charSpacing: -1.2, lineSpacing: 52,
    valign: 'top', isTextBox: true, margin: 0,
  });

  s.addText(
    'One governed record of a project — concept to the thirtieth year — on an append-only, hash-chained ledger. Every entry attributable. Every state replayable. Tampering detected, not just discouraged.',
    { x: M, y: 4.75, w: 8.6, h: 1.1, fontFace: SANS, fontSize: 15, color: MUTED, lineSpacing: 22, isTextBox: true, margin: 0 },
  );

  s.addText('The construction operating system  ·  construxvg.com', {
    x: M, y: 6.05, w: 8.6, h: 0.3,
    fontFace: SANS, fontSize: 12, bold: true, color: QUIET, charSpacing: 1.2, valign: 'top', isTextBox: true, margin: 0,
  });

  s.addNotes(
    'Open on the ledger, not on the AI. The ledger is the thing nobody else can retrofit; the AI is what forty other vendors also claim. ' +
    'Say the title sentence out loud and stop. Do not explain it yet — the next two slides earn it.',
  );
}

// ================================================== 2 · the problem, in money
{
  const s = slide({ ledger: 'the join between systems is where the money goes' });
  eyebrow(s, 'The problem');
  title(s, 'Nobody loses money because\nthey did not work hard.', { h: 1.5 });

  s.addText(
    'They lose it because the record of what was agreed, when, and on what basis is scattered across email, spreadsheets and somebody’s memory of a site meeting.',
    { x: M, y: 2.2, w: 11.0, h: 0.7, fontFace: SANS, fontSize: 16, color: MUTED, lineSpacing: 24, isTextBox: true, margin: 0 },
  );

  const items = [
    ['Late, not missing', 'The revision that changed the pipework interface was issued on time — and reached the people pouring concrete a fortnight after they needed it.'],
    ['Risk found after it cost money', 'A register reviewed monthly finds a risk that landed three weeks ago. By then it is not a risk. It is a variation, and the argument is about who pays.'],
    ['Your best people, chasing updates', 'The most expensive managers on the job, reduced to a human integration layer between systems that will not talk to each other.'],
  ];
  const cw = 3.6, gap = 0.35;
  items.forEach(([head, body], i) => {
    const x = M + i * (cw + gap);
    card(s, { x, y: 3.25, w: cw, h: 2.75 });
    disc(s, { x: x + 0.28, y: 3.52, label: i + 1 });
    // A fixed two-line block for the heading whether it uses one line or two.
    // Sized to the longest heading rather than to each: with the box hugging
    // its own text, the two headings that wrap pushed their body copy up until
    // it touched them, and the three cards no longer read as a set.
    s.addText(head, {
      x: x + 0.28, y: 4.2, w: cw - 0.56, h: 0.62,
      fontFace: SANS, fontSize: 16, bold: true, color: TEXT, lineSpacing: 20,
      valign: 'top', isTextBox: true, margin: 0,
    });
    s.addText(body, {
      x: x + 0.28, y: 4.88, w: cw - 0.56, h: 1.0,
      fontFace: SANS, fontSize: 11.5, color: MUTED, lineSpacing: 16, valign: 'top', isTextBox: true, margin: 0,
    });
  });

  s.addNotes('Three symptoms, met on project after project across twenty years. Let them recognise their own last job before you show them anything.');
}

// ======================================= 3 · the forcing function (the wedge)
{
  const s = slide({ dark: CORE, ledger: 'Building Safety Act 2022  ·  golden thread  ·  digital, structured, attributable, immutable' });
  eyebrow(s, 'Why now');
  title(s, 'This one is not a preference.\nIt is a statutory duty with a date.', { h: 1.5, size: 36 });

  card(s, { x: M, y: 2.55, w: 5.5, h: 3.35, fill: SLATE });
  s.addText('12,500', {
    x: M + 0.4, y: 2.85, w: 4.7, h: 1.15,
    fontFace: SANS, fontSize: 68, bold: true, color: ORANGE, charSpacing: -2, valign: 'top', isTextBox: true, margin: 0,
  });
  s.addText('higher-risk buildings in England', {
    x: M + 0.4, y: 3.98, w: 4.7, h: 0.32,
    fontFace: SANS, fontSize: 14, bold: true, color: TEXT, valign: 'top', isTextBox: true, margin: 0,
  });
  s.addText(
    'Broadly: residential at 18m or seven storeys with two or more units, plus care homes and hospitals in scope at design and construction. Duty-holders must produce the golden thread at every Gateway.',
    { x: M + 0.4, y: 4.42, w: 4.7, h: 1.2, fontFace: SANS, fontSize: 12, color: MUTED, lineSpacing: 17, isTextBox: true, margin: 0 },
  );

  card(s, { x: M + 5.9, y: 2.55, w: 5.5, h: 3.35, fill: SLATE });
  s.addText('What the guidance asks of the software itself', {
    x: M + 6.3, y: 2.85, w: 4.7, h: 0.32,
    fontFace: SANS, fontSize: 13, bold: true, color: ORANGE, valign: 'top', isTextBox: true, margin: 0,
  });
  s.addText(
    [
      { text: 'Every entry attributable to a named user', options: { bullet: true, breakLine: true } },
      { text: 'Timestamped', options: { bullet: true, breakLine: true } },
      { text: 'Immutable, with historical states preserved', options: { bullet: true, breakLine: true } },
      { text: 'Tenant isolation, documented encryption, UK residency', options: { bullet: true, breakLine: true } },
      { text: 'Annual independent penetration testing', options: { bullet: true } },
    ],
    { x: M + 6.3, y: 3.35, w: 4.7, h: 1.6, fontFace: SANS, fontSize: 12.5, color: TEXT, paraSpaceAfter: 6, isTextBox: true, margin: 0 },
  );
  s.addText('That is a specification of our architecture, published by somebody else.', {
    x: M + 6.3, y: 5.08, w: 4.7, h: 0.7,
    fontFace: SANS, fontSize: 13.5, bold: true, italic: true, color: TEXT, lineSpacing: 18, valign: 'top', isTextBox: true, margin: 0,
  });

  s.addNotes('This is the wedge: a buyer who is compelled, has a date, and has no good option. Do not soften it and do not oversell it — read the list and let it land.');
}

// ============================================ 4 · why the incumbents can't
{
  const s = slide({ ledger: 'a change log on a mutable file is not an immutable record' });
  eyebrow(s, 'The difference');
  title(s, 'Version history is a change log.\nIt is not an immutable record.', { h: 1.5, size: 36 });

  // One line, not two. At two lines this ran straight into the column headings
  // below it — the single worst defect in the first render, because a reader
  // sees two different things printed on top of each other and stops trusting
  // the rest of the page.
  s.addText(
    'Retrofitting an append-only ledger under a CDE built on mutable documents is not a feature. It is a rewrite.',
    { x: M, y: 2.12, w: 11.9, h: 0.34, fontFace: SANS, fontSize: 15, color: MUTED, isTextBox: true, margin: 0 },
  );

  const rows = [
    ['Attributable', 'User stamped on a document version', 'Every state change is an event with a named actor'],
    ['Immutable', 'Version history you can delete', 'Hash-chained, append-only. Nothing is edited'],
    ['Tamper-evident', 'Not claimed', 'Replay detects alteration and names the event'],
    ['Separation of duties', 'Advisory workflow', 'Refused, not warned'],
    ['AI governance', '“AI-powered”', 'No agent can approve anything, by construction'],
  ];
  const y0 = 3.02, rh = 0.72;
  const cx = [M, M + 3.3, M + 7.35];
  const cwid = [3.1, 3.85, 4.55];

  ['', 'Typical vendor', 'CONSTRUX'].forEach((h, i) => {
    if (!h) return;
    s.addText(h.toUpperCase(), {
      x: cx[i], y: y0 - 0.38, w: cwid[i], h: 0.28,
      fontFace: SANS, fontSize: 10, bold: true, color: i === 2 ? ORANGE : QUIET, charSpacing: 1.6,
      valign: 'top', isTextBox: true, margin: 0,
    });
  });

  rows.forEach(([claim, them, us], i) => {
    const y = y0 + i * rh;
    // A tint band on alternate rows, which is a table convention rather than a
    // decorative stripe — it exists to let the eye track across three columns.
    if (i % 2 === 0) {
      s.addShape(pres.ShapeType.rect, {
        x: M - 0.16, y: y - 0.06, w: W - M * 2 + 0.32, h: rh - 0.06,
        fill: { color: SLATE }, line: { width: 0 },
      });
    }
    s.addText(claim, { x: cx[0], y, w: cwid[0], h: 0.5, fontFace: SANS, fontSize: 13.5, bold: true, color: TEXT, valign: 'middle', isTextBox: true, margin: 0 });
    s.addText(them, { x: cx[1], y, w: cwid[1], h: 0.5, fontFace: SANS, fontSize: 12.5, color: QUIET, valign: 'middle', isTextBox: true, margin: 0 });
    s.addText(us, { x: cx[2], y, w: cwid[2], h: 0.5, fontFace: SANS, fontSize: 12.5, bold: true, color: GLOW, valign: 'middle', isTextBox: true, margin: 0 });
  });

  s.addNotes('Never rubbish the incumbent by name. The argument is architectural, not commercial: they cannot do this without rebuilding, and that is a fact about software, not a slur.');
}

// ============================================================ 5 · the proof
{
  const s = slide({ dark: CORE, ledger: 'run the replay  ·  root hash moves  ·  the event is named' });
  eyebrow(s, 'The demo, in order');
  title(s, 'Three things nobody else\ncan do on stage.', { h: 1.5 });

  const proofs = [
    ['Tamper. Then catch it.', 'Alter a record in front of them. Run the replay. The root hash moves and the platform names the exact event that changed.', ORANGE],
    ['Sign in as the regulator.', 'Every write control disappears. The export still works. Read-only oversight is architectural, not a checkbox somebody ticked.', ORANGE],
    ['Certify your own application.', 'The platform refuses. Separation of duties is enforced in the event catalogue, not advised in a workflow.', ORANGE],
  ];
  proofs.forEach(([head, body], i) => {
    const y = 2.5 + i * 1.28;
    disc(s, { x: M, y: y + 0.05, d: 0.62, label: i + 1 });
    s.addText(head, {
      x: M + 0.95, y, w: 10.6, h: 0.42,
      fontFace: SANS, fontSize: 21, bold: true, color: TEXT, valign: 'top', isTextBox: true, margin: 0,
    });
    s.addText(body, {
      x: M + 0.95, y: y + 0.44, w: 10.2, h: 0.62,
      fontFace: SANS, fontSize: 13.5, color: MUTED, lineSpacing: 19, valign: 'top', isTextBox: true, margin: 0,
    });
  });

  s.addText('Only then show the AI. Lead with the ledger and the AI becomes credible because it cannot act alone.', {
    x: M, y: 6.28, w: 11.4, h: 0.4,
    fontFace: SANS, fontSize: 13, bold: true, italic: true, color: GLOW, valign: 'top', isTextBox: true, margin: 0,
  });

  s.addNotes('Do all three live. If the room only remembers one thing, make it the tamper demo — it is the moment the product stops being a claim.');
}

// ======================================================= 6 · governed AI
{
  const s = slide({ ledger: 'aiAllowed:false on every decision event  ·  no mandate exceeds PROPOSE' });
  eyebrow(s, 'The AI, governed');
  title(s, 'Agents propose.\nA named human decides.', { h: 1.5 });

  s.addText(
    'Eighty-one agents read the project and raise work. Not one of them can approve anything — the event catalogue refuses an AI-authored approval outright, and no agent mandate exceeds PROPOSE.',
    { x: M, y: 2.2, w: 11.2, h: 0.75, fontFace: SANS, fontSize: 16, color: MUTED, lineSpacing: 23, isTextBox: true, margin: 0 },
  );

  const facts = [
    ['81', 'agents across every\ncapability area'],
    ['0', 'that can approve,\ncertify or sign'],
    ['100%', 'of AI spend priced\nbefore you commit'],
    ['Every', 'answer names its\nsources and its gaps'],
  ];
  const cw2 = 2.75, gap2 = 0.28;
  facts.forEach(([big, label], i) => {
    const x = M + i * (cw2 + gap2);
    card(s, { x, y: 3.3, w: cw2, h: 1.8 });
    s.addText(big, {
      x: x + 0.26, y: 3.5, w: cw2 - 0.52, h: 0.82,
      fontFace: SANS, fontSize: 46, bold: true, color: i === 1 ? SUCCESS : ORANGE, charSpacing: -1.5,
      valign: 'top', isTextBox: true, margin: 0,
    });
    // Closed up against the figure. The first render left a half-inch of dead
    // ground between the two, so the label read as belonging to nothing.
    s.addText(label, {
      x: x + 0.26, y: 4.32, w: cw2 - 0.52, h: 0.72,
      fontFace: SANS, fontSize: 13, color: MUTED, lineSpacing: 18, valign: 'top', isTextBox: true, margin: 0,
    });
  });

  s.addText('No AI action runs without showing its estimated cost first — and the wallet is prepaid, so it cannot run away with your money.', {
    x: M, y: 5.95, w: 11.4, h: 0.4,
    fontFace: SANS, fontSize: 13, bold: true, color: TEXT, valign: 'top', isTextBox: true, margin: 0,
  });

  s.addNotes('“AI in a safety-critical record? Absolutely not.” — Agreed. Then show them the catalogue refusing an AI-authored approval. This objection closes itself if you demo it.');
}

// ================================================ 7 · the second wedge: cash
{
  const s = slide({ dark: CORE, ledger: 'PAYMENT_CERTIFIED  ·  over-certification refused  ·  withholding requires a reason' });
  eyebrow(s, 'The second wedge');
  title(s, 'Compliance opens the door.\nCashflow closes the deal.', { h: 1.5 });

  s.addText(
    'Not every buyer cares about the Act. Every buyer cares about being paid. The statutory payment regime is date-driven and unforgiving, and the platform computes the dates rather than reminding you to.',
    { x: M, y: 2.25, w: 11.2, h: 0.75, fontFace: SANS, fontSize: 15.5, color: MUTED, lineSpacing: 22, isTextBox: true, margin: 0 },
  );

  const refusals = [
    ['Over-certification', 'refused'],
    ['Double certification', 'refused'],
    ['Overpayment', 'refused'],
    ['A withheld sum', 'must carry a reason'],
  ];
  refusals.forEach(([what, verdict], i) => {
    const y = 3.35 + i * 0.72;
    s.addShape(pres.ShapeType.rect, {
      x: M - 0.16, y: y - 0.08, w: 8.4, h: 0.62,
      fill: { color: i % 2 === 0 ? SLATE : CARBON }, line: { width: 0 },
    });
    s.addText(what, {
      x: M, y: y - 0.02, w: 4.0, h: 0.5,
      fontFace: SANS, fontSize: 16, bold: true, color: TEXT, valign: 'middle', isTextBox: true, margin: 0,
    });
    s.addText(verdict.toUpperCase(), {
      x: M + 4.1, y: y - 0.02, w: 3.9, h: 0.5,
      fontFace: MONO, fontSize: 13, bold: true, color: verdict === 'refused' ? CRITICAL : GLOW,
      charSpacing: 1.4, valign: 'middle', isTextBox: true, margin: 0,
    });
  });

  card(s, { x: M + 8.7, y: 3.27, w: 2.9, h: 2.9 });
  s.addText('“One disputed payment notice costs more than a year of the licence.”', {
    x: M + 8.95, y: 3.62, w: 2.4, h: 1.5,
    fontFace: SANS, fontSize: 15, bold: true, italic: true, color: TEXT, lineSpacing: 21,
    valign: 'top', isTextBox: true, margin: 0,
  });
  // Sits under the quote rather than at the foot of the card: an attribution
  // half an inch adrift of what it attributes reads as a separate note.
  s.addText('— the line that closes commercial directors', {
    x: M + 8.95, y: 5.02, w: 2.4, h: 0.55,
    fontFace: SANS, fontSize: 11, color: QUIET, lineSpacing: 15, valign: 'top', isTextBox: true, margin: 0,
  });

  s.addNotes('Use this slide when the room is commercial rather than technical. The Act gets you the meeting; this gets you the signature.');
}

// ================================================= 8 · what is actually built
{
  const s = slide({ ledger: 'zero runtime dependencies  ·  6,364 tests passing  ·  typecheck clean' });
  eyebrow(s, 'What is actually built');
  title(s, 'Not a roadmap.\nA running platform.', { h: 1.5 });

  const stats = [
    ['1,135', 'API routes', '777 writes, 358 reads — every one authorised server-side'],
    ['761', 'event types', 'A closed catalogue. Nothing writes a state the catalogue does not name'],
    ['11', 'lifecycle stages', 'Concept, design, tender, construction, commissioning, handover, thirty years of operation'],
    ['6,364', 'tests passing', 'Including invariants that fail the build if a screen or a door goes missing'],
  ];
  const cw3 = 2.75, gap3 = 0.28;
  stats.forEach(([big, label, note], i) => {
    const x = M + i * (cw3 + gap3);
    // Sized to what the cards actually hold. Once the text stopped floating in
    // the middle of its box, the surplus moved to the bottom of the card
    // instead — same defect, other end.
    card(s, { x, y: 2.5, w: cw3, h: 2.4 });
    s.addText(big, {
      x: x + 0.26, y: 2.72, w: cw3 - 0.52, h: 0.72,
      fontFace: SANS, fontSize: 40, bold: true, color: ORANGE, charSpacing: -1.4,
      valign: 'top', isTextBox: true, margin: 0,
    });
    s.addText(label.toUpperCase(), {
      x: x + 0.26, y: 3.42, w: cw3 - 0.52, h: 0.28,
      fontFace: SANS, fontSize: 11, bold: true, color: TEXT, charSpacing: 1.4, valign: 'top', isTextBox: true, margin: 0,
    });
    // The note follows its label rather than floating a third of an inch below
    // it, which is what left a visible dead band across all four cards.
    s.addText(note, {
      x: x + 0.26, y: 3.78, w: cw3 - 0.52, h: 1.4,
      fontFace: SANS, fontSize: 11.5, color: MUTED, lineSpacing: 16, valign: 'top', isTextBox: true, margin: 0,
    });
  });

  s.addText('Installs to the home screen. Works with no signal. The site diary is four fields.', {
    x: M, y: 5.95, w: 11.4, h: 0.4,
    fontFace: SANS, fontSize: 14, bold: true, color: GLOW, valign: 'top', isTextBox: true, margin: 0,
  });

  s.addNotes('“Our site teams won’t use it.” — This is the answer. Show the installed PWA on your own phone, in aeroplane mode, and capture a diary entry.');
}

// ================================================================ 9 · pricing
{
  const s = slide({ dark: CORE, ledger: 'per month  ·  cancel from the console  ·  your record exports as a signed, hash-verified event log' });
  eyebrow(s, 'Pricing');
  title(s, 'Start on one project.\nNot on a transformation programme.', { h: 1.5, size: 36 });

  const tiers = [
    ['Solo', '£100', '1 seat', 'Sole traders and single-project consultants', false],
    ['Core Project', '£950', '10 seats', 'SME contractors and pilot projects', true],
    ['Professional', '£2,200', '25 seats', 'Active contractors running multiple packages', false],
    ['Enterprise', '£6,500', 'Unlimited', 'Tier 1 and multi-portfolio, isolated tenancy', false],
  ];
  const cw4 = 2.75, gap4 = 0.28;
  tiers.forEach(([name, price, seats, who, featured], i) => {
    const x = M + i * (cw4 + gap4);
    card(s, { x, y: 2.6, w: cw4, h: 2.95, fill: featured ? RAISED : SLATE });
    if (featured) {
      s.addText('MOST START HERE', {
        x: x + 0.26, y: 2.78, w: cw4 - 0.52, h: 0.25,
        fontFace: SANS, fontSize: 9, bold: true, color: ORANGE, charSpacing: 1.6, valign: 'top', isTextBox: true, margin: 0,
      });
    }
    // Every row at the same y in all four cards. The first render offset the
    // featured card to make room for its label, so four prices sat on two
    // different lines — which reads as a mistake rather than as emphasis. The
    // space for the label is now reserved in all four; only one card fills it.
    s.addText(name, {
      x: x + 0.26, y: 3.06, w: cw4 - 0.52, h: 0.34,
      fontFace: SANS, fontSize: 15, bold: true, color: TEXT, valign: 'top', isTextBox: true, margin: 0,
    });
    s.addText(price, {
      x: x + 0.26, y: 3.42, w: cw4 - 0.52, h: 0.72,
      fontFace: SANS, fontSize: 36, bold: true, color: featured ? ORANGE : TEXT, charSpacing: -1.2,
      valign: 'top', isTextBox: true, margin: 0,
    });
    s.addText('per month', {
      x: x + 0.26, y: 4.1, w: cw4 - 0.52, h: 0.26,
      fontFace: SANS, fontSize: 11, color: QUIET, valign: 'top', isTextBox: true, margin: 0,
    });
    s.addText(seats, {
      x: x + 0.26, y: 4.4, w: cw4 - 0.52, h: 0.28,
      fontFace: SANS, fontSize: 12.5, bold: true, color: GLOW, valign: 'top', isTextBox: true, margin: 0,
    });
    s.addText(who, {
      x: x + 0.26, y: 4.74, w: cw4 - 0.52, h: 0.7,
      fontFace: SANS, fontSize: 11, color: MUTED, lineSpacing: 15, valign: 'top', isTextBox: true, margin: 0,
    });
  });

  s.addText('Site supervisor seats £70. Subcontractor access £25. AI is prepaid and priced before every run — never a surprise line on an invoice.', {
    x: M, y: 5.82, w: 11.4, h: 0.45,
    fontFace: SANS, fontSize: 13, color: MUTED, lineSpacing: 18, valign: 'top', isTextBox: true, margin: 0,
  });

  s.addNotes('“Too expensive for one project.” — Core Project is £950 a month. One disputed payment notice costs more than a year of it. Say the number without flinching.');
}

// ========================================================== 10 · the objection
{
  const s = slide({ ledger: 'export: signed, hash-verified event log  ·  escrow in the contract' });
  eyebrow(s, 'The two you will always be asked');
  title(s, 'Answered plainly.', { h: 0.9 });

  const qa = [
    ['“We already have Procore, Asite, Viewpoint.”',
     'Keep it. We are not your CDE. We are the governed record underneath it — and we can start on one building without touching the rest of your estate.'],
    ['“You are a startup. What if you disappear?”',
     'Your record exports at any time as a signed, hash-verified event log, and escrow is in the contract. You are not renting your compliance evidence from us.'],
  ];
  qa.forEach(([q, a], i) => {
    const y = 2.15 + i * 2.1;
    card(s, { x: M, y, w: W - M * 2, h: 1.78 });
    s.addText(q, {
      x: M + 0.4, y: y + 0.28, w: W - M * 2 - 0.8, h: 0.42,
      fontFace: SANS, fontSize: 19, bold: true, italic: true, color: QUIET, valign: 'top', isTextBox: true, margin: 0,
    });
    s.addText(a, {
      x: M + 0.4, y: y + 0.78, w: W - M * 2 - 0.8, h: 0.85,
      fontFace: SANS, fontSize: 15, color: TEXT, lineSpacing: 21, valign: 'top', isTextBox: true, margin: 0,
    });
  });

  s.addText('Built by Justin Nseya, MCIOB — from twenty years of meeting the same failure on project after project. It was not designed from a market gap.', {
    x: M, y: 6.4, w: 11.4, h: 0.45,
    fontFace: SANS, fontSize: 12.5, color: MUTED, lineSpacing: 17, valign: 'top', isTextBox: true, margin: 0,
  });

  s.addNotes('Do not bluff certifications. If asked about ISO 27001, say exactly where it stands and offer the pen test report. Bluffing here loses the deal at procurement, not in the room.');
}

// ================================================================= 11 · close
{
  const s = slide({ dark: CORE });

  s.addText('Fifteen minutes.\nYour project. Your record.', {
    x: M, y: 1.85, w: 10.5, h: 1.9,
    fontFace: SANS, fontSize: 48, bold: true, color: TEXT, charSpacing: -1.2, lineSpacing: 56,
    valign: 'top', isTextBox: true, margin: 0,
  });

  s.addText(
    'We will take one of your buildings, stand the record up in front of you, alter it on purpose, and let the platform catch us.',
    { x: M, y: 3.95, w: 9.2, h: 0.85, fontFace: SANS, fontSize: 17, color: MUTED, lineSpacing: 25, isTextBox: true, margin: 0 },
  );

  s.addShape(pres.ShapeType.roundRect, {
    x: M, y: 5.05, w: 3.5, h: 0.72, rectRadius: 0.06,
    fill: { color: ORANGE }, line: { width: 0 },
    shadow: { type: 'outer', color: '000000', blur: 16, offset: 5, angle: 90, opacity: 0.5 },
  });
  s.addText('construxvg.com', {
    x: M, y: 5.05, w: 3.5, h: 0.72,
    fontFace: SANS, fontSize: 17, bold: true, color: CORE, align: 'center', valign: 'middle',
    isTextBox: true, margin: 0,
  });

  s.addText('contact@construxvg.com', {
    x: M + 3.85, y: 5.05, w: 4.0, h: 0.72,
    fontFace: SANS, fontSize: 15, color: TEXT, valign: 'middle', isTextBox: true, margin: 0,
  });

  s.addText([
    { text: 'CONSTRU', options: { color: QUIET } },
    { text: 'X', options: { color: ORANGE } },
  ], {
    x: M, y: 6.35, w: 6.0, h: 0.4,
    fontFace: SANS, fontSize: 16, bold: true, charSpacing: 5, valign: 'top', isTextBox: true, margin: 0,
  });

  s.addNotes('Ask for the building, not for the meeting. A named building turns a demo into a pilot, and a pilot is the only thing that converts here.');
}

const out = process.argv[2] ?? 'docs/go-to-market/brand/CONSTRUX-sales-deck.pptx';
await pres.writeFile({ fileName: out });
console.log(`wrote ${out}`);
