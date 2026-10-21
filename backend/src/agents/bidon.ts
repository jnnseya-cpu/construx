import { customersOf, liveDeclarations } from '../domain/bidon/customers.ts';
import { engagementsOf } from '../domain/bidon/engagements.ts';
import { bidRegister } from '../domain/bidon/bids.ts';
import type { EngineContext } from '../engines/context.ts';
import type { AgentDefinition, AgentOutput, Finding } from './types.ts';

/**
 * The Bid-On engagement watch.
 *
 * ## Why an agent here at all
 *
 * Everything this reports is visible on the Bid-On screen, for one engagement
 * at a time. Nobody opens forty of them. A provider running six retainers and
 * a dozen one-off packs has a handful of facts that cost real money the week
 * nobody notices them, and each one is arithmetic over records the platform
 * already holds:
 *
 *   - **a retainer with no cycle open** is a customer being billed monthly and
 *     receiving nothing, which is the complaint that ends a retainer;
 *   - **a customer with no guest invited** cannot confirm a declaration, and a
 *     declaration is the one thing the provider may not confirm on their
 *     behalf — so the pack will be blocked at the last moment by something
 *     that took five minutes to fix weeks earlier;
 *   - **a declaration lapsing** is a submission resting on a statement that
 *     will not be true when the buyer reads it;
 *   - **an engagement drafted and never activated** is work somebody thinks is
 *     running and cannot start;
 *   - **an open stage past its due date** is a per-stage fee nobody can
 *     invoice, because the next stage does not open until this one is signed
 *     off.
 *
 * ## It observes, and that is not a limitation
 *
 * `maxUnattended: 'OBSERVE'` and `proposes: []`. Every action behind these
 * findings is a commercial act between two companies — open a cycle, invite a
 * customer's director, chase a renewal, sign off a stage, activate an
 * engagement at an agreed fee. Each binds a fee or speaks for somebody else's
 * company, and no agent mandate in this platform reaches an act that does
 * either. An agent proposing "activate this engagement at £2,500" would be an
 * agent agreeing a price.
 *
 * It carries `module: 'BID_ON'`, so the runtime will not run it for a tenancy
 * without the grant — the same gate every Bid-On route carries, applied to the
 * one caller that acts unattended.
 */

const empty: AgentOutput = { findings: [], proposals: [] };

/** How long a draft engagement can sit before it is worth saying so. */
const DRAFT_STALE_DAYS = 7;
/** How close a lapsing declaration has to be before it is a finding. */
const DECLARATION_WARNING_DAYS = 45;

const daysBetween = (from: string, to: string): number =>
  Math.ceil((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / 86_400_000);

export const bidOnEngagementAgent: AgentDefinition = {
  name: 'bid-on engagements',
  agentId: 'AGT-BIDON-ENGAGEMENT',
  module: 'BID_ON',
  division: 'BID',
  purpose:
    'Watches every engagement and customer workspace across the provider’s book, and says which ones are quietly ' +
    'costing money: a retainer with no cycle open, a customer who cannot confirm a declaration, a declaration about ' +
    'to lapse, a stage nobody can invoice.',
  // Every phase. A bid-support engagement is not on a construction phase at
  // all — it runs against the tenancy's own governance scope, before and
  // between the customers' projects.
  activeIn: 'ANY',
  triggers: [
    { kind: 'SCHEDULE', at: '06:00' },
    { kind: 'EVENT', eventType: 'BID_ON_ENGAGEMENT_ACTIVATED' },
    { kind: 'EVENT', eventType: 'BID_ON_STAGE_SIGNED_OFF' },
    { kind: 'EVENT', eventType: 'BID_ON_CUSTOMER_OPENED' },
  ],
  inputs: ['Customer workspaces and their guests', 'Confirmed declarations', 'Engagements, their stages and cycles'],
  outputs: [
    'Retainers with no cycle open',
    'Customers who cannot confirm a declaration',
    'Declarations lapsing',
    'Engagements drafted and never activated',
    'Stages open past their due date',
  ],
  emits: [],
  hitl: 'REVIEW',
  // High, because every finding is arithmetic over recorded facts rather than
  // a judgement. If the records are there, the gap either exists or it does not.
  confidenceFloor: 0.9,
  acuTier: 'LOW',
  memory: { reads: ['ORGANISATION'], writes: [] },
  mandate: {
    reads: ['BID_SERVICES'],
    proposes: [],
    approvers: ['OWNER'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx: EngineContext): AgentOutput {
    // Nothing at all for a tenancy that has not started using the module. An
    // agent with nothing to read has not found a problem; it has found nothing.
    const customers = customersOf(ctx);
    const engagements = engagementsOf(ctx);
    if (customers.length === 0 && engagements.length === 0) return empty;

    const today = new Date().toISOString().slice(0, 10);
    const findings: Finding[] = [];
    const nameOf = new Map(customers.map((customer) => [customer.id, customer.legalName]));

    for (const engagement of engagements) {
      const who = nameOf.get(engagement.customerAccountId) ?? 'a customer';

      if (engagement.status === 'DRAFT' && daysBetween(engagement.openedAt, today) >= DRAFT_STALE_DAYS) {
        findings.push({
          key: `bidon:draft:${engagement.id}`,
          severity: 'ATTENTION',
          summary:
            `${engagement.reference} for ${who} has been drafted since ${engagement.openedAt.slice(0, 10)} and never ` +
            'activated.',
          consequence:
            'No agent run and no bid can be started against a draft engagement, so this is work somebody may think ' +
            'is running. Activating it is what agrees the terms the customer will be charged against.',
          evidence: [
            { refType: 'BidOnEngagement', refId: engagement.id, note: `Opened ${engagement.openedAt.slice(0, 10)}` },
          ],
        });
      }

      if (engagement.status !== 'ACTIVE') continue;

      if (engagement.type === 'CONTINUOUS' && !engagement.stages.some((stage) => stage.status === 'OPEN')) {
        findings.push({
          key: `bidon:no-cycle:${engagement.id}`,
          severity: 'URGENT',
          summary: `${engagement.reference} for ${who} is a ${engagement.schedule?.toLowerCase() ?? 'repeating'} retainer with no cycle open.`,
          consequence:
            'A retainer with no cycle open is a customer being billed for work they are not receiving. It is also ' +
            'the complaint that ends a retainer, and it is invisible on an invoice.',
          evidence: [
            {
              refType: 'BidOnEngagement',
              refId: engagement.id,
              note: `${engagement.stages.filter((stage) => stage.status === 'SIGNED_OFF').length} cycle(s) delivered`,
            },
          ],
        });
      }

      const overdue = engagement.stages.filter(
        (stage) => stage.status === 'OPEN' && stage.dueOn && stage.dueOn < today,
      );
      for (const stage of overdue) {
        findings.push({
          key: `bidon:stage-overdue:${engagement.id}:${stage.id}`,
          severity: 'ATTENTION',
          summary: `${engagement.reference} · ${stage.name} was due ${stage.dueOn} and is still open.`,
          consequence:
            engagement.billingBasis === 'PER_STAGE' || engagement.billingBasis === 'PER_CYCLE'
              ? 'This engagement bills per stage, so nothing can be invoiced for it until it is signed off — and the ' +
                'next stage does not open either.'
              : 'The next stage does not open until this one is signed off, so the work behind it is waiting.',
          evidence: [{ refType: 'BidOnEngagement', refId: engagement.id, note: `${stage.name}, due ${stage.dueOn}` }],
        });
      }
    }

    for (const customer of customers) {
      if (customer.status !== 'ACTIVE') continue;

      const hasWork = engagements.some(
        (engagement) => engagement.customerAccountId === customer.id && engagement.status === 'ACTIVE',
      );

      // Only where there is live work. A workspace opened yesterday with no
      // engagement yet is not a problem, and saying so on every one of them is
      // how a briefing stops being read.
      if (hasWork && !customer.guests.some((guest) => guest.role === 'CUSTOMER_ADMIN')) {
        findings.push({
          key: `bidon:no-admin:${customer.id}`,
          severity: 'URGENT',
          summary: `${customer.reference} ${customer.legalName} has live work and nobody from that company invited.`,
          consequence:
            'Insurance cover, accident figures and legal statements can only be confirmed by the customer’s own ' +
            'admin — the provider cannot confirm one and neither can an agent. Without that person the pack will be ' +
            'blocked at the last moment by something that takes five minutes to fix now.',
          evidence: [{ refType: 'BidOnCustomer', refId: customer.id, note: `${customer.guests.length} guest(s)` }],
        });
      }

      for (const declaration of liveDeclarations(customer, today)) {
        if (!declaration.validUntil) continue;
        const left = daysBetween(today, declaration.validUntil);
        if (left > DECLARATION_WARNING_DAYS) continue;
        findings.push({
          key: `bidon:declaration-lapsing:${declaration.id}`,
          severity: left < 0 ? 'URGENT' : 'ATTENTION',
          summary:
            left < 0
              ? `${customer.legalName} declared "${declaration.statement.slice(0, 60)}" and it lapsed on ${declaration.validUntil}.`
              : `${customer.legalName}'s declaration "${declaration.statement.slice(0, 60)}" lapses in ${left} day(s).`,
          consequence:
            'A submission resting on a declaration that is not true when the buyer reads it is not marked down — it ' +
            'is thrown out, and everything else in the pack is spent for nothing. Only that customer’s own admin can ' +
            'reconfirm it.',
          evidence: [
            { refType: 'BidOnCustomer', refId: customer.id, note: `${declaration.kind}, until ${declaration.validUntil}` },
          ],
        });
      }
    }

    return { findings, proposals: [] };
  },
};

/**
 * The pack watch: which bids are drifting towards their deadline.
 *
 * The engagement agent above watches the commercial relationship. This watches
 * the work, and it is a different question with a different reader: a bid
 * director wants to know which of eleven packs will not be ready, while there
 * is still time to decide which one to drop.
 *
 * Observes and proposes nothing, for the same reason: every action behind a
 * finding here is a person drafting, approving, chasing a customer or deciding
 * not to bid. The one thing an agent could do unattended — draft the next
 * answer — spends a customer's money, and `PROPOSE` on a spend is a queue of
 * charges waiting for somebody to notice.
 */
const bidOnPackAgent: AgentDefinition = {
  name: 'bid-on packs',
  agentId: 'AGT-BIDON-PACK',
  module: 'BID_ON',
  division: 'BID',
  purpose:
    'Watches every bid under way against its deadline and says which ones will not be ready: mandatory answers with ' +
    'nothing written, gaps the customer has not answered, and packs whose evidence lapses before the buyer reads them.',
  activeIn: 'ANY',
  triggers: [
    { kind: 'SCHEDULE', at: '06:00' },
    { kind: 'EVENT', eventType: 'BID_ON_QUESTIONS_CONFIRMED' },
    { kind: 'EVENT', eventType: 'BID_ON_GAP_RAISED' },
    { kind: 'EVENT', eventType: 'BID_ON_ANSWER_REJECTED' },
  ],
  inputs: ['Bids and their deadlines', 'Questions and their latest answers', 'Open gaps', 'Evidence expiry'],
  outputs: [
    'Packs that will not be ready for their deadline',
    'Gaps the customer has not answered',
    'Mandatory answers nobody has approved',
    'Packs past their deadline never recorded as submitted',
  ],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.9,
  acuTier: 'LOW',
  memory: { reads: ['ORGANISATION'], writes: [] },
  mandate: {
    reads: ['BID_SERVICES'],
    proposes: [],
    approvers: ['OWNER'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx: EngineContext): AgentOutput {
    const register = (() => {
      try {
        return bidRegister(ctx);
      } catch {
        // A tenancy that has not started using the module, or a person with no
        // customers assigned. Nothing to say either way.
        return null;
      }
    })();
    if (!register || register.bids.length === 0) return empty;

    const findings: Finding[] = [];
    // This agent's own reading date. The register's countdowns are computed
    // against it already; the clarification window is a second date and has to
    // be counted against the same day or the two findings would disagree.
    const today = new Date().toISOString().slice(0, 10);

    for (const bid of register.bids) {
      const sent = ['SUBMITTED', 'WON', 'LOST'].includes(bid.status);

      /*
       * A rolling submission has no countdown, so every finding below is
       * meaningless on one — "closes in 0 days" on a dynamic market
       * application is a false alarm that would never clear.
       *
       * What is worth saying about one is the opposite problem. A dated bid has
       * a deadline that forces the issue; a membership pack that cannot be
       * exported has nothing forcing it, so it sits unfinished indefinitely and
       * nobody is reminded. That is the finding.
       */
      if (bid.daysLeft === null) {
        if (!sent && !bid.exportable && bid.questions > 0) {
          findings.push({
            key: `bidon:rolling-stalled:${bid.id}`,
            severity: 'ATTENTION',
            summary:
              `${bid.reference} for ${bid.customerName} is a rolling submission with no return date and cannot be ` +
              `exported: ${bid.approved} of ${bid.questions} answers approved` +
              (bid.openGaps > 0 ? `, ${bid.openGaps} gap(s) still with the customer` : '') +
              '.',
            consequence:
              'Nothing will force this one. A dated bid has a deadline that makes somebody finish it; an open ' +
              'market application has none, so it stays unfinished until somebody decides to finish it. It is also ' +
              'judged against today, so a certificate ageing can take it backwards while it waits.',
            evidence: [
              { refType: 'BidOnBid', refId: bid.id, note: `Readiness ${bid.readinessPercent ?? 0}%` },
            ],
          });
        }
        continue;
      }

      if (bid.daysLeft < 0 && !sent) {
        findings.push({
          key: `bidon:overdue:${bid.id}`,
          severity: 'URGENT',
          summary: `${bid.reference} for ${bid.customerName} was due ${bid.deadline} and was never recorded as submitted.`,
          consequence:
            'Either it went and nobody said so, in which case the record of what this customer sent is missing, or ' +
            'it did not go and the work was spent for nothing. Both are worth five minutes now.',
          evidence: [{ refType: 'BidOnBid', refId: bid.id, note: `${bid.openGaps} open gap(s)` }],
        });
        continue;
      }

      if (sent) continue;

      if (bid.daysLeft <= 7 && !bid.exportable) {
        findings.push({
          key: `bidon:not-ready:${bid.id}`,
          severity: bid.daysLeft <= 3 ? 'URGENT' : 'ATTENTION',
          summary:
            `${bid.reference} for ${bid.customerName} closes in ${bid.daysLeft} day(s) and cannot be exported: ` +
            `${bid.approved} of ${bid.questions} answers approved` +
            (bid.openGaps > 0 ? `, ${bid.openGaps} gap(s) still with the customer` : '') +
            '.',
          consequence:
            'Export is refused while any mandatory answer is red or unapproved, so this does not go out as it ' +
            'stands. The decision available now is to finish it or to stop spending on it; in three days only one ' +
            'of those is left.',
          evidence: [
            { refType: 'BidOnBid', refId: bid.id, note: `Readiness ${bid.readinessPercent ?? 0}%` },
          ],
        });
      }

      /*
       * The returnables half, and on a pack like a measured term contract it is
       * the finding most likely to save a submission.
       *
       * An unsigned order form or an unpriced cost model is not visible in a
       * readiness percentage — that figure is about answers — so a pack can
       * read 92% and be unsendable for a reason nobody is looking at. A
       * signature is also a lead time rather than a task, which is why this
       * fires earlier than the not-ready finding above.
       */
      if (bid.returnablesOutstanding > 0 && bid.daysLeft <= 21) {
        findings.push({
          key: `bidon:returnables:${bid.id}`,
          severity: bid.daysLeft <= 7 ? 'URGENT' : 'ATTENTION',
          summary:
            `${bid.reference} for ${bid.customerName} has ${bid.returnablesOutstanding} returnable(s) outstanding ` +
            `with ${bid.daysLeft} day(s) to the return.`,
          consequence:
            'A submission missing a required document is rejected exactly as completely as one missing an answer, ' +
            'and none of this shows in the readiness figure, which is about answers. Where one needs a signature ' +
            'it is a lead time rather than a task.',
          evidence: [
            { refType: 'BidOnBid', refId: bid.id, note: `Readiness ${bid.readinessPercent ?? 0}% on answers alone` },
          ],
        });
      }

      /*
       * The clarification window, which is the deadline nobody watches.
       *
       * Where the bid records one, this counts down to **that** date rather
       * than the return — asking on the last day before a return is asking
       * weeks too late. Where it does not, the return is the only date
       * available and the finding says so, because "no clarification deadline
       * recorded" is itself worth fixing.
       */
      const daysToAsk = bid.clarificationDeadline
        ? Math.ceil((Date.parse(bid.clarificationDeadline) - Date.parse(today)) / 86_400_000)
        : null;

      if (bid.clarificationsMissed > 0) {
        findings.push({
          key: `bidon:clarifications-missed:${bid.id}`,
          severity: 'ATTENTION',
          summary:
            `${bid.reference} for ${bid.customerName} has ${bid.clarificationsMissed} question(s) that were never ` +
            `put to the buyer, and their window shut on ${bid.clarificationDeadline}.`,
          consequence:
            'Each of those is now a point that has to be priced or accepted rather than negotiated. Nothing can be ' +
            'done about this bid; what can be done is to decide whether each point is still worth pricing for, and ' +
            'to record the clarification deadline earlier next time.',
          evidence: [{ refType: 'BidOnBid', refId: bid.id, note: 'The window has shut' }],
        });
      } else if (bid.clarifications > 0 && (daysToAsk === null ? bid.daysLeft <= 21 : daysToAsk <= 10)) {
        findings.push({
          key: `bidon:clarifications:${bid.id}`,
          severity: daysToAsk !== null && daysToAsk <= 3 ? 'URGENT' : 'ATTENTION',
          summary:
            `${bid.reference} has ${bid.clarifications} question(s) for the buyer that nobody has asked` +
            (daysToAsk === null
              ? `, with ${bid.daysLeft} day(s) to the return and no clarification deadline recorded.`
              : `, and ${daysToAsk} day(s) left to ask them.`),
          consequence:
            'A buyer’s clarification deadline is almost always well before their return deadline, so these stop ' +
            'being askable before the bid stops being writable. A point that could have been negotiated becomes a ' +
            'risk that has to be priced or accepted.' +
            (daysToAsk === null
              ? ' Record the clarification deadline on the bid and this counts down to the date that actually ' +
                'governs it.'
              : ''),
          evidence: [{ refType: 'BidOnBid', refId: bid.id, note: 'Raised from the question list or the amendments' }],
        });
      }

      if (bid.openGaps > 0 && bid.daysLeft <= 14) {
        findings.push({
          key: `bidon:gaps-waiting:${bid.id}`,
          severity: bid.daysLeft <= 5 ? 'URGENT' : 'ATTENTION',
          summary:
            `${bid.reference} is waiting on ${bid.customerName} for ${bid.openGaps} thing(s), ${bid.daysLeft} day(s) ` +
            'before the deadline.',
          consequence:
            'A gap pauses its own question, so the rest of the pack is still being written — but a mandatory ' +
            'question left as a gap is a rejected submission however good everything around it is.',
          evidence: [{ refType: 'BidOnBid', refId: bid.id, note: `${bid.openGaps} open` }],
        });
      }
    }

    return { findings, proposals: [] };
  },
};

export const BID_ON_AGENTS: AgentDefinition[] = [bidOnEngagementAgent, bidOnPackAgent];
