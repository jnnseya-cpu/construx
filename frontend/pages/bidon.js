import { api } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { badge, date, html, humanise, money, notice, pct, raw, render, table } from '../lib/ui.js';
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

/** What each engagement type means for how work opens and repeats. */
const TYPE_MEANING = {
  ONE_OFF: 'One or more bids, then it closes. Billed as a fixed fee.',
  PERMANENT: 'Open-ended; bids added at any time. Billed monthly.',
  CONTINUOUS: 'Repeats on a schedule — annual re-verification, a weekly tender watch. Billed per cycle.',
  STAGED: 'Ordered stages; the next opens only after the last is signed off. Billed per stage.',
  CUSTOM: 'Free-form terms recorded on the engagement itself.',
};

export async function bidon(root) {
  const [customers, engagements, offerings, bids] = await Promise.all([
    // Every read is tenant-scoped and filtered to this person inside the API,
    // not here. A screen that filtered would leak the moment anybody called
    // the route directly.
    api.read('/v1/bid-on/customers', 'BID_SERVICES', 'COMMERCIAL_L3').catch((error) => ({ error })),
    api.read('/v1/bid-on/engagements', 'BID_SERVICES', 'COMMERCIAL_L3').catch((error) => ({ error })),
    api.read('/v1/bid-on/offerings', 'BID_SERVICES', 'COMMERCIAL_L3').catch((error) => ({ error })),
    api.read('/v1/bid-on/bids', 'BID_SERVICES', 'COMMERCIAL_L3').catch((error) => ({ error })),
  ]);

  const customerList = customers?.customers ?? [];
  const bidList = bids?.bids ?? [];
  const engagementList = engagements?.engagements ?? [];
  const offeringList = offerings?.offerings ?? [];

  const customerOptions = customerList
    .filter((customer) => customer.status === 'ACTIVE')
    .map((customer) => ({ value: customer.id, label: `${customer.reference} — ${customer.legalName}` }));

  /** Engagements work can be done against, or acted on. */
  const liveEngagements = engagementList.filter(
    (entry) => entry.status === 'ACTIVE' || entry.status === 'PAUSED' || entry.status === 'DRAFT',
  );
  const engagementLabel = (entry) =>
    `${entry.reference} — ${entry.name} · ${humanise(entry.status)}`;

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
          { id: 'raise-gap', label: 'Raise a gap', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          { id: 'resolve-gap', label: 'Close a gap', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          { id: 'export-bid', label: 'Export the pack',
            permitted: can('BID_SERVICES', 'I'), reason: blockedReason('BID_SERVICES', 'I') },
          { id: 'record-bid-outcome', label: 'Record the outcome', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
        ]))}
      </div>
      ${table({
        headers: ['Ref', 'Customer', 'Buyer', 'Scheme', 'Due', 'Left', 'Questions', 'Approved', 'Gaps', 'Readiness', 'State', ''],
        align: ['', '', '', '', '', 'num', 'num', 'num', 'num', 'num', '', ''],
        rows: bidList.map((bid) => [
          bid.reference,
          bid.customerName,
          bid.buyerName,
          humanise(bid.scheme),
          date(bid.deadline),
          bid.daysLeft < 0
            ? badge(`${Math.abs(bid.daysLeft)} over`, 'bad')
            : badge(`${bid.daysLeft}d`, bid.daysLeft <= 5 ? 'warn' : ''),
          String(bid.questions),
          String(bid.approved),
          bid.openGaps === 0 ? '—' : badge(String(bid.openGaps), 'warn'),
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
          { id: 'record-extraction', label: 'Record what was read out of it', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          { id: 'withdraw-evidence', label: 'Withdraw an item', tone: 'quiet',
            permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
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
      </div>
      <div id="evidence-detail" style="padding:0 17px 4px"></div>
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
      const [position, estimate] = await Promise.all([
        api.read(`/v1/bid-on/bids/${open.dataset.bid}`, 'BID_SERVICES', 'COMMERCIAL_L3'),
        // Beside the pack rather than behind a separate button: the question
        // "what would it cost to finish this" is asked by whoever is looking
        // at what is left, and a quote on another screen is a quote nobody
        // reads before pressing the thing that spends.
        api
          .read(`/v1/bid-on/bids/${open.dataset.bid}/acu-estimate`, 'BID_SERVICES', 'COMMERCIAL_L3')
          .catch((error) => ({ error })),
      ]);
      render(detail, bidDetail(position, estimate));
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
   * One customer's library, and what it has for one question.
   *
   * Two buttons on one chooser rather than two choosers. The question is the
   * only thing that differs between them, and a second customer select is a
   * second chance to read the library of a customer you did not mean.
   */
  const evidenceDetail = root.querySelector('#evidence-detail');
  const chosenCustomer = () => root.querySelector('#ev-customer')?.value;

  root.querySelector('#ev-open')?.addEventListener('click', async () => {
    const customerId = chosenCustomer();
    if (!customerId || !evidenceDetail) return;
    try {
      const library = await api.read(
        `/v1/bid-on/customers/${customerId}/evidence`,
        'BID_SERVICES',
        'COMMERCIAL_L3',
      );
      render(evidenceDetail, evidencePanel(library));
    } catch (error) {
      render(evidenceDetail, notice(`The library could not be read: ${error.message}`, 'err'));
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
        { name: 'deadline', label: 'Return deadline', type: 'date',
          hint: 'The day the buyer reads it. Every certificate expiry is judged against this, not against today.' },
        { name: 'buyerReference', label: 'Buyer’s reference', type: 'text', required: false },
      ],
      transform: (v) => Object.fromEntries(Object.entries(v).filter(([, value]) => String(value ?? '').trim())),
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
      ],
      transform: ({ bidId: _b, body, yesNo, ...rest }) => ({
        ...rest,
        body: String(body ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
        ...(String(yesNo ?? '').trim() === '' ? {} : { yesNo: yesNo === 'true' }),
      }),
    },
    'parse-questionnaire': {
      title: 'Read the questionnaire',
      intent:
        'Reads a questionnaire into an ordered question list, keeping the buyer’s own numbering exactly as printed. ' +
        'It produces a proposal and nothing more: a person confirms the list against the source, because a parser ' +
        'that drops one question produces a pack where every answer is good and the submission is still rejected. ' +
        'The cost of the run is quoted before it starts.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/parse`,
      submitLabel: 'Read',
      ai: true,
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.filter((bid) => bid.questions === 0).map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.buyerName}` })) },
        { name: 'text', label: 'Pasted from the portal', type: 'textarea', rows: 10, required: false,
          hint: 'Paste the questions. Leave blank and give a file hash instead for a PDF, including a scan.' },
        { name: 'hash', label: 'Or a document hash', type: 'text', required: false,
          hint: 'A file already in the evidence store. A scan is read by a vision model rather than refused.' },
      ],
      transform: ({ bidId: _b, ...rest }) =>
        Object.fromEntries(Object.entries(rest).filter(([, value]) => String(value ?? '').trim())),
    },
    'draft-answer': {
      title: 'Draft an answer',
      intent:
        'Retrieval runs first, against this customer’s evidence only. If nothing in their library supports the ' +
        'question it raises a gap instead of drafting and costs nothing — a model asked to answer a question its ' +
        'evidence cannot support writes exactly the uncited claim that gets a submission thrown out. An answer that ' +
        'comes back citing nothing becomes a gap too.',
      path: (v) => `/v1/bid-on/bids/${v.bidId}/draft`,
      submitLabel: 'Draft',
      ai: true,
      fields: [
        { name: 'bidId', label: 'Bid', type: 'select',
          options: bidList.filter((bid) => bid.questions > 0).map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.buyerName}` })) },
        { name: 'questionId', label: 'Question id', type: 'text', hint: 'From the opened pack above.' },
        { name: 'reviewerInstructions', label: 'Anything the drafter should know', type: 'textarea', rows: 2, required: false,
          hint: 'A rejected answer already carries the reviewer’s instructions; this is for anything else.' },
      ],
      transform: ({ bidId: _b, reviewerInstructions, ...rest }) => ({
        ...rest,
        ...(String(reviewerInstructions ?? '').trim()
          ? { reviewerInstructions: String(reviewerInstructions).trim() }
          : {}),
      }),
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
          options: bidList.filter((bid) => bid.openGaps > 0).map((bid) => ({ value: bid.id, label: `${bid.reference} — ${bid.openGaps} open` })) },
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
        { name: 'evidenceId', label: 'Evidence filed to close it', type: 'text', required: false },
        { name: 'note', label: 'What closed it', type: 'text' },
      ],
      transform: ({ bidId: _b, gapId: _g, evidenceId, ...rest }) => ({
        ...rest,
        ...(String(evidenceId ?? '').trim() ? { evidenceId: String(evidenceId).trim() } : {}),
      }),
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
        { name: 'hash', label: 'File hash', type: 'text',
          hint: 'The hash of the file already uploaded to the evidence store, which refuses bytes that do not hash to the address they claim.' },
        { name: 'validFrom', label: 'Valid from', type: 'date', required: false },
        { name: 'expiresOn', label: 'Current until', type: 'date', required: false,
          hint: 'Required for a certificate or an insurance schedule. Everything else may genuinely not lapse.' },
        { name: 'consentSubject', label: 'Data subject', type: 'text', required: false,
          hint: 'For a CV: whose data it is.' },
        { name: 'consentBasis', label: 'How consent was obtained', type: 'text', required: false },
      ],
      transform: ({ customerId: _c, consentSubject, consentBasis, ...rest }) => ({
        ...Object.fromEntries(Object.entries(rest).filter(([, value]) => String(value ?? '').trim())),
        ...(String(consentSubject ?? '').trim()
          ? { consent: { subject: String(consentSubject).trim(), basis: String(consentBasis ?? '').trim() } }
          : {}),
      }),
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
        { name: 'evidenceId', label: 'Evidence id', type: 'text',
          hint: 'From the library panel above.' },
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
        { name: 'evidenceId', label: 'Evidence id', type: 'text' },
        { name: 'reason', label: 'Why', type: 'text' },
      ],
      transform: ({ evidenceId: _e, ...rest }) => rest,
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
        { name: 'offeringId', label: 'From the catalogue', type: 'select', required: false,
          options: [
            { value: '', label: 'Price it directly' },
            ...offeringList.filter((o) => o.active).map((o) => ({ value: o.id, label: `${o.reference} — ${o.name}` })),
          ],
          hint: 'Fills in the type, fee, basis, deposit and deliverables. Every one can still be changed below.' },
        { name: 'type', label: 'Engagement type', type: 'select',
          options: Object.entries(TYPE_MEANING).map(([value, meaning]) => ({ value, label: `${humanise(value)} — ${meaning}` })) },
        { name: 'billingBasis', label: 'Billing basis', type: 'select', required: false,
          options: [
            { value: '', label: 'Take it from the service' },
            ...['FIXED_FEE', 'MONTHLY', 'PER_CYCLE', 'PER_STAGE', 'AS_AGREED'].map((value) => ({ value, label: humanise(value) })),
          ] },
        { name: 'fee', label: 'Fee', type: 'number', required: false,
          hint: 'In whole currency units. Leave blank to take the service’s starting price.' },
        { name: 'currency', label: 'Currency', type: 'text', required: false, placeholder: 'GBP' },
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
  };

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const spec = COMMANDS[button.dataset.command];
    if (!spec) return;
    if (await command(spec)) await draw();
  });
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
function bidDetail(position, estimate) {
  const { bid, customer, questions, readiness, openGaps, limits } = position;
  return html`
    <div class="card pad0">
      <h2 style="padding:15px 17px 0">
        ${bid.reference} · ${bid.buyerName}
        ${readiness.exportable ? badge('ready to export', 'ok') : badge(humanise(bid.status), BID_TONE[bid.status] ?? '')}
      </h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        ${customer.legalName} · ${humanise(bid.scheme)} · due ${date(bid.deadline)}.
        ${readiness.summary}
        Every verdict is judged against the deadline rather than against today, because that is the day the buyer
        reads it.
      </p>
      ${
        limits.length > 0
          ? html`<div class="notice warn" style="margin:11px 17px 0"><div>
              ${limits.map((line) => html`<div>${line}</div>`)}
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
      ${table({
        headers: ['#', 'Section', 'Question', 'Type', 'Limit', 'Weight', 'Words', 'Cites', 'v', 'Answer', 'Verdict'],
        align: ['', '', '', '', 'num', 'num', 'num', 'num', 'num', '', ''],
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
        ]),
        empty: 'No question confirmed yet',
        emptyDetail:
          'The question list is confirmed by a person once, against the source document. A parser that missed a ' +
          'question produces a pack where every answer is good and the submission is still rejected.',
      })}
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
                </div>`,
              )}
            </div></div>`
          : ''
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

/** One customer's evidence library. */
function evidencePanel(library) {
  return html`
    <div style="margin-top:11px">
      <p class="metric-sub">${library.summary}</p>
      ${table({
        headers: ['Ref', 'Type', 'Title', 'Valid from', 'Expires', 'Days left', 'Passages', 'Standing'],
        align: ['', '', '', '', '', 'num', 'num', ''],
        rows: library.evidence.map((item) => [
          item.reference,
          humanise(item.type),
          item.title,
          item.validFrom ? date(item.validFrom) : '—',
          item.expiresOn ? date(item.expiresOn) : html`<span style="font-size:12px;color:var(--text-3)">does not lapse</span>`,
          item.daysLeft === null ? '—' : item.daysLeft < 0 ? badge(`${Math.abs(item.daysLeft)} ago`, 'bad') : String(item.daysLeft),
          item.extracted ? String(item.chunkCount) : badge('nothing read', 'warn'),
          item.withdrawnAt
            ? badge('withdrawn', '')
            : item.currentNow
              ? badge('current', 'ok')
              : badge('lapsed', 'bad'),
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
