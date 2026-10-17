import { api } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { badge, date, html, humanise, money, notice, raw, render, table } from '../lib/ui.js';
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

/** What each engagement type means for how work opens and repeats. */
const TYPE_MEANING = {
  ONE_OFF: 'One or more bids, then it closes. Billed as a fixed fee.',
  PERMANENT: 'Open-ended; bids added at any time. Billed monthly.',
  CONTINUOUS: 'Repeats on a schedule — annual re-verification, a weekly tender watch. Billed per cycle.',
  STAGED: 'Ordered stages; the next opens only after the last is signed off. Billed per stage.',
  CUSTOM: 'Free-form terms recorded on the engagement itself.',
};

export async function bidon(root) {
  const [customers, engagements, offerings] = await Promise.all([
    // Every read is tenant-scoped and filtered to this person inside the API,
    // not here. A screen that filtered would leak the moment anybody called
    // the route directly.
    api.read('/v1/bid-on/customers', 'BID_SERVICES', 'COMMERCIAL_L3').catch((error) => ({ error })),
    api.read('/v1/bid-on/engagements', 'BID_SERVICES', 'COMMERCIAL_L3').catch((error) => ({ error })),
    api.read('/v1/bid-on/offerings', 'BID_SERVICES', 'COMMERCIAL_L3').catch((error) => ({ error })),
  ]);

  const customerList = customers?.customers ?? [];
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

    <div class="notice info" style="margin-bottom:14px"><div>
      <b>A declaration is confirmed by the customer, never here.</b>
      Insurance cover, accident figures and legal statements are representations the customer makes to a buyer under
      its own name. They are confirmed by that customer's own admin, as a guest, inside their workspace — so there is
      deliberately no button for the provider's staff on this screen. Whoever confirms it is who the buyer will hold
      to it.
    </div></div>
  `;

  render(root, view);

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
