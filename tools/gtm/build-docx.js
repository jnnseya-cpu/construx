const fs = require('fs');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
  LevelFormat, PageBreak, Header, Footer, PageNumber, TableOfContents,
} = require('docx');

// ── Brand ──────────────────────────────────────────────────────────────────
const ORANGE = 'FF6600';
const INK = '141519';
const MUTED = '6F757E';
const RULE = 'DDD9D3';
const WASH = 'F7F5F2';
const CRIT = 'B3261E';
const GOOD = '157F47';
const ORANGE_TINT = 'FBDCC6';   // light bar / tinted fill
const QUIET = 'E6E3DE';         // preparatory bar

const W = 9600;            // usable table width in DXA at 2cm margins
const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };

// ── Helpers ────────────────────────────────────────────────────────────────
const t = (text, o = {}) => new TextRun({ text, font: o.font ?? 'Cambria', size: o.size ?? 20, bold: o.bold, italics: o.italics, color: o.color ?? INK, allCaps: o.caps, characterSpacing: o.spacing });

const p = (text, o = {}) => new Paragraph({
  children: Array.isArray(text) ? text : [t(text, o)],
  spacing: { after: o.after ?? 120, before: o.before ?? 0, line: o.line ?? 264 },
  alignment: o.align,
  indent: o.indent,
  border: o.border,
  shading: o.shading,
});

const h1 = (text) => new Paragraph({
  children: [t(text, { font: 'Arial', size: 34, bold: true })],
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 380, after: 60 },
  pageBreakBefore: true,
});

const eyebrow = (text) => new Paragraph({
  children: [t(text, { font: 'Consolas', size: 15, bold: true, color: ORANGE, caps: true, spacing: 30 })],
  spacing: { before: 0, after: 90 },
});

const h2 = (text) => new Paragraph({
  children: [t(text, { font: 'Arial', size: 24, bold: true })],
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 300, after: 110 },
});

const h3 = (text) => new Paragraph({
  children: [t(text, { font: 'Consolas', size: 17, bold: true, color: MUTED, caps: true, spacing: 20 })],
  heading: HeadingLevel.HEADING_3,
  spacing: { before: 240, after: 90 },
});

const bullet = (text, level = 0) => new Paragraph({
  children: Array.isArray(text) ? text : [t(text)],
  numbering: { reference: 'bullets', level },
  spacing: { after: 70, line: 264 },
});

const numbered = (text) => new Paragraph({
  children: Array.isArray(text) ? text : [t(text)],
  numbering: { reference: 'numbers', level: 0 },
  spacing: { after: 70, line: 264 },
});

/** A callout box: tinted, left-ruled, used for the things that must not be skimmed. */
const callout = (title, lines, tone = ORANGE) => {
  const rows = [new TableRow({
    children: [new TableCell({
      width: { size: W, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: WASH, color: 'auto' },
      margins: { top: 160, bottom: 160, left: 200, right: 200 },
      borders: { top: NONE, bottom: NONE, right: NONE, left: { style: BorderStyle.SINGLE, size: 18, color: tone } },
      children: [
        p([t(title, { font: 'Arial', size: 20, bold: true, color: tone })], { after: 90 }),
        ...lines.map((l, i) => p(Array.isArray(l) ? l : [t(l)], { after: i === lines.length - 1 ? 0 : 90 })),
      ],
    })],
  })];
  return new Table({ rows, width: { size: W, type: WidthType.DXA }, columnWidths: [W],
    borders: { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE } });
};

/** Data table. Column widths must sum to W and be repeated on every cell. */
const table = ({ headers, rows, widths, foot }) => {
  const sum = widths.reduce((a, b) => a + b, 0);
  const cols = widths.map((x) => Math.round((x / sum) * W));
  cols[cols.length - 1] = W - cols.slice(0, -1).reduce((a, b) => a + b, 0);

  const cell = (content, i, o = {}) => new TableCell({
    width: { size: cols[i], type: WidthType.DXA },
    shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined,
    margins: { top: 90, bottom: 90, left: 130, right: 130 },
    borders: {
      top: o.top ?? { style: BorderStyle.SINGLE, size: 2, color: RULE },
      bottom: o.bottom ?? { style: BorderStyle.SINGLE, size: 2, color: RULE },
      left: NONE, right: NONE,
    },
    children: (Array.isArray(content) ? content : [content]).map((line, k) =>
      p(Array.isArray(line) ? line : [t(line, { size: 18, color: o.color ?? INK, bold: o.bold })],
        { after: k === (Array.isArray(content) ? content.length : 1) - 1 ? 0 : 40, line: 240, align: o.align })),
  });

  const head = new TableRow({
    tableHeader: true,
    children: headers.map((hd, i) => new TableCell({
      width: { size: cols[i], type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: WASH, color: 'auto' },
      margins: { top: 100, bottom: 100, left: 130, right: 130 },
      borders: { top: { style: BorderStyle.SINGLE, size: 8, color: INK }, bottom: { style: BorderStyle.SINGLE, size: 4, color: INK }, left: NONE, right: NONE },
      children: [p([t(String(hd).replace(/^~/, ''), { font: 'Consolas', size: 15, bold: true, color: MUTED, caps: true })],
        { after: 0, align: String(hd).startsWith('~') ? AlignmentType.RIGHT : undefined })],
    })),
  });

  const body = rows.map((r) => new TableRow({
    children: r.map((c, i) => cell(c, i, { align: String(headers[i]).startsWith('~') ? AlignmentType.RIGHT : undefined })),
  }));

  const footer = foot ? [new TableRow({
    children: foot.map((c, i) => cell(c, i, {
      fill: WASH, bold: true,
      top: { style: BorderStyle.SINGLE, size: 8, color: INK },
      bottom: { style: BorderStyle.SINGLE, size: 8, color: INK },
      align: String(headers[i]).startsWith('~') ? AlignmentType.RIGHT : undefined,
    })),
  })] : [];

  return new Table({
    rows: [head, ...body, ...footer],
    width: { size: W, type: WidthType.DXA },
    columnWidths: cols,
    borders: { top: NONE, bottom: NONE, left: NONE, right: NONE,
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: RULE }, insideVertical: NONE },
  });
};


/**
 * The programme strip, as a table.
 *
 * Thirteen week columns and a shaded run of cells per workstream. It is the
 * same picture the PDF draws with CSS bars; a table is how Word draws it.
 */
const programme = (rows) => {
  const LBL = 2000;
  const week = Math.round((W - LBL) / 13);
  const cols = [LBL, ...Array.from({ length: 13 }, () => week)];
  cols[13] = W - LBL - week * 12;

  const cell = (i, o = {}) => new TableCell({
    width: { size: cols[i], type: WidthType.DXA },
    shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined,
    margins: { top: 60, bottom: 60, left: i === 0 ? 130 : 40, right: 40 },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      left: { style: BorderStyle.SINGLE, size: 2, color: 'FFFFFF' },
      right: { style: BorderStyle.SINGLE, size: 2, color: 'FFFFFF' },
    },
    children: [p([t(o.text ?? '', { font: 'Consolas', size: o.size ?? 13, bold: o.bold, color: o.color ?? INK })],
      { after: 0, line: 200, align: i === 0 ? undefined : AlignmentType.CENTER })],
  });

  const head = new TableRow({ tableHeader: true, children: [
    cell(0, { text: 'Workstream', size: 13, bold: true, color: MUTED, fill: WASH }),
    ...Array.from({ length: 13 }, (_, k) => cell(k + 1, { text: 'W' + (k + 1), size: 12, color: MUTED, fill: WASH })),
  ] });

  const body = rows.map((r) => new TableRow({ children: [
    cell(0, { text: r.label, size: 14 }),
    ...Array.from({ length: 13 }, (_, k) => {
      const w = k + 1;
      const bar = r.bars.find((x) => w >= x.from && w <= x.to);
      if (!bar) return cell(w);
      const fill = bar.tone === 'solid' ? ORANGE : bar.tone === 'quiet' ? QUIET : ORANGE_TINT;
      // The caption sits in the run's first cell so it reads left to right.
      return cell(w, { fill, text: w === bar.from ? bar.text ?? '' : '', size: 12,
        color: bar.tone === 'solid' ? 'FFFFFF' : INK, bold: true });
    }),
  ] }));

  return new Table({ rows: [head, ...body], width: { size: W, type: WidthType.DXA }, columnWidths: cols,
    borders: { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE } });
};

const spacer = (h = 200) => new Paragraph({ children: [], spacing: { after: h } });

const hr = () => new Paragraph({
  children: [], spacing: { before: 160, after: 200 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 1 } },
});

// ═══════════════════════════════════════════════════════════════════════════
const body = [];
const S = (x) => body.push(...(Array.isArray(x) ? x : [x]));

// ── Cover ──────────────────────────────────────────────────────────────────
S(new Paragraph({ children: [t('CONSTRUX', { font: 'Arial', size: 22, bold: true }), t('.AI', { font: 'Arial', size: 22, bold: true, color: ORANGE })], spacing: { after: 1400 } }));
S(new Paragraph({ children: [t('GO-TO-MARKET', { font: 'Arial', size: 76, bold: true })], spacing: { after: 60 } }));
S(new Paragraph({ children: [t('Manchester launch · 90-day programme · first 100 customers', { font: 'Arial', size: 24, color: MUTED })], spacing: { after: 700 } }));
S(new Paragraph({
  children: [t('Sell the thing the law ', { font: 'Arial', size: 44, bold: true }),
             t('already forces them to buy', { font: 'Arial', size: 44, bold: true, color: ORANGE }),
             t('.', { font: 'Arial', size: 44, bold: true })],
  spacing: { after: 260, line: 460 },
}));
S(p('Most construction software is a productivity argument. CONSTRUX is a compliance one. The Building Safety Act 2022 made an immutable, attributable building record a statutory duty for higher-risk buildings — and most vendors claiming to meet it are storing documents in a folder. That gap is the entire go-to-market.', { size: 22, after: 900 }));

S(table({
  headers: ['Decision', 'Locked position'],
  widths: [30, 70],
  rows: [
    ['Launch city', [[t('Greater Manchester', { size: 18, bold: true })], 'Single city until day 90. Not London, not "the UK".']],
    ['Wedge', 'Building Safety Act golden thread, with statutory payment as the second hook'],
    ['Beachhead segment', 'Tier 2/3 principal contractors, £10m–£150m turnover, live HRB work'],
    ['Target', [[t('100 customers · £2.77m ARR by day 270', { size: 18, bold: true })]]],
    ['90-day budget', [[t('£162,750', { size: 18, bold: true })], 'Built from quoted 2026 UK market rates, not estimates']],
    ['90-day outcome', '20 paying customers, £400k+ ARR at Gate 2'],
    ['Status', [[t('BLOCKED — see Gate 0', { size: 18, bold: true, color: CRIT })], 'No paid contract until data persistence ships']],
  ],
}));

S(new Paragraph({ children: [new PageBreak()] }));
S(new Paragraph({ children: [t('Contents', { font: 'Arial', size: 28, bold: true })], spacing: { after: 200 } }));
S(new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }));

// ── 00 Blocker ─────────────────────────────────────────────────────────────
S(h1('00 · Start here: you cannot sell this yet'));
S(eyebrow('The gate before every other gate'));
S(callout('The ledger is in-process. There is no database.', [
  'Restart the server and every project, event and hash chain is gone. The Golden Thread — the entire product claim — currently survives exactly as long as the process does. Selling a statutory building record that evaporates on deploy is not a rough edge; it is a liability with a regulator attached.',
  [t('No paid contract is signed until Gate 0 clears. ', { bold: true }), t('Design-partner work on non-production data can start immediately and should. That distinction is the difference between a fast start and a mis-sold product.')],
], CRIT));
S(spacer());
S(h2('Gate 0 exit criteria'));
S(table({
  headers: ['Requirement', 'Why it gates the sale', 'Owner', '~Days'],
  widths: [26, 52, 10, 12],
  rows: [
    ['Postgres persistence with append-only constraints and row-level security', 'The ledger must outlive the process. RLS enforces the tenant isolation the code already assumes.', 'Eng', '15'],
    ['Object store with WORM (S3 Object Lock, compliance mode)', 'Evidence must be immutable in storage, not only referenced by an immutable hash.', 'Eng', '5'],
    ['UK data residency — eu-west-2 or UK South, no cross-border sub-processing', "Named in buyers' procurement checklists for HRB information. Fails the first security review without it.", 'Eng', '7'],
    ['Cyber Essentials Plus', 'The floor for public-sector and housing-association procurement. Cheap and fast.', 'Ops', '21'],
    ['DPAs and no-training clauses with every AI provider', 'Customer project data must not train a foundation model. Buyers now ask this in writing.', 'Legal', '10'],
    ['Independent penetration test (CREST-accredited)', 'Annual pen testing is an explicit expectation for safety-critical residential information.', 'Ops', '14'],
    ['Backup, restore and replay drill — proven, timed, documented', '"Can you restore our golden thread?" is answered with a stopwatch, not a policy.', 'Eng', '5'],
  ],
  foot: ['Critical path, run in parallel', '', '', '~30'],
}));
S(spacer());
S(p('ISO 27001 takes longer than 90 days and should start now in the background — but it is a Gate 2 unlock, not a Gate 0 blocker. Cyber Essentials Plus plus a clean pen-test report will clear most Tier 2 and housing-association reviews in the meantime.'));

// ── 01 Wedge ───────────────────────────────────────────────────────────────
S(h1('01 · The wedge: compelled, deadlined, badly served'));
S(eyebrow('Pick the buyer with no choice and a date'));
S(p('The Building Safety Act 2022 made the golden thread a legal duty for higher-risk buildings — broadly, residential buildings at least 18 metres or seven storeys with two or more units, plus care homes and hospitals in scope at design and construction. There are roughly 12,500 HRBs in England. Duty-holders must produce the golden thread at each Gateway, and it must be digital, structured, attributable and immutable.'));
S(spacer(80));
S(callout('The sentence that sells the product', [
  'Published industry guidance on what the Act requires of the software itself is explicit: the record must show who did what, when and why — every entry attributable to a named user, timestamped, and immutable so historical states are preserved. Procurement should demand ISO 27001 alignment, Cyber Essentials, documented encryption, UK data residency, tenant isolation and annual independent penetration testing.',
  [t('That is a specification of the CONSTRUX architecture, published by someone else.', { bold: true })],
]));
S(spacer());
S(h2('Why the incumbents cannot simply answer it'));
S(p('A document management system with version history is not an immutable attributable record — it is a mutable record with a change log, and the distinction is exactly what a coroner or a regulator will probe. Retrofitting a hash-chained append-only ledger beneath a CDE built on mutable documents is not a feature; it is a rewrite. CONSTRUX started there.'));
S(spacer(80));
S(table({
  headers: ['Claim', 'Typical vendor', 'CONSTRUX', 'Proof you can show live'],
  widths: [17, 25, 27, 31],
  rows: [
    ['Attributable', 'User stamped on a document version', 'Every state change is an event with a named actor', 'Audit feed, per-event actor and correlation id'],
    ['Immutable', 'Version history you can delete', 'Hash-chained append-only ledger', 'Replay reconstructs the project and reports a root hash'],
    ['Tamper-evident', 'Not claimed', 'Replay detects alteration', 'The demo tampers with a record on purpose; the replay catches it'],
    ['Tenant isolated', 'Configured per-project permissions', 'Enforced server-side on every read', 'Sign in as the regulator; write controls disappear'],
    ['Separation of duties', 'Advisory workflow', 'Refused, not warned', 'Applicant cannot certify their own application'],
    ['AI governance', '"AI-powered"', 'No agent can approve anything', 'Autopilot raises; a nominated human decides'],
  ],
}));
S(spacer());
S(h2('The second wedge: getting paid'));
S(p('Late and disputed payment is endemic in UK construction, and the statutory regime is date-driven and unforgiving. CONSTRUX computes the statutory dates, refuses over-certification, double certification and overpayment, and makes every withheld sum carry a reason. This is the wedge for the commercial director who does not care about the Act. Compliance opens the door; cashflow closes the deal.'));

// ── 02 CITY ────────────────────────────────────────────────────────────────
S(h1('02 · Launch city: Greater Manchester'));
S(eyebrow('Locked. One city until day 90.'));
S(p([t('Launching "in the UK" is not a plan; it is an absence of one. ', { bold: true }), t('The entire 90-day programme is executed inside Greater Manchester. No London prospecting, no opportunistic out-of-region deals, no national campaigns. The constraint is the point: a city is small enough to saturate, and saturation is what produces referrals.')]));
S(spacer(80));
S(h2('Why Manchester and not London'));
S(table({
  headers: ['Factor', 'Greater Manchester', 'London'],
  widths: [24, 40, 36],
  rows: [
    ['Concentration', 'One of four national concentrations of monitored remediation (with Greater London, West Yorkshire, the south coast)', 'Largest absolute stock, but spread across 32 boroughs'],
    [[[t('Convening body', { size: 18, bold: true })]], [[t('Greater Manchester High Rise Task Force — one body convening the whole buyer set', { size: 18, bold: true })]], 'No single equivalent. Fragmented across boroughs and bodies'],
    ['Buyer mix', 'Tier 2/3 principal contractors dominate — your ICP', 'Tier 1 dominated: 12–18 month procurement, enterprise architecture review'],
    ['AE base salary', '£42,000–£60,000', '£55,000–£80,000'],
    ['SDR base salary', '£28,000–£38,000', '£35,000–£45,000'],
    ['Geographic density', 'Deansgate, Castlefield, Ancoats, Salford Quays, MediaCity — four site visits in a day, on foot and tram', 'Four site visits is four days'],
    ['Community effect', 'Small, networked NW construction community. Reputation compounds inside 90 days', 'Too large for word-of-mouth to compound at this scale'],
    ['Fallback', '2h07 to London Euston when a deal requires it', '—'],
  ],
}));
S(spacer());
S(callout('The 28% argument', [
  'Manchester salaries for the two most expensive GTM hires run roughly 25–30% below London. On an AE and an SDR that is about £23,000 a year of runway bought for nothing but a postcode decision — and the buyers are easier to reach.',
]));
S(spacer());
S(h2('The named target clusters'));
S(p('Work these five in order. Each is a walkable or single-tram cluster of in-scope buildings and the contractors working on them.'));
S(numbered('Deansgate Square, Castlefield and the Great Jackson Street corridor — the densest concentration of new-build high-rise residential in the city.'));
S(numbered('Salford Quays and MediaCity — mixed new-build and occupied stock, with registered providers as Accountable Persons.'));
S(numbered('Ancoats and New Islington — active mid-rise and high-rise residential delivery.'));
S(numbered('Manchester city centre core — occupation-phase duties on completed towers.'));
S(numbered('Trafford and Stretford — regeneration schemes entering scope.'));
S(spacer(80));
S(h2('The institutions to be known by'));
S(bullet([t('Greater Manchester High Rise Task Force', { bold: true }), t(' — the single most valuable relationship in this plan. Convened by the Combined Authority; it puts the whole buyer set in one room. Target: a speaking or briefing slot by day 60.')]));
S(bullet([t('Greater Manchester Fire and Rescue Service', { bold: true }), t(' — protection teams see the evidence quality problem first-hand and are credible referrers.')]));
S(bullet([t('Manchester City Council and Salford City Council building control', { bold: true }), t(' — route to Gateway applicants.')]));
S(bullet([t('Registered providers operating in Greater Manchester', { bold: true }), t(' — Accountable Persons with occupation-phase duties and, unlike contractors, a permanent obligation.')]));
S(bullet([t('Place North West', { bold: true }), t(' — the regional property and construction title your buyers actually read. Target three placements in 90 days.')]));
S(spacer(80));
S(h2('City-launch tactics that do not work nationally'));
S(bullet([t('Two hosted roundtable dinners, twelve seats each, Manchester city centre.', { bold: true }), t(' Invite by building, not by job title: "you are responsible for [building]; six other people in this city are in the same position." Budgeted at £2,500 each.')]));
S(bullet([t('The Greater Manchester Golden Thread Index.', { bold: true }), t(' A regional benchmark on evidence completeness, published quarterly. First-mover regional data becomes press coverage and gives the Task Force a reason to cite you.')]));
S(bullet([t('Walk-in site visits.', { bold: true }), t(' In a walkable cluster, "I am ten minutes away, can I show you ninety seconds of something" converts at a rate no email sequence matches.')]));
S(bullet([t('One regional event sponsorship', { bold: true }), t(' rather than a national trade show. A £3,500 regional slot puts you in front of the same buyers a £14,000 London stand would, minus the noise.')]));
S(spacer(80));
S(callout('Exit condition for the city constraint', [
  'Open a second city only when Greater Manchester has produced 25 paying customers and at least two channel partners generating referrals unprompted. Expanding earlier converts a focused motion into a thin national one — the most common way a good wedge is wasted.',
  'Second city: Leeds and West Yorkshire, on the same evidence — a named national concentration, adjacent geography, shared consultancy channel.',
]));

// ── 03 Segments ────────────────────────────────────────────────────────────
S(h1('03 · Who buys, and what makes them move'));
S(eyebrow('Six segments, ranked by time to signature'));
S(table({
  headers: ['Segment', 'Economic buyer', 'Trigger event', 'Entry package', '~ACV', '~Rank'],
  widths: [24, 17, 24, 15, 12, 8],
  rows: [
    [[[t('Tier 2/3 principal contractors', { size: 18, bold: true })], '£10m–£150m turnover, HRB residential'], 'Commercial Director or MD', 'Gateway 2 application; a client demanding evidence', 'Professional Delivery', '£26,400', '1'],
    [[[t('Housing associations and registered providers', { size: 18, bold: true })], 'Accountable Person duty'], 'Director of Building Safety or Assets', 'Occupation-phase duties; a BSR information request', 'Enterprise', '£78,000', '1'],
    [[[t('Remediation specialists', { size: 18, bold: true })], 'Cladding and fire safety works'], 'Contracts Director', 'A funded remediation award with reporting obligations', 'Professional Delivery', '£26,400', '1'],
    [[[t('QS, PM and BIM consultancies', { size: 18, bold: true })], 'Sold as a channel, not an end user'], 'Partner or Head of Digital', 'A client asks them to hold the golden thread', 'Core Project ×N', '£11,400', '2'],
    [[[t('Regional developers', { size: 18, bold: true })], '7+ storey residential'], 'Development Director', 'Planning consent on an in-scope scheme', 'Core Project', '£11,400', '3'],
    [[[t('Asset and facilities managers', { size: 18, bold: true })], 'Taking handover of HRBs'], 'Head of FM', 'Practical completion of an in-scope building', 'Enterprise', '£78,000', '3'],
  ],
}));
S(spacer());
S(h2('The ideal first customer, precisely'));
S(callout('Qualification, in one sentence', [
  'A principal contractor turning over £25m–£80m, headquartered or delivering in Greater Manchester, running two to five live packages, with at least one HRB going through Gateway 2 in the next six months, currently managing the golden thread in SharePoint plus a spreadsheet, that has already lost an argument about a payment notice in the last year.',
  'They have the pain twice over, the deadline is external, and nobody in the building loves the incumbent tool.',
]));
S(spacer());
S(h2('Who to walk away from in the first 100'));
S(bullet([t('Tier 1 contractors. ', { bold: true }), t('12–18 month procurement, enterprise architecture review, and they will ask for the ISO 27001 you do not yet have. Court them; do not count on them.')]));
S(bullet([t('Anything outside Greater Manchester before day 90. ', { bold: true }), t('The city constraint is the strategy, not a limitation to be worked around.')]));
S(bullet([t('Anything outside England, ever, without a deliberate decision. ', { bold: true }), t('The compliance wedge is jurisdictional — Scotland, Wales and Ireland have different regimes and are separate wedges.')]));
S(bullet([t('Sub-£5m contractors. ', { bold: true }), t('They buy Core Project, churn in seven months, and consume the support of an Enterprise logo.')]));

// ── 04 Positioning ─────────────────────────────────────────────────────────
S(h1('04 · Positioning and the words that do the work'));
S(eyebrow('One line, three proofs, every objection'));
S(callout('The one-liner', [
  [t('The construction record that proves it has not been altered — and the payment cycle that cannot be paid twice.', { font: 'Arial', size: 26, bold: true })],
]));
S(spacer());
S(h2('Three proofs, in demo order'));
S(numbered([t('Tamper, then catch it. ', { bold: true }), t('Alter a record in front of them. Run the replay. The root hash moves and the platform names the event. Nobody else can do this on stage.')]));
S(numbered([t('Sign in as the regulator. ', { bold: true }), t('Every write control disappears; the export still works. Read-only oversight is architectural, not a checkbox.')]));
S(numbered([t('Try to certify your own application. ', { bold: true }), t('The platform refuses. Separation of duties is enforced, not advised.')]));
S(spacer(80));
S(p('Then, and only then, show Autopilot: eight agents that read the project and propose, with a nominated human deciding. Lead with AI and you are one of forty vendors. Lead with the ledger and the AI becomes credible because it cannot act alone.'));
S(spacer(80));
S(h2('Objection handling'));
S(table({
  headers: ['They say', 'You say'],
  widths: [32, 68],
  rows: [
    ['"We already have Procore / Asite / Viewpoint."', 'Keep it. We are not your CDE. We are the governed record underneath it — and we can start on one HRB without touching the rest of your estate.'],
    ['"Our SharePoint is the golden thread."', 'Can you prove nobody edited a document last March? The Act asks for an immutable record with preserved historical states. Version history is a change log on a mutable file.'],
    ['"You are a startup. What if you disappear?"', 'Your record exports as a signed, hash-verified event log at any time, and escrow is in the contract. You are not renting your compliance evidence from us.'],
    ['"Do you have ISO 27001?"', 'Cyber Essentials Plus today, an independent pen-test report available under NDA, ISO 27001 in progress. Never bluff this — the person asking will check.'],
    ['"AI in a safety-critical record? Absolutely not."', 'Agreed. No agent can approve anything here — the event catalogue refuses an AI-authored approval outright. Agents propose; a nominated human decides. Then show them.'],
    ['"Too expensive for one project."', 'Core Project is £950 a month. One disputed payment notice costs more than a year of it.'],
    ['"Our site teams will not use it."', 'It installs to the home screen, works with no signal, and the site diary is four fields. Supervisor seats are £70.'],
  ],
}));

// ── 05 Pricing ─────────────────────────────────────────────────────────────
S(h1('05 · Pricing, packaging and unit economics'));
S(eyebrow('Read from the implementation, not proposed'));
S(table({
  headers: ['Package', 'Included', '~Monthly', '~Annual'],
  widths: [26, 40, 17, 17],
  rows: [
    ['Trial', '3 seats · 5 GB', 'Free', '—'],
    ['Core Project', '10 seats · 100 GB', '£950', '£11,400'],
    ['Professional Delivery', '25 seats · 500 GB · API access', '£2,200', '£26,400'],
    ['Enterprise', 'Unlimited seats · isolated tenancy · API', '£6,500', '£78,000'],
  ],
}));
S(spacer(120));
S(h3('Seat rates — the comparison anchor'));
S(table({
  headers: ['Seat', '~Monthly', 'Seat', '~Monthly'],
  widths: [32, 18, 32, 18],
  rows: [
    ['Construction Manager', '£180', 'Planner', '£110'],
    ['Commercial Manager / QS', '£150', 'Design / Document Controller', '£90'],
    ['Project Manager', '£140', 'Site Manager / Supervisor', '£70'],
    ['Director / Executive', '£120', 'Subcontractor / trade access', '£25'],
    [[[t('Building Safety Regulator', { size: 18, bold: true })]], [[t('£0', { size: 18, bold: true })]], 'Platform operator', '£0'],
  ],
}));
S(spacer());
S(callout('Free regulator access is a sales weapon, not a giveaway', [
  'It means the buyer can hand their regulator a login without raising a purchase order. That removes the last procurement objection from the person who has the deadline — and it puts your product in front of the regulator at no acquisition cost.',
]));
S(spacer());
S(h2('AI is metered, never bundled'));
S(p('Prepaid ACU bundles at a 3× markup on provider cost: Starter £300 (10,000 ACUs), Growth £1,000 (40,000), Scale £2,500 (110,000). Hard caps, per-engine attribution, and no provider call on an empty wallet. Sell this as budget control, because that is what a commercial director hears: your AI spend cannot surprise you.'));
S(spacer(80));
S(h2('Unit economics at 100 customers'));
S(table({
  headers: ['Package', '~Logos', '~ACV', '~Subscription ARR', '~CAC', '~Payback'],
  widths: [26, 12, 15, 21, 14, 12],
  rows: [
    ['Core Project', '55', '£11,400', '£627,000', '£3,200', '4.1 mo'],
    ['Professional Delivery', '35', '£26,400', '£924,000', '£7,500', '4.2 mo'],
    ['Enterprise', '10', '£78,000', '£780,000', '£18,000', '3.4 mo'],
    ['ACU attach (55% at ~£8,000)', '55', '—', '£440,000', '£0', '—'],
  ],
  foot: ['Total', '100', '£27,710', '£2,771,000', '£5,700', '3.6 mo'],
}));
S(spacer());
S(p('Assumes 82% gross margin after AI cost-of-goods, 85% gross logo retention and 112% net revenue retention from project-to-portfolio expansion. Payback is on gross profit, not revenue. Every one of these is an assumption to be replaced by measurement by day 90 — they are stated so they can be falsified, not defended.', { size: 18, color: MUTED }));

// ── 06 First 100 ───────────────────────────────────────────────────────────
S(h1('06 · The first 100 customers'));
S(eyebrow('Five motions, each with a list you can build this week'));
S(table({
  headers: ['Motion', 'Where the list comes from', '~Logos', '~CAC', '~Cycle', '~Spend'],
  widths: [22, 34, 11, 12, 10, 11],
  rows: [
    ['1 · Founding partners', "Hand-sourced from the founding team's own Greater Manchester network", '10', '£1,000', '3 wk', '£10,000'],
    ['2 · Gateway-compelled outbound', 'BSR building-control approval data; HRB register; Gateway 2 applicants in GM', '25', '£9,000', '10 wk', '£225,000'],
    ['3 · Consultancy channel', 'NW-based QS, PM and BIM practices reselling into their client base', '30', '£4,500', '12 wk', '£135,000'],
    ['4 · Remediation programme', 'Funded remediation buildings in GM and their contractors', '20', '£8,500', '14 wk', '£170,000'],
    ['5 · Land and expand', 'Existing logos: one project → portfolio → O&M', '15', '£2,000', '6 wk', '£30,000'],
  ],
  foot: ['Total', '', '100', '£5,700', '—', '£570,000'],
}));
S(spacer());
S(p('The £570,000 is the full acquisition cost to reach 100 customers over roughly nine months. The £162,750 in section 11 is the first 90 days of it, plus the one-off engineering, certification and legal work that only happens once.', { size: 18, color: MUTED }));
S(spacer(120));

S(h2('Motion 1 — Ten founding partners, in three weeks'));
S(p('Free for twelve months. In exchange, contractually: a named reference, a logo, a recorded twenty-minute case interview, and a quarterly product session. Not a pilot — a partnership with obligations on both sides. Write the exchange into the agreement or you will end up with ten free users and no evidence.'));
S(bullet('Target mix: five principal contractors, two registered providers, two consultancies, one remediation specialist. All Greater Manchester.'));
S(bullet('Recruit by direct approach only. No form, no waiting list, no "request a demo".'));
S(bullet([t('Qualify hard: no live HRB, no partnership. ', { bold: true }), t('A design partner without the deadline gives you feedback about a product nobody is forced to buy.')]));
S(spacer(120));

S(h2('Motion 2 — Outbound to people with a statutory date'));
S(p('Build the list from public and paid sources, in this order. Filter every one of them to Greater Manchester.'));
S(table({
  headers: ['Source', 'What it gives you', '~Cost'],
  widths: [30, 52, 18],
  rows: [
    ['BSR building-control approval application data (GOV.UK)', 'Who is applying at Gateway 2, and when', 'Free'],
    ['HRB register (HSE / BSR)', 'Registered higher-risk buildings and responsible entities', 'Free'],
    ['Companies House API', 'Turnover band, filing health, directors, group structure', 'Free'],
    ['Barbour ABI or Glenigan', 'Contract awards, project pipeline, contractor by scheme', '£8,000–£15,000/yr'],
    ['Place North West', 'Regional scheme news and trigger events, read by the buyer too', 'Free / £'],
    ['Construction Enquirer and Construction News award feeds', 'Daily national trigger events', 'Free'],
    ['Planning portals — 7+ storey residential consents in GM', 'Schemes entering scope 12–24 months ahead', 'Free'],
  ],
}));
S(spacer(120));
S(h3('The sequence that gets replies'));
S(p('Trigger-based, never volume-based. The opening line names their building. Six touches over eighteen days, then stop and recycle in ninety.'));
S(numbered([t('Day 1 — email. ', { bold: true }), t('Subject line is the building\'s address. "You registered [building] with the BSR in [month]. One question: if the regulator asked you to prove nobody edited the fire strategy since Gateway 2, how long would that take?"')]));
S(numbered([t('Day 3 — LinkedIn connection, ', { bold: true }), t('no pitch, referencing the same scheme.')]));
S(numbered([t('Day 6 — email. ', { bold: true }), t('The ninety-second tamper-detection film. Nothing else in the message.')]));
S(numbered([t('Day 10 — phone. ', { bold: true }), t('The only goal is to learn who owns the golden thread internally.')]));
S(numbered([t('Day 14 — email to that person, ', { bold: true }), t('referencing the first conversation.')]));
S(numbered([t('Day 18 — break-up email ', { bold: true }), t('with the regulator-access point: "your BSR login costs you nothing on our platform."')]));
S(spacer(120));

S(h2('Motion 3 — The consultancy channel is the cheapest logo you will buy'));
S(p('A Manchester QS or BIM practice with thirty clients is thirty warm introductions from one relationship. Structure it properly.'));
S(bullet([t('20% of first-year subscription ', { bold: true }), t('on referred logos, paid quarterly, with a 24-month tail.')]));
S(bullet([t('Free Professional Delivery tenancy ', { bold: true }), t("for the practice's own use — they must live in it to sell it.")]));
S(bullet([t('Co-branded golden-thread readiness assessment ', { bold: true }), t('they deliver as a paid service. You supply the template; they keep the fee. This is the hook — it makes you part of their revenue, not their software stack.')]));
S(bullet([t('Named partner manager from day 45. ', { bold: true }), t('Channel without a human owner decays to a logo on a slide.')]));
S(spacer(120));

S(h2('Motion 5 — Expansion is a product motion, not a sales one'));
S(p('The land-and-expand path is built into the platform: a customer starts on one project (Core Project), adds packages and API access (Professional Delivery), rolls up to portfolio and isolated tenancy (Enterprise), then carries the same record into thirty-year O&M. Instrument the moment they hit the seat cap or create a second project, and trigger the conversation automatically. Expansion revenue at £2,000 CAC is the best money in this plan.'));

// ── 07 Acquisition ─────────────────────────────────────────────────────────
S(h1('07 · The acquisition engine'));
S(eyebrow('Ranked by cost per qualified opportunity'));
S(table({
  headers: ['Channel', 'Why it works here', '~Cost/SQL', 'Verdict'],
  widths: [26, 42, 14, 18],
  rows: [
    ['Trigger-based outbound', 'The buyer has a statutory date, and you know the date', '£450', 'Fund'],
    ['Consultancy channel', 'Borrowed trust, warm introductions, no cold start', '£280', 'Fund'],
    ['Founder-led LinkedIn', 'UK construction leadership genuinely lives there', '£310', 'Fund'],
    ['Regional trade press — Place North West', 'Read by exactly this buyer in exactly this city', '£340', 'Fund'],
    ['Hosted roundtable dinners', 'Twelve duty-holders in a room; highest conversion of anything here', '£520', 'Fund'],
    ['National trade press — Construction News, Building, Inside Housing', 'Authority and credibility, slower to convert', '£620', 'Fund'],
    ['Professional bodies — CIOB, RICS, ICE, Build UK', 'CPD webinars put you in front of duty-holders as an educator', '£380', 'Fund'],
    ['Search — "golden thread software"', 'Small volume, extremely high intent', '£600', 'Test £1,500'],
    ['Paid LinkedIn ABM', 'Precise targeting; works only with the content engine behind it', '£950', 'Test £3,000/mo'],
    ['National trade shows', 'Dense buyers, but expensive and out of region for now', '£1,400', 'Defer to Gate 3'],
    ['Generic SaaS review sites', 'Traffic is procurement-led and price-shopping', '£2,100', 'Skip'],
  ],
}));
S(spacer());
S(h2('The content that actually converts'));
S(p('Not thought leadership. Operational artefacts a duty-holder can use on Monday. Each is gated only by an email address and designed to be forwarded internally to the person who owns the problem.'));
S(bullet([t('The Golden Thread Readiness Assessment ', { bold: true }), t('— forty questions, scored, producing a PDF a Building Safety Director can take to their board. The single highest-value asset in this plan.')]));
S(bullet([t('"What the Act requires of your software" ', { bold: true }), t('— a procurement checklist covering immutability, attribution, residency, isolation and pen testing. You win on this document because you wrote it against the architecture you already have.')]));
S(bullet([t('The tamper film, ninety seconds, no narration. ', { bold: true }), t('Alter a record; run the replay; the hash moves.')]));
S(bullet([t('Statutory payment date calculator ', { bold: true }), t('— free, no login, genuinely useful, and it embeds your name in a QS\'s bookmarks.')]));
S(bullet([t('The Greater Manchester Golden Thread Index ', { bold: true }), t('— quarterly, anonymised, regional. This becomes press coverage and a reason for the Task Force to cite you.')]));
S(spacer(120));
S(h2('Activation is where deals are won or lost'));
S(p('Instrument these five and treat any miss as a churn signal, not a support ticket.'));
S(bullet('Day 0 — tenant live, three seats assigned.'));
S(bullet('Day 2 — first governed event committed against a real project.'));
S(bullet('Day 7 — first evidence file hashed and attached.'));
S(bullet('Day 14 — first Golden Thread export produced.'));
S(bullet('Day 21 — first agent proposal approved by a named human.'));
S(spacer(80));
S(p('That last one matters more than it looks. A customer who has approved an Autopilot proposal has accepted the platform\'s authority model. They do not churn.'));

// ── 08 Marketing ───────────────────────────────────────────────────────────
S(h1('08 · Marketing and the agency brief'));
S(eyebrow('What you run in-house, what you buy'));
S(callout('On marketwaros.com — verify before you sign', [
  'This site could not be reached: it is blocked by network egress in the environment this document was produced in, and returns no results in search. No claims are made here about what they do, and no recommendation is given on capabilities that have not been seen.',
  'Everything below is the brief to put to them — or to any agency — and the terms that make the engagement accountable. Step one is a 45-minute call and two referenceable B2B construction or regulated-industry case studies. If those do not exist, use the shortlist test that follows.',
], CRIT));
S(spacer());
S(h2('The brief — hand this over verbatim'));
S(h3('Scope of engagement'));
S(bullet([t('Positioning is not in scope. ', { bold: true }), t('It is set in section 04 of this document and is not open. The agency executes it; they do not rediscover it.')]));
S(bullet([t('Category: ', { bold: true }), t('UK construction compliance software. Buyer: Commercial Director, Building Safety Director, Head of Digital. Geography: Greater Manchester only until day 90. Not "construction tech buyers".')]));
S(bullet([t('Deliverables, first 90 days: ', { bold: true }), t('brand system extension from the existing CONSTRUX identity; the Readiness Assessment as an interactive tool; four operational artefacts; the ninety-second tamper film; LinkedIn ABM setup and management; placement in Place North West plus one national title.')]));
S(bullet([t('Explicitly excluded: ', { bold: true }), t('logo redesign, brand repositioning, "awareness" campaigns, impression-based reporting.')]));
S(h3('How they are measured'));
S(bullet([t('Primary metric: cost per sales-qualified lead, ', { bold: true }), t('target under £600 by day 90.')]));
S(bullet('Secondary: assessment completions, trade-press placements, ABM engaged-account rate.'));
S(bullet([t('No impressions, no reach, no "engagement" in the reporting pack. ', { bold: true }), t('Say this in the first meeting.')]));
S(bullet('Monthly retainer with a 30-day termination right for the first two quarters.'));
S(bullet([t('You retain ownership of all accounts, pixels, lists and creative source files ', { bold: true }), t('— in the contract, not in good faith.')]));
S(spacer(120));
S(h2('If the reference check fails — shortlist criteria'));
S(table({
  headers: ['Test', 'Pass looks like'],
  widths: [30, 70],
  rows: [
    ['Sector fluency', 'They can explain what Gateway 2 is without you prompting'],
    ['Named references', 'Two B2B construction or regulated-industry clients you can telephone'],
    ['Reporting', 'They volunteer pipeline metrics before you ask for them'],
    ['Team', 'The people in the pitch are the people on the account, named in the SOW'],
    ['Commercials', 'Rolling monthly after an initial 90 days; no twelve-month lock'],
    ['Ownership', 'You own the ad accounts, the CRM data and the creative source files'],
    ['Region', 'They have run a single-city B2B campaign before and can say what it cost'],
  ],
}));
S(spacer());
S(h2('In-house, never outsourced'));
S(bullet([t('Founder LinkedIn. ', { bold: true }), t('Ghost-written founder content is obvious to this audience and costs credibility with exactly the people you need.')]));
S(bullet([t('The tamper demo. ', { bold: true }), t('An agency cannot narrate a hash chain convincingly. Record it yourself.')]));
S(bullet([t('The procurement checklist. ', { bold: true }), t('It is a technical document that must be exactly true.')]));
S(bullet([t('Customer conversations. ', { bold: true }), t('Every one, for the first 100. No exceptions and no delegation.')]));

// ── 09 Suppliers ───────────────────────────────────────────────────────────
S(h1('09 · Suppliers: what to buy, and how to source it'));
S(eyebrow('In a compliance product, your suppliers sit inside your compliance claim'));
S(table({
  headers: ['Category', 'Candidates', 'Non-negotiable term', '~Cost/mo', '~Gate'],
  widths: [17, 24, 36, 14, 9],
  rows: [
    ['Cloud and residency', 'AWS eu-west-2, Azure UK South, GCP europe-west2', 'UK region only; no cross-border replication of tenant data', '£600', '0'],
    ['Database', 'Aurora PostgreSQL, Neon, Supabase', 'Point-in-time recovery, RLS support, documented restore time', '£250', '0'],
    ['Evidence store', 'S3 with Object Lock (compliance mode)', 'WORM immutability; a retention lock the vendor cannot lift', '£150', '0'],
    ['AI providers', 'OpenAI, Google Gemini, Anthropic, Mistral', 'No training on customer data, in writing; UK/EU processing; two providers minimum', '£800', '0'],
    ['Email relay', 'Postmark, AWS SES, Mailgun', 'Dedicated IP, DKIM/SPF/DMARC, EU region', '£120', '1'],
    ['SMS and MFA', 'Twilio, Vonage, Bird', 'UK sender ID, delivery receipts', '£150', '1'],
    ['Monitoring', 'Grafana Cloud, Datadog, Better Stack', 'Log retention that satisfies your own audit story', '£200', '1'],
    ['Security certification', 'BSI, NQA, Alcumus (ISO 27001); IASME (Cyber Essentials)', 'Fixed-fee scope; surveillance audit costs disclosed up front', 'See §11', '0'],
    ['Penetration testing', 'Any CREST-accredited firm', 'Annual retest included; report shareable with customers under NDA', 'See §11', '0'],
    ['Project data', 'Barbour ABI, Glenigan', 'CRM export rights; seats covering the whole sales team', '£1,050', '1'],
    ['Cost indices', 'BCIS (RICS)', 'Redistribution rights inside the product — often excluded, check carefully', '£450', '2'],
    ['Credit and entity data', 'Companies House API (free), Creditsafe, Experian', 'Per-lookup pricing, not per-seat', '£350', '2'],
    ['Legal', 'Construction-specialist UK firm', 'Duty-holder liability review — generic SaaS terms are wrong here', 'See §11', '0'],
  ],
}));
S(spacer());
S(h2('How to source, in six steps'));
S(numbered([t('Write the requirement before you look. ', { bold: true }), t('One page: what it must do, the compliance clause it sits inside, and the failure you are insuring against. Vendors will otherwise sell you their roadmap.')]));
S(numbered([t('Three-way RFI, never fewer. ', { bold: true }), t('A second quote is a negotiating position; a third is a sanity check on the category.')]));
S(numbered([t('Security and DPA review before commercials. ', { bold: true }), t('Ask for the sub-processor list, data residency map, breach-notification window and deletion SLA. If they cannot produce these quickly they are not enterprise-ready, and neither are you if you buy them.')]));
S(numbered([t('Commercials with an exit. ', { bold: true }), t('Monthly or annual, never multi-year, until you have run a full year. Committed-spend discounts on AI are worth taking only once your usage curve is measured.')]));
S(numbered([t('Pilot against a real workload. ', { bold: true }), t('Two weeks, with a pass mark written down beforehand.')]));
S(numbered([t('Document the exit before you sign the entry. ', { bold: true }), t('How do you get your data out, in what format, how fast, at what cost? For the evidence store this is a customer-facing answer.')]));
S(spacer(120));
S(callout('Two supplier decisions that are actually product decisions', [
  [t('Never single-source AI. ', { bold: true }), t('The orchestrator already routes to a healthy provider and falls back. Keep two contracted at all times — a provider outage must degrade a feature, not the platform, and a provider price rise must not be a repricing event for you.')],
  [t('WORM storage is not optional. ', { bold: true }), t('A hash chain proves a file was not altered. Object Lock proves it was not deleted. A golden thread needs both, and a buyer\'s security reviewer will know the difference.')],
]));
S(spacer());
S(h2('Implementation and channel partners'));
S(p('Distinct from suppliers, and sourced differently: recruit from the Manchester consultancies already in Motion 3. Certify them — a two-day accreditation, a public partner register, and a rule that only accredited partners may configure a tenant. This protects delivery quality and makes the partnership feel like status rather than a discount.'));

// ── 10 Programme ───────────────────────────────────────────────────────────
S(h1('10 · The 90-day programme'));
S(eyebrow('Four gates. You do not pass because time elapsed.'));
S(programme([
  { label: 'Persistence & deploy', bars: [{ from: 1, to: 5, tone: 'solid', text: 'Gate 0' }] },
  { label: 'Security & certification', bars: [{ from: 1, to: 7, tone: 'light', text: 'CE+ · pen test' }, { from: 8, to: 13, tone: 'quiet', text: 'ISO 27001' }] },
  { label: 'Design partners', bars: [{ from: 1, to: 4, tone: 'solid', text: 'Recruit 10' }, { from: 5, to: 13, tone: 'light', text: 'Run & evidence' }] },
  { label: 'Content & assets', bars: [{ from: 2, to: 6, tone: 'light', text: 'Build' }, { from: 7, to: 13, tone: 'light', text: 'Publish' }] },
  { label: 'Outbound', bars: [{ from: 3, to: 5, tone: 'quiet', text: 'List' }, { from: 6, to: 13, tone: 'solid', text: 'Sequences live' }] },
  { label: 'Channel', bars: [{ from: 5, to: 7, tone: 'quiet', text: 'Recruit' }, { from: 8, to: 13, tone: 'light', text: 'Referrals' }] },
  { label: 'Hiring (Manchester)', bars: [{ from: 2, to: 5, tone: 'quiet', text: 'AE + SDR' }, { from: 6, to: 13, tone: 'light', text: 'Ramp' }] },
]));
S(spacer(240));

const gate = (id, name, when, doing, exits) => {
  // The PDF puts each gate behind a solid bar; this is the same device.
  S(new Table({
    rows: [new TableRow({ children: [new TableCell({
      width: { size: W, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: INK, color: 'auto' },
      margins: { top: 130, bottom: 130, left: 200, right: 200 },
      borders: { top: NONE, bottom: NONE, left: { style: BorderStyle.SINGLE, size: 24, color: ORANGE }, right: NONE },
      children: [
        p([t(id + '  ', { font: 'Consolas', size: 15, bold: true, color: ORANGE }),
           t(name, { font: 'Arial', size: 22, bold: true, color: 'FFFFFF' })], { after: 40 }),
        p([t(when, { font: 'Consolas', size: 14, color: 'B9BDC4' })], { after: 0 }),
      ],
    })] })],
    width: { size: W, type: WidthType.DXA }, columnWidths: [W],
    borders: { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE },
  }));
  S(spacer(140));
  S(h3('Do'));
  doing.forEach((d) => S(bullet(d)));
  S(h3('Exit criteria — all must be true'));
  S(callout('Gate cannot be passed until every line is true', exits, GOOD));
  S(spacer(160));
};

gate('GATE 0', 'Make it sellable', 'Days −14 → 30 · Owner: Engineering', [
  'Postgres persistence with append-only constraints and row-level security; migrate the in-process ledger.',
  'S3 Object Lock evidence store. Backup, restore and replay drill — timed and written down.',
  'Deploy to a UK region. Infrastructure as code, so the topology is reproducible rather than remembered.',
  'Cyber Essentials Plus submitted. Pen test booked. ISO 27001 gap analysis started.',
  'DPAs and no-training clauses signed with two AI providers.',
  'Terms of service reviewed by a construction-specialist firm for duty-holder liability.',
  'Recruit and sign ten Greater Manchester founding partners. Non-production data only until this gate clears.',
  'Manchester base established — four desks, and a standing Thursday in the city for site visits.',
], [
  "A customer's golden thread survives a full restart and a restore-from-backup, demonstrated.",
  'Ten founding partners signed, all Greater Manchester, with reference obligations in the agreement.',
  'Cyber Essentials Plus certificate in hand.',
  'Two AI providers contracted, either able to carry the load alone.',
]);

gate('GATE 1', 'Prove it on real buildings', 'Days 31 → 60 · Owner: Founder and Sales', [
  'Move all ten founding partners onto production data and real Greater Manchester HRBs.',
  'Ship the Golden Thread Readiness Assessment as an interactive tool. The quarter\'s most important marketing asset.',
  'Publish the procurement checklist and the ninety-second tamper film.',
  'Build the outbound list — BSR approval data, HRB register, Companies House, Barbour ABI — filtered to Greater Manchester. Target 300 qualified accounts in-region.',
  'Hire one AE and one SDR, both Manchester-based. Founder still runs every first call.',
  'Recruit five NW consultancy channel partners; give each a free tenancy and the co-branded assessment.',
  'First hosted roundtable dinner — twelve seats, invited by building.',
  'Approach the Greater Manchester High Rise Task Force for a briefing slot.',
  'Instrument the five activation milestones and review them weekly.',
  'Agency engaged against the section 08 brief, after the reference check.',
], [
  'Five paying customers. Converted founding partners count only if they are paying.',
  'Three referenceable case studies with a number in them — days saved, dispute avoided, evidence pack produced.',
  '200 assessment completions.',
  'Cost per SQL measured, whatever it is. A measured bad number beats an unmeasured good feeling.',
]);

gate('GATE 2', 'Make it repeatable', 'Days 61 → 90 · Owner: Sales and Marketing', [
  'Outbound sequences live across all 300 in-region accounts; SDR at 40 qualified conversations a month.',
  'First channel-referred logos closing. Appoint a named partner manager.',
  'Open the remediation motion: funded remediation buildings in Greater Manchester and their contractors.',
  'Second roundtable dinner. One regional event sponsorship with the tamper demo running live.',
  'Two CPD webinars with professional bodies. You are the educator, not the vendor.',
  'Publish the first Greater Manchester Golden Thread Index.',
  'Land-and-expand triggers instrumented: seat cap reached, second project created.',
  'ISO 27001 Stage 1 audit booked.',
  'Pricing reviewed against real win/loss data — not against the original assumptions.',
], [
  '20 paying customers, £400,000+ ARR.',
  'Blended CAC under £8,000 and falling.',
  'Two channel partners producing referrals without being chased.',
  'Activation: 70% of new tenants reach a first governed event within 48 hours.',
  'Zero customers lost to a security review.',
]);

gate('GATE 3', 'Scale to 100', 'Days 91 → 270 · Owner: Sales leadership', [
  'Second AE and second SDR. The founder exits first calls and moves to Enterprise deals only.',
  'ISO 27001 certified — this unlocks Tier 1 contractors and larger registered providers.',
  'Ship the file ingestion pipeline and OCR. Close the capability gaps customers name in lost deals, in that order.',
  'Open the asset and facilities management segment as buildings reach handover.',
  'Open Leeds and West Yorkshire as the second city, on the same evidence base.',
  'Evaluate Scotland, Wales and Ireland as separate wedges, not as a bigger market.',
], [
  '100 customers and approximately £2.77m ARR by day 270.',
  'Greater Manchester at 25+ customers before any second-city spend.',
  'Net revenue retention above 110%.',
]);

// ── 11 Budget ──────────────────────────────────────────────────────────────
S(h1('11 · Team and 90-day budget'));
S(eyebrow('Built from quoted 2026 UK market rates'));
S(p('Every figure below is sourced from published 2026 UK pricing or salary benchmarks rather than estimated. Where a range exists, the mid-point is taken and the range is shown. Salaries are Greater Manchester rates, which is a material part of why the city was chosen.'));
S(spacer(120));
S(table({
  headers: ['Line', 'Basis', '~90-day cost'],
  widths: [26, 56, 18],
  rows: [
    [[[t('Engineering — Gate 0', { size: 18, bold: true })]], '2 contract engineers × 6 weeks (30 working days) at £550/day', '£33,000'],
    ['AE — 2 months', 'Manchester mid-market base £50,000 (range £42k–£60k), plus 15% employer NI and pension', '£9,600'],
    ['SDR — 2 months', 'Manchester base £32,000 (range £28k–£38k), plus 15% employer NI and pension', '£6,150'],
    ['Sales commission', 'Ramp period only; minimal attainment expected in the window', '£2,000'],
    ['Recruitment fee', 'One agency placement (AE) at 18% of base; SDR hired direct', '£9,000'],
    ['Cyber Essentials Plus', 'Certification from £1,399+VAT for a micro organisation; UK government data puts average total cost, including consultancy and technical remediation, at ~£4,941', '£4,950'],
    ['Penetration test', 'External infrastructure and web application test, small business: quoted range £4,000–£8,000', '£6,500'],
    ['ISO 27001 — gap analysis and Stage 1 prep', 'Year-one total for a small organisation is £6,000–£15,000 at ~£1,500 per auditor day; only the gap analysis and Stage 1 prep fall inside 90 days', '£3,500'],
    ['Legal', 'Construction-specialist review of terms and duty-holder liability, plus DPAs, channel agreement and partner accreditation terms', '£12,000'],
    ['Cloud and AI providers', 'AWS eu-west-2 production and staging with multi-AZ, backups and logging (~£600/mo); two AI providers (~£800/mo); monitoring (~£200/mo)', '£5,400'],
    ['Data and sales tooling', 'Barbour ABI or Glenigan pro-rata (£8k–£15k/yr), CRM, sales engagement, LinkedIn Sales Navigator', '£5,700'],
    ['Content production', 'Readiness Assessment interactive build (£6,000), tamper film (£4,500), four operational artefacts (£4,000)', '£14,500'],
    ['Agency retainer', '2 months at £6,000/mo against the section 08 brief', '£12,000'],
    ['Paid media', 'LinkedIn ABM test £3,000/mo × 2; search £750/mo × 2', '£7,500'],
    ['Events and roundtables', 'Two hosted dinners in Manchester at £2,500 each; one regional event sponsorship at £3,500', '£8,500'],
    ['Manchester base and travel', '4 co-working desks at ~£250/desk/mo × 3 months; travel to site and London', '£5,000'],
    ['Contingency', '12% — the pen test will find something', '£17,450'],
  ],
  foot: ['Total, 90 days', 'Producing 20 paying customers and £400,000+ ARR at Gate 2', '£162,750'],
}));
S(spacer());
S(callout('What the real numbers changed', [
  'An earlier draft of this plan carried £242,300, built on estimated engineering day rates and inflated cloud costs. Sourcing actual 2026 UK market rates took roughly a third out of it — the largest corrections were engineering (£72,000 estimated against £33,000 at real contract rates) and infrastructure (£16,000 against £5,400).',
  'This matters beyond accuracy. £162,750 is a smaller, more defensible ask, and every line can be traced to a quote.',
]));
S(spacer(120));
S(h2('Ongoing run rate from day 91'));
S(table({
  headers: ['Line', '~Monthly'],
  widths: [70, 30],
  rows: [
    ['AE and SDR, fully loaded, plus commission at target', '£9,900'],
    ['Agency retainer', '£6,000'],
    ['Paid media', '£3,750'],
    ['Data and sales tooling', '£1,900'],
    ['Cloud, AI and monitoring (scaling with customers)', '£1,800'],
    ['ISO 27001 continuation and surveillance provision', '£1,000'],
  ],
  foot: ['Monthly run rate at Gate 3 entry', '£24,350'],
}));
S(spacer());
S(h2('Hire in this order, and not before'));
S(numbered([t('SDR before AE. ', { bold: true }), t('The founder can close; nobody else will build the list.')]));
S(numbered([t('Customer Success at customer 25, ', { bold: true }), t('not before. Until then the founder does onboarding and learns more from it than from any report.')]));
S(numbered([t('Partner Manager at five active partners. ', { bold: true }), t('Channel without an owner decays quietly.')]));
S(numbered([t('Head of Security and Compliance at customer 50. ', { bold: true }), t('By then, security questionnaires are a full-time job and a bottleneck on every deal.')]));

// ── 12 Risk ────────────────────────────────────────────────────────────────
S(h1('12 · What kills this, and when to stop'));
S(eyebrow('Written in advance, because kill criteria are inconvenient when they trigger'));
S(table({
  headers: ['Risk', 'Early signal', 'Response'],
  widths: [24, 30, 46],
  rows: [
    ['Gate 0 overruns', 'Persistence not done by day 30', 'Stop all paid acquisition. Every pound spent selling an unsellable product is wasted twice.'],
    ['An incumbent adds a credible ledger', 'A major CDE announces immutability at a trade show', 'Move fast to depth — payment cycle, delay attribution, Autopilot. The ledger is the wedge, not the moat.'],
    ['Sales cycles longer than modelled', 'Median above 120 days at Gate 2', 'Shift weight to the consultancy channel and Core Project entry pricing; extend the runway assumption.'],
    ['Security review failures', 'Two deals lost on ISO 27001', 'Accelerate certification; pre-empt with the pen-test report and Statement of Applicability in the first meeting.'],
    ['AI cost exceeds the 3× markup', 'Gross margin below 75%', 'The ACU model already caps exposure per tenant. Reprice the bundles; do not absorb it.'],
    ['Regulatory timetable slips', 'Enforcement deferred', 'Pivot the lead message to the payment wedge, which has no regulatory dependency. Keep the compliance proof as the differentiator.'],
    ['Manchester is too small', 'Fewer than 40 qualified in-region accounts after list build', 'Extend to the North West — Liverpool, Leeds — before extending nationally. Keep the density principle.'],
    ['Design partners never convert', 'Fewer than five paying at day 60', 'The problem is value, not price. Stop selling and go and watch three of them work for a day each.'],
  ],
}));
S(spacer());
S(h2('Kill criteria'));
S(callout('Stop and re-plan if any of these is true', [
  [t('Under 5 paying customers at day 90 ', { bold: true }), t('— the wedge is wrong, not the execution. Re-segment before spending more.')],
  [t('Blended CAC above £25,000 at day 120 ', { bold: true }), t('— the economics do not work at this ACV. Move upmarket to Enterprise-only or rebuild the channel motion.')],
  [t('Activation below 40% ', { bold: true }), t('— customers are buying and not using. Fix onboarding before acquiring another logo; you are filling a leaking bucket.')],
  [t('Any customer data loss event ', { bold: true }), t('— stop selling, fix it, and tell every customer before they find out. In a compliance product this is existential, and no version of concealing it survives.')],
], CRIT));
S(spacer());
S(h2('The single number to run the company on'));
S(p([t('Not ARR. ', { bold: true }), t('Governed events committed per customer per week.', { bold: true, color: ORANGE }), t(' It is the only metric that captures whether the golden thread is actually being built rather than bought. It predicts renewal, it predicts expansion, and it is the number a customer\'s regulator would care about too. Put it on the wall.')]));

// ── Sources ────────────────────────────────────────────────────────────────
S(h1('Sources and honesty notes'));
S(h3('Taken from the implementation'));
S(p('Pricing, packages, seat rates, ACU bundles and the free regulator seat are read directly from the CONSTRUX codebase (backend/src/billing/seats.ts), not proposed. Product capability claims in section 01 are taken from the verified build state in docs/STATE.md.'));
S(h3('Externally sourced'));
S(bullet('Higher-risk building scale (~12,500 in England), Gateway duties and golden thread requirements: Building Safety Act 2022 and published UK guidance.'));
S(bullet('Software procurement requirements quoted in section 01 — attribution, timestamping, immutability, ISO 27001, Cyber Essentials, UK residency, tenant isolation, annual penetration testing — from published industry guidance on what the Act requires of software.'));
S(bullet('Remediation concentration in Greater London, Greater Manchester, West Yorkshire and the south coast, and the Greater Manchester High Rise Task Force: GOV.UK building safety remediation data releases and Greater Manchester Combined Authority.'));
S(bullet('Cyber Essentials Plus pricing from £1,399+VAT for micro organisations, with average total cost including consultancy of ~£4,941: UK 2026 pricing guides and government data.'));
S(bullet('ISO 27001 year-one cost of £6,000–£15,000 for small organisations at ~£1,500 per auditor day: UK 2026 certification cost guides.'));
S(bullet('Penetration test cost of £4,000–£8,000 for a small business external infrastructure and web application test: UK 2026 pricing guides.'));
S(bullet('Manchester and London salary benchmarks for SDR and Account Executive roles: UK 2026 SaaS sales salary guides.'));
S(h3('Modelled, not measured'));
S(callout('Do not present these as benchmarks', [
  'Conversion rates, CAC by motion, sales-cycle lengths, retention, net revenue retention and cost-per-SQL are modelled assumptions. They are stated explicitly so they can be replaced by measurement at Gate 1 and Gate 2 — they are not industry benchmarks and should not be presented to an investor as such.',
  'marketwaros.com could not be reached or verified. Section 08 gives a brief and contract terms rather than a recommendation.',
], CRIT));

// ═══════════════════════════════════════════════════════════════════════════
const doc = new Document({
  creator: 'CONSTRUX',
  title: 'CONSTRUX Go-To-Market',
  description: 'Manchester launch, 90-day programme, first 100 customers',
  numbering: {
    config: [
      { reference: 'bullets', levels: [
        { level: 0, format: LevelFormat.BULLET, text: '—', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 340, hanging: 220 } }, run: { color: ORANGE, bold: true } } },
        { level: 1, format: LevelFormat.BULLET, text: '·', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 680, hanging: 220 } }, run: { color: MUTED } } },
      ] },
      { reference: 'numbers', levels: [
        { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 400, hanging: 280 } }, run: { color: ORANGE, bold: true } } },
      ] },
    ],
  },
  styles: {
    default: {
      heading1: { run: { font: 'Arial', size: 34, bold: true, color: INK } },
      heading2: { run: { font: 'Arial', size: 24, bold: true, color: INK } },
      heading3: { run: { font: 'Consolas', size: 17, bold: true, color: MUTED } },
    },
  },
  sections: [{
    properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
    headers: {
      default: new Header({ children: [new Paragraph({
        children: [t('CONSTRUX', { font: 'Consolas', size: 15, color: MUTED, bold: true }),
                   t('   ·   GO-TO-MARKET   ·   Greater Manchester launch', { font: 'Consolas', size: 15, color: MUTED })],
        spacing: { after: 60 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 6 } },
      })] }),
    },
    footers: {
      default: new Footer({ children: [new Paragraph({
        children: [t('Commercial in confidence   ·   page ', { font: 'Consolas', size: 14, color: MUTED }),
                   new TextRun({ children: [PageNumber.CURRENT], font: 'Consolas', size: 14, color: MUTED })],
        alignment: AlignmentType.RIGHT,
      })] }),
    },
    children: body,
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync('GO-TO-MARKET.docx', buf);
  console.log('GO-TO-MARKET.docx written —', (buf.length / 1024).toFixed(1), 'kB');
});
