import { api } from '../lib/api.js';
import { command, commandBar, quoteAction } from '../lib/command.js';
import { csvRateCardToLines, parseRateCardEntries, rateCardReport } from '../lib/ratecard.js';
import { badge, date, html, humanise, money, notice, pct, raw, render, table, toast } from '../lib/ui.js';
import { blockedReason, can, draw } from '../app.js';

/**
 * CONSTRUX Bid-On — bid work delivered for external customers.
 *
 * The first screen of the module, and it leads with the customers rather than
 * the bids. That is deliberate: in this module a bid is never the top-level
 * thing. It belongs to an engagement, which belongs to a customer, and the
 * reason somebody cannot start work is almost always one level up — the
 * engagement is paused, or drafted and never activated, or the customer has
 * none open at all. A screen that led with bids would answer "why can I not
 * draft this" with silence.
 *
 * Two things on it are not conveniences and are the point of the module.
 *
 * **The register says what it is not showing.** A provider's customers compete
 * with each other, so a bid writer sees only the ones they are assigned to.
 * "You are seeing four of nine" is a true and useful statement; four rows that
 * look like all of them is not.
 *
 * **A declaration has no door here.** Insurance cover, accident figures and
 * legal statements are confirmed by the customer's own admin, as a guest, in
 * their own workspace. There is no button on this screen for the provider's
 * staff to do it, because the API refuses them and a door onto a refusal is
 * worse than no door.
 */

const ENGAGEMENT_TONE = {
  ACTIVE: 'ok',
  DRAFT: 'warn',
  PAUSED: 'info',
  COMPLETED: '',
  CANCELLED: 'bad',
};

const STAGE_TONE = { OPEN: 'ok', PENDING: '', SIGNED_OFF: 'info' };

/** A bid's own state. `EXPORTED` is not done — somebody still has to submit it. */
const BID_TONE = {
  CREATED: 'warn',
  PARSING: 'info',
  DRAFTING: '',
  IN_REVIEW: 'info',
  APPROVED: 'ok',
  EXPORTED: 'info',
  SUBMITTED: 'ok',
  WON: 'good',
  LOST: 'bad',
};

/** The traffic lights the rubric publishes. */
const RAG_TONE = { GREEN: 'ok', AMBER: 'warn', RED: 'bad' };

/** An answer's own review state. */
const ANSWER_TONE = { DRAFT: '', IN_REVIEW: 'warn', APPROVED: 'ok', REJECTED: 'bad' };

/**
 * What each severity means, in the words the form that sets it uses.
 *
 * On the buttons rather than in a legend: somebody deciding whether to send
 * four questions or twenty-five is deciding what "major" is worth, and the
 * answer should not be on another screen.
 */
const SEVERITY_MEANS = {
  CRITICAL: 'We cannot price or insure it as it stands.',
  MAJOR: 'It changes what we would commit to.',
  MINOR: 'It changes how we answer.',
};

/** An invoice's standing. A waiver is neutral: it was a decision, not a failure. */
const INVOICE_TONE = { ISSUED: 'warn', PAID: 'ok', WAIVED: '', VOID: '' };

/** What each engagement type means for how work opens and repeats. */
const TYPE_MEANING = {
  ONE_OFF: 'One or more bids, then it closes. Billed as a fixed fee.',
  PERMANENT: 'Open-ended; bids added at any time. Billed monthly.',
  CONTINUOUS: 'Repeats on a schedule — annual re-verification, a weekly tender watch. Billed per cycle.',
  STAGED: 'Ordered stages; the next opens only after the last is signed off. Billed per stage.',
  CUSTOM: 'Free-form terms recorded on the engagement itself.',
};

export async function bidon(root) {
  const [customers, engagements, offerings, bids, invoices, importable, documents] = await Promise.all([
    // Every read is tenant-scoped and filtered to this person inside the API,
    // not here. A screen that filtered would leak the moment anybody called
    // the route directly.
    api.read('/v1/bid-on/customers', 'BID_SERVICES', 'COMMERCIAL_L3').catch((error) => ({ error })),
    api.read('/v1/bid-on/engagements', 'BID_SERVICES', 'COMMERCIAL_L3').catch((error) => ({ error })),
    api.read('/v1/bid-on/offerings', 'BID_SERVICES', 'COMMERCIAL_L3').catch((error) => ({ error })),
    api.read('/v1/bid-on/bids', 'BID_SERVICES', 'COMMERCIAL_L3').catch((error) => ({ error })),
    api.read('/v1/bid-on/invoices', 'BID_SERVICES', 'COMMERCIAL_L3').catch((error) => ({ error })),
    // Declared against Tender & Procurement rather than against this module,
    // because that is the access the route actually checks: the invitations are
    // the standard section's records, and holding Bid-On is not permission to
    // read them. Somebody with the module and no tender access gets the
    // refusal, which is the honest answer.
    api.read('/v1/bid-on/importable-tenders', 'ESTIMATE_TENDER', 'COMMERCIAL_L3').catch((error) => ({ error })),
    /*
     * Every document this person may see, for the panels that used to ask them
     * to type an id.
     *
     * Six commands took an identifier as free text with a hint explaining
     * which of the three values on a library row to copy — and the commonest
     * refusal in the module was somebody pasting the wrong one, or pasting
     * nothing because the panel did not make clear a document was needed. The
     * per-customer library cannot answer for a panel, because it is loaded
     * only after a customer has been chosen; this is one tenant-scoped read,
     * filtered to the customers this person is assigned to by the API.
     */
    api.read('/v1/bid-on/evidence', 'BID_SERVICES', 'COMMERCIAL_L3').catch((error) => ({ error })),
  ]);

  const customerList = customers?.customers ?? [];
  const bidList = bids?.bids ?? [];
  const invoiceList = invoices?.invoices ?? [];
  const engagementList = engagements?.engagements ?? [];
  const offeringList = offerings?.offerings ?? [];
  /**
   * The services an engagement can actually be priced from.
   *
   * Withdrawn ones are kept on the catalogue — an engagement signed against one
   * is unaffected and the record of what was sold stays readable — but nothing
   * new is priced from one, so the forms offer the live ones only. Hoisted
   * because two fields and three hints depend on whether this is empty.
   */
  const priceable = offeringList.filter((entry) => entry.active);

  /**
   * The filed documents, as something to choose from.
   *
   * Grouped by customer, because a provider's customers compete with each
   * other and a flat list of forty documents is where somebody picks the wrong
   * company's insurance schedule. Each option says what has been read out of
   * the document, since an item with no passages can be filed and cannot be
   * cited, embedded or drafted from — which is a fact worth seeing *before*
   * pressing a button rather than in the refusal afterwards.
   *
   * `documentOptions(filter)` takes a predicate so each panel offers only what
   * it can act on: embedding wants a document that has been read, reading
   * wants one that is not withdrawn.
   */
  const documentList = (documents?.evidence ?? []).filter((item) => !item.withdrawn);
  const customerName = (id) => {
    const found = customerList.find((customer) => customer.id === id);
    return found ? `${found.reference} — ${found.legalName}` : 'Another customer';
  };
  /**
   * How much of a question set a document looks like, from what has been read
   * out of it.
   *
   * Zero for a stock list, a cost model, an order form or an insurance
   * certificate; high for a questionnaire. Question marks and the imperatives a
   * questionnaire is written in — "describe", "set out", "confirm" — are the
   * signals that separate the two. Numbered lines are deliberately only a
   * tie-breaker: a list of two thousand addresses is full of house numbers.
   */
  const ASK_RANK = { QUESTIONS: 3, SOMETHING: 2, UNREAD: 1, NOTHING: 0 };
  const askScore = (item) => ASK_RANK[item.asks] ?? 1;

  const documentOptions = (filter = () => true, { rankByQuestions = false } = {}) => {
    const kept = documentList.filter(filter);
    const byCustomer = new Map();
    for (const item of kept) {
      const key = item.customerAccountId;
      if (!byCustomer.has(key)) byCustomer.set(key, []);
      byCustomer.get(key).push(item);
    }
    return [...byCustomer.entries()].map(([id, items]) => ({
      label: customerName(id),
      options: (rankByQuestions
        ? /*
           * The ones that ask something first.
           *
           * Somebody looking for the questionnaire among nine filed documents
           * was paying for a model call per guess — the amendments, the
           * certificates, the order form, a 382,691-character stock list, the
           * cost model. The platform has already read all of them and can say
           * which asks anything, for nothing. So it does, and says why.
           */
          [...items].sort((a, b) => askScore(b) - askScore(a) || a.reference.localeCompare(b.reference))
        : items
      ).map((item) => ({
        value: item.id,
        label:
          `${item.reference} — ${item.title}` +
          (item.read ? '' : ' · nothing read out of it yet') +
          /*
           * The verdict the API published, not a rule restated here.
           *
           * The first version of this label counted question-ish words in the
           * browser and called nine documents out of ten a question set — a
           * schedule of amendments is full of "provide" and "confirm", because
           * that is how an obligation is written. The rule now lives in one
           * place and says one of four things.
           */
          (rankByQuestions && item.asks === 'QUESTIONS' ? ` · the question set — ${item.asksDetail}` : '') +
          (rankByQuestions && item.asks === 'SOMETHING' ? ` · ${item.asksDetail}` : '') +
          (rankByQuestions && item.asks === 'NOTHING' ? ' · asks nothing — not the questionnaire' : '') +
          (!rankByQuestions && item.embedded ? ' · searchable by meaning' : ''),
      })),
    }));
  };
  /** Whether there is anything to choose at all. An empty chooser is worse than a field. */
  const haveDocuments = documentList.length > 0;

  const customerOptions = customerList
    .filter((customer) => customer.status === 'ACTIVE')
    .map((customer) => ({ value: customer.id, label: `${customer.reference} — ${customer.legalName}` }));

  /** Engagements work can be done against, or acted on. */
  const liveEngagements = engagementList.filter(
    (entry) => entry.status === 'ACTIVE' || entry.status === 'PAUSED' || entry.status === 'DRAFT',
  );
  const engagementLabel = (entry) =>
    `${entry.reference} — ${entry.name} · ${humanise(entry.status)}`;

  const importableList = importable?.tenders ?? [];
  /** The bids that came from a tender, which are the only ones a resync applies to. */
  const importedBids = bidList.filter((bid) => !bid.standalone);
  /** Imported bids whose source has moved since. The banner is driven off these. */
  const driftedBids = importableList.flatMap((tender) =>
    tender.importedAs.filter((entry) => entry.sourceChanged).map((entry) => ({ ...entry, tender })),
  );

  const view = html`
    <h1>Bid-On</h1>
    <p class="metric-sub" style="margin-bottom:14px">
      Bid work delivered for external customers. Each customer has its own workspace, its own evidence and its own
      engagement with its own terms — and a customer's evidence is never visible to another customer of the same
      provider. This does not replace Tender &amp; Procurement, which stays as it is for bidding this business's own
      work.
    </p>

    ${customers?.error ? notice(customers.error.detail ?? 'The customer register could not be read.', 'bad') : ''}

    <div class="card pad0" style="margin-bottom:14px">
      <h2 style="padding:15px 17px 0">Customers</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        ${customers?.summary ?? ''}
        A workspace is visible to whoever opened it and to the staff assigned to it, and to nobody else — because the
        firms in this list compete with each other, and each has handed over its accident statistics, its insurance
        values and its case studies.
      </p>
      <div style="padding:11px 17px 0">
        ${raw(commandBar([
          { id: 'open-customer', label: 'Open a customer workspace',
            permitted: can('BID_SERVICES', 'G'), reason: blockedReason('BID_SERVICES', 'G') },
          { id: 'assign-staff', label: 'Assign staff', tone: 'quiet',
            permitted: can('BID_SERVICES', 'G'), reason: blockedReason('BID_SERVICES', 'G') },
          { id: 'invite-guest', label: 'Invite the customer’s own people', tone: 'quiet',
            permitted: can('BID_SERVICES', 'G'), reason: blockedReason('BID_SERVICES', 'G') },
          { id: 'update-profile', label: 'Update standing facts', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          { id: 'close-customer', label: 'Close a workspace', tone: 'quiet',
            permitted: can('BID_SERVICES', 'G'), reason: blockedReason('BID_SERVICES', 'G') },
        ]))}
      </div>
      ${table({
        headers: ['Ref', 'Customer', 'Company no.', 'Sectors', 'Guests', 'Declarations', 'Engagements', 'Standing'],
        align: ['', '', '', '', 'num', 'num', 'num', ''],
        rows: customerList.map((customer) => [
          customer.reference,
          customer.legalName,
          customer.profile?.companyNumber ?? '—',
          (customer.profile?.sectors ?? []).join(', ') || '—',
          String(customer.guestCount),
          customer.declarationCount === customer.liveDeclarationCount
            ? String(customer.declarationCount)
            : html`${customer.liveDeclarationCount} live
                <span style="font-size:12px;color:var(--text-3)">of ${customer.declarationCount}</span>`,
          String(customer.engagements.length),
          badge(humanise(customer.status), customer.status === 'ACTIVE' ? 'ok' : ''),
        ]),
        empty: 'No customer workspace you can see',
        emptyDetail:
          'Open one for each external customer. Its evidence library stays inside it, which is what lets the same ' +
          'provider work for two firms chasing the same framework.',
      })}
      ${
        (customers?.limits ?? []).length > 0
          ? html`<div class="notice info" style="margin:11px 17px 15px"><div>
              ${customers.limits.map((line) => html`<div>${line}</div>`)}
            </div></div>`
          : ''
      }
    </div>

    <div class="card pad0" style="margin-bottom:14px">
      <h2 style="padding:15px 17px 0">Engagements</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        ${engagements?.error ? 'The engagement register could not be read.' : (engagements?.summary ?? '')}
        Every bid belongs to one engagement, which is what makes the AI cost of a run attributable to a customer and
        to a piece of commercial work. Pausing is a status rather than a type, so any engagement can stop and start:
        while it is paused nothing is billed, no agent runs, and every bid stays exactly where it was.
      </p>
      <div style="padding:11px 17px 0">
        ${raw(commandBar([
          { id: 'open-engagement', label: 'Open an engagement',
            permitted: can('BID_SERVICES', 'G') && customerOptions.length > 0,
            reason: customerOptions.length === 0
              ? 'Open a customer workspace first — an engagement is with one customer.'
              : blockedReason('BID_SERVICES', 'G') },
          { id: 'activate-engagement', label: 'Activate',
            permitted: can('BID_SERVICES', 'A'), reason: blockedReason('BID_SERVICES', 'A') },
          { id: 'pause-engagement', label: 'Pause', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          { id: 'resume-engagement', label: 'Resume', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          { id: 'reterm-engagement', label: 'Change the terms', tone: 'quiet',
            permitted: can('BID_SERVICES', 'G'), reason: blockedReason('BID_SERVICES', 'G') },
          { id: 'open-cycle', label: 'Open the next cycle', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          { id: 'sign-off-stage', label: 'Sign off a stage',
            permitted: can('BID_SERVICES', 'A'), reason: blockedReason('BID_SERVICES', 'A') },
          { id: 'close-engagement', label: 'Complete or cancel', tone: 'quiet',
            permitted: can('BID_SERVICES', 'A'), reason: blockedReason('BID_SERVICES', 'A') },
        ]))}
      </div>
      ${table({
        headers: ['Ref', 'Engagement', 'Customer', 'Type', 'Billing', 'Fee', 'Open stage', 'Signed off', 'Standing'],
        align: ['', '', '', '', '', 'num', '', 'num', ''],
        rows: engagementList.map((entry) => [
          entry.reference,
          entry.name,
          customerList.find((customer) => customer.id === entry.customerAccountId)?.legalName ?? '—',
          html`<span title="${TYPE_MEANING[entry.type] ?? ''}">${humanise(entry.type)}</span>`,
          humanise(entry.billingBasis),
          money(entry.feeMinor, entry.currency),
          entry.openStage
            ? html`${entry.openStage.name}${entry.openStage.dueOn
                ? html` <span style="font-size:12px;color:var(--text-3)">due ${date(entry.openStage.dueOn)}</span>`
                : ''}`
            : entry.stages.length === 0
              ? html`<span style="font-size:12px;color:var(--text-3)">no stages</span>`
              : badge('none open', 'warn'),
          String(entry.stagesSignedOff),
          entry.openForWork
            ? badge('open for work', 'ok')
            : html`<span title="${entry.blockedReason ?? ''}">${badge(humanise(entry.status), ENGAGEMENT_TONE[entry.status] ?? '')}</span>`,
        ]),
        empty: 'No engagement opened yet',
        emptyDetail:
          'Every bid belongs to one. Pick a service from the catalogue below and the terms are filled in from it.',
      })}
      ${
        (engagements?.limits ?? []).length > 0
          ? html`<div class="notice warn" style="margin:11px 17px 15px"><div>
              ${engagements.limits.map((line) => html`<div>${line}</div>`)}
            </div></div>`
          : ''
      }
    </div>

    ${
      // The stages of every engagement that has any, flattened. A staged
      // engagement's whole point is that work waits for a sign-off, so which
      // stage is open has to be readable without opening each one.
      engagementList.some((entry) => entry.stages.length > 0)
        ? html`<div class="card pad0" style="margin-bottom:14px">
            <h2 style="padding:15px 17px 0">Stages and cycles</h2>
            <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
              A cycle is a stage with a number on it — annual re-verification and a weekly tender watch are the same
              shape as prequalification then tender, and both wait for a sign-off before the next one opens.
            </p>
            ${table({
              headers: ['Engagement', '#', 'Stage', 'Scope', 'Fee', 'Due', 'Signed off by', 'Standing'],
              align: ['', 'num', '', '', 'num', '', '', ''],
              rows: engagementList.flatMap((entry) =>
                entry.stages.map((stage) => [
                  entry.reference,
                  String(stage.order),
                  stage.cycle ? `${stage.name} (cycle ${stage.cycle})` : stage.name,
                  stage.scope,
                  money(stage.feeMinor, entry.currency),
                  stage.dueOn ? date(stage.dueOn) : '—',
                  stage.signedOffBy ?? '—',
                  badge(humanise(stage.status), STAGE_TONE[stage.status] ?? ''),
                ]),
              ),
            })}
          </div>`
        : ''
    }

    <div class="card pad0" style="margin-bottom:14px">
      <h2 style="padding:15px 17px 0">Service catalogue</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        ${offerings?.error ? 'The catalogue could not be read.' : (offerings?.summary ?? '')}
        What this business sells, defined once and priced by this business — no price here is a platform constant.
        An engagement takes a <b>copy</b> of the terms, so repricing a service next quarter never moves an engagement
        already signed.
      </p>
      <div style="padding:11px 17px 0">
        ${raw(commandBar([
          { id: 'define-offering', label: 'Define a service',
            permitted: can('BID_SERVICES', 'G'), reason: blockedReason('BID_SERVICES', 'G') },
          { id: 'update-offering', label: 'Reprice or withdraw', tone: 'quiet',
            permitted: can('BID_SERVICES', 'G'), reason: blockedReason('BID_SERVICES', 'G') },
        ]))}
      </div>
      ${table({
        headers: ['Ref', 'Service', 'Type', 'Billing', 'From', 'Deposit', 'What the customer gets', 'Standing'],
        align: ['', '', '', '', 'num', 'num', '', ''],
        rows: offeringList.map((offering) => [
          offering.reference,
          offering.name,
          humanise(offering.engagementType),
          humanise(offering.billingBasis),
          money(offering.defaultFeeMinor, offering.currency),
          offering.depositPercent === undefined ? '—' : `${offering.depositPercent}%`,
          offering.deliverables.join('; '),
          offering.active ? badge('active', 'ok') : badge('withdrawn', ''),
        ]),
        empty: 'No service defined yet',
        emptyDetail: 'Define what this business sells once, and every engagement is priced from it.',
      })}
    </div>

    <div class="card pad0" style="margin-bottom:14px">
      <h2 style="padding:15px 17px 0">Bids</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        ${bids?.error ? 'The bid register could not be read.' : (bids?.summary ?? '')}
        A bid is a questionnaire, its questions in the buyer's own numbering, every version of every answer, and the
        gaps nobody can answer yet. A gap pauses its own question and nothing else, so the rest of a pack keeps
        drafting while the customer is asked for what is missing. Export is refused until every mandatory answer is
        approved and out of red.
      </p>
      <div style="padding:11px 17px 0">
        ${raw(commandBar([
          { id: 'create-bid', label: 'Open a bid',
            permitted: can('BID_SERVICES', 'C') && liveEngagements.some((e) => e.openForWork),
            reason: liveEngagements.some((e) => e.openForWork)
              ? blockedReason('BID_SERVICES', 'C')
              : 'Activate an engagement first — a bid belongs to one, which is what makes its AI cost attributable.' },
          { id: 'parse-questionnaire', label: 'Read the questionnaire',
            permitted: can('BID_SERVICES', 'X'), reason: blockedReason('BID_SERVICES', 'X') },
          { id: 'confirm-questions', label: 'Confirm the question list',
            permitted: can('BID_SERVICES', 'C'), reason: blockedReason('BID_SERVICES', 'C') },
          { id: 'draft-answer', label: 'Draft an answer',
            permitted: can('BID_SERVICES', 'X'), reason: blockedReason('BID_SERVICES', 'X') },
          { id: 'rescore-answer', label: 'Score it as the buyer would',
            permitted: can('BID_SERVICES', 'X'), reason: blockedReason('BID_SERVICES', 'X') },
          { id: 'gap-request', label: 'Write the request to the customer', tone: 'quiet',
            permitted: can('BID_SERVICES', 'X'), reason: blockedReason('BID_SERVICES', 'X') },
          { id: 'record-answer', label: 'Write an answer', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          { id: 'score-answer', label: 'Score an answer', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          { id: 'approve-answer', label: 'Approve an answer',
            permitted: can('BID_SERVICES', 'A'), reason: blockedReason('BID_SERVICES', 'A') },
          { id: 'reject-answer', label: 'Reject with instructions', tone: 'quiet',
            permitted: can('BID_SERVICES', 'A'), reason: blockedReason('BID_SERVICES', 'A') },
          { id: 'floor-override', label: 'Submit an answer below the floor', tone: 'quiet',
            permitted: can('BID_SERVICES', 'A'), reason: blockedReason('BID_SERVICES', 'A') },
          { id: 'evidence-needs', label: 'Work out what this pack needs',
            permitted: can('BID_SERVICES', 'X'), reason: blockedReason('BID_SERVICES', 'X') },
          { id: 'raise-gap', label: 'Raise a gap', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          { id: 'resolve-gap', label: 'Close a gap', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          { id: 'raise-clarification', label: 'Raise a question for the buyer', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          { id: 'clarification-asked', label: 'Record that we asked it', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          { id: 'clarification-answer', label: 'Record the buyer’s answer', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          { id: 'clarification-withdraw', label: 'Withdraw a question', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          { id: 'record-returnables', label: 'Record what has to be returned',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          { id: 'record-returnables-bulk', label: 'Record several at once', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          { id: 'supply-returnable', label: 'Mark a returnable done', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          { id: 'waive-returnable', label: 'Waive a returnable', tone: 'quiet',
            permitted: can('BID_SERVICES', 'A'), reason: blockedReason('BID_SERVICES', 'A') },
          { id: 'review-amendments', label: 'Read the schedule of amendments',
            permitted: can('BID_SERVICES', 'X'), reason: blockedReason('BID_SERVICES', 'X') },
          { id: 'set-bid-floor', label: 'Set the quality floor', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          { id: 'export-bid', label: 'Export the pack',
            permitted: can('BID_SERVICES', 'I'), reason: blockedReason('BID_SERVICES', 'I') },
          { id: 'record-bid-outcome', label: 'Record the outcome', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
        ]))}
      </div>
      ${table({
        headers: ['Ref', 'Customer', 'Buyer', 'Scheme', 'Stage', 'Due', 'Left', 'Questions', 'Approved', 'Gaps', 'To return', 'To ask', 'Readiness', 'State', ''],
        align: ['', '', '', '', '', '', 'num', 'num', 'num', 'num', 'num', 'num', 'num', '', ''],
        rows: bidList.map((bid) => [
          bid.reference,
          bid.customerName,
          bid.buyerName,
          humanise(bid.scheme),
          bid.stage === 'SINGLE_STAGE'
            ? html`<span style="font-size:12px;color:var(--text-3)">one stage</span>`
            : badge(humanise(bid.stage), bid.stage === 'PQQ' ? '' : 'info'),
          // A rolling submission has no return date and no countdown. Showing
          // today's date under "Due" would be a date nobody set, and a
          // countdown of 0 would read as due today on something with no due
          // date at all.
          bid.rolling ? badge('rolling', 'info') : date(bid.deadline),
          bid.daysLeft === null
            ? html`<span style="font-size:12px;color:var(--text-3)">no return date</span>`
            : bid.daysLeft < 0
              ? badge(`${Math.abs(bid.daysLeft)} over`, 'bad')
              : badge(`${bid.daysLeft}d`, bid.daysLeft <= 5 ? 'warn' : ''),
          String(bid.questions),
          String(bid.approved),
          bid.openGaps === 0 ? '—' : badge(String(bid.openGaps), 'warn'),
          // Beside the readiness figure, because that figure is about answers
          // and cannot see this. "92% ready" next to "1 to return" is the only
          // honest way to show both at once.
          bid.returnablesOutstanding === 0
            ? '—'
            : html`<span title="${bid.returnablesWithCustomer} with the customer">${badge(String(bid.returnablesOutstanding), 'bad')}</span>`,
          // Questions for the buyer, and the ones whose window has already
          // shut. A missed one cannot be fixed on this bid, which is exactly
          // why it has to be visible rather than quietly dropped.
          bid.clarificationsMissed > 0
            ? badge(`${bid.clarificationsMissed} missed`, 'bad')
            : bid.clarifications === 0
              ? '—'
              : badge(String(bid.clarifications), 'warn'),
          bid.readinessPercent === null ? '—' : `${bid.readinessPercent}%`,
          bid.exportable
            ? badge('ready to export', 'ok')
            : badge(humanise(bid.status), BID_TONE[bid.status] ?? ''),
          html`<button class="btn sm" data-bid="${bid.id}">Open</button>`,
        ]),
        empty: 'No bid yet',
        emptyDetail:
          'A bid can be started here from a questionnaire with no tender in the standard section at all, and a bid ' +
          'started here never appears there.',
      })}
      ${
        (bids?.limits ?? []).length > 0
          ? html`<div class="notice warn" style="margin:11px 17px 15px"><div>
              ${bids.limits.map((line) => html`<div>${line}</div>`)}
            </div></div>`
          : ''
      }
    </div>

    <!-- The topbar is sticky, so scrolling a pack into view without a margin
         puts its own heading underneath it. -->
    <div id="bid-detail" style="margin-bottom:14px;scroll-margin-top:68px"></div>

    ${
      // The banner, at the top of the card rather than inside a pack nobody has
      // opened. A change at source is not urgent enough to interrupt and is far
      // too important to find by accident.
      driftedBids.length > 0
        ? html`<div class="notice warn" style="margin-bottom:14px"><div>
            <b>${driftedBids.length === 1 ? 'A tender has changed' : `${driftedBids.length} tenders have changed`}
            since the bid was imported.</b>
            Nothing has re-parsed. Resync when you are ready — approved answers are kept and only a question the buyer
            actually reworded goes back for review.
            ${driftedBids.map((entry) => html`<div style="margin-top:4px">
              ${entry.reference} — ${entry.tender.reference}:
              ${entry.changed.map((move) => `${move.field} ${move.was} → ${move.now}`).join('; ')}
            </div>`)}
          </div></div>`
        : ''
    }

    <div class="card pad0" style="margin-bottom:14px">
      <h2 style="padding:15px 17px 0">Import from Tender &amp; Procurement</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        ${importable?.error ? 'The standard Tenders section could not be read.' : (importable?.summary ?? '')}
        A shortcut, never a requirement: it exists so a provider whose customer's tender is <i>already</i> recorded
        does not upload the same questionnaire twice. The import is <b>one-way</b> — the fields are copied and any
        file registered against the invitation comes over by its hash, so a deadline edited in the standard section
        cannot silently move every certificate-expiry verdict in the pack. A tender with no file registered against
        it carries its record and its deadline, and the questionnaire itself still has to be given to the parser.
      </p>
      <div style="padding:11px 17px 0">
        ${raw(commandBar([
          { id: 'import-bid', label: 'Import a tender as a bid',
            permitted: can('BID_SERVICES', 'C') && importableList.length > 0 && liveEngagements.some((e) => e.openForWork),
            reason: importableList.length === 0
              ? 'No invitation is recorded in the standard section — or you do not have read access to it there, which is checked separately from this module.'
              : liveEngagements.some((e) => e.openForWork)
                ? blockedReason('BID_SERVICES', 'C')
                : 'Activate an engagement first — an imported bid belongs to one exactly as any other does.' },
          { id: 'resync-bid', label: 'Resync a bid with its source', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U') && importedBids.length > 0,
            reason: importedBids.length === 0
              ? 'No bid here was imported. A bid started from a questionnaire has no source to resync from.'
              : blockedReason('BID_SERVICES', 'U') },
        ]))}
      </div>
      ${table({
        headers: ['Reference', 'Buyer', 'Title', 'Return', 'Listed', 'Files', 'Addenda', 'Already imported as'],
        align: ['', '', '', '', 'num', 'num', 'num', ''],
        rows: importableList.map((tender) => [
          tender.reference || '—',
          tender.clientName || '—',
          tender.title || '—',
          tender.deadline ? date(tender.deadline) : badge('no deadline', 'bad'),
          String(tender.documents.length),
          // Listed is what the transmittal said it contained, in words. Files is
          // what is actually in the evidence store and can be read without
          // uploading anything, which is a different and smaller number.
          tender.files === 0 ? badge('none', 'warn') : String(tender.files),
          String(tender.addenda),
          tender.importedAs.length === 0
            ? '—'
            : html`${tender.importedAs.map((entry) => html`<div>
                ${entry.reference}
                ${entry.sourceChanged ? badge('source changed', 'warn') : badge(humanise(entry.status), BID_TONE[entry.status] ?? '')}
              </div>`)}`,
        ]),
        empty: 'No invitation to import',
        emptyDetail:
          'Importing is a shortcut. A bid started here from a questionnaire needs no tender in the standard section ' +
          'at all, and never appears there.',
      })}
      ${
        (importable?.limits ?? []).length > 0
          ? html`<div class="notice info" style="margin:11px 17px 15px"><div>
              ${importable.limits.map((line) => html`<div>${line}</div>`)}
            </div></div>`
          : ''
      }
    </div>

    <div class="card pad0" style="margin-bottom:14px">
      <h2 style="padding:15px 17px 0">Evidence library</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        One library per customer, and never the provider's. Every answer is drafted from it and every claim cites it,
        which is why a certificate filed without the day it lapses is refused — that date is what the hard rule reads,
        and a missing one is a safety check switched off rather than a blank field. A CV is refused without the data
        subject's consent.
      </p>
      <div style="padding:11px 17px 0">
        ${raw(commandBar([
          { id: 'file-evidence', label: 'File an evidence item',
            permitted: can('BID_SERVICES', 'C') && customerOptions.length > 0,
            reason: customerOptions.length === 0
              ? 'Open a customer workspace first — evidence belongs to a customer, not to the provider.'
              : blockedReason('BID_SERVICES', 'C') },
          // Before the hand-typed recorder, because it is what somebody should
          // reach for: nine documents of passages transcribed by a bid writer
          // is the labour this module exists to remove, and the recorder
          // beside it is for a correction or a document a provider cannot read.
          { id: 'read-evidence', label: 'Read it for me',
            permitted: can('BID_SERVICES', 'X'), reason: blockedReason('BID_SERVICES', 'X') },
          { id: 'record-extraction', label: 'Type the passages myself', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          // Before withdrawal, because it is the lighter act and the one people
          // actually need: a mistyped title on one of nine appendices filed in
          // a batch, where withdrawing and filing again breaks every citation
          // already made against it.
          { id: 'correct-evidence', label: 'Correct a title or a date', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          { id: 'withdraw-evidence', label: 'Withdraw an item', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          { id: 'embed-evidence', label: 'Make an item searchable by meaning',
            permitted: can('BID_SERVICES', 'X'), reason: blockedReason('BID_SERVICES', 'X') },
        ]))}
      </div>
      <!--
        A lookup, not a position: there is no "the library" to show, only one
        customer's at a time. The chooser's options are the customers this
        person is assigned to, so it cannot ask for one they may not read.
      -->
      <div class="actions" style="padding:11px 17px 0;align-items:flex-end">
        <div class="field" style="margin:0;min-width:260px">
          <label for="ev-customer">Whose library?</label>
          <select id="ev-customer">
            ${customerOptions.map((option) => html`<option value="${option.value}">${option.label}</option>`)}
          </select>
        </div>
        <div class="field" style="margin:0;min-width:180px">
          <label for="ev-question">Or ask it a question</label>
          <input id="ev-question" type="text" placeholder="local labour and apprenticeships">
        </div>
        <button class="btn sm" id="ev-open">Open the library</button>
        <button class="btn sm quiet" id="ev-retrieve">What do we have</button>
        <!--
          Two buttons rather than one, because they are not the same search and
          one of them spends. "What do we have" ranks on distinctive-term
          overlap and costs nothing; "Search by meaning" embeds the question and
          is charged. A single button that silently picked the paid path when a
          library happened to be embedded would be a screen spending money
          nobody pressed for.
        -->
        <button class="btn sm quiet" id="ev-semantic">Search by meaning · quote it</button>
      </div>
      <div id="evidence-detail" style="padding:0 17px 4px"></div>
    </div>

    <div class="card pad0" style="margin-bottom:14px">
      <h2 style="padding:15px 17px 0">Invoices and statements</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        ${invoices?.error ? 'The invoice register could not be read.' : (invoices?.summary ?? '')}
        A deposit is issued when an engagement is activated, a stage fee on sign-off and a balance on completion —
        the provider does not have to remember. An outstanding deposit blocks <b>agent runs only</b>: a person can
        still set the customer up, file their evidence and confirm a question list, because what a deposit protects
        is the spend rather than the relationship.
      </p>
      <div style="padding:11px 17px 0">
        ${raw(commandBar([
          { id: 'issue-invoice', label: 'Issue an invoice',
            permitted: can('BID_SERVICES', 'G'), reason: blockedReason('BID_SERVICES', 'G') },
          { id: 'record-payment', label: 'Record a payment',
            permitted: can('BID_SERVICES', 'G'), reason: blockedReason('BID_SERVICES', 'G') },
          { id: 'waive-invoice', label: 'Waive a deposit', tone: 'quiet',
            permitted: can('BID_SERVICES', 'G'), reason: blockedReason('BID_SERVICES', 'G') },
          { id: 'void-invoice', label: 'Void one issued in error', tone: 'quiet',
            permitted: can('BID_SERVICES', 'G'), reason: blockedReason('BID_SERVICES', 'G') },
        ]))}
      </div>
      <!--
        The statement is a lookup: there is no "the statement", only one
        engagement's for a period. The chooser offers the engagements this
        person can already see, so it cannot ask for one they may not read.
      -->
      <div class="actions" style="padding:11px 17px 0;align-items:flex-end">
        <div class="field" style="margin:0;min-width:280px">
          <label for="st-engagement">Statement for</label>
          <select id="st-engagement">
            ${liveEngagements.concat(engagementList.filter((entry) => !liveEngagements.includes(entry))).map(
              (entry) => html`<option value="${entry.id}">${engagementLabel(entry)}</option>`,
            )}
          </select>
        </div>
        <div class="field" style="margin:0"><label for="st-from">From</label><input id="st-from" type="date"></div>
        <div class="field" style="margin:0"><label for="st-to">To</label><input id="st-to" type="date"></div>
        <button class="btn sm" id="st-go">Show it</button>
      </div>
      <div id="statement-detail" style="padding:0 17px"></div>
      ${table({
        headers: ['Ref', 'Customer', 'Engagement', 'For', 'Amount', 'Issued', 'Due', 'Standing'],
        align: ['', '', '', '', 'num', '', '', ''],
        rows: invoiceList.map((invoice) => [
          invoice.reference,
          invoice.customerName,
          invoice.engagementReference,
          invoice.narrative,
          money(invoice.amountMinor, invoice.currency),
          date(invoice.issuedAt),
          invoice.dueOn ? date(invoice.dueOn) : '—',
          invoice.overdue
            ? badge('past due', 'bad')
            : badge(humanise(invoice.status), INVOICE_TONE[invoice.status] ?? ''),
        ]),
        empty: 'Nothing invoiced yet',
        emptyDetail: 'A deposit appears here the moment an engagement whose terms include one is activated.',
      })}
      ${
        (invoices?.limits ?? []).length > 0
          ? html`<div class="notice warn" style="margin:11px 17px 15px"><div>
              ${invoices.limits.map((line) => html`<div>${line}</div>`)}
            </div></div>`
          : ''
      }
    </div>

    <div class="notice info" style="margin-bottom:14px"><div>
      <b>A declaration is confirmed by the customer, never here.</b>
      Insurance cover, accident figures and legal statements are representations the customer makes to a buyer under
      its own name. They are confirmed by that customer's own admin, as a guest, inside their workspace — so there is
      deliberately no button for the provider's staff on this screen. Whoever confirms it is who the buyer will hold
      to it.
    </div></div>
  `;

  render(root, view);

  /*
   * Opening one pack.
   *
   * Loaded on a click rather than with the register, because the register
   * shows every bid and a pack carries a hundred questions. Loading all of
   * them to show one would be a hundred packs read to display one.
   */
  const detail = root.querySelector('#bid-detail');
  root.addEventListener('click', async (event) => {
    const open = event.target.closest('[data-bid]');
    if (!open || !detail) return;
    open.disabled = true;
    open.textContent = 'Opening…';
    try {
      const row = bidList.find((bid) => bid.id === open.dataset.bid);
      const [position, estimate, source] = await Promise.all([
        api.read(`/v1/bid-on/bids/${open.dataset.bid}`, 'BID_SERVICES', 'COMMERCIAL_L3'),
        // Beside the pack rather than behind a separate button: the question
        // "what would it cost to finish this" is asked by whoever is looking
        // at what is left, and a quote on another screen is a quote nobody
        // reads before pressing the thing that spends.
        api
          .read(`/v1/bid-on/bids/${open.dataset.bid}/acu-estimate`, 'BID_SERVICES', 'COMMERCIAL_L3')
          .catch((error) => ({ error })),
        // Only for an imported bid, and swallowed on refusal. Reading it needs
        // access to the tender in its own section, which a bid writer may not
        // have — and not being able to see whether the source moved is not a
        // reason to fail to open the pack.
        row && !row.standalone
          ? api
              .read(`/v1/bid-on/bids/${open.dataset.bid}/source`, 'ESTIMATE_TENDER', 'COMMERCIAL_L3')
              .catch((error) => ({ error }))
          : null,
      ]);
      render(detail, bidDetail(position, estimate, source));
      detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      // A denial shown as a denial. An empty panel here would read as "this
      // pack is empty", which is a different statement.
      render(detail, notice(`This pack could not be opened: ${error.message}`, 'err'));
    } finally {
      open.disabled = false;
      open.textContent = 'Open';
    }
  });

  /*
   * One engagement's statement for a period.
   *
   * A lookup with a default rather than a required period: the question is
   * almost always "what has this cost and earned so far", and making somebody
   * pick two dates to ask it is how a screen stops being used.
   */
  const statementDetail = root.querySelector('#statement-detail');
  root.querySelector('#st-go')?.addEventListener('click', async () => {
    const engagementId = root.querySelector('#st-engagement')?.value;
    if (!engagementId || !statementDetail) return;
    const from = root.querySelector('#st-from')?.value;
    const to = root.querySelector('#st-to')?.value;
    const query = [from ? `from=${from}` : '', to ? `to=${to}` : ''].filter(Boolean).join('&');
    try {
      const statement = await api.read(
        `/v1/bid-on/engagements/${engagementId}/statement${query ? `?${query}` : ''}`,
        'BID_SERVICES',
        'COMMERCIAL_L3',
      );
      render(statementDetail, statementPanel(statement));
    } catch (error) {
      render(statementDetail, notice(`The statement could not be read: ${error.message}`, 'err'));
    }
  });

  /*
   * Taking the pack out.
   *
   * A download rather than a panel: the deliverable is a file somebody emails
   * or uploads to a portal, and rendering it into the page would be showing
   * somebody a Word document as HTML. The text form is put on the clipboard
   * instead, because an online portal has a box per question and what somebody
   * wants is to paste.
   */

  /*
   * What this customer has already answered.
   *
   * Two reads rather than one: the board says which questions have something
   * worth reading, and only then is one question's candidates fetched.
   * Fetching every question's candidates to render the list would be sixty
   * reads for a list somebody scans once.
   */
  root.addEventListener('click', async (event) => {
    const open = event.target.closest('[data-carry]');
    if (!open) return;
    const panel = root.querySelector('#carry-detail');
    if (!panel) return;
    open.disabled = true;
    try {
      const board = await api.read(
        `/v1/bid-on/bids/${open.dataset.carry}/carry-forward`,
        'BID_SERVICES',
        'COMMERCIAL_L3',
      );
      render(panel, carryPanel(board, open.dataset.carry));
    } catch (error) {
      render(panel, notice(error.detail ?? error.message, 'err'));
    } finally {
      open.disabled = false;
    }
  });

  /*
   * The cost-model calculator. Revealed on demand, and it stays open after a
   * calculation so a client can try a different margin or test a price they are
   * weighing — iterating is the point, and a modal that closed on each submit
   * would fight that.
   */
  root.addEventListener('click', (event) => {
    const open = event.target.closest('[data-cost-open]');
    if (!open) return;
    const panel = root.querySelector('#cost-detail');
    if (!panel) return;
    if (panel.dataset.open === '1') {
      panel.dataset.open = '0';
      render(panel, html``);
    } else {
      panel.dataset.open = '1';
      render(panel, costPanel(bidList));
    }
  });

  root.addEventListener('click', async (event) => {
    const calc = event.target.closest('#cost-calc');
    if (!calc) return;
    const slot = root.querySelector('#cost-result');
    if (!slot) return;
    const num = (id) => {
      const el = root.querySelector(id);
      const value = el ? el.value.trim() : '';
      return value === '' ? null : Number(value);
    };
    const pounds = (value) => (value === null ? null : Math.round(value * 100));
    const unitCostMinor = pounds(num('#cost-unit'));
    const quantity = num('#cost-qty');
    const fixedCostMinor = pounds(num('#cost-fixed'));
    const marginPercent = num('#cost-margin');
    const marginBasis = root.querySelector('#cost-basis')?.value ?? 'ON_COST';
    const proposedUnitPriceMinor = pounds(num('#cost-proposed'));
    // The same words the server would use, said here, so a blank or nonsense
    // entry is a sentence under the button rather than a round-trip and a 400.
    if (unitCostMinor === null || quantity === null || marginPercent === null) {
      render(slot, notice('Enter at least the unit cost, the quantity and the target margin.', 'warn'));
      return;
    }
    const request = { unitCostMinor, quantity, targetMargin: marginPercent / 100, marginBasis };
    if (fixedCostMinor !== null) request.fixedCostMinor = fixedCostMinor;
    if (proposedUnitPriceMinor !== null) request.proposedUnitPriceMinor = proposedUnitPriceMinor;
    calc.disabled = true;
    try {
      const result = await api.post('/v1/bid-on/cost-model/build-up', request);
      render(slot, costResult(result));
    } catch (error) {
      render(slot, notice(error.detail ?? error.message, 'err'));
    } finally {
      calc.disabled = false;
    }
  });

  // The tender rate picker in the cost calculator: pick a tender, its rates load
  // into the second box, and picking one fills "what one unit costs you". Built
  // with DOM Option nodes so a description sets textContent and cannot inject.
  root.addEventListener('change', async (event) => {
    const bidSel = event.target.closest('#cost-bid');
    if (bidSel) {
      const rateSel = root.querySelector('#cost-rate');
      const note = root.querySelector('#cost-rate-note');
      if (!rateSel) return;
      const setRateNote = (text) => {
        if (note) note.textContent = text;
      };
      rateSel.replaceChildren();
      if (!bidSel.value) {
        rateSel.add(new Option('choose a tender first', ''));
        rateSel.disabled = true;
        setRateNote('Rates imported for that tender only.');
        return;
      }
      rateSel.add(new Option('loading…', ''));
      rateSel.disabled = true;
      try {
        const card = await api.read(`/v1/bid-on/bids/${bidSel.value}/rate-card`, 'BID_SERVICES', 'COMMERCIAL_L3');
        const rates = Array.isArray(card?.rates) ? card.rates : [];
        rateSel.replaceChildren();
        if (rates.length === 0) {
          rateSel.add(new Option('no rates imported for this tender', ''));
          rateSel.disabled = true;
          setRateNote('No rates yet — use “Import a rate card for a tender” first.');
          return;
        }
        rateSel.add(new Option('— choose a rate —', ''));
        for (const rate of rates) {
          rateSel.add(new Option(`${rate.description} · ${money(rate.rateMinor)}/${rate.unit}`, String(rate.rateMinor)));
        }
        rateSel.disabled = false;
        setRateNote(`${rates.length} rate${rates.length === 1 ? '' : 's'} held for this tender.`);
      } catch (error) {
        rateSel.replaceChildren();
        rateSel.add(new Option('could not load rates', ''));
        rateSel.disabled = true;
        setRateNote(error.detail ?? error.message ?? 'Could not load the tender’s rates.');
      }
      return;
    }
    const rateSel = event.target.closest('#cost-rate');
    if (rateSel && rateSel.value) {
      const unit = root.querySelector('#cost-unit');
      if (unit) unit.value = (Number(rateSel.value) / 100).toString();
    }
  });

  root.addEventListener('click', async (event) => {
    const open = event.target.closest('[data-prior]');
    if (!open) return;
    const slot = root.querySelector('#prior-detail');
    if (!slot) return;
    open.disabled = true;
    try {
      const offer = await api.read(
        `/v1/bid-on/bids/${open.dataset.priorBid}/questions/${open.dataset.prior}/prior-answers`,
        'BID_SERVICES',
        'COMMERCIAL_L3',
      );
      render(slot, priorPanel(offer));
    } catch (error) {
      render(slot, notice(error.detail ?? error.message, 'err'));
    } finally {
      open.disabled = false;
    }
  });

  /*
   * Confirming the parse, in one press.
   *
   * The command takes an empty list to mean "the parse was right", which is a
   * decision somebody makes after reading the proposal above — so this is a
   * button under the proposal rather than a step in a panel asking for the
   * list to be typed again.
   */
  root.addEventListener('click', async (event) => {
    const confirm = event.target.closest('[data-confirm-proposal]');
    if (!confirm) return;
    confirm.disabled = true;
    try {
      const result = await api.post(`/v1/bid-on/bids/${confirm.dataset.confirmProposal}/questions`, { questions: [] });
      toast(
        'Question list confirmed',
        `${result.questions?.length ?? 0} question(s), in the buyer's own numbering. Drafting is open.`,
        'ok',
      );
      await draw();
    } catch (error) {
      toast('Not confirmed', error.detail ?? error.message ?? 'The list could not be confirmed.', 'err');
      confirm.disabled = false;
    }
  });

  /** The same list, in the editor, for anybody who wants to change a line first. */
  root.addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-edit-proposal]');
    if (!edit) return;
    const bidId = edit.dataset.editProposal;
    const spec = COMMANDS['confirm-questions'];
    if (!spec) return;
    edit.disabled = true;
    // Read back rather than carried in a variable: the pack on screen may be
    // minutes old, and the list somebody edits has to be the list the platform
    // currently holds.
    let position;
    try {
      position = await api.read(`/v1/bid-on/bids/${bidId}`, 'BID_SERVICES', 'COMMERCIAL_L3');
    } catch (error) {
      toast('Not opened', error.detail ?? error.message ?? 'The proposal could not be read.', 'err');
      edit.disabled = false;
      return;
    }
    edit.disabled = false;
    // Pre-filled with what was parsed, in the format the field takes, so
    // "edit" means editing rather than transcribing.
    const proposal = (position.bid?.proposedQuestions ?? [])
      .map((entry) =>
        [
          entry.section,
          entry.number,
          entry.text,
          String(entry.answerType ?? 'TEXT').toLowerCase(),
          entry.wordLimit ?? '',
          entry.weighting ?? '',
          entry.mandatory ? 'M' : 'O',
          entry.passFail ? 'PF' : '',
        ].join(' | '),
      )
      .join('\n');
    if (
      await command({
        ...spec,
        fields: spec.fields.map((field) =>
          field.name === 'questions'
            ? { ...field, value: proposal }
            : field.name === 'bidId'
              ? { ...field, value: bidId }
              : field,
        ),
      })
    ) {
      await draw();
    }
  });

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-render]');
    if (!button) return;
    const format = button.dataset.render;
    button.disabled = true;
    try {
      const pack = await api.read(
        `/v1/bid-on/bids/${button.dataset.renderBid}/render?format=${format}` +
          (button.dataset.renderReview === '1' ? '&review=1' : ''),
        'BID_SERVICES',
        'COMMERCIAL_L3',
      );
      if (format === 'TEXT') {
        await navigator.clipboard?.writeText(pack.content);
        toast(
          pack.review ? 'Review copy copied' : 'Copied',
          `${pack.questions} answer(s) across ${pack.sections.length} section(s), in the buyer's own numbering.` +
            (pack.review ? ` Not for submission — ${pack.outstanding.length} item(s) outstanding.` : ''),
          pack.review ? 'warn' : 'ok',
        );
      } else {
        // Base64 from the API rather than a blob URL the server issued: the
        // bytes are the pack and there is nothing to keep on a server.
        const bytes = Uint8Array.from(atob(pack.content), (char) => char.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: pack.contentType }));
        const link = document.createElement('a');
        link.href = url;
        link.download = pack.filename;
        link.click();
        URL.revokeObjectURL(url);
        toast(
          pack.review ? 'Review copy downloaded' : 'Downloaded',
          `${pack.filename} — ${pack.sections.length} section(s) in source order.` +
            (pack.review ? ` Not for submission — ${pack.outstanding.length} item(s) outstanding.` : ''),
          pack.review ? 'warn' : 'ok',
        );
      }
    } catch (error) {
      // The one export failure with a next step rather than a dead end: the pack
      // is branded and no tenancy identity is set yet. Open the door to set it
      // instead of only naming the error.
      if (error.code === 'BRANDING_NOT_CONFIGURED') {
        const saved = await command(COMMANDS['set-branding']);
        toast(
          saved ? 'Identity saved' : 'Set your company identity first',
          saved
            ? 'Your company identity is set. Press the export button again to produce the pack.'
            : 'Exports carry your company name, colour and legal footer. Set it once, then export again.',
          saved ? 'ok' : 'warn',
        );
      } else {
        toast('Not rendered', error.detail ?? error.message ?? 'The pack could not be taken out.', 'err');
      }
    } finally {
      button.disabled = false;
    }
  });

  /*
   * The questions for the buyer, as one message.
   *
   * Sending happens in the buyer's own portal — the platform does not email a
   * buyer and should not — so what is needed here is the text, in the order it
   * should be read in, with nothing in it that was written for a colleague. The
   * severity orders the message and is deliberately not in it: "critical, we
   * cannot price this as it stands" tells a buyer exactly where we are soft.
   *
   * Clipboard by default, because a portal has a box to paste into. The file is
   * for the ones that take an attachment, and for the record of what was sent.
   */
  /*
   * The next act on one question, from the row it belongs to.
   *
   * One handler for every per-row button, because the difference between them
   * is which command and which ids — and the command itself is the one in
   * `COMMANDS`, opened with the ids filled in. Nothing about the form changes:
   * the fields, the hints, the AI cost and the validation are the same whether
   * somebody reaches it from here or from the row of doors above.
   */
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const spec = COMMANDS[button.dataset.act];
    if (!spec) return;
    const filled = {
      bidId: button.dataset.actBid,
      questionId: button.dataset.actQuestion,
      answerId: button.dataset.actAnswer,
      gapId: button.dataset.actGap,
      returnableId: button.dataset.actReturnable,
      clarificationId: button.dataset.actClarification,
      overOpenGap: button.dataset.actOver === '1',
    };

    /*
     * The one way pre-filling could do harm, closed.
     *
     * Every one of these commands builds its path from the submitted `bidId`,
     * and a chooser filters — `Draft an answer` offers bids with a confirmed
     * list, `Close a gap` offers bids with one open. Setting a value a select
     * does not carry leaves the browser showing its first option, so the form
     * would open looking filled and act on a different bid. The pack and the
     * chooser come from the same read, so this cannot happen on a current
     * screen; it would take a list that moved under somebody mid-afternoon,
     * which is exactly when nobody checks.
     */
    const chooser = spec.fields.find((field) => field.name === 'bidId' && field.type === 'select');
    if (chooser && !(chooser.options ?? []).some((option) => String(option.value) === String(filled.bidId))) {
      toast(
        'Reload the screen',
        'This bid is no longer in the list this form offers, so the form cannot be filled in for it. Nothing has ' +
          'been sent.',
        'warn',
      );
      return;
    }

    /*
     * What is being decided, in the panel that decides it.
     *
     * The director pressed **Approve** and was shown a note field and a score
     * override — and not the answer. A two-person check in which the second
     * person cannot read what the first wrote is a signature on a reference
     * number, and it is the whole value of this module.
     *
     * Read back rather than taken off the screen, for the same reason the
     * question list is: the pack on display may be minutes old, and what
     * somebody signs has to be what the platform currently holds.
     */
    let brief;
    if (['approve-answer', 'reject-answer', 'score-answer', 'rescore-answer'].includes(button.dataset.act)) {
      button.disabled = true;
      try {
        const position = await api.read(`/v1/bid-on/bids/${filled.bidId}`, 'BID_SERVICES', 'COMMERCIAL_L3');
        const entry = (position.questions ?? []).find(
          (held) => held.question.id === filled.questionId || held.answer?.id === filled.answerId,
        );
        if (entry) brief = answerBrief(entry);
      } catch (error) {
        toast('Not opened', error.detail ?? error.message ?? 'The answer could not be read.', 'err');
        button.disabled = false;
        return;
      }
      button.disabled = false;
    }

    if (
      await command({
        ...spec,
        ...(brief ? { brief } : {}),
        fields: spec.fields.map((field) =>
          field.name in filled && filled[field.name] !== '' && filled[field.name] !== undefined
            ? { ...field, value: filled[field.name] }
            : field,
        ),
      })
    ) {
      await draw();
    }
  });

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-clar-send]');
    if (!button) return;
    button.disabled = true;
    try {
      const set = await api.read(
        `/v1/bid-on/bids/${button.dataset.clarSend}/clarifications/to-send` +
          (button.dataset.clarSeverity ? `?severity=${button.dataset.clarSeverity}` : ''),
        'BID_SERVICES',
        'COMMERCIAL_L3',
      );
      if (set.entries.length === 0) {
        toast('Nothing to send', set.summary, 'warn');
        return;
      }
      if (button.dataset.clarFile === '1') {
        const url = URL.createObjectURL(new Blob([set.content], { type: set.contentType }));
        const link = document.createElement('a');
        link.href = url;
        link.download = set.filename;
        link.click();
        URL.revokeObjectURL(url);
        toast('Downloaded', `${set.filename} — ${set.summary}`, 'ok');
      } else {
        await navigator.clipboard?.writeText(set.content);
        toast('Copied', set.summary, 'ok');
      }
    } catch (error) {
      toast('Not copied', error.detail ?? error.message ?? 'The questions could not be read.', 'err');
    } finally {
      button.disabled = false;
    }
  });

  /*
   * Recording that they went, in one act.
   *
   * One message to the buyer is one date and one reference, so the form asks
   * for those once and takes the questions as a tick list — pre-ticked with
   * everything outstanding, because the normal case is that the whole set went
   * in one message and the exception is one held back.
   *
   * The list is read back rather than taken off the screen: the pack on display
   * may be minutes old, and what somebody is recording has to be the register
   * the platform currently holds.
   */
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-clar-asked]');
    if (!button) return;
    const bidId = button.dataset.clarAsked;
    button.disabled = true;
    let set;
    try {
      set = await api.read(`/v1/bid-on/bids/${bidId}/clarifications/to-send`, 'BID_SERVICES', 'COMMERCIAL_L3');
    } catch (error) {
      toast('Not opened', error.detail ?? error.message ?? 'The questions could not be read.', 'err');
      button.disabled = false;
      return;
    }
    button.disabled = false;
    if (set.entries.length === 0) {
      toast('Nothing to record', set.summary, 'warn');
      return;
    }
    const options = set.entries.map((entry) => ({
      value: entry.id,
      label: `${humanise(entry.severity)} · ${entry.subject}`,
    }));
    if (
      await command({
        title: 'Record that the questions went to the buyer',
        intent:
          'One message, one date, one reference. A portal takes a single clarification message with the questions ' +
          'numbered inside it and the buyer answers the lot in one response issued to every bidder — so this is one ' +
          'act, not one per question. The date is the point: a question is only worth having if it reached the buyer ' +
          'before their window shut. Untick anything held back; all of them or none is recorded.',
        path: `/v1/bid-on/bids/${bidId}/clarifications/asked`,
        submitLabel: `Record ${set.entries.length}`,
        fields: [
          { name: 'clarificationIds', label: 'What went', type: 'multiselect', options, value: options.map((o) => o.value),
            hint: 'Pre-ticked with everything outstanding, worst first. Untick anything that was held back.' },
          { name: 'askedOn', label: 'The day it went', type: 'date', required: false,
            hint: 'Blank is today. Put the real date if you are recording it after the fact.' },
          { name: 'buyerReference', label: 'Their reference', type: 'text', required: false,
            hint: 'The buyer’s own number for the message, which is what their answer will quote back.' },
        ],
        transform: (v) => ({
          clarificationIds: Array.isArray(v.clarificationIds)
            ? v.clarificationIds
            : [v.clarificationIds].filter(Boolean),
          ...(String(v.askedOn ?? '').trim() ? { askedOn: v.askedOn } : {}),
          ...(String(v.buyerReference ?? '').trim() ? { buyerReference: v.buyerReference } : {}),
        }),
      })
    ) {
      await draw();
    }
  });

  /*
   * One customer's library, and what it has for one question.
   *
   * Two buttons on one chooser rather than two choosers. The question is the
   * only thing that differs between them, and a second customer select is a
   * second chance to read the library of a customer you did not mean.
   */
  const evidenceDetail = root.querySelector('#evidence-detail');
  const chosenCustomer = () => root.querySelector('#ev-customer')?.value;

  /*
   * Filing a document straight from the checklist gap it fills.
   *
   * The checklist named what is missing; this opens the filing form for it with
   * the kind and the title already set, so "file the health & safety policy" is
   * one press and a file picker rather than a form filled from scratch. The same
   * `file-evidence` command, pre-filled — one definition, one set of rules.
   */
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-file-for]');
    if (!button) return;
    const spec = COMMANDS['file-evidence'];
    if (!spec) return;
    const filled = {
      customerId: button.dataset.fileFor,
      type: button.dataset.fileType,
      title: button.dataset.fileTitle,
    };
    if (
      await command({
        ...spec,
        fields: spec.fields.map((field) =>
          field.name in filled ? { ...field, value: filled[field.name] } : field,
        ),
      })
    ) {
      // Re-read the library so the checklist reflects the new document at once.
      const customerId = filled.customerId;
      if (customerId && evidenceDetail) {
        try {
          const library = await api.read(`/v1/bid-on/customers/${customerId}/evidence`, 'BID_SERVICES', 'COMMERCIAL_L3');
          render(evidenceDetail, evidencePanel(library, customerId));
        } catch {
          /* the next open will show it */
        }
      }
    }
  });

  root.querySelector('#ev-open')?.addEventListener('click', async () => {
    const customerId = chosenCustomer();
    if (!customerId || !evidenceDetail) return;
    try {
      const library = await api.read(
        `/v1/bid-on/customers/${customerId}/evidence`,
        'BID_SERVICES',
        'COMMERCIAL_L3',
      );
      render(evidenceDetail, evidencePanel(library, customerId));
    } catch (error) {
      render(evidenceDetail, notice(`The library could not be read: ${error.message}`, 'err'));
    }
  });

  /*
   * The hash of a filed document, onto the clipboard.
   *
   * Delegated on the page rather than bound to the rows, because the library
   * panel is rendered after this handler is attached and again every time a
   * different customer is opened — binding per row would work once.
   */
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const value = button.dataset.copy;
    const what = button.dataset.copyWhat ?? 'value';
    try {
      await navigator.clipboard?.writeText(value);
      toast('Copied', `The ${what} is on the clipboard. Paste it into the command that asks for it.`, 'ok');
    } catch {
      // A browser that refuses clipboard access is not a failure to report as
      // one: the value is on the element's own tooltip and printed in the row,
      // so there is still a way to read it.
      toast('Not copied', `This browser would not write to the clipboard. The full ${what} is in the tooltip.`, 'warn');
    }
  });

  /*
   * The paid search.
   *
   * A POST, because it embeds the question and that is a model call. The answer
   * carries which method actually ran and how many passages were not compared,
   * and the panel shows both — a semantic search that silently skipped a
   * library looks exactly like a library with nothing in it.
   */
  root.querySelector('#ev-semantic')?.addEventListener('click', async () => {
    const customerId = chosenCustomer();
    const question = root.querySelector('#ev-question')?.value?.trim();
    const button = root.querySelector('#ev-semantic');
    if (!customerId || !evidenceDetail) return;
    if (!question) {
      render(
        evidenceDetail,
        notice('Type the question first. Embedding two words costs the same and ranks against everything equally badly.', 'warn'),
      );
      return;
    }
    button.disabled = true;
    try {
      // Quoted before it runs, the same rule every other AI action here keeps,
      // and the same `/v1/ai/quote` the command panel uses. A search is a
      // small spend and a small spend nobody was shown is still a surprise on
      // an invoice.
      const quote = await quoteAction(`/v1/bid-on/customers/${customerId}/retrieval`);
      render(
        evidenceDetail,
        html`<div class="notice ${raw(quote.affordable ? 'info' : 'warn')}" style="margin-top:11px"><div>
          <b>Ranking by meaning costs ${money(quote.estimatedChargeMinor)}.</b>
          ${quote.summary ?? ''}
          ${quote.affordable
            ? html`<div style="margin-top:8px">
                <button class="btn sm" id="ev-semantic-go" data-customer="${customerId}">Run it</button>
              </div>`
            : html`<div style="margin-top:4px">There is not enough in the wallet to run it.</div>`}
        </div></div>`,
      );
    } catch (error) {
      // A denial, an unconfigured deployment and an unpaid deposit are all
      // shown as what they are. "Semantic search is off on this deployment"
      // names the variable that turns it on; an empty panel would read as
      // "nothing found", which is a different and false statement.
      render(evidenceDetail, notice(error.detail ?? error.message, 'err'));
    } finally {
      button.disabled = false;
    }
  });

  /* The second press, which is the one that spends. */
  root.addEventListener('click', async (event) => {
    const go = event.target.closest('#ev-semantic-go');
    if (!go || !evidenceDetail) return;
    const question = root.querySelector('#ev-question')?.value?.trim();
    if (!question) return;
    go.disabled = true;
    go.textContent = 'Searching…';
    try {
      const result = await api.post(`/v1/bid-on/customers/${go.dataset.customer}/retrieval`, { question });
      render(evidenceDetail, retrievalPanel(result));
    } catch (error) {
      render(evidenceDetail, notice(error.detail ?? error.message, 'err'));
    }
  });

  root.querySelector('#ev-retrieve')?.addEventListener('click', async () => {
    const customerId = chosenCustomer();
    const question = root.querySelector('#ev-question')?.value?.trim();
    if (!customerId || !evidenceDetail) return;
    if (!question) {
      render(
        evidenceDetail,
        notice('Type the question first. Retrieval ranks against a question; with none it has nothing to rank.', 'warn'),
      );
      return;
    }
    try {
      const result = await api.read(
        `/v1/bid-on/customers/${customerId}/retrieval?question=${encodeURIComponent(question)}`,
        'BID_SERVICES',
        'COMMERCIAL_L3',
      );
      render(evidenceDetail, retrievalPanel(result));
    } catch (error) {
      render(evidenceDetail, notice(`Retrieval was refused: ${error.message}`, 'err'));
    }
  });

  const COMMANDS = {
    'import-tender-rate-card': {
      title: 'Import a rate card for this tender',
      intent:
        'Load your rates for one bid in a paste or a CSV file. They are held for this tender only — available to ' +
        'price this bid and never saved to your permanent rate library, because a one-off customer’s rates are not ' +
        'your house rates. Import them again on any future tender that needs them. A line it cannot read is reported.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/rate-card/import`,
      submitLabel: 'Import for this tender',
      fields: [
        {
          name: 'bidId',
          label: 'Bid',
          type: 'select',
          options: bidList.map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.buyerName} · ${humanise(bid.status)}` })),
          hint: 'The tender these rates are for. They stay with this bid and no other.',
        },
        {
          name: 'cardFile',
          label: 'Choose a CSV file',
          type: 'textfile',
          into: 'card',
          accept: '.csv,.tsv,.txt',
          required: false,
          parse: csvRateCardToLines,
          hint:
            'Export your price list as CSV (Save As → CSV) and choose it — its columns are read into the box below ' +
            'for you to check before importing. Or skip this and paste into the box.',
        },
        {
          name: 'card',
          label: 'The rate card, one rate per line',
          type: 'textarea',
          rows: 10,
          placeholder:
            'E20.007, Facing-brick outer leaf, m2, 145\nF10.001, Blockwork inner leaf 100mm, m2, 62\nR10.004, Readymix GEN3, m3, 148, supply and place',
          hint:
            'code, description, unit, rate — and an optional note at the end. The code may be left off. Rate is £ per ' +
            'unit. Or paste spreadsheet columns (tab-separated), which keeps a description’s own commas whole. Blank ' +
            'lines are skipped; a line missing a description, unit or rate is reported back.',
        },
      ],
      validate: (v) => {
        const lines = String(v.card ?? '').split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
        if (lines.length === 0) {
          return {
            field: 'card',
            message: 'Paste at least one rate line, or choose a CSV file. The grey example is a format guide, not content.',
          };
        }
        return undefined;
      },
      transform: (v) => ({ entries: parseRateCardEntries(v.card) }),
      report: (res) =>
        rateCardReport(
          res,
          'Held for this tender only — available to price this bid, and not saved to your permanent rate library.',
        ),
    },
    'open-customer': {
      title: 'Open a customer workspace',
      intent:
        'One workspace per external customer. Its evidence, its company profile and its declarations live inside it ' +
        'and are visible only to the staff assigned and to that customer’s own people. Two workspaces for one firm ' +
        'is how its evidence library ends up split in half, so a duplicate legal name is refused.',
      path: '/v1/bid-on/customers',
      submitLabel: 'Open',
      fields: [
        { name: 'legalName', label: 'Legal name', type: 'text',
          hint: 'As it appears on the questionnaire — a prequalification asks for the registered name, not the trading one.' },
        { name: 'companyNumber', label: 'Company number', type: 'text', required: false },
        { name: 'headcount', label: 'Headcount', type: 'number', required: false },
        { name: 'turnoverBand', label: 'Turnover band', type: 'text', required: false,
          hint: 'As the customer states it. Most questionnaires ask for a band rather than a figure.' },
        { name: 'sicCodes', label: 'SIC codes', type: 'text', required: false, hint: 'Comma separated.' },
        { name: 'sectors', label: 'Sectors it bids in', type: 'text', required: false,
          hint: 'Comma separated — "energy, grid, utilities". Used to frame answers for the buyer.' },
        { name: 'regions', label: 'Regions it works in', type: 'text', required: false, hint: 'Comma separated.' },
      ],
      transform: (v) => ({
        legalName: v.legalName,
        ...(String(v.companyNumber ?? '').trim() ? { companyNumber: String(v.companyNumber).trim() } : {}),
        ...(String(v.headcount ?? '').trim() === '' ? {} : { headcount: Number(v.headcount) }),
        ...(String(v.turnoverBand ?? '').trim() ? { turnoverBand: String(v.turnoverBand).trim() } : {}),
        ...listOf(v.sicCodes, 'sicCodes'),
        ...listOf(v.sectors, 'sectors'),
        ...listOf(v.regions, 'regions'),
      }),
    },
    'assign-staff': {
      title: 'Assign staff to a customer',
      intent:
        'Restrictive by default: a new workspace is visible to nobody but whoever opened it. The opposite default — ' +
        'everybody sees everything unless excluded — is one forgotten exclusion away from a competitor’s evidence on ' +
        'the wrong screen, and nothing about that failure is visible until it matters.',
      path: (v) => `/v1/bid-on/customers/${v.customerId}/staff`,
      submitLabel: 'Assign',
      fields: [
        { name: 'customerId', label: 'Customer', type: 'select', options: customerOptions },
        { name: 'add', label: 'Give access to', type: 'text', required: false,
          hint: 'Comma-separated user ids. Each one will be able to read this customer’s evidence.' },
        { name: 'remove', label: 'Take access from', type: 'text', required: false,
          hint: 'Comma separated. Whoever opened the workspace keeps access — the record already says they created it.' },
      ],
      transform: ({ customerId: _c, add, remove }) => ({
        ...listOf(add, 'add'),
        ...listOf(remove, 'remove'),
      }),
    },
    'invite-guest': {
      title: 'Invite the customer’s own people',
      intent:
        'A guest sees exactly one workspace — their own. One account cannot be a guest of two of this provider’s ' +
        'customers, because that would be two competitors’ evidence behind one login. Only the customer’s admin can ' +
        'confirm a declaration; a contributor uploads evidence and comments.',
      path: (v) => `/v1/bid-on/customers/${v.customerId}/guests`,
      submitLabel: 'Invite',
      fields: [
        { name: 'customerId', label: 'Customer', type: 'select', options: customerOptions },
        { name: 'actorId', label: 'User id', type: 'text' },
        { name: 'organisation', label: 'Their company', type: 'text',
          hint: 'Recorded on every declaration they confirm, so the record is readable years later.' },
        { name: 'role', label: 'Role', type: 'select',
          options: [
            { value: 'CUSTOMER_ADMIN', label: 'Customer Admin — speaks for the company, confirms declarations' },
            { value: 'CUSTOMER_CONTRIBUTOR', label: 'Customer Contributor — uploads evidence and comments' },
          ] },
      ],
      transform: ({ customerId: _c, ...rest }) => rest,
    },
    'update-profile': {
      title: 'Update a customer’s standing facts',
      intent:
        'The first twenty questions of every prequalification — registered name, company number, headcount, turnover ' +
        'band, SIC codes, sectors, regions. Answered once here so nobody retypes them per bid. The customer’s own ' +
        'people can keep these current too; whoever last changed them is recorded.',
      path: (v) => `/v1/bid-on/customers/${v.customerId}/profile`,
      method: 'PUT',
      submitLabel: 'Save',
      fields: [
        { name: 'customerId', label: 'Customer', type: 'select', options: customerOptions },
        { name: 'legalName', label: 'Legal name', type: 'text', required: false },
        { name: 'companyNumber', label: 'Company number', type: 'text', required: false },
        { name: 'headcount', label: 'Headcount', type: 'number', required: false },
        { name: 'turnoverBand', label: 'Turnover band', type: 'text', required: false },
        { name: 'sicCodes', label: 'SIC codes', type: 'text', required: false, hint: 'Comma separated.' },
        { name: 'sectors', label: 'Sectors it bids in', type: 'text', required: false, hint: 'Comma separated.' },
        { name: 'regions', label: 'Regions it works in', type: 'text', required: false, hint: 'Comma separated.' },
      ],
      // Only what was actually answered. Sending an empty string would replace
      // a recorded company number with nothing because the field was left
      // blank, which is the browser inventing an answer nobody gave.
      transform: ({ customerId: _c, legalName, companyNumber, headcount, turnoverBand, sicCodes, sectors, regions }) => ({
        ...(String(legalName ?? '').trim() ? { legalName: String(legalName).trim() } : {}),
        ...(String(companyNumber ?? '').trim() ? { companyNumber: String(companyNumber).trim() } : {}),
        ...(String(headcount ?? '').trim() === '' ? {} : { headcount: Number(headcount) }),
        ...(String(turnoverBand ?? '').trim() ? { turnoverBand: String(turnoverBand).trim() } : {}),
        ...listOf(sicCodes, 'sicCodes'),
        ...listOf(sectors, 'sectors'),
        ...listOf(regions, 'regions'),
      }),
    },
    'close-customer': {
      title: 'Close a customer workspace',
      intent:
        'Nothing is deleted and its bids stay readable. Refused while an engagement is still open — closing the ' +
        'customer under live work would leave a fee running and nobody accountable for it.',
      path: (v) => `/v1/bid-on/customers/${v.customerId}/close`,
      submitLabel: 'Close',
      fields: [
        { name: 'customerId', label: 'Customer', type: 'select', options: customerOptions },
        { name: 'reason', label: 'Why', type: 'text' },
      ],
      transform: ({ customerId: _c, ...rest }) => rest,
    },

    'define-offering': {
      title: 'Define a service',
      intent:
        'The provider’s own catalogue. Picking a service when opening an engagement pre-fills the type, fee, billing ' +
        'basis, deposit and deliverables — and every one of them can still be changed per customer.',
      path: '/v1/bid-on/offerings',
      submitLabel: 'Define',
      fields: [
        { name: 'name', label: 'Service', type: 'text',
          hint: 'As it is sold — "UVDB / prequalification pack", "Tender quality submission", "Bid retainer".' },
        { name: 'engagementType', label: 'Engagement type', type: 'select',
          options: Object.entries(TYPE_MEANING).map(([value, meaning]) => ({ value, label: `${humanise(value)} — ${meaning}` })) },
        { name: 'billingBasis', label: 'Billing basis', type: 'select',
          options: ['FIXED_FEE', 'MONTHLY', 'PER_CYCLE', 'PER_STAGE', 'AS_AGREED'].map((value) => ({ value, label: humanise(value) })),
          hint: 'It has to fit the type: a staged engagement billed monthly has no answer to "what does the next stage cost".' },
        { name: 'defaultFee', label: 'Starting price', type: 'number',
          hint: 'In whole currency units. The starting point, not the price — every engagement can be priced per customer.' },
        { name: 'currency', label: 'Currency', type: 'text', value: 'GBP', placeholder: 'GBP' },
        { name: 'depositPercent', label: 'Deposit (%)', type: 'number', required: false },
        { name: 'deliverables', label: 'What the customer gets', type: 'textarea', rows: 4,
          hint: 'One per line. A service with no stated deliverables is a price with nothing attached, and it is the provider who loses that argument.' },
        { name: 'rubricScheme', label: 'Scoring rubric', type: 'text', required: false,
          hint: 'The buyer-side scheme answers under this service are scored against.' },
      ],
      transform: (v) => ({
        name: v.name,
        engagementType: v.engagementType,
        billingBasis: v.billingBasis,
        defaultFeeMinor: Math.round(Number(v.defaultFee) * 100),
        currency: String(v.currency ?? 'GBP').toUpperCase(),
        ...(String(v.depositPercent ?? '').trim() === '' ? {} : { depositPercent: Number(v.depositPercent) }),
        deliverables: String(v.deliverables ?? '').split('\n').map((l) => l.trim()).filter(Boolean),
        ...(String(v.rubricScheme ?? '').trim() ? { rubricScheme: String(v.rubricScheme).trim() } : {}),
      }),
    },
    'update-offering': {
      title: 'Reprice or withdraw a service',
      intent:
        'Engagements already signed keep their own copy of the terms and do not move. Withdrawing a service stops it ' +
        'being offered on a new engagement and changes nothing that is running.',
      path: (v) => `/v1/bid-on/offerings/${v.offeringId}`,
      method: 'PUT',
      submitLabel: 'Save',
      fields: [
        { name: 'offeringId', label: 'Service', type: 'select',
          options: offeringList.map((o) => ({ value: o.id, label: `${o.reference} — ${o.name}` })) },
        { name: 'defaultFee', label: 'New starting price', type: 'number', required: false },
        { name: 'active', label: 'Offered', type: 'select', required: false,
          options: [{ value: '', label: 'Leave as it is' }, { value: 'true', label: 'Offered' }, { value: 'false', label: 'Withdrawn' }] },
      ],
      transform: ({ offeringId: _o, defaultFee, active }) => ({
        ...(String(defaultFee ?? '').trim() === '' ? {} : { defaultFeeMinor: Math.round(Number(defaultFee) * 100) }),
        ...(String(active ?? '').trim() === '' ? {} : { active: active === 'true' }),
      }),
    },

    'create-bid': {
      title: 'Open a bid',
      intent:
        'A questionnaire or a tender, under one engagement. Refused for a paused, completed or cancelled ' +
        'engagement — which is what makes every ACU the bid later spends attributable to a customer and a piece of ' +
        'commercial work. A bid started here needs no tender in the standard section and never appears there.',
      path: '/v1/bid-on/bids',
      submitLabel: 'Open',
      fields: [
        { name: 'engagementId', label: 'Engagement', type: 'select',
          options: liveEngagements
            .filter((entry) => entry.openForWork)
            .map((entry) => ({ value: entry.id, label: engagementLabel(entry) })),
          hint: 'Only an engagement that is open for work. A draft or paused one accepts no bid.' },
        { name: 'buyerName', label: 'Buyer', type: 'text', hint: 'The organisation asking. It frames every answer.' },
        { name: 'scheme', label: 'Scheme', type: 'select',
          options: [
            { value: 'UVDB', label: 'UVDB — Achilles utilities' },
            { value: 'CONSTRUCTIONLINE', label: 'Constructionline' },
            { value: 'PAS91', label: 'PAS 91' },
            { value: 'SQ_PA23', label: 'Procurement Act standard selection questionnaire' },
            { value: 'ITT', label: 'ITT — a full invitation' },
            { value: 'CUSTOM', label: 'Something else' },
          ],
          hint: 'Which rubric the answers are scored against.' },
        { name: 'stage', label: 'Stage', type: 'select', required: false,
          options: [
            { value: '', label: 'One stage — a registration, an open ITT, a dynamic market' },
            { value: 'PQQ', label: 'PQQ — prequalification, with an ITT to follow if we get through' },
            { value: 'ITT', label: 'ITT — the tender stage' },
          ],
          hint:
            'A PQQ and the ITT after it are two submissions to one buyer about one job, with separate deadlines, ' +
            'separate question sets and separate clarification windows.' },
        { name: 'followsBidId', label: 'The PQQ it follows', type: 'select', required: false,
          options: [
            { value: '', label: 'Nothing — this is not a second stage' },
            ...bidList
              .filter((bid) => bid.stage === 'PQQ')
              .map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.buyerName}` })),
          ],
          hint: 'Links the ITT to the prequalification it came out of. Only that customer’s own PQQ is offered.' },
        { name: 'clarificationDeadline', label: 'Questions to the buyer close', type: 'date', required: false,
          hint:
            'The day they stop accepting questions — almost always weeks before the return, and the date nobody ' +
            'watches. Set it and everything here counts down to it rather than to the return.' },
        { name: 'deadline', label: 'Return deadline', type: 'date', required: false,
          hint:
            'The day the buyer reads it. Every certificate expiry is judged against this, not against today. Leave ' +
            'it blank only if you tick rolling below.' },
        { name: 'rolling', label: 'No return date', type: 'select', required: false,
          options: [
            { value: '', label: 'There is a return deadline' },
            { value: 'true', label: 'Rolling — a dynamic market or a maintained registration' },
          ],
          hint:
            'A dynamic market accepts applications at any point in its life, and a UVDB or Constructionline ' +
            'registration is maintained rather than returned. Neither has a return date, so a rolling bid is judged ' +
            'against the day it is read — which means its readiness moves on its own as certificates age.' },
        { name: 'buyerReference', label: 'Buyer’s reference', type: 'text', required: false },
        { name: 'qualityFloorPercent', label: 'Quality floor (%)', type: 'number', required: false, min: 0, max: 100,
          hint:
            'The score a mandatory answer must reach to export. Leave blank for 80, the green band. The gate enforces ' +
            'the mark this rubric can find, not the buyer’s own mark.' },
      ],
      transform: (v) => ({
        ...Object.fromEntries(
          Object.entries(v).filter(
            ([key, value]) => key !== 'rolling' && key !== 'qualityFloorPercent' && String(value ?? '').trim(),
          ),
        ),
        ...(v.rolling === 'true' ? { rolling: true } : {}),
        ...(String(v.qualityFloorPercent ?? '').trim() === ''
          ? {}
          : { qualityFloorPercent: Number(v.qualityFloorPercent) }),
      }),
    },
    'import-bid': {
      title: 'Import a tender as a bid',
      intent:
        'For a tender the standard section already holds. Read access to that tender there is checked separately ' +
        'from this module. One-way: the fields are copied, any file registered against the invitation comes over by ' +
        'its hash so the questionnaire can be read without uploading it again, nothing is written back, and a later ' +
        'change at source shows a banner rather than re-parsing anything. Where no file is registered there, you ' +
        'get the record and the deadline and still have to give the parser the questionnaire.',
      path: '/v1/bid-on/bids/import',
      submitLabel: 'Import',
      fields: [
        { name: 'tenderId', label: 'Tender', type: 'select',
          options: importableList.map((tender) => ({
            value: tender.tenderId,
            label: `${tender.reference || tender.tenderId} — ${tender.clientName}${
              tender.importedAs.length > 0 ? ` · already imported as ${tender.importedAs.map((entry) => entry.reference).join(', ')}` : ''
            }`,
          })),
          hint:
            'A second import off one invitation is allowed — a prequalification stage and a later ITT stage are two ' +
            'bids — so the label says what already exists.' },
        { name: 'engagementId', label: 'Engagement', type: 'select',
          options: liveEngagements
            .filter((entry) => entry.openForWork)
            .map((entry) => ({ value: entry.id, label: engagementLabel(entry) })),
          hint: 'An imported bid belongs to an engagement exactly as any other does.' },
        { name: 'scheme', label: 'Scheme', type: 'select', required: false,
          options: [
            { value: 'ITT', label: 'ITT — a full invitation' },
            { value: 'SQ_PA23', label: 'Procurement Act standard selection questionnaire' },
            { value: 'PAS91', label: 'PAS 91' },
            { value: 'UVDB', label: 'UVDB — Achilles utilities' },
            { value: 'CONSTRUCTIONLINE', label: 'Constructionline' },
            { value: 'CUSTOM', label: 'Something else' },
          ],
          hint: 'Which rubric the answers are scored against. An invitation is taken as an ITT unless you say otherwise.' },
        { name: 'documentIds', label: 'Only these documents', type: 'text', required: false,
          hint:
            'Comma separated, by the names the transmittal recorded. Blank carries all of them over, which is ' +
            'almost always what you want. This narrows the recorded list only — every file registered against the ' +
            'invitation comes over either way, because a hash the store already holds is the point of importing.' },
      ],
      transform: (v) => ({
        tenderId: v.tenderId,
        engagementId: v.engagementId,
        ...(String(v.scheme ?? '').trim() ? { scheme: v.scheme } : {}),
        ...listOf(v.documentIds, 'documentIds'),
      }),
    },
    'resync-bid': {
      title: 'Resync a bid with its source',
      intent:
        'Pulls the tender’s changes in: the deadline follows the source, because every certificate-expiry verdict in ' +
        'the pack is judged against it. Approved answers survive — only a question whose wording you give here as ' +
        'genuinely different goes back for review, and every version is kept. It takes the new wording rather than ' +
        're-reading the document, because re-reading is an agent run with a cost, and a button that silently spends ' +
        'money is a button nobody should press.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/resync`,
      submitLabel: 'Resync',
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: importedBids.map((bid) => ({
            value: bid.id,
            label: `${bid.reference} — ${bid.buyerName} · ${humanise(bid.status)}`,
          })),
          hint: 'Only a bid that was imported, and only one that has not been sent.' },
        { name: 'questions', label: 'Reworded questions', type: 'textarea', rows: 8, required: false,
          hint:
            'One per line as "number | the new wording", in the buyer’s own numbering. Leave it blank to take the ' +
            'deadline and the document list only: a question whose number moved or whose heading was retyped is the ' +
            'same question, and listing it here would throw away a good answer over a typo.' },
      ],
      transform: ({ questions }) => {
        const lines = String(questions ?? '')
          .split('\n')
          .map((line) => line.split('|').map((part) => part.trim()))
          .filter((parts) => parts.length >= 2 && parts[0] && parts[1])
          .map((parts) => ({ number: parts[0], text: parts[1] }));
        return lines.length > 0 ? { questions: lines } : {};
      },
    },
    'embed-evidence': {
      title: 'Make an item searchable by meaning',
      intent:
        'Embeds one item’s passages so a question finds them by meaning rather than by shared words. A one-off cost ' +
        'per item, quoted before it runs, and refused if the same model has already done it — that would be the ' +
        'same vectors and a second charge. Items are never compared across models: a cosine between two models’ ' +
        'vectors is not a weaker score, it is a number with no meaning. There is no stand-in on this one, because a ' +
        'made-up vector ranks and scores exactly like a real one and nobody could tell.',
      path: (v) => `/v1/bid-on/evidence/${v.evidenceId}/embedding`,
      submitLabel: 'Embed',
      fields: [
        haveDocuments
          ? { name: 'evidenceId', label: 'The document', type: 'select',
              // Only what can actually be embedded. An item with no passages
              // is offered nowhere rather than offered and refused.
              options: documentOptions((item) => item.read), placeholder: 'Choose a document that has been read',
              hint: 'Only documents something has been read out of. Read one first and it appears here.' }
          : { name: 'evidenceId', label: 'Evidence id', type: 'text',
              hint: 'Nothing is filed yet.' },
      ],
      transform: () => ({}),
      ai: true,
    },
    'raise-clarification': {
      title: 'Raise a question for the buyer',
      intent:
        'The module raises most of these itself — a question with no stated limit, a returnable with no stated ' +
        'format, an amendment that shifts a risk. This is the door for the ones only a reader finds. It is a ' +
        'question to ask, not a note to keep: a clarification nobody sent is worth nothing, and a buyer’s window ' +
        'for them shuts well before the return.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/clarifications`,
      submitLabel: 'Raise',
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.buyerName}` })) },
        { name: 'severity', label: 'How much it matters', type: 'select',
          options: [
            { value: 'CRITICAL', label: 'Critical — we cannot price or insure it as it stands' },
            { value: 'MAJOR', label: 'Major — it changes what we would commit to' },
            { value: 'MINOR', label: 'Minor — it changes how we answer' },
          ] },
        { name: 'subject', label: 'Subject', type: 'text',
          hint: 'Short. One subject per question — two questions about one subject invites two answers to reconcile.' },
        { name: 'question', label: 'The question, as you would ask it', type: 'textarea', rows: 5,
          hint: 'In the words it will be sent in. Buyers usually issue clarification answers to every bidder.' },
      ],
      transform: ({ bidId: _b, ...rest }) => rest,
    },
    'clarification-asked': {
      title: 'Record that we asked it',
      intent:
        'The date is the point. A clarification is only worth having if it reached the buyer before their window ' +
        'shut, and that date is almost always weeks before the return. Recorded even where it went late — that is ' +
        'a fact, and a buyer may or may not answer a late question.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/clarifications/${v.clarificationId}/asked`,
      submitLabel: 'Record',
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList
            .filter((bid) => bid.clarifications > 0)
            .map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.clarifications} to ask` })) },
        { name: 'clarificationId', label: 'Question id', type: 'text', hint: 'From the opened pack above.' },
        { name: 'askedOn', label: 'The day it went', type: 'date', required: false,
          hint: 'Blank is today. Put the real date if you are recording it after the fact.' },
        { name: 'buyerReference', label: 'Their reference', type: 'text', required: false,
          hint: 'The buyer’s own number for it, which is what their answer will quote back.' },
      ],
      transform: ({ bidId: _b, clarificationId: _c, ...rest }) =>
        Object.fromEntries(Object.entries(rest).filter(([, value]) => String(value ?? '').trim())),
    },
    'clarification-answer': {
      title: 'Record the buyer’s answer',
      intent:
        'In their words, verbatim. A buyer’s answer to a clarification is part of the tender documents from the ' +
        'moment they give it — usually issued to every bidder — so a paraphrase of it is a new claim with nobody’s ' +
        'name on it. What the answer changes is a separate act: a stated limit goes on the question, a waived ' +
        'document on the register, a moved date on the bid.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/clarifications/${v.clarificationId}/answer`,
      submitLabel: 'Record',
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.buyerName}` })) },
        { name: 'clarificationId', label: 'Question id', type: 'text' },
        { name: 'answer', label: 'What they said', type: 'textarea', rows: 6,
          hint: 'Verbatim. Not a summary.' },
        { name: 'answeredOn', label: 'The day they answered', type: 'date', required: false },
      ],
      transform: ({ bidId: _b, clarificationId: _c, ...rest }) =>
        Object.fromEntries(Object.entries(rest).filter(([, value]) => String(value ?? '').trim())),
    },
    'clarification-withdraw': {
      title: 'Withdraw a question',
      intent:
        'For one that will not be asked. The reason is required because the module raises most of these itself and ' +
        'will raise the same subject again next time a register is added to — the withdrawal is what stops that, so ' +
        'it has to say why. Otherwise the next person sees a dropped question with no way to know whether it was ' +
        'answered elsewhere, judged irrelevant, or simply missed.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/clarifications/${v.clarificationId}/withdraw`,
      submitLabel: 'Withdraw',
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.buyerName}` })) },
        { name: 'clarificationId', label: 'Question id', type: 'text' },
        { name: 'reason', label: 'Why it will not be asked', type: 'textarea', rows: 3 },
      ],
      transform: ({ bidId: _b, clarificationId: _c, ...rest }) => rest,
    },
    'record-returnables': {
      title: 'Record what has to be returned',
      intent:
        'The half of a submission that is not answers. An order form to sign, a cost model the customer prices, a ' +
        'schedule of amendments to accept or qualify — a submission missing one of those is rejected exactly as ' +
        'completely as one missing an answer, and none of it shows in a readiness percentage. Adds to the register ' +
        'rather than replacing it, because these are found across nine documents over an afternoon.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/returnables`,
      submitLabel: 'Record it',
      /*
       * One returnable, in fields.
       *
       * This was a textarea taking nine values separated by pipes, with the
       * format explained in a hint underneath. Somebody recording their first
       * one read the hint as a set of prompts and answered them a line at a
       * time —
       *
       *     Ref — RFX1000209
       *     M — EPC Assessments
       *     CUSTOMER — JCC
       *     SIG — Justin Nseya
       *     Your own date — 24/11/2026
       *
       * — which is an entirely reasonable reading of a blank box under an
       * explanation, and produced "must contain at least 1 item(s)". Four of
       * those five lines are also answering the wrong question: `M` is a flag
       * rather than a name, `CUSTOMER` says who produces it rather than who
       * they are, and `SIG` says it needs signing rather than who signs.
       *
       * A format nobody can get wrong is better than a format explained well.
       * The register appends, so one per press is the natural shape — and the
       * bulk form is still there under its own command for somebody with nine
       * to enter at once.
       */
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.buyerName}` })) },
        { name: 'reference', label: 'Its reference', type: 'text',
          hint: 'The buyer’s own, so the register maps onto what you upload: a portal slot like 2.01, or APP3.' },
        { name: 'title', label: 'What it is', type: 'text',
          hint: 'As somebody checking the submission would name it — "Order form, completed and signed".' },
        { name: 'mandatory', label: 'Mandatory', type: 'checkbox', value: true,
          hint: 'Gates the export. A submission missing a mandatory return is rejected, not marked down.' },
        { name: 'owner', label: 'Who produces it', type: 'select',
          options: [
            { value: 'CUSTOMER', label: 'The customer — their rates, their signature, their certificate' },
            { value: 'PROVIDER', label: 'Us — we write it' },
          ],
          hint: 'A customer item goes into the request we send them.' },
        { name: 'signatureRequired', label: 'Needs signing', type: 'checkbox', required: false,
          hint: 'A lead time rather than a task: a document needing a director’s signature on the 30th cannot be started on the 30th.' },
        // A plain date, not `iso`: the register holds the day, and a timestamp
        // would be a precision nobody chose.
        { name: 'internalDueBy', label: 'Our own date', type: 'date', required: false,
          hint: 'Earlier than the buyer’s. With an afternoon close, ours is the only date that binds.' },
        { name: 'format', label: 'Format', type: 'text', required: false, hint: 'PDF, XLSX, native spreadsheet. Optional.' },
        { name: 'pageLimit', label: 'Page limit', type: 'number', required: false },
        { name: 'fileSizeLimitMb', label: 'Size limit in MB', type: 'number', required: false },
      ],
      transform: ({ bidId: _b, reference, title, mandatory, owner, signatureRequired, internalDueBy, format, pageLimit, fileSizeLimitMb }) => ({
        returnables: [
          {
            reference: String(reference).trim(),
            title: String(title).trim(),
            mandatory: mandatory === true,
            owner,
            ...(String(format ?? '').trim() ? { format: String(format).trim() } : {}),
            ...(pageLimit ? { pageLimit: Number(pageLimit) } : {}),
            ...(fileSizeLimitMb ? { fileSizeLimitMb: Number(fileSizeLimitMb) } : {}),
            ...(signatureRequired ? { signatureRequired: true } : {}),
            ...(internalDueBy ? { internalDueBy } : {}),
          },
        ],
      }),
    },
    'record-returnables-bulk': {
      title: 'Record several returnables at once',
      intent:
        'The same register, for somebody reading nine documents in an afternoon who would rather type than press a ' +
        'button nine times. One per line; anything the line does not carry is left unset. The field-by-field form ' +
        'is the one to use for a single item.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/returnables`,
      submitLabel: 'Record them',
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.buyerName}` })) },
        { name: 'returnables', label: 'One per line', type: 'textarea', rows: 10,
          placeholder:
            'APP2 | Order form, completed and signed | M | CUSTOMER | PDF | | | SIG | 2026-10-29\n' +
            'APP5 | EPC cost model, fully priced | M | CUSTOMER | XLSX | | | | 2026-10-30',
          hint:
            'ref | what it is | M or O | PROVIDER or CUSTOMER | format | pages | MB | SIG | our date. Only the ' +
            'first four matter; the rest may be blank, and the bars still have to be there for the blanks.' },
      ],
      validate: ({ returnables }) =>
        String(returnables ?? '')
          .split('\n')
          .some((line) => line.split('|').length >= 4 && line.split('|')[0].trim() && line.split('|')[1].trim())
          ? undefined
          : {
              field: 'returnables',
              message:
                'Each line needs at least "ref | what it is | M or O | PROVIDER or CUSTOMER", with the bars. One ' +
                'returnable per line, not one field per line — or use "Record what has to be returned", which asks ' +
                'for the fields one at a time.',
            },
      transform: ({ returnables }) => ({
        returnables: String(returnables ?? '')
          .split('\n')
          .map((line) => line.split('|').map((part) => part.trim()))
          .filter((parts) => parts.length >= 4 && parts[0] && parts[1])
          .map((parts) => ({
            reference: parts[0],
            title: parts[1],
            mandatory: String(parts[2] ?? '').toUpperCase().startsWith('M'),
            owner: String(parts[3] ?? 'PROVIDER').toUpperCase().startsWith('C') ? 'CUSTOMER' : 'PROVIDER',
            ...(parts[4] ? { format: parts[4] } : {}),
            ...(parts[5] ? { pageLimit: Number(parts[5]) } : {}),
            ...(parts[6] ? { fileSizeLimitMb: Number(parts[6]) } : {}),
            ...(String(parts[7] ?? '').toUpperCase().includes('SIG') ? { signatureRequired: true } : {}),
            ...(parts[8] ? { internalDueBy: parts[8] } : {}),
          })),
      }),
    },
    'supply-returnable': {
      title: 'Mark a returnable done',
      intent:
        'Point it at the filed item that is it wherever you can. A returnable citing its evidence can be checked by ' +
        'somebody else in ten seconds; one that merely says done can only be checked by asking whoever ticked it.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/returnables/${v.returnableId}/supplied`,
      submitLabel: 'Mark done',
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList
            .filter((bid) => bid.returnablesOutstanding > 0)
            .map((bid) => ({
              value: bid.id,
              label: `${bid.reference} — ${bid.buyerName} · ${bid.returnablesOutstanding} outstanding`,
            })),
          hint: 'Only a bid with something outstanding. Open the pack above and the register carries the ids.',
          emptyHint:
            'No bid has an outstanding returnable — either none has been recorded yet (Record what has to be ' +
            'returned), or everything recorded is already done or waived.' },
        { name: 'returnableId', label: 'Returnable id', type: 'text', hint: 'From the register in the opened pack.' },
        haveDocuments
          ? { name: 'evidenceId', label: 'The item that is it', type: 'select', required: false,
              options: documentOptions(), placeholder: 'A filed document, if one is it',
              hint: 'Strongly preferred over a bare note: a returnable backed by a filed document is one a reviewer can open.' }
          : { name: 'evidenceId', label: 'The item that is it', type: 'text', required: false,
              hint: 'An evidence id from this customer’s own library. Strongly preferred over a bare note.' },
        { name: 'note', label: 'Note', type: 'text', required: false,
          hint: 'Where it went, who signed it, which version.' },
      ],
      transform: ({ bidId: _b, returnableId: _r, ...rest }) =>
        Object.fromEntries(Object.entries(rest).filter(([, value]) => String(value ?? '').trim())),
    },
    'waive-returnable': {
      title: 'Waive a returnable',
      intent:
        'For one the buyer has confirmed is not required, or that does not apply to this bidder. It removes a gate, ' +
        'so it takes approval and the reason is mandatory — a waiver with no reason is indistinguishable from a ' +
        'document nobody chased, and the difference matters when a submission comes back rejected for a missing one.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/returnables/${v.returnableId}/waive`,
      submitLabel: 'Waive',
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList
            .filter((bid) => bid.returnablesOutstanding > 0)
            .map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.buyerName}` })) },
        { name: 'returnableId', label: 'Returnable id', type: 'text' },
        { name: 'reason', label: 'Why it is not required', type: 'textarea', rows: 3,
          hint: 'Name who confirmed it and when. This is what somebody reads if the submission is rejected for it.' },
      ],
      transform: ({ bidId: _b, returnableId: _r, ...rest }) => rest,
    },
    'review-amendments': {
      title: 'Read the schedule of amendments',
      intent:
        'An unamended standard form is a known quantity; the same contract with twenty amendments is a different ' +
        'contract, and the commonest way a term contract goes wrong is that nobody read them until the first ' +
        'dispute. This produces questions to ask the buyer and observations to put in front of whoever advises the ' +
        'customer. It accepts nothing, qualifies nothing and says nothing about whether a clause is enforceable — ' +
        'that decision binds a company, and no agent here reaches one. ' +
        'A document longer than one model request is read in parts and each part is a charge of its own, so a two-hundred-page bundle costs what two hundred pages cost rather than being refused.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/amendments`,
      submitLabel: 'Read it',
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.buyerName}` })) },
        { name: 'contractForm', label: 'The form it amends', type: 'text', required: false,
          hint: 'As the invitation names it — "JCT Measured Term Contract 2024". The reading is against the unamended form.' },
        /*
         * The document, chosen rather than typed.
         *
         * This panel was still asking for a hash as free text with the pasted
         * schedule above it, so being told "choose Appendix 3" and finding two
         * text boxes is the panel's fault. The questionnaire reader was given
         * a chooser and this one was not — the same command, the same library,
         * two different ways of naming a document.
         *
         * Ordered with the documents that look like contract prose first,
         * since that is what a schedule of amendments is, and the hint names
         * what it is for.
         */
        haveDocuments
          ? { name: 'hash', label: 'The schedule, as a filed document', type: 'select', required: false,
              options: documentOptions(), placeholder: 'Choose the filed schedule of amendments',
              hint: 'Appendix 3 on a JCT tender, or whatever the invitation calls its schedule of amendments. The ' +
                'contract particulars read the same way, so that document works here too.' }
          : { name: 'hash', label: 'Or the file’s hash', type: 'text', required: false,
              hint: 'File the document in the library first and it will be offered here by name.' },
        { name: 'text', label: 'Or paste the clauses', type: 'textarea', rows: 10, required: false,
          hint: 'For amendments that arrived in an email or a portal page rather than as a document.' },
      ],
      // One of the two, said here rather than by the platform after a round
      // trip: the command needs something to read.
      validate: ({ text, hash }) =>
        String(text ?? '').trim() || String(hash ?? '').trim()
          ? undefined
          : {
              field: 'hash',
              message: 'Choose the filed schedule, or paste the clauses below. Either will do.',
            },
      transform: ({ bidId: _b, anyway, ...rest }) => ({
        ...Object.fromEntries(Object.entries(rest).filter(([, value]) => String(value ?? '').trim())),
        ...(anyway ? { anyway: true } : {}),
      }),
      ai: true,
    },
    'confirm-questions': {
      title: 'Confirm the question list',
      intent:
        'Once, by a person, against the source document. A parser that missed one question produces a pack where ' +
        'every answer is good, readiness reads 100%, and the submission is rejected for a missing mandatory ' +
        'response — and nothing downstream can detect that, because what is wrong is the list itself.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/questions`,
      submitLabel: 'Confirm',
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList
            .filter((bid) => bid.questions === 0)
            .map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.buyerName}` })),
          emptyHint:
            'Every bid here already has a confirmed question list. A questionnaire that genuinely changed is a ' +
            'resync, which keeps approved answers and redrafts only the questions whose wording moved.',
          hint: 'Only a bid with no confirmed list. A questionnaire that genuinely changed is a resync.' },
        { name: 'questions', label: 'The questions', type: 'textarea', rows: 12,
          hint:
            'One per line as "section | number | question | type | limit | weight | M or O | PF". Type is text, ' +
            'yes_no, numeric, upload or table. Limit and weight may be blank. M is mandatory, O optional, PF ' +
            'pass/fail. The buyer’s own numbering, because the export has to match the source.' },
      ],
      transform: ({ questions }) => ({
        questions: String(questions ?? '')
          .split('\n')
          .map((line) => line.split('|').map((part) => part.trim()))
          .filter((parts) => parts.length >= 4 && parts[1] && parts[2])
          .map((parts) => ({
            section: parts[0] || 'General',
            number: parts[1],
            text: parts[2],
            answerType: String(parts[3] ?? 'text').toUpperCase().replace('-', '_'),
            ...(parts[4] ? { wordLimit: Number(parts[4]) } : {}),
            ...(parts[5] ? { weighting: Number(parts[5]) } : {}),
            mandatory: String(parts[6] ?? '').toUpperCase().startsWith('M'),
            passFail: String(parts[7] ?? '').toUpperCase().includes('PF'),
          })),
      }),
    },
    'record-answer': {
      title: 'Write an answer',
      intent:
        'A new version every time, because the version that went to a buyer is a promise the customer made. The same ' +
        'door an agent’s draft comes through, so an answer a bid writer rewrote by hand is checked exactly as hard ' +
        'as one nobody touched.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/answers`,
      submitLabel: 'Record',
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList
            .filter((bid) => bid.questions > 0)
            .map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.buyerName}` })) },
        { name: 'questionId', label: 'Question id', type: 'text',
          hint: 'From the opened pack above. Open the bid, and the question row carries it.' },
        { name: 'body', label: 'The answer', type: 'textarea', rows: 10,
          hint: 'One paragraph per line.' },
        { name: 'yesNo', label: 'For a yes/no question', type: 'select', required: false,
          options: [
            { value: '', label: 'Not a yes/no question' },
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No — this ends the bid at the gate' },
          ],
          hint: 'The hard rule that ends a bid on a "no" reads this field. Prose alone leaves it unanswered.' },
        { name: 'carriedFromBidId', label: 'Carried forward from this bid', type: 'text', required: false,
          hint:
            'Where you wrote this from an earlier approved answer. Both ids are on the candidate card in "What ' +
            'have we answered before?". Verified against that bid and this customer, so it is provenance rather ' +
            'than a label.' },
        { name: 'carriedFromAnswerId', label: '…and this answer', type: 'text', required: false },
      ],
      transform: ({ bidId: _b, body, yesNo, carriedFromBidId, carriedFromAnswerId, ...rest }) => ({
        ...rest,
        body: String(body ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
        ...(String(yesNo ?? '').trim() === '' ? {} : { yesNo: yesNo === 'true' }),
        ...(String(carriedFromBidId ?? '').trim() && String(carriedFromAnswerId ?? '').trim()
          ? { carriedFrom: { bidId: String(carriedFromBidId).trim(), answerId: String(carriedFromAnswerId).trim() } }
          : {}),
      }),
    },
    'parse-questionnaire': {
      title: 'Read the questionnaire',
      intent:
        'Reads a questionnaire into an ordered question list, keeping the buyer’s own numbering exactly as printed. ' +
        'It produces a proposal and nothing more: a person confirms the list against the source, because a parser ' +
        'that drops one question produces a pack where every answer is good and the submission is still rejected. ' +
        'The cost of the run is quoted before it starts. ' +
        'A document longer than one model request is read in parts and each part is a charge of its own, so a two-hundred-page bundle costs what two hundred pages cost rather than being refused.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/parse`,
      submitLabel: 'Read',
      ai: true,
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.filter((bid) => bid.questions === 0).map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.buyerName}` })),
          emptyHint:
            'Every bid here already has a confirmed list. Confirming happens once; a questionnaire that changed is ' +
            'a resync.' },
        haveDocuments
          ? { name: 'hash', label: 'The questionnaire, as a filed document', type: 'select', required: false,
              // Ranked, because the whole difficulty is knowing which of nine
              // documents holds the questions.
              options: documentOptions(() => true, { rankByQuestions: true }),
              placeholder: 'Choose the filed questionnaire',
              hint:
                'The document with the questions in it — the questionnaire, the selection questionnaire, or the ' +
                'section of the ITT that carries them. Not the specification, the schedule of amendments or the ' +
                'pricing schedule: those have no questions to find, and the amendments have a reader of their own. ' +
                'A PDF, a Word file or a spreadsheet is read directly; a scan goes to a model that can see.' }
          : { name: 'hash', label: 'Or a document hash', type: 'text', required: false,
              hint: 'File the questionnaire in the customer’s library first and it will be offered here by name.' },
        { name: 'text', label: 'Or paste it out of the portal', type: 'textarea', rows: 10, required: false,
          hint: 'For a portal that shows the questions on screen with nothing to download.' },
        { name: 'anyway', label: 'Read it anyway', type: 'checkbox', required: false,
          hint: 'A document with no numbered lines, no question marks and none of a questionnaire’s phrasing is ' +
            'refused before a model is called, so hunting through a library costs nothing. Tick this if you know ' +
            'better than that check does — it costs one call.' },
      ],
      /*
       * One of the two, named here rather than refused by the platform.
       *
       * Both fields are optional because either will do, which made the panel
       * look as though neither was needed — and pressing Read with both empty
       * produced `BID_ON_NOTHING_TO_PARSE` from the server, after a round trip,
       * about a form that had just been offered as complete.
       */
      validate: ({ text, hash }) =>
        String(text ?? '').trim() || String(hash ?? '').trim()
          ? undefined
          : {
              field: 'hash',
              message: 'Choose the filed questionnaire, or paste the questions into the box below. Either will do.',
            },
      transform: ({ bidId: _b, ...rest }) =>
        Object.fromEntries(Object.entries(rest).filter(([, value]) => String(value ?? '').trim())),
    },
    'draft-answer': {
      title: 'Draft an answer',
      intent:
        'Retrieval runs first, against this customer’s evidence only. If nothing in their library supports the ' +
        'question it raises a gap instead of drafting and costs nothing — a model asked to answer a question its ' +
        'evidence cannot support writes exactly the uncited claim that gets a submission thrown out. An answer that ' +
        'comes back citing nothing becomes a gap too. A question already waiting on the customer can still be ' +
        'drafted — tick the box and the model is told what is outstanding, and the answer carries the gap for ' +
        'whoever reviews it.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/draft`,
      submitLabel: 'Draft',
      ai: true,
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.filter((bid) => bid.questions > 0).map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.buyerName}` })),
          emptyHint: 'A bid appears here once its question list is confirmed. Open the bid, read the proposed list against the source document and press Confirm — or confirm a list by hand. Nothing can be drafted against a list nobody has checked.' },
        { name: 'questionId', label: 'Question id', type: 'text', hint: 'From the opened pack above.' },
        { name: 'reviewerInstructions', label: 'Anything the drafter should know', type: 'textarea', rows: 2, required: false,
          hint: 'A rejected answer already carries the reviewer’s instructions; this is for anything else.' },
        { name: 'overOpenGap', label: 'Draft it even though the customer has not come back', type: 'checkbox', required: false,
          hint: 'For a question with an open gap. The draft writes what is evidenced, leaves the rest outstanding, ' +
            'and says on the answer that it was written over the gap. Two days before a return this is usually the ' +
            'right call; it is yours to make, not the platform’s.' },
      ],
      transform: ({ bidId: _b, reviewerInstructions, overOpenGap, ...rest }) => ({
        ...rest,
        ...(String(reviewerInstructions ?? '').trim()
          ? { reviewerInstructions: String(reviewerInstructions).trim() }
          : {}),
        ...(overOpenGap ? { overOpenGap: true } : {}),
      }),
      /*
       * A gap is not a draft, and must not be reported as one.
       *
       * This command answers with an outcome: it either wrote something it can
       * cite, or it found nothing it could cite and raised a gap instead. Both
       * are a 200 — both are the platform working correctly — and both used to
       * produce the same green "Recorded in the Golden Thread". So somebody who
       * pressed Draft, paid for a retrieval and received no draft at all was
       * told in green that their draft was recorded, and went looking for it.
       */
      report: (result) => {
        const how =
          result.retrieval?.method === 'TERM_OVERLAP'
            ? ' The library is not embedded, so this was a word search' +
              (result.retrieval.skipped > 0 ? ` and ${result.retrieval.skipped} passage(s) were not compared` : '') +
              ' — the answer may be on file in words the question does not use. Making the library searchable by ' +
              'meaning is worth doing before deciding it is missing.'
            : '';
        return result.outcome === 'GAP_RAISED'
          ? {
              title: 'No draft — a gap was raised',
              message:
                'Nothing on file could be cited for this question, so nothing was written: a model asked to answer ' +
                'from evidence it has not got writes the uncited claim that gets a submission thrown out. The gap ' +
                'is on the bid, with the request to send to the customer.' +
                how,
              tone: 'warn',
            }
          : {
              title: 'Drafted',
              message:
                'A version is written and cited, waiting to be scored. Read it against the question before you ' +
                'sign it.' + how,
              tone: 'ok',
            };
      },
    },
    'rescore-answer': {
      title: 'Score it as the buyer would',
      intent:
        'A separate call with a separate prompt, given the answer and the question but not the retrieval — a scorer ' +
        'that saw the retrieval would be marking the drafter’s homework against the drafter’s own notes. Where the ' +
        'same provider drafted and scored, the run says so rather than implying independence it does not have.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/answers/${v.answerId}/rescore`,
      submitLabel: 'Score',
      ai: true,
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.buyerName}` })) },
        { name: 'answerId', label: 'Answer id', type: 'text' },
      ],
      transform: () => ({}),
    },
    'gap-request': {
      title: 'Write the request to the customer',
      intent:
        'Turns every open gap into one message they can answer in a sitting. Twelve separate emails over three days ' +
        'is how a customer stops replying. The gaps are already on the record; this writes the covering note in ' +
        'their language rather than the bid team’s, and changes nothing.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/gap-request`,
      submitLabel: 'Write it',
      ai: true,
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.filter((bid) => bid.openGaps > 0).map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.openGaps} open` })),
          emptyHint: 'No bid has an open gap. A gap is raised by the drafter when the evidence cannot support a question, or by hand.' },
      ],
      transform: () => ({}),
    },
    'score-answer': {
      title: 'Score an answer',
      intent:
        'A separate act from writing it, so the drafter cannot grade its own work — the route that records an answer ' +
        'carries no score field at all. Every criterion needs the reason a reviewer would argue with, because a ' +
        'score nobody can argue with is a score a reviewer ignores.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/answers/${v.answerId}/score`,
      submitLabel: 'Score',
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.buyerName}` })) },
        { name: 'answerId', label: 'Answer id', type: 'text', hint: 'From the opened pack above.' },
        { name: 'compliance', label: 'Compliance (30%)', type: 'number',
          hint: 'Is every part of the question answered, in the order asked?' },
        { name: 'complianceWhy', label: 'Why', type: 'text' },
        { name: 'evidence', label: 'Evidence (25%)', type: 'number',
          hint: 'Is every claim cited to an in-date item, with no unsupported claim?' },
        { name: 'evidenceWhy', label: 'Why', type: 'text' },
        { name: 'relevance', label: 'Buyer relevance (20%)', type: 'number' },
        { name: 'relevanceWhy', label: 'Why', type: 'text' },
        { name: 'specificity', label: 'Specificity (15%)', type: 'number' },
        { name: 'specificityWhy', label: 'Why', type: 'text' },
        { name: 'clarity', label: 'Clarity and limits (10%)', type: 'number' },
        { name: 'clarityWhy', label: 'Why', type: 'text' },
      ],
      transform: (v) => ({
        scores: {
          COMPLIANCE: Number(v.compliance),
          EVIDENCE: Number(v.evidence),
          BUYER_RELEVANCE: Number(v.relevance),
          SPECIFICITY: Number(v.specificity),
          CLARITY_AND_LIMITS: Number(v.clarity),
        },
        reasons: {
          COMPLIANCE: String(v.complianceWhy ?? ''),
          EVIDENCE: String(v.evidenceWhy ?? ''),
          BUYER_RELEVANCE: String(v.relevanceWhy ?? ''),
          SPECIFICITY: String(v.specificityWhy ?? ''),
          CLARITY_AND_LIMITS: String(v.clarityWhy ?? ''),
        },
      }),
    },
    'approve-answer': {
      title: 'Approve an answer',
      intent:
        'Refused for whoever wrote it, where a person wrote it. Where an agent drafted it, a reviewer signing is the ' +
        'two-person check; where a person wrote it, the same person approving is one person at both ends of a ' +
        'statement going to a buyer. An override is permitted with the reason that justifies it, and cannot clear a ' +
        'hard rule.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/answers/${v.answerId}/approve`,
      submitLabel: 'Approve',
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.buyerName}` })) },
        { name: 'answerId', label: 'Answer id', type: 'text', hint: 'From the opened pack above.' },
        { name: 'note', label: 'What you checked', type: 'textarea', rows: 2,
          hint: '"Figures reconciled to the 2026 accounts" is a check. "OK" is a signature on nothing.' },
        { name: 'overrideScore', label: 'Override the score', type: 'number', required: false },
        { name: 'overrideReason', label: 'Why the scorer was wrong', type: 'text', required: false },
      ],
      transform: ({ bidId: _b, answerId: _a, overrideScore, overrideReason, ...rest }) => ({
        ...rest,
        ...(String(overrideScore ?? '').trim() === ''
          ? {}
          : { overrideScore: Number(overrideScore), overrideReason: String(overrideReason ?? '').trim() }),
      }),
    },
    'reject-answer': {
      title: 'Reject with instructions',
      intent:
        'The instructions are mandatory and are the point: a rejection with none is a round trip that produces the ' +
        'same answer again. They go back to the drafter attached to the answer.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/answers/${v.answerId}/reject`,
      submitLabel: 'Reject',
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.buyerName}` })) },
        { name: 'answerId', label: 'Answer id', type: 'text' },
        { name: 'instructions', label: 'What has to change', type: 'textarea', rows: 3 },
      ],
      transform: ({ bidId: _b, answerId: _a, ...rest }) => rest,
    },
    'evidence-needs': {
      title: 'Work out what this pack needs',
      intent:
        'Before a word is drafted. It reads the confirmed question list against this customer’s library and says ' +
        'what answering each question will take — the CPD matrix, the accreditation certificate, the three case ' +
        'studies, the audit outcomes — marks off what is already filed, and raises a gap naming everything that ' +
        'is not. Then "Write the request to the customer" turns the lot into one message. Run this first: the ' +
        'alternative is finding out what was missing by paying for a draft that could not have been evidenced, one ' +
        'question at a time.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/evidence-needs`,
      submitLabel: 'Work it out',
      ai: true,
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.filter((bid) => bid.questions > 0).map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.questions} question(s)` })),
          emptyHint:
            'A bid appears here once its question list is confirmed — that list is what this reads. Open the bid, ' +
            'check the proposed questions against the source document and press Confirm.' },
      ],
      transform: () => ({}),
      report: (result) => ({
        title: result.raised > 0 ? `${result.raised} question(s) now have a gap` : 'Nothing further is needed',
        message: result.summary,
        tone: result.raised > 0 ? 'warn' : 'ok',
      }),
    },
    'raise-gap': {
      title: 'Raise a gap',
      intent:
        'Something nobody can answer from the evidence held. It pauses its own question and nothing else, so the ' +
        'rest of the pack keeps drafting while the customer is asked. Gaps are batched into one list per bid rather ' +
        'than an email per question.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/gaps`,
      submitLabel: 'Raise',
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.buyerName}` })) },
        { name: 'questionId', label: 'Question id', type: 'text' },
        { name: 'promptToClient', label: 'What to ask the customer', type: 'textarea', rows: 3,
          hint:
            'Written for them, not for you. "Social value evidence missing" is a note to self; "how many ' +
            'apprenticeship starts and completions in 2026" is something somebody can answer.' },
      ],
      transform: ({ bidId: _b, ...rest }) => rest,
    },
    'resolve-gap': {
      title: 'Close a gap',
      intent:
        'By filing evidence, which is the useful case, or by answering in text where there is no document. The ' +
        'customer’s own people may do this — it is their material.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/gaps/${v.gapId}/resolve`,
      submitLabel: 'Close',
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.filter((bid) => bid.openGaps > 0).map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.openGaps} open` })) },
        { name: 'gapId', label: 'Gap id', type: 'text', hint: 'From the opened pack above.' },
        haveDocuments
          ? { name: 'evidenceId', label: 'Evidence filed to close it', type: 'select', required: false,
              options: documentOptions(), placeholder: 'The document that closes it, if there is one' }
          : { name: 'evidenceId', label: 'Evidence filed to close it', type: 'text', required: false },
        { name: 'note', label: 'What closed it', type: 'text' },
      ],
      transform: ({ bidId: _b, gapId: _g, evidenceId, ...rest }) => ({
        ...rest,
        ...(String(evidenceId ?? '').trim() ? { evidenceId: String(evidenceId).trim() } : {}),
      }),
    },
    'set-bid-floor': {
      title: 'Set the quality floor',
      intent:
        'The score a mandatory answer must reach before the pack may export — 80 by default, where 80 is the green ' +
        'band; settable per bid. A below-floor answer blocks the export until it is strengthened and re-scored, or a ' +
        'named reviewer records a reason to submit it as it stands. The gate enforces the mark this rubric can find, ' +
        'which a buyer’s own scorer may still read differently.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/quality-floor`,
      submitLabel: 'Set',
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.map((bid) => ({ value: bid.id, label: `${bid.reference} — floor ${bid.qualityFloorPercent ?? 80}%` })) },
        { name: 'floorPercent', label: 'Quality floor (%)', type: 'number', min: 0, max: 100,
          hint: '80 is the green band. Raise it for a flagship account, lower it where a mark is genuinely out of reach.' },
      ],
      transform: ({ bidId: _b, floorPercent }) => ({ floorPercent: Number(floorPercent) }),
    },
    'floor-override': {
      title: 'Submit an answer below the floor',
      intent:
        'A named reviewer’s decision to export an answer that scores below the quality floor, with the reason that ' +
        'justifies it — a genuinely unreachable mark must not trap a legitimate bid. It cannot clear a red (a ' +
        'sub-amber score or a hard rule), and it is refused on an answer that already meets the floor. Recorded on ' +
        'the answer and kept, so three weeks later the record says what was concluded and on what basis.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/answers/${v.answerId}/floor-override`,
      submitLabel: 'Record',
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.buyerName}` })) },
        { name: 'answerId', label: 'Answer id', type: 'text', hint: 'From the opened pack above — the answer that is below the floor.' },
        { name: 'reason', label: 'Why it goes out below the floor', type: 'textarea', rows: 2,
          hint: 'At least 12 characters. What you concluded, not that you looked.' },
      ],
      transform: ({ bidId: _b, answerId: _a, ...rest }) => rest,
    },
    'export-bid': {
      title: 'Export the pack',
      intent:
        'Refused unless every mandatory answer is approved and out of red, naming every blocking answer rather than ' +
        'the first. A submission missing a mandatory response is not marked down, it is rejected, and everything ' +
        'else in it is spent for nothing.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/export`,
      submitLabel: 'Export',
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.map((bid) => ({
            value: bid.id,
            label: `${bid.reference} — ${bid.exportable ? 'ready' : 'blocked'}`,
          })) },
      ],
      transform: () => ({}),
    },
    'record-bid-outcome': {
      title: 'Record the outcome',
      intent:
        'Submitted, won or lost, with the buyer’s feedback where they gave any. An outcome follows a submission: ' +
        'recording one against a pack that was never sent would put a result on the record with nothing behind it.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/outcome`,
      submitLabel: 'Record',
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.map((bid) => ({ value: bid.id, label: `${bid.reference} · ${humanise(bid.status)}` })) },
        { name: 'outcome', label: 'What happened', type: 'select',
          options: [
            { value: 'SUBMITTED', label: 'Submitted — it has gone to the buyer' },
            { value: 'WON', label: 'Won' },
            { value: 'LOST', label: 'Lost' },
          ] },
        { name: 'on', label: 'On', type: 'date', required: false },
        { name: 'feedback', label: 'The buyer’s feedback', type: 'textarea', rows: 3, required: false,
          hint: 'What they actually said. It is the only honest way a scoring rule improves.' },
      ],
      transform: ({ bidId: _b, ...rest }) =>
        Object.fromEntries(Object.entries(rest).filter(([, value]) => String(value ?? '').trim())),
    },

    'file-evidence': {
      title: 'File an evidence item',
      intent:
        'Against a customer, never the provider. A certificate or insurance schedule is refused without the day it ' +
        'lapses — that date is what the hard rule reads, and a missing one is a safety check switched off rather ' +
        'than a blank field. A CV is refused without the data subject’s consent.',
      path: (v) => `/v1/bid-on/customers/${v.customerId}/evidence`,
      submitLabel: 'File',
      fields: [
        { name: 'customerId', label: 'Customer', type: 'select', options: customerOptions },
        { name: 'type', label: 'Kind', type: 'select',
          options: [
            { value: 'POLICY', label: 'Policy' },
            { value: 'CERTIFICATE', label: 'Certificate — needs an expiry' },
            { value: 'CASE_STUDY', label: 'Case study' },
            { value: 'CV', label: 'CV — needs the person’s consent' },
            { value: 'STATS', label: 'Accident or performance statistics' },
            { value: 'INSURANCE', label: 'Insurance — needs an expiry' },
            { value: 'OTHER', label: 'Something else' },
          ] },
        { name: 'title', label: 'Title', type: 'text',
          hint: 'As a reviewer looking for it would describe it.' },
        // The file itself, not a hash somebody obtained elsewhere.
        //
        // This field asked for a hash as text, which is a true description of
        // what the command takes and left no way to produce one from a
        // browser: a tender arrives as nine PDFs, and the operator was reduced
        // to a shell and `sha256sum`. `type: 'file'` is the console's own
        // mechanism for exactly this — it hashes in the browser, files the
        // record, uploads the bytes after it is accepted, and queues them on
        // the device where the connection cannot carry them. Nothing new is
        // built here; the field was simply the wrong type.
        { name: 'hash', label: 'The file', type: 'file',
          hint: 'Hashed in this browser. The record is filed first and the bytes follow it, so a dropped connection leaves a record naming a document rather than bytes nothing names.' },
        { name: 'validFrom', label: 'Valid from', type: 'date', required: false },
        { name: 'expiresOn', label: 'Current until', type: 'date', required: false,
          hint: 'Required for a certificate or an insurance schedule — that date is what the hard rule reads. Everything else may genuinely not lapse.' },
        { name: 'consentSubject', label: 'Data subject', type: 'text', required: false,
          hint: 'Required for a CV: whose data it is. A CV is a named person’s data going to a buyer, so it is filed with their consent.' },
        { name: 'consentBasis', label: 'How consent was obtained', type: 'text', required: false,
          hint: 'Required for a CV. How and when the person agreed their CV could go to a buyer — captured now, because afterwards the file is already in the library and already citable.' },
      ],
      /*
       * The two rules the server keeps that the field list cannot show.
       *
       * A certificate or insurance schedule is refused without an expiry, and a
       * CV without the data subject's consent — `MUST_EXPIRE` and `MUST_CONSENT`
       * in `evidence.ts`. Both fields are optional in general, because most
       * kinds genuinely do not need them, so they cannot be marked `required`
       * on the field itself. Checked here, keyed to the kind, so the person is
       * told before anything is sent rather than pressing File and reading a
       * refusal about a form the console had just offered as complete. The
       * server still enforces it; this only stops the round trip and names the
       * field. The message mirrors the server's own `BID_ON_*` text.
       */
      validate: (v) => {
        if ((v.type === 'CERTIFICATE' || v.type === 'INSURANCE') && !String(v.expiresOn ?? '').trim()) {
          return {
            field: 'expiresOn',
            message:
              'A certificate or insurance schedule is refused without the day it lapses — that date is what the hard ' +
              'rule reads, and a missing one is a safety check switched off rather than a blank field.',
          };
        }
        if (v.type === 'CV') {
          if (!String(v.consentSubject ?? '').trim()) {
            return { field: 'consentSubject', message: 'A CV is a named person’s data. File it with that person named as the data subject.' };
          }
          if (!String(v.consentBasis ?? '').trim()) {
            return { field: 'consentBasis', message: 'Say how and when the person’s consent was obtained — it is captured now, not after the file is already citable.' };
          }
        }
        return undefined;
      },
      transform: ({ customerId: _c, consentSubject, consentBasis, ...rest }) => ({
        ...Object.fromEntries(Object.entries(rest).filter(([, value]) => String(value ?? '').trim())),
        ...(String(consentSubject ?? '').trim()
          ? { consent: { subject: String(consentSubject).trim(), basis: String(consentBasis ?? '').trim() } }
          : {}),
      }),
    },
    'read-evidence': {
      title: 'Read a filed document',
      intent:
        'A vision model reads the document and files the passages a drafter cites — the document’s own words, with ' +
        'its page or clause where it shows one. A scan is read rather than refused. The passages are what every ' +
        'answer is drafted from and cited against, so a sentence the document does not contain would be a false ' +
        'statement made in the customer’s name: the local stand-in is refused before anything is charged, and the ' +
        'cost of the run is quoted before it starts. Reading it again replaces what is there. ' +
        'A document longer than one model request is read in parts and each part is a charge of its own, so a two-hundred-page bundle costs what two hundred pages cost rather than being refused.',
      path: (v) => `/v1/bid-on/evidence/${v.evidenceId}/read`,
      submitLabel: 'Read it',
      ai: true,
      fields: [
        haveDocuments
          ? { name: 'evidenceId', label: 'The document', type: 'select',
              options: documentOptions(), placeholder: 'Choose a filed document' }
          : { name: 'evidenceId', label: 'Evidence id', type: 'text',
              hint: 'Nothing is filed yet. File a document first, then it is offered here by name.' },
      ],
      transform: () => ({}),
    },
    'correct-evidence': {
      title: 'Correct what a document says about itself',
      intent:
        'Its title, its kind, the dates it is current between. Appended with what each field was and why, never ' +
        'overwritten — a title is how a reviewer finds a document and how the export names it, so "it used to be ' +
        'filed as something else" is a fact somebody may need. The file itself cannot be corrected: a wrong document ' +
        'is a withdrawal and a fresh filing, because those are two documents and the record should say so.',
      path: (v) => `/v1/bid-on/evidence/${v.evidenceId}/correction`,
      submitLabel: 'Correct it',
      fields: [
        haveDocuments
          ? { name: 'evidenceId', label: 'The document', type: 'select',
              options: documentOptions(), placeholder: 'Choose a filed document' }
          : { name: 'evidenceId', label: 'Evidence id', type: 'text' },
        { name: 'title', label: 'Title', type: 'text', required: false,
          hint: 'Leave blank to keep it. As a reviewer looking for it would describe it.' },
        { name: 'type', label: 'Kind', type: 'select', required: false,
          options: [
            { value: '', label: 'Leave unchanged' },
            { value: 'POLICY', label: 'Policy' },
            { value: 'CERTIFICATE', label: 'Certificate — needs an expiry' },
            { value: 'CASE_STUDY', label: 'Case study' },
            { value: 'CV', label: 'CV' },
            { value: 'STATS', label: 'Accident or performance statistics' },
            { value: 'INSURANCE', label: 'Insurance — needs an expiry' },
            { value: 'OTHER', label: 'Something else' },
          ] },
        { name: 'validFrom', label: 'Valid from', type: 'date', required: false },
        { name: 'expiresOn', label: 'Current until', type: 'date', required: false,
          hint: 'Required if you are reclassifying it as a certificate or an insurance schedule.' },
        { name: 'reason', label: 'Why', type: 'text',
          hint: 'At least twelve characters. Recorded against the correction — "filed under the wrong appendix number".' },
      ],
      transform: ({ evidenceId: _e, ...rest }) =>
        Object.fromEntries(Object.entries(rest).filter(([, value]) => String(value ?? '').trim())),
    },
    'record-extraction': {
      title: 'Record what was read out of a document',
      intent:
        'The passages a retriever ranks. Separate from filing, because a document can be filed and attached without ' +
        'anything being read out of it — a certificate is proof whether or not a model can read the scan. A passage ' +
        'too short to mean anything is dropped rather than indexed.',
      path: (v) => `/v1/bid-on/evidence/${v.evidenceId}/extraction`,
      submitLabel: 'Record',
      fields: [
        haveDocuments
          ? { name: 'evidenceId', label: 'The document', type: 'select',
              options: documentOptions(), placeholder: 'Choose a filed document' }
          : { name: 'evidenceId', label: 'Evidence id', type: 'text' },
        { name: 'chunks', label: 'The passages', type: 'textarea', rows: 10,
          hint: 'One per line, optionally as "page 4 | the passage". Each is what a citation will open to.' },
      ],
      transform: ({ evidenceId: _e, chunks }) => {
        const lines = String(chunks ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
        return {
          extractedText: lines,
          chunks: lines.map((line) => {
            const [first, ...rest] = line.split('|');
            return rest.length > 0
              ? { pageRef: first.trim(), text: rest.join('|').trim() }
              : { text: line };
          }),
        };
      },
    },
    'withdraw-evidence': {
      title: 'Withdraw an evidence item',
      intent:
        'Out of use, never deleted: a bid that cited it still cited it, and the submission that went out said what ' +
        'it said.',
      path: (v) => `/v1/bid-on/evidence/${v.evidenceId}/withdraw`,
      submitLabel: 'Withdraw',
      fields: [
        haveDocuments
          ? { name: 'evidenceId', label: 'The document', type: 'select',
              options: documentOptions(), placeholder: 'Choose a filed document' }
          : { name: 'evidenceId', label: 'Evidence id', type: 'text' },
        { name: 'reason', label: 'Why', type: 'text' },
      ],
      transform: ({ evidenceId: _e, ...rest }) => rest,
    },

    'issue-invoice': {
      title: 'Issue an invoice',
      intent:
        'Govern rather than create, for the same reason setting a fee is: whoever may agree what a customer pays is ' +
        'who may bill them for it. The amount comes from the engagement’s own terms where they decide it — a deposit ' +
        'percentage, a stage fee, the monthly fee — and is refused rather than guessed where they do not.',
      path: (v) => `/v1/bid-on/engagements/${v.engagementId}/invoices`,
      submitLabel: 'Issue',
      fields: [
        { name: 'engagementId', label: 'Engagement', type: 'select',
          options: engagementList
            .filter((entry) => entry.status !== 'DRAFT')
            .map((entry) => ({ value: entry.id, label: engagementLabel(entry) })),
          hint: 'A draft engagement cannot be billed: its terms are not agreed yet.' },
        { name: 'kind', label: 'What for', type: 'select',
          options: [
            { value: 'DEPOSIT', label: 'Deposit — blocks agent runs until settled' },
            { value: 'BALANCE', label: 'Balance on delivery' },
            { value: 'STAGE', label: 'A stage, on sign-off' },
            { value: 'CYCLE', label: 'A cycle of a retainer' },
            { value: 'MONTHLY', label: 'The monthly fee' },
          ] },
        { name: 'amount', label: 'Amount', type: 'number', required: false,
          hint: 'Leave blank to take it from the engagement’s terms.' },
        { name: 'narrative', label: 'What it says', type: 'text', required: false,
          hint: 'Leave blank for the wording the terms imply.' },
        { name: 'dueOn', label: 'Due', type: 'date', required: false, hint: 'Fourteen days by default.' },
      ],
      transform: ({ engagementId: _e, amount, ...rest }) => ({
        ...Object.fromEntries(Object.entries(rest).filter(([, value]) => String(value ?? '').trim())),
        ...(String(amount ?? '').trim() === '' ? {} : { amountMinor: Math.round(Number(amount) * 100) }),
      }),
    },
    'record-payment': {
      title: 'Record a payment',
      intent:
        'Somebody saying it was paid, not a payment being taken — the payment gateway is not built and every read ' +
        'here says so. Settling a deposit this way is what unblocks agent runs on that engagement.',
      path: (v) => `/v1/bid-on/invoices/${v.invoiceId}/paid`,
      submitLabel: 'Record',
      fields: [
        { name: 'invoiceId', label: 'Invoice', type: 'select',
          options: invoiceList
            .filter((invoice) => invoice.status === 'ISSUED')
            .map((invoice) => ({
              value: invoice.id,
              label: `${invoice.reference} — ${invoice.customerName} — ${invoice.narrative}`,
            })) },
        { name: 'paymentReference', label: 'Reference', type: 'text',
          hint: 'The bank reference or whatever identifies it on your statement.' },
        { name: 'paidOn', label: 'Paid on', type: 'date', required: false },
      ],
      transform: ({ invoiceId: _i, paidOn, ...rest }) => ({
        ...rest,
        ...(String(paidOn ?? '').trim() ? { paidOn: String(paidOn) } : {}),
      }),
    },
    'waive-invoice': {
      title: 'Waive a deposit',
      intent:
        'So work can start before it is paid. A provider who knows the customer will sometimes start on a handshake, ' +
        'and a platform that made that impossible is a platform they work around. The reason is mandatory and is ' +
        'the point: a waiver with none is indistinguishable from a deposit nobody chased.',
      path: (v) => `/v1/bid-on/invoices/${v.invoiceId}/waive`,
      submitLabel: 'Waive',
      fields: [
        { name: 'invoiceId', label: 'Invoice', type: 'select',
          options: invoiceList
            .filter((invoice) => invoice.status === 'ISSUED')
            .map((invoice) => ({ value: invoice.id, label: `${invoice.reference} — ${invoice.narrative}` })) },
        { name: 'reason', label: 'Why', type: 'text' },
      ],
      transform: ({ invoiceId: _i, ...rest }) => rest,
    },
    'void-invoice': {
      title: 'Void an invoice issued in error',
      intent:
        'Voided, never deleted, because the number was used. Refused on one already paid — that would leave money ' +
        'received against nothing.',
      path: (v) => `/v1/bid-on/invoices/${v.invoiceId}/void`,
      submitLabel: 'Void',
      fields: [
        { name: 'invoiceId', label: 'Invoice', type: 'select',
          options: invoiceList
            .filter((invoice) => invoice.status === 'ISSUED')
            .map((invoice) => ({ value: invoice.id, label: `${invoice.reference} — ${invoice.narrative}` })) },
        { name: 'reason', label: 'Why', type: 'text' },
      ],
      transform: ({ invoiceId: _i, ...rest }) => rest,
    },

    'open-engagement': {
      title: 'Open an engagement',
      intent:
        'The piece of work, its terms and its fee. It opens as a draft and is activated as a second act, because the ' +
        'terms are what the customer will be charged against and somebody has to say they are right first. Naming a ' +
        'service fills the terms in from the catalogue; the engagement then keeps its own copy of them for good.',
      path: (v) => `/v1/bid-on/customers/${v.customerId}/engagements`,
      submitLabel: 'Open',
      fields: [
        { name: 'customerId', label: 'Customer', type: 'select', options: customerOptions },
        { name: 'name', label: 'What the work is', type: 'text',
          hint: '"UVDB prequalification", "Q1 tender submissions", "Bid retainer 2027".' },
        // The catalogue, and what the form says when there is nothing in it.
        //
        // Every terms field below used to read "take it from the service" and
        // offer to leave itself blank. On a tenancy with no service defined —
        // which is every tenancy on its first afternoon — that is an invitation
        // to submit a form the platform then refuses for incomplete terms. The
        // refusal is right and says what to do; the form should not have asked
        // for it. So where the catalogue is empty, the three terms are the only
        // route and the fields say so.
        { name: 'offeringId', label: 'From the catalogue', type: 'select', required: false,
          options: [
            { value: '', label: priceable.length > 0 ? 'Price it directly' : 'Nothing in the catalogue — price it below' },
            ...priceable.map((o) => ({ value: o.id, label: `${o.reference} — ${o.name}` })),
          ],
          hint: priceable.length > 0
            ? 'Fills in the type, fee, basis, deposit and deliverables. Every one can still be changed below.'
            : 'No service is defined yet, so state the basis, the fee and the currency below. Defining one first fills all three in and prices every later engagement from it.' },
        { name: 'type', label: 'Engagement type', type: 'select',
          options: Object.entries(TYPE_MEANING).map(([value, meaning]) => ({ value, label: `${humanise(value)} — ${meaning}` })) },
        { name: 'billingBasis', label: 'Billing basis', type: 'select', required: priceable.length === 0,
          options: [
            // Offered only where there is a service to take it from. Left in
            // with an empty catalogue it is the default choice and sends
            // nothing, which is the refusal again.
            ...(priceable.length > 0 ? [{ value: '', label: 'Take it from the service' }] : []),
            ...['FIXED_FEE', 'MONTHLY', 'PER_CYCLE', 'PER_STAGE', 'AS_AGREED'].map((value) => ({ value, label: humanise(value) })),
          ],
          hint: 'It has to fit the type above: a one-off takes a fixed fee or as-agreed, a continuous one is billed per cycle or monthly, a staged one per stage.' },
        { name: 'fee', label: 'Fee', type: 'number', required: priceable.length === 0,
          hint: priceable.length > 0
            ? 'In whole currency units. Leave blank to take the service’s starting price.'
            : 'In whole currency units. There is no service to take it from, so it is needed here.' },
        { name: 'currency', label: 'Currency', type: 'text', required: false, placeholder: 'GBP',
          ...(priceable.length === 0 ? { value: 'GBP' } : {}) },
        { name: 'schedule', label: 'Repeats', type: 'select', required: false,
          options: [
            { value: '', label: 'Does not repeat' },
            ...['WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL'].map((value) => ({ value, label: humanise(value) })),
          ],
          hint: 'Required for a continuous engagement and refused on any other — a schedule nothing reads is a schedule that misleads.' },
        { name: 'startOn', label: 'Starts', type: 'date', required: false },
        { name: 'endOn', label: 'Ends', type: 'date', required: false },
        { name: 'termsText', label: 'Terms as agreed', type: 'textarea', rows: 3, required: false,
          hint: 'Free-form, and the whole of a custom engagement’s terms. Read by whoever argues about scope later.' },
        { name: 'stages', label: 'Stages', type: 'textarea', rows: 4, required: false,
          hint: 'One per line as "name | scope | fee". A staged engagement needs at least two; any other type takes none.' },
      ],
      transform: ({ customerId: _c, offeringId, type, billingBasis, fee, currency, schedule, stages, termsText, ...rest }) => ({
        ...rest,
        type,
        ...(offeringId ? { offeringId } : {}),
        ...(billingBasis ? { billingBasis } : {}),
        ...(String(fee ?? '').trim() === '' ? {} : { feeMinor: Math.round(Number(fee) * 100) }),
        ...(String(currency ?? '').trim() ? { currency: String(currency).toUpperCase() } : {}),
        ...(schedule ? { schedule } : {}),
        ...(String(termsText ?? '').trim() ? { termsText: String(termsText).trim() } : {}),
        ...(String(stages ?? '').trim()
          ? {
              stages: String(stages)
                .split('\n')
                .map((line) => line.split('|').map((part) => part.trim()))
                .filter((parts) => parts.length >= 3 && parts[0])
                .map((parts) => ({ name: parts[0], scope: parts[1], feeMinor: Math.round(Number(parts[2]) * 100) })),
            }
          : {}),
      }),
    },
    'activate-engagement': {
      title: 'Activate an engagement',
      intent: 'What lets work start. A draft engagement accepts no agent run, because its terms are not agreed yet.',
      path: (v) => `/v1/bid-on/engagements/${v.engagementId}/activate`,
      submitLabel: 'Activate',
      fields: [
        { name: 'engagementId', label: 'Engagement', type: 'select',
          options: liveEngagements.filter((e) => e.status === 'DRAFT').map((e) => ({ value: e.id, label: engagementLabel(e) })) },
      ],
      transform: () => ({}),
    },
    'pause-engagement': {
      title: 'Pause an engagement',
      intent:
        'Any type, any time. No agent run, no recurring charge, and every bid left exactly where it was. The reason ' +
        'is required because "why is this customer’s work stopped" is the question somebody asks four months later.',
      path: (v) => `/v1/bid-on/engagements/${v.engagementId}/pause`,
      submitLabel: 'Pause',
      fields: [
        { name: 'engagementId', label: 'Engagement', type: 'select',
          options: liveEngagements.filter((e) => e.status === 'ACTIVE').map((e) => ({ value: e.id, label: engagementLabel(e) })) },
        { name: 'reason', label: 'Why', type: 'text' },
      ],
      transform: ({ engagementId: _e, ...rest }) => rest,
    },
    'resume-engagement': {
      title: 'Resume an engagement',
      intent: 'Restores every bid exactly as it was. How long they were away, and why, stays on the record.',
      path: (v) => `/v1/bid-on/engagements/${v.engagementId}/resume`,
      submitLabel: 'Resume',
      fields: [
        { name: 'engagementId', label: 'Engagement', type: 'select',
          options: liveEngagements.filter((e) => e.status === 'PAUSED').map((e) => ({ value: e.id, label: engagementLabel(e) })) },
      ],
      transform: () => ({}),
    },
    'reterm-engagement': {
      title: 'Change the terms',
      intent:
        'Versioned. The new terms apply from now and the old ones stay on the record — a fee edited in place would ' +
        'rewrite what the customer owed for work already delivered, and last month’s statement would change after it ' +
        'was sent.',
      path: (v) => `/v1/bid-on/engagements/${v.engagementId}`,
      method: 'PUT',
      submitLabel: 'Save',
      fields: [
        { name: 'engagementId', label: 'Engagement', type: 'select',
          options: liveEngagements.map((e) => ({ value: e.id, label: engagementLabel(e) })) },
        { name: 'reason', label: 'Why it changed', type: 'text' },
        { name: 'fee', label: 'New fee', type: 'number', required: false },
        { name: 'endOn', label: 'New end date', type: 'date', required: false },
        { name: 'termsText', label: 'Terms as now agreed', type: 'textarea', rows: 3, required: false },
      ],
      transform: ({ engagementId: _e, fee, ...rest }) => ({
        ...Object.fromEntries(Object.entries(rest).filter(([, value]) => String(value ?? '').trim())),
        ...(String(fee ?? '').trim() === '' ? {} : { feeMinor: Math.round(Number(fee) * 100) }),
      }),
    },
    'open-cycle': {
      title: 'Open the next cycle',
      intent:
        'A continuous engagement repeats on its schedule. Refused while a cycle is still open, because two open ' +
        'cycles is two cycles billed for one period of work — and the due date is derived from the last cycle rather ' +
        'than from today, so a gap does not silently reset the cadence.',
      path: (v) => `/v1/bid-on/engagements/${v.engagementId}/cycles`,
      submitLabel: 'Open',
      fields: [
        { name: 'engagementId', label: 'Engagement', type: 'select',
          options: liveEngagements
            .filter((e) => e.type === 'CONTINUOUS' && e.status === 'ACTIVE')
            .map((e) => ({ value: e.id, label: engagementLabel(e) })) },
        { name: 'scope', label: 'What this cycle covers', type: 'textarea', rows: 2,
          hint: '"Weekly portal watch and bid/no-bid advice, w/c 2 November" — read by whoever signs it off.' },
      ],
      transform: ({ engagementId: _e, ...rest }) => rest,
    },
    'sign-off-stage': {
      title: 'Sign off a stage',
      intent:
        'What opens the next stage or cycle. Refused twice on the same one — a second sign-off is not a correction, ' +
        'it would bill the stage twice.',
      /*
       * The path is built from the combined chooser below, which carries the
       * engagement and the stage in one value.
       */
      path: (v) => {
        const [engagementId, stageId] = String(v.stageId).split('::');
        return `/v1/bid-on/engagements/${engagementId}/stages/${stageId}/sign-off`;
      },
      submitLabel: 'Sign off',
      fields: [
        { name: 'stageId', label: 'Stage', type: 'select',
          /*
           * One chooser, not two. The value carries the engagement and the
           * stage together, so a person cannot pick a stage from one
           * engagement and an engagement from another — which the two-select
           * version made not just possible but easy.
           */
          options: liveEngagements.flatMap((entry) =>
            entry.stages
              .filter((stage) => stage.status === 'OPEN')
              .map((stage) => ({ value: `${entry.id}::${stage.id}`, label: `${entry.reference} · ${stage.name}` })),
          ),
          hint: 'Only a stage that is open. Stages run in order, because the next one’s scope depends on what the last delivered.' },
        { name: 'note', label: 'What was delivered', type: 'textarea', rows: 2 },
      ],
      transform: ({ stageId: _s, ...rest }) => rest,
    },
    'close-engagement': {
      title: 'Complete or cancel',
      intent:
        'One act for both. The effect on the work is identical — the bids become read-only and nothing more is billed ' +
        '— and the difference is what the record says about why.',
      path: (v) => `/v1/bid-on/engagements/${v.engagementId}/close`,
      submitLabel: 'Close',
      fields: [
        { name: 'engagementId', label: 'Engagement', type: 'select',
          options: liveEngagements.map((e) => ({ value: e.id, label: engagementLabel(e) })) },
        { name: 'outcome', label: 'Outcome', type: 'select',
          options: [
            { value: 'COMPLETED', label: 'Completed — the work was delivered' },
            { value: 'CANCELLED', label: 'Cancelled — it stopped before it finished' },
          ] },
        { name: 'reason', label: 'Why', type: 'text' },
      ],
      transform: ({ engagementId: _e, ...rest }) => rest,
    },

    /*
     * The company identity the exported pack carries.
     *
     * The Word and spreadsheet exports are branded documents and the platform
     * refuses to render one until a tenancy identity is set — an unbranded
     * submission going to a buyer under nobody's name is worse than none. The
     * route to set it has always existed (`PUT /v1/branding`); what was missing
     * was a door to it, so the export walled off with no way forward. This is
     * that door. One identity for the tenancy, applied to every export.
     */
    'set-branding': {
      title: 'Set your company identity',
      intent:
        'The name, colour and legal footer your exported tender pack goes out under. A submission carries your own ' +
        'identity, so the Word and spreadsheet exports are held until this is set. Set it once — it applies to every export.',
      method: 'PUT',
      path: '/v1/branding',
      submitLabel: 'Save identity',
      fields: [
        { name: 'clientName', label: 'Company name', type: 'text', hint: 'As it should appear on the document — e.g. JNseya Construction.' },
        { name: 'primaryColour', label: 'Brand colour', type: 'text', hint: 'A hex colour for headings, e.g. #1F4FD0.' },
        { name: 'documentReferencePrefix', label: 'Document reference prefix', type: 'text', hint: 'A short code that numbers your documents, e.g. JNSEYA.' },
        { name: 'legalFooter', label: 'Legal footer', type: 'textarea', rows: 2,
          hint: 'The registered line at the foot of each page — company name, number and registered address.' },
      ],
    },
  };

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const spec = COMMANDS[button.dataset.command];
    if (!spec) return;
    if (await command(spec)) await draw();
  });
}


/**
 * Which questions have something to read first.
 *
 * Sorted by what is useful rather than by question number: the unanswered ones
 * with a strong prior answer are where somebody should start, and a list in
 * source order buries them among the fifty that have nothing.
 */
/**
 * The cost-model calculator form.
 *
 * Reused `.field` controls, nothing bespoke. The only thing it insists on in
 * words is what it is not: a tool for the client's own cost and margin, never a
 * source of a market price.
 */
function costPanel(bidList = []) {
  // The rates a tender holds, to fill "what one unit costs you" by selection
  // rather than retyping. Only shown when there is a bid to pick — the rates
  // belong to a tender, so the bid is chosen first and its rates load into the
  // second box. Pulling one is a convenience; the build-up still prices from it.
  const picker = bidList.length
    ? html`
      <div class="grid g3" style="gap:0 14px;margin:0 0 6px">
        <div class="field"><label>Pull a unit cost from a tender’s rate card <span class="opt">(optional)</span></label>
          <select id="cost-bid">
            <option value="">— choose a tender —</option>
            ${bidList.map((bid) => html`<option value="${bid.id}">${bid.reference} — ${bid.buyerName}</option>`)}
          </select></div>
        <div class="field"><label>Its rate</label>
          <select id="cost-rate" disabled><option value="">choose a tender first</option></select></div>
        <div class="field" style="align-self:end"><div class="metric-sub" id="cost-rate-note">Rates imported for that tender only.</div></div>
      </div>`
    : raw('');
  return html`
    <div class="card" style="margin-top:10px">
      <p style="margin:0 0 11px;font-size:12.5px;color:var(--text-3)">
        Your own numbers only. This works out the price that covers your cost and the margin you want, and shows the
        profit on cost and on price so "20% margin" is not two different numbers. It holds no market price — what the
        market pays is yours to bring.
      </p>
      ${picker}
      <div class="grid g3" style="gap:0 14px">
        <div class="field"><label>What one unit costs you (all-in)</label>
          <input id="cost-unit" type="number" step="any" min="0" placeholder="e.g. 68.00"></div>
        <div class="field"><label>How many units</label>
          <input id="cost-qty" type="number" step="1" min="1" placeholder="e.g. 250"></div>
        <div class="field"><label>Fixed cost across the line <span class="opt">(optional)</span></label>
          <input id="cost-fixed" type="number" step="any" min="0" placeholder="mobilisation, PM…"></div>
        <div class="field"><label>Target margin %</label>
          <input id="cost-margin" type="number" step="any" min="0" placeholder="e.g. 20"></div>
        <div class="field"><label>Margin basis</label>
          <select id="cost-basis">
            <option value="ON_COST">Cost plus (markup on cost)</option>
            <option value="ON_PRICE">Share of the price (margin on price)</option>
          </select></div>
        <div class="field"><label>A price you’re weighing <span class="opt">(optional, per unit)</span></label>
          <input id="cost-proposed" type="number" step="any" min="0" placeholder="check it covers cost"></div>
      </div>
      <div class="actions" style="margin-top:4px">
        <button class="btn sm" id="cost-calc">Work out the price</button>
      </div>
      <div id="cost-result"></div>
    </div>`;
}

/** The build-up the server returned, as three figures, any price check, and the notes. */
function costResult(result) {
  const percent = (fraction) => `${Math.round(fraction * 1000) / 10}%`;
  const proposed = result.proposed;
  return html`
    <div style="margin-top:12px">
      <div class="grid g3" style="gap:10px">
        <div class="card">
          <h2>Your cost</h2>
          <div class="metric">${money(result.totalCostMinor)}</div>
          <div class="metric-sub">
            ${money(result.unitCostMinor)}/unit × ${result.quantity}${
              result.fixedCostMinor ? html` + ${money(result.fixedCostMinor)} fixed` : ''
            }
          </div>
        </div>
        <div class="card">
          <h2>Price to offer</h2>
          <div class="metric good">${money(result.priceMinor)}</div>
          <div class="metric-sub">${money(result.unitPriceMinor)} per unit</div>
        </div>
        <div class="card">
          <h2>Profit</h2>
          <div class="metric">${money(result.profitMinor)}</div>
          <div class="metric-sub">${percent(result.marginOnCost)} on cost · ${percent(result.marginOnPrice)} on price</div>
        </div>
      </div>
      ${
        proposed
          ? html`<div class="notice ${raw(proposed.belowCost ? 'err' : proposed.belowTarget ? 'warn' : 'ok')}" style="margin:10px 0 0"><div>
              <b>${money(proposed.unitPriceMinor)} per unit makes ${percent(proposed.marginOnCost)} on cost
              (${money(proposed.profitMinor)} across ${result.quantity}).</b>
            </div></div>`
          : ''
      }
      ${result.notes.map((line) => html`<p style="margin:8px 0 0;font-size:12px;color:var(--text-3)">${line}</p>`)}
    </div>`;
}

function carryPanel(board, bidId) {
  const useful = board.questions
    .filter((entry) => entry.candidates > 0)
    .sort(
      (a, b) =>
        Number(a.answered) - Number(b.answered) ||
        b.fromLineage - a.fromLineage ||
        (b.best ?? 0) - (a.best ?? 0),
    );

  return html`
    <div style="margin-top:11px">
      <div class="notice ${raw(useful.length === 0 ? 'warn' : 'info')}" style="margin:0 0 10px">
        <div>
          ${board.summary}
          ${board.follows
            ? html`<div style="margin-top:4px">
                This is the ${humanise(board.stage)} stage, following ${board.follows.reference}. Answers from that
                pack are offered first.
              </div>`
            : ''}
        </div>
      </div>
      ${table({
        headers: ['#', 'Section', 'Answered here', 'Candidates', 'From the PQQ', 'Best match', ''],
        align: ['', '', '', 'num', 'num', 'num', ''],
        rows: useful.map((entry) => [
          entry.number,
          entry.section,
          entry.answered ? badge('yes', 'ok') : badge('not yet', 'warn'),
          String(entry.candidates),
          entry.fromLineage === 0 ? '—' : badge(String(entry.fromLineage), 'info'),
          entry.best === null ? '—' : pct(entry.best * 100, 0),
          html`<button class="btn sm" data-prior="${entry.questionId}" data-prior-bid="${bidId}">Read them</button>`,
        ]),
        empty: 'Nothing to carry forward',
        emptyDetail:
          'Either every question with a prior answer is already answered here, or this customer’s earlier bids do ' +
          'not cover these questions. The second submission is where this starts paying for itself.',
      })}
      <div id="prior-detail"></div>
    </div>
  `;
}

/**
 * The candidates for one question.
 *
 * Each shown with the two things reading an old pack by hand would miss:
 * whether its citations are still current on this bid's date, and whether it
 * fits this question's limit. The ids are on the card because reusing one means
 * writing an answer that names it, and the command needs them.
 */
function priorPanel(offer) {
  return html`
    <div style="margin-top:11px">
      <div class="notice ${raw(offer.candidates.length === 0 ? 'warn' : 'info')}" style="margin:0 0 10px">
        <div>
          <b>${offer.question.number} — ${offer.candidates.length} candidate(s)</b>
          <div>${offer.note}</div>
          ${offer.limits.map((line) => html`<div style="margin-top:4px">${line}</div>`)}
        </div>
      </div>
      ${offer.candidates.map(
        (candidate) => html`<div style="padding:9px 0;border-top:1px solid var(--line)">
          <div class="actions" style="justify-content:space-between;align-items:baseline">
            <b>
              ${candidate.bidReference} · ${candidate.buyerName}
              ${candidate.fromLineage
                ? badge('from the PQQ this follows', 'info')
                : badge(humanise(candidate.stage), '')}
              ${candidate.outcome
                ? badge(humanise(candidate.outcome), candidate.outcome === 'WON' ? 'ok' : '')
                : ''}
            </b>
            <span style="font-size:12px;color:var(--text-3)">
              wording match ${pct(candidate.match * 100, 0)}${candidate.score === null
                ? ''
                : ` · scored ${candidate.score}`} · ${candidate.words} words
              ${candidate.withinLimit === false ? badge('over this limit', 'warn') : ''}
            </span>
          </div>
          <div style="font-size:12.5px;color:var(--text-3);margin:3px 0">
            It answered: ${candidate.question.number} ${candidate.question.text}
          </div>
          ${candidate.body.map((line) => html`<p style="margin:5px 0;font-size:13px;line-height:1.55">${line}</p>`)}
          ${
            candidate.citations.length === 0
              ? html`<div class="notice warn" style="margin:6px 0"><div>
                  No citation at all. Reusing this means finding the evidence for it now — an uncited claim in a
                  submission is one the customer cannot stand behind.
                </div></div>`
              : html`<div style="font-size:12px;margin:5px 0">
                  ${candidate.citations.map((citation) => html`<span style="margin-right:10px">
                    ${citation.current
                      ? badge('current', 'ok')
                      : citation.withdrawn
                        ? badge('withdrawn', 'bad')
                        : badge('lapsed', 'bad')}
                    ${citation.reference} ${citation.title}${citation.expiresOn
                      ? ` · expires ${citation.expiresOn}`
                      : ''}
                  </span>`)}
                </div>`
          }
          <div style="font-size:11.5px;color:var(--text-3)">
            To reuse it, write the answer and name this one:
            <code>${candidate.bidId}</code> / <code>${candidate.answerId}</code>
          </div>
        </div>`,
      )}
    </div>
  `;
}

/** "a, b, c" to a list, or nothing at all when it is empty. */
function listOf(value, key) {
  const list = String(value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return list.length > 0 ? { [key]: list } : {};
}

/**
 * One pack, question by question.
 *
 * The verdict column is the point of the screen and the hard rules are shown
 * in full rather than summarised. A reviewer who sees "red" learns nothing; a
 * reviewer who sees "EV-0004 — Employers liability certificate — expires
 * 2026-11-15, before the deadline of 2026-12-01" knows what to do in the next
 * ten seconds.
 *
 * Where a hard rule fired, the band the prose alone would have earned is shown
 * beside it. "This would have been green" is what tells somebody the writing is
 * fine and the problem is a certificate.
 */
/**
 * The answer itself, for the panel that decides about it.
 *
 * Approving was a note field and a score override, with the answer nowhere on
 * the screen. The two-person check is the whole value of this module and it
 * cannot be performed against a reference number — so this is what is being
 * signed: the question it answers, the text in full, what it cites, and the
 * marks the scorer gave with the reasons they gave them.
 *
 * The scores are shown worst first. A reviewer reading five criteria is
 * deciding whether the weakest one is good enough to send, and that is the one
 * they should read first.
 */
function answerBrief(entry) {
  const answer = entry.answer;
  if (!answer) return undefined;
  const scores = Object.entries(answer.scores ?? {}).sort(([, a], [, b]) => Number(a) - Number(b));
  return html`
    <h4>The question</h4>
    <p>
      <b>${entry.question.number}</b> ${entry.question.text}
      <span class="said">
        ${entry.question.wordLimit ? html` · ${entry.question.wordLimit}-word limit` : ''}
        ${entry.question.weighting ? html` · worth ${entry.question.weighting}%` : ''}
        ${entry.question.mandatory ? html` · mandatory` : ''}
      </span>
    </p>
    <h4>The answer — version ${answer.version}, ${answer.words} words${
      answer.authorship === 'AI_DRAFTED' ? html`, drafted by ${answer.provider ?? 'an agent'}` : html`, written by hand`
    }</h4>
    ${answer.yesNo === undefined ? '' : html`<p><b>${answer.yesNo ? 'Yes' : 'No'}</b></p>`}
    ${(answer.body ?? []).map((line) => html`<p>${line}</p>`)}
    <h4>What it cites</h4>
    ${
      /*
       * One line per place, not one per passage.
       *
       * An answer drawing four paragraphs from one section of one document
       * printed that section four times, which reads as four sources and is
       * one. What a reviewer is checking is where the claims come from, so the
       * places are listed once each with how many passages came from each.
       */
      (answer.citations ?? []).length === 0
        ? html`<p class="said">Nothing. Every claim in it is uncited.</p>`
        : [...(answer.citations ?? []).reduce((places, citation) => {
            const key = `${citation.reference}${citation.pageRef ? ` · ${citation.pageRef}` : ''}`;
            return places.set(key, (places.get(key) ?? 0) + 1);
          }, new Map())].map(
            ([place, passages]) => html`<p class="said">
              ${place}${passages > 1 ? html` <span style="color:var(--text-3)">· ${passages} passages</span>` : ''}
            </p>`,
          )
    }
    ${
      scores.length === 0
        ? html`<h4>Not scored yet</h4>`
        : html`<h4>How it scored — weakest first</h4>
            ${scores.map(
              ([criterion, score]) => html`<p class="said">
                <b>${humanise(criterion)} ${score}</b> — ${answer.scoreReasons?.[criterion] ?? 'no reason given'}
              </p>`,
            )}`
    }
    ${
      entry.verdict?.toGreen
        ? html`<h4>What it needs to be green</h4><p class="said">${entry.verdict.toGreen.note}</p>`
        : html`<h4>Green</h4><p class="said">${entry.verdict?.weightedScore ?? ''} — above the floor of 80.</p>`
    }
    ${
      answer.draftedOverGap
        ? html`<h4>Written over an open gap</h4>
            <p class="said">${answer.draftedOverGap.prompt}</p>`
        : ''
    }
    ${
      answer.reviewNote
        ? html`<h4>What the last reviewer said</h4><p class="said">${answer.reviewNote}</p>`
        : ''
    }
  `;
}

/**
 * What one question is waiting for, as the button that does it.
 *
 * The pack prints the question id and the answer id and every answer command
 * asks for one of them "from the opened pack above". That was already an
 * improvement on printing neither — but on a six-question tender it is
 * eighteen acts, each one a copy out of a table into a form, and on a
 * thirty-question ITT it is ninety. The pack knows which question has nothing
 * written, which answer is unscored and which is waiting for a signature, so
 * it can offer the one act that is next instead of a value to carry.
 *
 * The forms are unchanged. Each button opens the command that already exists,
 * pre-filled — so what the form offers and what the platform enforces still
 * come from one place, and the same command is still reachable from the row of
 * doors above for anybody working from an id.
 */
function nextAct(bidId, entry) {
  const answer = entry.answer;
  const act = (name, label, tone, extra = {}) => html`<button class="btn sm${raw(tone)}"
    data-act="${name}" data-act-bid="${bidId}" data-act-question="${entry.question.id}"
    data-act-answer="${answer?.id ?? ''}" data-act-gap="${entry.gap?.id ?? ''}"
    data-act-over="${extra.over ? '1' : ''}">${label}</button>`;

  if (answer === null || answer === undefined) {
    // Nothing written. A gap on the question is not a wall: drafting over it
    // writes what is evidenced and says on the answer that it was written that
    // way, which two days before a return is usually the right call.
    return entry.gap
      ? html`<div class="row-acts">
          ${act('draft-answer', 'Draft over it', '', { over: true })}
          ${act('resolve-gap', 'Close the gap', ' quiet')}
        </div>`
      : html`<div class="row-acts">
          ${act('draft-answer', 'Draft', '')}
          ${act('record-answer', 'Write it', ' quiet')}
        </div>`;
  }

  if (answer.status === 'APPROVED') return html`<span style="font-size:12px;color:var(--text-3)">signed</span>`;

  if (answer.status === 'REJECTED') {
    // The reviewer's instructions are already attached to the answer, so the
    // redraft is one press rather than a brief retyped.
    return html`<div class="row-acts">${act('draft-answer', 'Draft again', '')}</div>`;
  }

  if (!answer.scoredAt) {
    return html`<div class="row-acts">
      ${act('rescore-answer', 'Score it', '')}
      ${act('score-answer', 'By hand', ' quiet')}
    </div>`;
  }

  /*
   * A scored answer has four futures, and the row offered two.
   *
   * Approve and Reject were there; **Score again** and **Draft again** were
   * not, and both are things a person standing in front of a red 22.8 actually
   * wants. Scoring again is how a reviewer gets a second read of the same
   * words — the first one may have been the author's own, or made before the
   * evidence was filed. Drafting again is how the answer improves, and the
   * drafter now carries the scorer's criterion-by-criterion reasons into the
   * rewrite, so a redraft of a scored answer is a revision rather than another
   * guess.
   *
   * Rejecting is still the right act where a *person* has instructions to
   * give: those travel with the answer and reach the next draft too. What was
   * wrong was making it the only road back.
   */
  return html`<div class="row-acts">
    ${act('approve-answer', 'Approve', '')}
    ${act('reject-answer', 'Reject', ' quiet')}
    ${act('draft-answer', 'Draft again', ' quiet')}
    ${act('rescore-answer', 'Score again', ' quiet')}
  </div>`;
}

function bidDetail(position, estimate, source) {
  const { bid, customer, questions, readiness, openGaps, limits } = position;
  /*
   * The questions for the buyer, counted by severity.
   *
   * Reading a schedule of amendments against a contract form raises one per
   * clause it moves — thirty-seven on the first real tender through here — and
   * the first thing anybody needs of that is how many cannot be left unasked.
   * The register arrives worst first from the platform; this is the count that
   * says what the top of the list is made of.
   */
  const clarifications = position.clarifications ?? [];
  const toAsk = clarifications.filter((entry) => entry.status === 'RAISED');
  const bySev = (severity) => toAsk.filter((entry) => entry.severity === severity).length;
  /*
   * All three severities, including the ones at nought.
   *
   * The first cut printed a badge only where the count was above zero, and on
   * a bid whose twelve minor questions had all been withdrawn the heading read
   * `4 CRITICAL 21 MAJOR` — which says nothing about whether this tender ever
   * raised a minor question or whether somebody dealt with twelve of them. A
   * register that hides a row at nought cannot be read as a register: the
   * reader has to know the difference between *none* and *none left*.
   *
   * So all three, always, with the rest of the story on the badge itself.
   */
  const severityBadge = (severity, tone) => {
    const all = clarifications.filter((entry) => entry.severity === severity);
    const waiting = all.filter((entry) => entry.status === 'RAISED').length;
    const settled = all.length - waiting;
    const word = severity.toLowerCase();
    return html`<span title="${`${waiting} of ${all.length} ${word} still to ask.${
      settled === 0 ? '' : ` ${settled} asked, answered or withdrawn.`
    }`}">${badge(`${waiting} ${word}`, waiting === 0 ? '' : tone)}</span>`;
  };
  return html`
    <div class="card pad0">
      <h2 style="padding:15px 17px 0">
        ${bid.reference} · ${bid.buyerName}
        ${readiness.exportable ? badge('ready to export', 'ok') : badge(humanise(bid.status), BID_TONE[bid.status] ?? '')}
      </h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        ${customer.legalName} · ${humanise(bid.scheme)} ·
        ${bid.stage === 'SINGLE_STAGE' ? 'one stage' : humanise(bid.stage)}${
          bid.followsBidId ? html`, following the prequalification` : ''
        } ·
        ${bid.rolling ? html`no return date` : html`due ${date(bid.deadline)}`}${
          bid.clarificationDeadline ? html` · questions close ${date(bid.clarificationDeadline)}` : ''
        } · quality floor ${bid.qualityFloorPercent ?? 80}%.
        ${readiness.summary}
        ${bid.rolling
          ? html`Every verdict is judged against <b>${date(position.judgementDay)}</b>, the day this was read, and is
              re-judged on every read — a membership nobody returns has no other honest date to judge against.`
          : html`Every verdict is judged against the deadline rather than against today, because that is the day the
              buyer reads it.`}
      </p>
      ${
        /*
         * The one thing to read first: can this be submitted, and if not, why —
         * in the API's own plain words, not inferred from a percentage and a
         * severity count. A requirement wall (a pass/fail answered no, lapsed
         * evidence, an unconfirmed declaration) is red and says "cannot be
         * submitted"; work still to do is amber; a ready pack is green. The
         * blockers are one list, walls first, each with what to do — so nobody
         * has to reconcile the questions table and the returnables table in
         * their head to find out what is actually stopping the bid.
         */
        (() => {
          const gate = readiness.gate;
          const tone = gate.canSubmit ? 'ok' : gate.requirementUnmet ? 'err' : 'warn';
          return html`<div class="notice ${raw(tone)}" style="margin:11px 17px 0"><div>
            <b style="font-size:13.5px">${gate.headline}</b>
            ${
              gate.blockers.length > 0
                ? html`<ul style="margin:9px 0 0;padding-left:0;list-style:none">
                    ${gate.blockers.map(
                      (block) => html`<li style="margin-bottom:8px">
                        <div>
                          ${block.requirementUnmet ? badge('requirement not met', 'bad') : ''}
                          ${block.what}
                        </div>
                        <div style="color:var(--text-3);font-size:12px;margin-top:2px">→ ${block.remedy}</div>
                      </li>`,
                    )}
                  </ul>`
                : ''
            }
          </div></div>`;
        })()
      }
      ${
        /*
         * The order of operations, off the screen rather than carried in
         * somebody's head. The gate above says whether the pack can go and why;
         * this says what to work through to get there, in sequence. The one
         * NOW step is the thing to do next; DONE steps are ticked so progress
         * reads at a glance; LATER steps are dimmed so nobody jumps ahead to a
         * step that waits on an earlier one.
         */
        (position.nextSteps ?? []).length > 0
          ? html`<div style="margin:12px 17px 0">
              <h2 style="margin:0 0 7px;font-size:14px">Do this next</h2>
              <ol style="margin:0;padding:0;list-style:none">
                ${position.nextSteps.map(
                  (step) => html`<li style="display:flex;gap:9px;padding:7px 0;border-top:1px solid var(--line);${
                    step.state === 'LATER' ? 'opacity:.55' : ''
                  }">
                    <span style="flex:none;width:76px">${
                      step.state === 'DONE'
                        ? badge('done', 'ok')
                        : step.state === 'NOW'
                          ? badge('do now', 'info')
                          : badge('later', '')
                    }</span>
                    <div>
                      <div style="font-weight:${raw(step.state === 'NOW' ? '600' : '400')};font-size:12.5px">${step.title}</div>
                      <div style="color:var(--text-3);font-size:12px;margin-top:2px">${step.detail}</div>
                    </div>
                  </li>`,
                )}
              </ol>
            </div>`
          : ''
      }
      ${
        limits.length > 0
          ? html`<div class="notice warn" style="margin:11px 17px 0"><div>
              ${limits.map((line) => html`<div>${line}</div>`)}
            </div></div>`
          : ''
      }
      ${
        // The source banner, on the pack itself as well as on the register.
        // Shown only where the tender has actually moved: a banner that is
        // always there is furniture, and the one time it means something it is
        // read as furniture too.
        source?.changed?.length > 0
          ? html`<div class="notice warn" style="margin:11px 17px 0"><div>
              <b>The tender this bid was imported from has changed.</b>
              ${source.note}
            </div></div>`
          : ''
      }
      ${
        // The hashes the import carried, shown where there are any and where
        // the list is not confirmed yet — which is when somebody needs them.
        // Each is a file the store already holds, so the parser can be pointed
        // at one instead of asking the customer for the pack again.
        (bid.sourceFiles ?? []).length > 0 && questions.length === 0
          ? html`<div class="notice info" style="margin:11px 17px 0"><div>
              <b>${bid.sourceFiles.length} file(s) came over with this tender.</b>
              Read the questionnaire from one of them — nothing has to be uploaded again.
              ${bid.sourceFiles.map((file) => html`<div style="margin-top:4px">
                ${file.description}
                <code style="font-size:11.5px;color:var(--text-3)">${file.hash}</code>
              </div>`)}
            </div></div>`
          : ''
      }
      ${
        /*
         * The parse's proposal, which nothing showed.
         *
         * The module reads a questionnaire into a proposed list and then asks
         * a person to confirm it against the source — and the screen never
         * displayed the proposal, so "confirm it" meant retyping, by hand, in
         * a pipe-delimited format, the list a model had just extracted. The
         * command has always accepted an empty list to mean "the parse was
         * right"; there was simply no way to see what one would be agreeing
         * to.
         *
         * So: the proposal, in full, with one button that confirms it and one
         * that opens the editor pre-filled. The confirmation is still a
         * person's act against the source document — that rule is the reason
         * the proposal is not applied automatically — but it is now a reading
         * rather than a transcription.
         */
        (bid.proposedQuestions ?? []).length > 0 && questions.length === 0
          ? html`<div class="card pad0" style="margin:11px 17px 0">
              <h2 style="padding:15px 17px 0">Proposed question list — not confirmed yet</h2>
              <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                ${bid.proposedQuestions.length} question(s) read out of the questionnaire${bid.parsedBy ? ` by ${bid.parsedBy}` : ''}.
                <b>Check them against the source document before confirming.</b> A parser that missed one question
                produces a pack where every answer is good, readiness reads 100%, and the submission is rejected for
                a missing mandatory response — and nothing downstream can detect that, because what is wrong is the
                list itself.
              </p>
              <div style="padding:11px 17px 0">
                ${table({
                  headers: ['Section', '#', 'Question', 'Type', 'Limit', 'Weight', 'Must'],
                  align: ['', '', '', '', 'num', 'num', ''],
                  rows: bid.proposedQuestions.map((entry) => [
                    entry.section,
                    entry.number,
                    entry.text,
                    humanise(entry.answerType ?? 'TEXT'),
                    entry.wordLimit ?? '—',
                    entry.weighting ?? '—',
                    entry.mandatory ? badge('mandatory', 'warn') : badge('optional', ''),
                  ]),
                })}
              </div>
              <div class="actions" style="padding:11px 17px 15px">
                <button class="btn" data-confirm-proposal="${bid.id}">Confirm these ${bid.proposedQuestions.length} questions</button>
                <button class="btn quiet" data-edit-proposal="${bid.id}">Edit before confirming</button>
              </div>
            </div>`
          : ''
      }
      ${
        /*
         * The step that should come before drafting, said before drafting.
         *
         * A question asked for six things and the library held none of them —
         * and the platform found that out by drafting an answer, charging for
         * it, and raising a gap at the end. Nobody had ever been asked for the
         * material. The question list is confirmed days earlier; from that
         * moment what the pack will take is knowable, and leaving somebody to
         * discover it one paid draft at a time is the defect this notice
         * exists to stop repeating.
         */
        questions.length > 0 && !bid.evidenceNeeds
          ? html`<div class="notice warn" style="margin:11px 17px 0"><div>
              <b>Nothing has been asked of the customer for this pack yet.</b>
              The question list is confirmed, so what answering it will take can be worked out now — what each
              question needs, what the library already covers, and one request for the rest. Doing this before
              drafting is the difference between one message to the customer and finding out what was missing by
              paying for a draft that could not have been evidenced.
              <div class="actions" style="margin-top:9px">
                <button class="btn sm" data-act="evidence-needs" data-act-bid="${bid.id}">
                  Work out what this pack needs
                </button>
              </div>
            </div></div>`
          : ''
      }
      ${
        bid.evidenceNeeds
          ? html`<div class="notice info" style="margin:11px 17px 0"><div>
              <b>What this pack needs was worked out on ${date(bid.evidenceNeeds.reviewedAt)}</b>
              by ${bid.evidenceNeeds.provider}: ${bid.evidenceNeeds.needed} piece(s) of evidence across
              ${bid.evidenceNeeds.questions} question(s), ${bid.evidenceNeeds.held} of them already filed,
              ${bid.evidenceNeeds.raised} gap(s) raised.
              ${
                openGaps.length > 0
                  ? html`<b>Send the request before drafting</b> — the open gaps below are what is still missing.`
                  : ''
              }
            </div></div>`
          : ''
      }
      <div class="grid g4" style="padding:11px 17px 0">
        <div class="card">
          <h2>Readiness</h2>
          <div class="metric ${raw(readiness.readinessPercent === null ? '' : readiness.readinessPercent >= 80 ? 'good' : readiness.readinessPercent >= 50 ? 'orange' : 'bad')}">
            ${readiness.readinessPercent === null ? '—' : `${readiness.readinessPercent}%`}
          </div>
          <div class="metric-sub">Weighted by each question's own share of the buyer's marks.</div>
        </div>
        <div class="card">
          <h2>Approved</h2>
          <div class="metric">${readiness.approved} of ${readiness.total}</div>
          <div class="metric-sub">A person has to put their name to every answer before anything leaves here.</div>
        </div>
        <div class="card">
          <h2>Traffic lights</h2>
          <div class="metric">${readiness.green}/${readiness.amber}/${readiness.red}</div>
          <div class="metric-sub">Green, amber, red. Red is below 50 or a hard rule.</div>
        </div>
        <div class="card">
          <h2>Open gaps</h2>
          <div class="metric ${raw(openGaps.length === 0 ? 'good' : 'warn')}">${openGaps.length}</div>
          <div class="metric-sub">Each pauses its own question only.</div>
        </div>
      </div>
      ${
        estimate && !estimate.error
          ? html`<div class="notice info" style="margin:11px 17px 0"><div>
              <b>To finish this pack: ${money(estimate.chargeMinor)} across ${estimate.runs} agent run(s).</b>
              ${estimate.summary}
              ${estimate.limits.map((line) => html`<div style="margin-top:4px">${line}</div>`)}
            </div></div>`
          : ''
      }
      <div style="padding:11px 17px 0">
        <!--
          Carry-forward is a read and costs nothing, but it is a second screen's
          worth of detail on a pack that is already long — so it is a button
          rather than always-on. On a sixty-question ITT the first question a
          writer asks is "what have we already answered", and this is it.
        -->
        <button class="btn sm quiet" data-carry="${bid.id}">What have we answered before?</button>
      </div>
      <div id="carry-detail" style="padding:0 17px"></div>
      ${
        // The returnables, where there are any. Above the questions table
        // deliberately: a pack can read 92% on answers and be unsendable for an
        // unsigned order form, and the thing nobody is looking at belongs where
        // they are looking.
        (position.returnables ?? []).length > 0
          ? html`<div style="padding:11px 17px 0">
              <h2 style="margin:0 0 4px;font-size:14px">What has to be returned</h2>
              <p style="margin:0 0 6px;font-size:12.5px;color:var(--text-3)">
                Not answers. A submission missing a required document is rejected exactly as completely as one
                missing an answer, and none of this is in the readiness figure above.
                <b>Who</b> is who has to produce each one: the <b>bid team</b> (you) or
                <b>${customer.legalName}</b>, the bidding company whose submission this is — never the buyer. A
                document that is the bidding company's own, like a signed form or a priced cost model, cannot be
                drafted here; it goes in the request to them.
              </p>
              ${table({
                headers: ['Ref', 'What', 'Who', 'Format', 'Limit', 'Sign', 'We need it by', 'Standing', 'Next', 'id'],
                align: ['', '', '', '', 'num', '', '', '', ''],
                rows: position.returnables.map((item) => [
                  item.mandatory ? html`${item.reference} ${badge('must', 'warn')}` : item.reference,
                  item.title,
                  item.owner === 'CUSTOMER'
                    ? html`<span title="${customer.legalName} — the bidding company. Their own document to produce or sign; the bid team cannot do it for them.">${badge(customer.legalName, 'info')}</span>`
                    : html`<span title="The bid team (you) — yours to produce.">bid team</span>`,
                  item.format ?? html`<span style="font-size:12px;color:var(--text-3)">not stated</span>`,
                  item.pageLimit ? `${item.pageLimit}pp` : item.fileSizeLimitMb ? `${item.fileSizeLimitMb}MB` : '—',
                  item.signatureRequired ? badge('signature', 'warn') : '—',
                  item.internalDueBy ? date(item.internalDueBy) : '—',
                  item.status === 'SUPPLIED'
                    ? badge('done', 'ok')
                    : item.status === 'WAIVED'
                      ? html`<span title="${item.waivedReason ?? ''}">${badge('waived', '')}</span>`
                      : badge('outstanding', item.mandatory ? 'bad' : 'warn'),
                  /*
                   * The two acts that discharge a returnable, on its own row.
                   *
                   * This is the half of a submission that gets bids rejected
                   * rather than marked down, and both commands wanted the
                   * returnable id typed in from the register they are printed
                   * beside. Waiving stays quiet and second: it removes a gate,
                   * and the reason it asks for is what somebody reads if the
                   * submission comes back rejected for the missing document.
                   */
                  item.status === 'OUTSTANDING'
                    ? html`<div class="row-acts">
                        <button class="btn sm" data-act="supply-returnable" data-act-bid="${bid.id}"
                          data-act-returnable="${item.id}">Mark done</button>
                        <button class="btn sm quiet" data-act="waive-returnable" data-act-bid="${bid.id}"
                          data-act-returnable="${item.id}">Waive</button>
                      </div>`
                    : html`<span style="font-size:12px;color:var(--text-3)">—</span>`,
                  html`<code class="idcell" style="font-size:11px;color:var(--text-3)" data-copy="${item.id}" data-copy-what="returnable id" title="${item.id}">${item.id.slice(-8)}</code>`,
                ]),
              })}
            </div>`
          : ''
      }
      ${
        /*
         * Pricing guidance, not a price. A cost model (an EPC rate schedule, a
         * priced bill) is the hardest returnable to get right and the one a
         * client most often does blind — the real defect this closes was a unit
         * priced below its own cost, found only after the bid was won. The
         * calculator takes the client's own cost and margin and shows the price
         * that covers both, with the profit on cost and on price so "20%" is
         * not two different numbers. It holds no market price: what the market
         * pays is the client's to bring.
         */
        html`<div style="padding:11px 17px 0">
          <button class="btn sm quiet" data-cost-open>Price a cost line (cost + margin)</button>
          ${bidList.length > 0 ? html`<button class="btn sm quiet" data-command="import-tender-rate-card">Import a rate card for a tender</button>` : raw('')}
          <div id="cost-detail" style="margin-top:0"></div>
        </div>`
      }
      ${
        // Questions for the buyer. Separate from gaps, which go to the
        // customer, and time-critical in a different way: a clarification
        // deadline is almost always well before the return.
        clarifications.length > 0
          ? html`<div style="padding:11px 17px 0">
              <h2 style="margin:0 0 4px;font-size:14px">
                Questions for the buyer
                ${severityBadge('CRITICAL', 'bad')}
                ${severityBadge('MAJOR', 'warn')}
                ${severityBadge('MINOR', '')}
              </h2>
              <p style="margin:0 0 6px;font-size:12.5px;color:var(--text-3)">
                ${position.clarificationStanding?.summary ?? ''}
                Worst first. A question nobody sent is worth nothing, and a buyer usually issues their answers to
                every bidder — so the words matter and so does the date it went.
              </p>
              ${
                /*
                 * Sending them, and recording that they went.
                 *
                 * A portal takes one clarification message with the questions
                 * numbered inside it, and the buyer answers the lot in one
                 * response issued to every bidder. So the message is generated
                 * whole — nobody retypes thirty-seven questions out of a table,
                 * which is where one gets dropped, and the dropped one is never
                 * the minor one — and the record of it going is one act with one
                 * date, not thirty-seven.
                 *
                 * Sending itself happens in the buyer's portal. The platform
                 * does not email a buyer and should not: a clarification goes
                 * under a named account in an audited procurement.
                 */
                toAsk.length > 0
                  ? html`<div class="actions" style="margin:0 0 9px">
                      ${
                        // One per severity that has something waiting, in the
                        // order they would be sent. A button that would copy
                        // nothing is not offered — that is the rule for an act,
                        // where the rule for the register above is the opposite.
                        ['CRITICAL', 'MAJOR', 'MINOR']
                          .filter((severity) => bySev(severity) > 0)
                          .map(
                            (severity) => html`<button class="btn sm${raw(severity === 'CRITICAL' ? '' : ' quiet')}"
                              data-clar-send="${bid.id}" data-clar-severity="${severity}"
                              title="${SEVERITY_MEANS[severity]}">
                              Copy the ${bySev(severity)} ${severity.toLowerCase()}
                            </button>`,
                          )
                      }
                      <button class="btn sm quiet" data-clar-send="${bid.id}"
                        title="Every question not yet asked, worst first, as a message to paste into the portal">
                        Copy all ${toAsk.length} to send
                      </button>
                      <button class="btn sm quiet" data-clar-send="${bid.id}" data-clar-file="1">Download it</button>
                      <button class="btn sm quiet" data-clar-asked="${bid.id}">Record that they went</button>
                    </div>`
                  : ''
              }
              ${table({
                headers: ['', 'Subject', 'The question', 'Raised by', 'Asked', 'Their answer', 'Standing', 'Next', 'id'],
                rows: clarifications.map((entry) => [
                  badge(
                    humanise(entry.severity),
                    entry.severity === 'CRITICAL' ? 'bad' : entry.severity === 'MAJOR' ? 'warn' : '',
                  ),
                  entry.subject,
                  entry.question,
                  // Which part of the module noticed it, or a person. Worth
                  // showing: a reader treats "the amendments reading spotted
                  // this" differently from "a colleague asked for this".
                  humanise(entry.source),
                  entry.askedAt
                    ? html`${date(entry.askedAt)}${entry.buyerReference
                        ? html` <span style="font-size:12px;color:var(--text-3)">${entry.buyerReference}</span>`
                        : ''}`
                    : '—',
                  entry.answer ?? '—',
                  entry.status === 'ANSWERED'
                    ? badge('answered', 'ok')
                    : entry.status === 'ASKED'
                      ? badge('awaiting an answer', 'warn')
                      : entry.status === 'WITHDRAWN'
                        ? html`<span title="${entry.withdrawnReason ?? ''}">${badge('withdrawn', '')}</span>`
                        : badge('not asked yet', 'bad'),
                  /*
                   * What this question is waiting for.
                   *
                   * Asking is the buttons above — one message, not one act per
                   * question. What is left per row is what only applies to one
                   * of them: the buyer's answer when it comes back, and the
                   * withdrawal of one that will not be sent.
                   */
                  entry.status === 'ASKED'
                    ? html`<button class="btn sm" data-act="clarification-answer" data-act-bid="${bid.id}"
                        data-act-clarification="${entry.id}">Their answer</button>`
                    : entry.status === 'RAISED'
                      ? html`<button class="btn sm quiet" data-act="clarification-withdraw" data-act-bid="${bid.id}"
                          data-act-clarification="${entry.id}">Withdraw</button>`
                      : html`<span style="font-size:12px;color:var(--text-3)">—</span>`,
                  html`<code class="idcell" style="font-size:11px;color:var(--text-3)" data-copy="${entry.id}" data-copy-what="clarification id" title="${entry.id}">${entry.id.slice(-8)}</code>`,
                ]),
              })}
            </div>`
          : ''
      }
      ${
        // What the amendments reading found. Observations, not a verdict —
        // nothing here accepts or qualifies anything.
        position.bid.amendmentsReview
          ? html`<div class="notice info" style="margin:11px 17px 0"><div>
              <b>The schedule of amendments, as read on ${date(position.bid.amendmentsReview.reviewedAt)}</b>
              by ${position.bid.amendmentsReview.provider}${
                position.bid.amendmentsReview.contractForm
                  ? html`, against ${position.bid.amendmentsReview.contractForm}`
                  : ''
              }.
              Observations only — nothing here accepts, qualifies or advises on a clause, and the decision it
              informs binds a company.
              ${position.bid.amendmentsReview.observations.map((line) => html`<div style="margin-top:4px">${line}</div>`)}
            </div></div>`
          : ''
      }
      ${table({
        headers: ['#', 'Section', 'Question', 'Type', 'Limit', 'Weight', 'Words', 'Cites', 'v', 'Answer', 'Verdict', 'Next', 'ids'],
        align: ['', '', '', '', 'num', 'num', 'num', 'num', 'num', '', '', '', ''],
        rows: questions.map((entry) => [
          entry.question.number,
          entry.question.section,
          html`${entry.question.text}${entry.question.mandatory ? badge('mandatory', 'warn') : ''}${
            entry.question.passFail ? badge('pass/fail', 'bad') : ''
          }`,
          humanise(entry.question.answerType),
          entry.question.wordLimit === undefined ? '—' : String(entry.question.wordLimit),
          entry.question.weighting === undefined ? '—' : `${entry.question.weighting}%`,
          entry.answer ? String(entry.answer.words) : '—',
          entry.answer ? String(entry.answer.citations.length) : '—',
          entry.versions === 0 ? '—' : String(entry.versions),
          entry.answer
            ? badge(humanise(entry.answer.status), ANSWER_TONE[entry.answer.status] ?? '')
            : entry.gap
              ? badge('gap raised', 'warn')
              : badge('nothing written', 'bad'),
          html`${badge(entry.verdict.rag, RAG_TONE[entry.verdict.rag] ?? '')}${
            entry.verdict.hardRules.length > 0 && entry.verdict.weightedBand !== 'RED'
              ? html`<span style="font-size:12px;color:var(--text-3)"> prose alone: ${entry.verdict.weightedBand} ${entry.verdict.weightedScore}</span>`
              : html`<span style="font-size:12px;color:var(--text-3)"> ${entry.verdict.weightedScore}</span>`
          }`,
          // What this question is waiting for, as the button that does it.
          nextAct(position.bid.id, entry),
          /*
           * The two ids every answer command asks for.
           *
           * `Draft an answer`, `Write an answer`, `Score an answer`, `Approve
           * an answer` and `Raise a gap` each take a question id or an answer
           * id "from the opened pack above", and the pack printed neither —
           * while the returnables and the clarifications beside it printed
           * theirs. The commands were unreachable from this screen: the
           * platform worked, the forms were correct, and there was nowhere to
           * read the one value they needed. Click either to copy it.
           */
          html`<div><code class="idcell" style="font-size:11px;color:var(--text-3)" data-copy="${entry.question.id}" data-copy-what="question id" title="${entry.question.id}">Q ${entry.question.id.slice(-8)}</code></div>${
            entry.answer
              ? html`<div><code class="idcell" style="font-size:11px;color:var(--text-3)" data-copy="${entry.answer.id}" data-copy-what="answer id" title="${entry.answer.id}">A ${entry.answer.id.slice(-8)}</code></div>`
              : ''
          }`,
        ]),
        empty: 'No question confirmed yet',
        emptyDetail:
          'The question list is confirmed by a person once, against the source document. A parser that missed a ' +
          'question produces a pack where every answer is good and the submission is still rejected.',
      })}
      ${
        /*
         * What every answer that is not green needs, in one place.
         *
         * "RED 40" is a verdict, not an instruction. The shortfall is exactly
         * computable from the weights the score was made with — Evidence at
         * 25% needs four points for every one Clarity at 10% needs — so the
         * platform does that arithmetic instead of leaving somebody to do it
         * in their head on a tender week.
         *
         * Nothing here moves a threshold or softens a score. The green floor
         * is 80 because a buyer's evaluator is not generous, and an answer
         * shown as green that a buyer will mark at 40 is the one failure this
         * module cannot recover from.
         */
        questions.filter((entry) => entry.answer && entry.verdict.toGreen).length > 0
          ? html`<div class="notice warn" style="margin:11px 17px 0"><div>
              <b>${questions.filter((entry) => entry.answer && entry.verdict.toGreen).length} answer(s) are not green
              yet, and this is what each one needs.</b>
              The floor is 80. The arithmetic is the rubric's own weights, so the lightest route is the first one
              named — but a route is only worth taking if the evidence actually supports it.
              ${questions
                .filter((entry) => entry.answer && entry.verdict.toGreen)
                .map(
                  (entry) => html`<div style="margin-top:6px">
                    <b>${entry.question.number}</b> ${entry.verdict.toGreen.note}
                  </div>`,
                )}
            </div></div>`
          : ''
      }
      ${
        questions.some((entry) => entry.verdict.hardRules.length > 0)
          ? html`<div class="notice bad" style="margin:11px 17px 0"><div>
              <b>Hard rules fired. Each one overrides the score to red however well the answer reads.</b>
              ${questions
                .filter((entry) => entry.verdict.hardRules.length > 0)
                .map(
                  (entry) => html`<div style="margin-top:6px">
                    <b>${entry.question.number}</b>
                    ${entry.verdict.hardRules.map(
                      (hit) => html`<div style="margin-left:10px">
                        ${humanise(hit.rule)} — ${hit.detail} <i>${hit.remedy}</i>
                      </div>`,
                    )}
                  </div>`,
                )}
            </div></div>`
          : ''
      }
      ${
        openGaps.length > 0
          ? html`<div class="notice warn" style="margin:11px 17px 0"><div>
              <b>Waiting on the customer for ${openGaps.length} thing(s).</b>
              Batched deliberately: one list the customer answers in a sitting, rather than an email per question.
              ${openGaps.map(
                (gap) => html`<div style="margin-top:6px">
                  ${questions.find((entry) => entry.question.id === gap.questionId)?.question.number ?? '—'} —
                  ${gap.promptToClient}
                  <code class="idcell" style="font-size:11px;color:var(--text-3)" data-copy="${gap.id}" data-copy-what="gap id" title="${gap.id}">${gap.id.slice(-8)}</code>
                </div>`,
              )}
            </div></div>`
          : ''
      }
      ${
        /*
         * The pack comes out either way, and the buttons say which it is.
         *
         * Before this, a pack that was not finished could not be taken out at
         * all — so the only way to read the thing you were working on was to
         * finish it first, which on a real tender is the last afternoon. The
         * gate has not moved: a review copy is named REVIEW, carries everything
         * outstanding on its first page, and cannot be mistaken for the
         * submission.
         */
        html`<div class="actions" style="padding:11px 17px 0">
          <span style="font-size:12.5px;color:var(--text-3)">
            ${readiness.exportable
              ? "Take it out in the questionnaire's own structure — nothing is renumbered or regrouped:"
              : 'Not ready to send, and readable now — a review copy marked REVIEW, with what is outstanding on its first page:'}
          </span>
          <button class="btn sm${raw(readiness.exportable ? '' : ' quiet')}" data-render="DOCX" data-render-bid="${bid.id}"
            ${raw(readiness.exportable ? '' : 'data-render-review="1"')}>
            ${readiness.exportable ? 'Word' : 'Word — review copy'}
          </button>
          <button class="btn sm quiet" data-render="XLSX" data-render-bid="${bid.id}"
            ${raw(readiness.exportable ? '' : 'data-render-review="1"')}>
            ${readiness.exportable ? 'Spreadsheet' : 'Spreadsheet — review copy'}
          </button>
          <button class="btn sm quiet" data-render="TEXT" data-render-bid="${bid.id}"
            ${raw(readiness.exportable ? '' : 'data-render-review="1"')}>
            ${readiness.exportable ? 'Copy-ready text' : 'Copy-ready text — review copy'}
          </button>
          <button class="btn sm quiet" data-command="set-branding"
            title="The name, colour and footer the Word and spreadsheet exports carry. Set once per company.">Company identity</button>
        </div>`
      }
      ${
        readiness.blocking.length > 0
          ? html`<div class="notice err" style="margin:11px 17px 15px"><div>
              <b>${readiness.blocking.length} mandatory answer(s) block the export.</b>
              Named in full rather than one at a time, because fixing them one attempt at a time is how somebody
              decides at 4pm that the check is the problem.
              ${readiness.blocking.map(
                (entry) => html`<div style="margin-top:4px">
                  ${questions[entry.index]?.question.number ?? entry.index} — ${entry.reason}
                </div>`,
              )}
            </div></div>`
          : html`<div style="padding:0 17px 15px"></div>`
      }
    </div>
  `;
}

/** The badge tone for a checklist item's state. */
const CHECKLIST_TONE = { CURRENT: 'ok', LAPSED: 'bad', MISSING: 'warn' };

/**
 * What a bidder is asked for, shown before anything is drafted.
 *
 * This is the answer to "the system must know from the start what to put in and
 * where." The standing set of documents a tender asks for, measured against the
 * library, essentials first — so the gaps are visible on the day the workspace
 * is opened rather than discovered when an answer scores low for want of them.
 * Each gap carries a File button that opens the filing form with the kind and
 * the title already set.
 */
function checklistPanel(coverage, customerId) {
  if (!coverage) return '';
  const order = { ESSENTIAL: 0, COMMON: 1, SOMETIMES: 2 };
  const items = [...coverage.items].sort(
    (a, b) => order[a.importance] - order[b.importance] || a.label.localeCompare(b.label),
  );
  return html`<div class="card pad0" style="margin-bottom:11px">
    <h2 style="padding:15px 17px 0">What a tender will ask for</h2>
    <p style="padding:4px 17px 0;margin:0;font-size:12.5px;color:var(--text-3)">
      ${coverage.summary}
      <b> Essentials: ${coverage.essentialsCovered} of ${coverage.essentialsTotal}.</b>
      Build this before drafting — an answer can only cite what is already on file.
    </p>
    <div style="padding:11px 17px 15px">
      ${table({
        headers: ['', 'Document', 'What it is for', 'On file', 'Next'],
        rows: items.map((item) => [
          badge(humanise(item.importance), item.importance === 'ESSENTIAL' ? 'bad' : item.importance === 'COMMON' ? 'warn' : ''),
          html`${item.label}<div class="metric-sub"><code>${humanise(item.type)}</code></div>`,
          html`<span style="font-size:12.5px;color:var(--text-3)">${item.why}</span>`,
          item.status === 'CURRENT'
            ? html`${badge('on file', 'ok')}${item.coveredBy ? html`<div class="metric-sub">${item.coveredBy.reference}</div>` : ''}`
            : item.status === 'LAPSED'
              ? html`${badge('lapsed', 'bad')}${item.coveredBy ? html`<div class="metric-sub">${item.coveredBy.reference} — renew it</div>` : ''}`
              : badge('not on file', 'warn'),
          item.status === 'CURRENT'
            ? html`<span style="font-size:12px;color:var(--text-3)">—</span>`
            : html`<button class="btn sm" data-file-for="${customerId}" data-file-type="${item.type}" data-file-title="${item.label}">File it</button>`,
        ]),
      })}
    </div>
  </div>`;
}

/** One customer's evidence library. */
function evidencePanel(library, customerId) {
  return html`
    <div style="margin-top:11px">
      ${checklistPanel(library.checklist, customerId)}
      <p class="metric-sub">${library.summary}</p>
      ${table({
        headers: ['Ref', 'Type', 'Title', 'Valid from', 'Expires', 'Days left', 'Passages', 'Searchable', 'Standing', 'ids'],
        align: ['', '', '', '', '', 'num', 'num', '', '', ''],
        rows: library.evidence.map((item) => [
          item.reference,
          humanise(item.type),
          /*
           * The title, and how the document actually begins.
           *
           * A title is what somebody typed while filing nine documents in a
           * row, and a real library turned up holding two different files both
           * called "Appendix 1" — one of which was the Invitation to Tender.
           * Every column on this screen showed what had been said *about* the
           * documents; none showed anything from inside them. The first words
           * of the first passage settle it at a glance and cost nothing.
           */
          html`<div>${item.title}</div>
            ${item.opens
              ? html`<div class="metric-sub" style="margin-top:3px;max-width:52ch">
                  ${item.asks === 'QUESTIONS' ? html`${badge('asks questions', 'ok')} ` : ''}${item.opens}
                </div>`
              : ''}`,
          item.validFrom ? date(item.validFrom) : '—',
          item.expiresOn ? date(item.expiresOn) : html`<span style="font-size:12px;color:var(--text-3)">does not lapse</span>`,
          item.daysLeft === null ? '—' : item.daysLeft < 0 ? badge(`${Math.abs(item.daysLeft)} ago`, 'bad') : String(item.daysLeft),
          item.extracted ? String(item.chunkCount) : badge('nothing read', 'warn'),
          // Which of the two searches will find it, and in whose space. A
          // library half embedded by one model and half by another is a real
          // state and the column is where somebody sees it.
          item.semanticModel
            ? html`<span title="${item.semanticModel.provider}/${item.semanticModel.modelClass}, ${item.semanticModel.dimensions} dimensions">${badge('by meaning', 'ok')}</span>`
            : item.extracted
              ? badge('terms only', 'warn')
              : '—',
          item.withdrawnAt
            ? badge('withdrawn', '')
            : item.currentNow
              ? badge('current', 'ok')
              : badge('lapsed', 'bad'),
          /*
           * The two values the library's own commands ask to be typed.
           *
           * The id: `Record what was read out of it`, `Make an item searchable
           * by meaning`, `Close a gap` and `Mark a returnable done` all take an
           * evidence id, and two of their hints said it was on this row when it
           * was not — the row carried the reference, EVD-0004, which is not the
           * id and is not what the route takes.
           *
           * The hash: the questionnaire parser and the amendments reading take
           * a document by its hash. Sixty-nine characters of hex printed into a
           * ten-column table makes every other column unreadable, so it is a
           * button onto the clipboard; the id is shortened and clickable, like
           * every other id in this screen.
           */
          html`<div><code class="idcell" style="font-size:11px;color:var(--text-3)" data-copy="${item.id}" data-copy-what="evidence id" title="${item.id}">${item.id.slice(-8)}</code></div>
            <button class="btn quiet sm" type="button" style="margin-top:4px" data-copy="${item.hash}" data-copy-what="document hash" title="${item.hash}">Copy hash</button>`,
        ]),
        empty: 'Nothing filed for this customer',
        emptyDetail:
          'The library is what every answer is drafted from, so it is the first thing to build — and the thing that ' +
          'makes the second bid faster than the first.',
      })}
      ${
        library.limits.length > 0
          ? html`<div class="notice warn" style="margin-top:10px"><div>
              ${library.limits.map((line) => html`<div>${line}</div>`)}
            </div></div>`
          : ''
      }
    </div>
  `;
}

/** What the library has for one question, with the floor's refusal said plainly. */
function retrievalPanel(result) {
  return html`
    <div style="margin-top:11px">
      <div class="notice ${raw(result.chunks.length === 0 ? 'warn' : 'info')}" style="margin:0 0 10px">
        <div>
          <b>${result.method === 'EMBEDDING' ? 'Ranked by meaning' : 'Ranked on term overlap'}</b>${
            result.model ? html` · ${result.model}` : ''
          }${result.acuConsumed ? html` · cost ${money(result.acuConsumed)}` : ''}
        </div>
        <div>${result.note}</div>
      </div>
      ${result.chunks.map(
        (chunk) => html`<div style="padding:9px 0;border-top:1px solid var(--line)">
          <div class="actions" style="justify-content:space-between;align-items:baseline">
            <b>${chunk.reference} · ${chunk.title}</b>
            <span style="font-size:12px;color:var(--text-3)">
              ${humanise(chunk.type)}${chunk.pageRef ? ` · ${chunk.pageRef}` : ''} · match ${pct(chunk.score * 100, 0)}
              ${chunk.expiresOn ? ` · expires ${chunk.expiresOn}` : ''}
            </span>
          </div>
          <p style="margin:6px 0;font-size:13px;line-height:1.55">${chunk.text}</p>
        </div>`,
      )}
    </div>
  `;
}

/**
 * One engagement's account for a period.
 *
 * The contribution figure is labelled as what it is. `received − AI cost` is
 * not profit: it ignores the provider's own time, which is the largest cost in
 * a bid-support business by a wide margin, and a screen that called it profit
 * would be telling somebody they made £1,420 on a pack that took three days.
 */
function statementPanel(statement) {
  return html`
    <div style="margin-top:11px">
      <p class="metric-sub">${statement.summary}</p>
      <div class="grid g4">
        <div class="card">
          <h2>Invoiced</h2>
          <div class="metric">${money(statement.invoicedMinor)}</div>
          <div class="metric-sub">${money(statement.receivedMinor)} received, ${money(statement.outstandingMinor)} outstanding.</div>
        </div>
        <div class="card">
          <h2>AI it took</h2>
          <div class="metric orange">${money(statement.acuChargedMinor)}</div>
          <div class="metric-sub">${statement.acuRuns} agent run(s) attributed to this engagement.</div>
        </div>
        <div class="card">
          <h2>Contribution</h2>
          <div class="metric ${raw(statement.contributionMinor >= 0 ? 'good' : 'bad')}">
            ${money(statement.contributionMinor)}
          </div>
          <div class="metric-sub">
            Received less what the AI cost. <b>Not profit</b> — it ignores your own time.
          </div>
        </div>
        <div class="card">
          <h2>Delivered</h2>
          <div class="metric">${statement.work.packsExported}</div>
          <div class="metric-sub">
            pack(s) exported · ${statement.work.answersApproved} answer(s) approved ·
            ${statement.work.stagesSignedOff} stage(s) signed off
          </div>
        </div>
      </div>
      ${table({
        headers: ['On', 'What', 'Reference', 'Narrative', 'Amount'],
        align: ['', '', '', '', 'num'],
        rows: statement.lines.map((line) => [
          date(line.on),
          humanise(line.kind),
          line.reference,
          line.narrative,
          line.amountMinor === 0 ? '—' : money(line.amountMinor),
        ]),
        empty: 'Nothing in this period',
      })}
      <div class="notice info" style="margin-top:10px"><div>
        ${statement.limits.map((line) => html`<div>${line}</div>`)}
      </div></div>
    </div>
  `;
}
