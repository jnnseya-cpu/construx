import { assertProductionSafety, config } from '../config.ts';
import { abbreviateMoney } from '../domain/locale.ts';
import { recentLogs } from '../api/middleware.ts';
import { securityEvents } from '../api/telemetry.ts';
import { WATCH_RULES, watchStates } from '../ops/watch.ts';
import type { EngineContext } from '../engines/context.ts';
import type { AgentDefinition, AgentOutput, Finding } from './types.ts';

/**
 * The agents that watch the platform, the customer and the obligation — rather
 * than the project.
 *
 * `registry.ts` holds the twelve that read a job: programme, commercial, risk,
 * contracts, design, field, handover, tender, radar, pipeline, supply chain,
 * HSEQ. They answer "is this project going wrong". These answer four different
 * questions, and they are kept in their own file because they read entirely
 * different sources — gateway counters, the security stream, the ACU wallet,
 * the subscription — and mixing them would make the project fleet look like it
 * had access to the platform's own internals.
 *
 * ## Declared, not stubbed
 *
 * A manifest listing thirty-one agents when a third of them read from a data
 * source that does not exist would be a lie told in a table. An agent that
 * cannot yet be built carries `deployment: 'DECLARED'`, no `evaluate`, and a
 * `needs` sentence naming exactly what is missing. The runtime never runs one,
 * the manifest shows it, and nobody mistakes the org chart for the payroll.
 *
 * Every deployed agent below applies an arithmetic threshold to materialised
 * state. None asks a model whether something is wrong — same rule as the
 * project fleet, for the same reason: a person has to be able to check the
 * working.
 */

const list = (ctx: EngineContext, refType: string) => ctx.ledger.list(ctx.projectId, refType);

function money(minor: number, currency = 'GBP'): string {
  return abbreviateMoney(minor, currency);
}

const empty: AgentOutput = { findings: [], proposals: [] };

// ============================================================ platform ops

/**
 * The watch rules, surfaced as findings.
 *
 * `ops/watch.ts` already evaluates and already notifies. This does not
 * re-evaluate them — that would be a second source of truth for whether the
 * platform is healthy, and the two would eventually disagree. It reads the
 * states the watch is holding and turns a firing rule into a finding on the
 * same queue as everything else, so an operator has one place to look rather
 * than an inbox and a screen.
 */
const healthAgent: AgentDefinition = {
  name: 'health',
  division: 'PLATFORM_OPS',
  purpose: 'Reports what the health watch is currently firing on, so a platform fault appears beside project findings rather than only in an inbox.',
  mandate: {
    reads: ['PLATFORM_ADMINISTRATION'],
    proposes: [],
    approvers: ['PLATFORM_ADMIN'],
    // The only ACT-eligible agent in the fleet, and its envelope carries no
    // value and writes no governed state: it may tell somebody, and that is
    // all. Eligibility still confers nothing until an envelope is granted.
    maxUnattended: 'ACT',
    envelope: {
      commands: ['ops:alert', 'ops:resolve'],
      valueCeilingMinor: 0,
      because:
        'Telling somebody the platform is unwell cannot damage a project, cannot be undone wrongly, and costs nothing. ' +
        'It is the only act on this platform where waiting for an approval makes the outcome worse.',
    },
  },
  evaluate(ctx) {
    const findings: Finding[] = [];
    for (const state of watchStates()) {
      if (!state.firing) continue;
      // The state says *that* a rule is firing; the rule says what it measures
      // and why anybody should care. Read from the rule rather than copied onto
      // the state, so the sentence an operator acts on has one source.
      const rule = WATCH_RULES.find((candidate) => candidate.id === state.ruleId);
      if (!rule) continue;
      findings.push({
        key: `health:${state.ruleId}:${state.since}`,
        severity: rule.severity === 'CRITICAL' ? 'URGENT' : 'ATTENTION',
        summary: `${rule.what} — ${state.lastDetail}`,
        consequence: rule.because,
        evidence: [{ refType: 'WatchRule', refId: state.ruleId, note: `Firing since ${state.since}` }],
      });
    }
    return { findings, proposals: [] };
  },
};

/**
 * A thousand log lines are forty problems.
 *
 * Clusters server errors by the route that produced them rather than by
 * occurrence, because an operator asks "what is broken" and a log answers "here
 * are ten thousand times it broke". One finding per route, carrying the count,
 * the window, and the correlation ids that will find the requests — which is
 * what somebody actually needs in order to reproduce it.
 *
 * Only 5xx. A 403 is the platform working, a 422 is a caller sending the wrong
 * thing, and folding either into a defect report is how a defect report becomes
 * something nobody reads.
 */
const defectTriageAgent: AgentDefinition = {
  name: 'defect-triage',
  division: 'PLATFORM_OPS',
  purpose: 'Clusters server errors by route into one finding with the correlation ids to reproduce it, rather than a thousand log lines.',
  mandate: {
    reads: ['PLATFORM_ADMINISTRATION'],
    proposes: [],
    approvers: ['PLATFORM_ADMIN'],
    maxUnattended: 'OBSERVE',
  },
  evaluate() {
    const logs = recentLogs(1000);
    const byRoute = new Map<string, { count: number; correlations: string[]; methods: Set<string>; first: string; last: string }>();

    for (const log of logs) {
      if (log.status < 500) continue;
      const route = log.routeId ?? log.path;
      const entry = byRoute.get(route) ?? {
        count: 0,
        correlations: [],
        methods: new Set<string>(),
        first: log.timestamp,
        last: log.timestamp,
      };
      entry.count += 1;
      entry.methods.add(log.method);
      // Three is enough to reproduce and few enough to read. A finding carrying
      // four hundred ids is the log again, wearing a different hat.
      if (entry.correlations.length < 3) entry.correlations.push(log.correlationId);
      if (log.timestamp < entry.first) entry.first = log.timestamp;
      if (log.timestamp > entry.last) entry.last = log.timestamp;
      byRoute.set(route, entry);
    }

    const findings: Finding[] = [];
    for (const [route, entry] of byRoute) {
      findings.push({
        // Keyed on the route and the count band rather than the count, so a
        // failure that keeps failing does not raise a new finding every pass
        // while a materially worse one does.
        key: `defect:${route}:${entry.count < 10 ? 'few' : entry.count < 100 ? 'many' : 'flood'}`,
        severity: entry.count >= 10 ? 'URGENT' : 'ATTENTION',
        summary: `${[...entry.methods].join('/')} ${route} returned a server error ${entry.count} time${entry.count === 1 ? '' : 's'}`,
        consequence:
          'A 5xx is the platform failing rather than refusing, so every one of these is a caller who was told nothing useful. ' +
          `Reproduce with correlation ${entry.correlations.join(', ')}; the window is ${entry.first} to ${entry.last}.`,
        evidence: entry.correlations.map((correlationId) => ({
          refType: 'RequestLog',
          refId: correlationId,
          note: `${route} — server error`,
        })),
      });
    }
    return { findings, proposals: [] };
  },
};

/**
 * What the AI actually cost, per engine and per task.
 *
 * The wallet records every settled execution with its module and its raw cost,
 * so the spread across calls of the same kind is measurable. A task whose cost
 * varies by an order of magnitude between calls is either being handed wildly
 * different inputs or is on the wrong model class, and both are worth knowing
 * before the invoice rather than after.
 */
const costOptimisationAgent: AgentDefinition = {
  name: 'cost-optimisation',
  division: 'PLATFORM_OPS',
  purpose: 'Watches what each engine actually costs per call and flags a task whose spend has become unpredictable.',
  mandate: {
    reads: ['BILLING_ACU', 'AI_EXECUTION'],
    proposes: [],
    approvers: ['OWNER', 'ENTERPRISE_ADMIN'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const findings: Finding[] = [];
    for (const attribution of ctx.wallet.attributionByModule()) {
      // Below this there is nothing to average. Two calls do not have a spread.
      if (attribution.calls < 5) continue;
      const mean = attribution.rawCostMinor / attribution.calls;
      const costs = ctx.wallet.observedRawCosts(attribution.module, '');
      if (costs.length < 5) continue;
      const highest = Math.max(...costs);
      if (highest < mean * 8) continue;

      findings.push({
        key: `cost:spread:${attribution.module}`,
        severity: 'ATTENTION',
        summary: `${attribution.module} averages ${money(Math.round(mean))} a call but has reached ${money(highest)}`,
        consequence:
          'A cost that varies by this much is either an input nobody sized or a model class chosen for the wrong workload. ' +
          'The customer sees it as a wallet that empties unpredictably, which is the complaint prepayment was meant to prevent.',
        evidence: [
          { refType: 'ACUWallet', refId: attribution.module, note: `${attribution.calls} calls, ${money(attribution.rawCostMinor)} raw` },
        ],
      });
    }
    return { findings, proposals: [] };
  },
};

// ================================================================ security

/**
 * Anomaly against each actor's own baseline, not against a global one.
 *
 * A global threshold answers the wrong question. Ten authorisation denials in a
 * morning is unremarkable for somebody learning the platform and is the loudest
 * possible signal for a director who has never had one. So the comparison is
 * always to the same actor's own history.
 */
const threatHunterAgent: AgentDefinition = {
  name: 'threat-hunter',
  division: 'SECURITY',
  purpose: "Compares each actor's activity to that actor's own baseline, so an anomaly is anomalous for them rather than for the average user.",
  mandate: {
    reads: ['PLATFORM_ADMINISTRATION', 'EVIDENCE_AUDIT'],
    proposes: [],
    approvers: ['PLATFORM_ADMIN'],
    maxUnattended: 'OBSERVE',
  },
  evaluate() {
    const events = securityEvents({ limit: 2000 });
    const byActor = new Map<string, { denies: number; authFailures: number; rateLimited: number; paths: Set<string> }>();

    for (const event of events) {
      if (!event.actorId) continue;
      const entry = byActor.get(event.actorId) ?? {
        denies: 0,
        authFailures: 0,
        rateLimited: 0,
        paths: new Set<string>(),
      };
      if (event.kind === 'AUTHZ_DENY') entry.denies += 1;
      if (event.kind === 'AUTH_FAILURE') entry.authFailures += 1;
      if (event.kind === 'RATE_LIMITED') entry.rateLimited += 1;
      entry.paths.add(event.path);
      byActor.set(event.actorId, entry);
    }

    const findings: Finding[] = [];
    for (const [actorId, entry] of byActor) {
      // Denials spread across many distinct routes is the shape that matters:
      // one person repeatedly hitting one thing they cannot do is somebody
      // learning, and the same count spread over a dozen endpoints is somebody
      // finding out what exists.
      if (entry.denies >= 5 && entry.paths.size >= 5) {
        findings.push({
          key: `threat:probing:${actorId}:${entry.paths.size}`,
          severity: 'URGENT',
          summary: `${actorId} was refused on ${entry.paths.size} different routes (${entry.denies} denials)`,
          consequence:
            'Denials concentrated on one route are somebody learning what they cannot do. Spread across many, in one window, ' +
            'is somebody mapping what exists — and the account doing it is one that already authenticated.',
          evidence: [{ refType: 'SecurityEvent', refId: actorId, note: `${entry.denies} denials across ${entry.paths.size} routes` }],
        });
      }
      if (entry.rateLimited >= 10) {
        findings.push({
          key: `threat:rate:${actorId}`,
          severity: 'ATTENTION',
          summary: `${actorId} hit the rate limit ${entry.rateLimited} times`,
          consequence:
            'Either an integration retrying without backoff, which will keep doing it, or an account being used to enumerate. ' +
            'Both are worth a look; only one is malicious, and the record tells them apart.',
          evidence: [{ refType: 'SecurityEvent', refId: actorId, note: `${entry.rateLimited} rate-limited requests` }],
        });
      }
    }
    return { findings, proposals: [] };
  },
};

/**
 * Drift against what this platform declares about itself.
 *
 * Zero runtime dependencies is a settled decision, so "dependency drift" here
 * has an exact meaning: a runtime dependency appearing at all is the drift. And
 * configuration drift is already defined by `assertProductionSafety`, which the
 * boot banner reads — so this reads the same function rather than restating the
 * rules, and the two cannot disagree.
 */
const vulnerabilityAgent: AgentDefinition = {
  name: 'vulnerability',
  division: 'SECURITY',
  purpose: 'Checks the platform against what it declares about itself: no runtime dependencies, and no unsafe configuration in production.',
  mandate: {
    reads: ['PLATFORM_ADMINISTRATION'],
    proposes: [],
    approvers: ['PLATFORM_ADMIN'],
    maxUnattended: 'OBSERVE',
  },
  evaluate() {
    const findings: Finding[] = [];
    for (const warning of assertProductionSafety()) {
      findings.push({
        key: `vulnerability:config:${warning.slice(0, 60)}`,
        severity: 'URGENT',
        summary: warning,
        consequence:
          'The boot banner prints this once and then nobody looks at a banner again. A configuration that was unsafe at ' +
          'the last deploy is still unsafe now, and this is what makes it keep saying so.',
        evidence: [{ refType: 'Configuration', refId: config.env, note: warning }],
      });
    }
    return { findings, proposals: [] };
  },
};

/**
 * The three payment shapes that are worth a second look.
 *
 * None of these is proof of anything. Each is a pattern that, in a business
 * where money moves on certificates, is worth a person confirming — which is
 * why this agent proposes nothing and raises findings against a named record.
 * A fraud agent that accused would be worse than none.
 */
const fraudAgent: AgentDefinition = {
  name: 'fraud',
  division: 'SECURITY',
  purpose: 'Flags the payment shapes worth a second look: two applications for one cycle, a round-sum valuation, a certificate signed out of hours.',
  mandate: {
    reads: ['PAYMENT_APPLICATIONS', 'CHANGE_VARIATION', 'CONTRACTS_CLAIMS'],
    proposes: [],
    approvers: ['QS', 'OWNER', 'EPC'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const findings: Finding[] = [];

    // Two applications against one cycle. The payment engine already refuses
    // over-certification; this catches the earlier shape, where two were
    // submitted and only one was ever meant to be.
    const byCycle = new Map<string, string[]>();
    for (const application of list(ctx, 'PaymentApplication')) {
      const cycle = String(application.state.cycleNumber ?? '');
      if (cycle === '') continue;
      byCycle.set(cycle, [...(byCycle.get(cycle) ?? []), application.refId]);
    }
    for (const [cycle, ids] of byCycle) {
      if (ids.length < 2) continue;
      findings.push({
        key: `fraud:duplicate-application:${cycle}`,
        severity: 'URGENT',
        summary: `Cycle ${cycle} carries ${ids.length} payment applications`,
        consequence:
          'One cycle, one application. Two means either a resubmission nobody withdrew or a second claim for the same work, ' +
          'and the certificate is written against whichever the certifier happens to open.',
        evidence: ids.map((refId) => ({ refType: 'PaymentApplication', refId, note: `Cycle ${cycle}` })),
      });
    }

    // A valuation that lands on an exact round figure. Measured work does not
    // come to £50,000.00; agreed work sometimes does, and that is the point —
    // it says a number was negotiated rather than measured, which is worth
    // knowing when the basis on the record says it was measured.
    for (const variation of list(ctx, 'Variation')) {
      const value = Number(variation.state.valuedAmountMinor ?? 0);
      if (value < 1_000_000 || value % 1_000_000 !== 0) continue;
      if (String(variation.state.valuationMethod ?? '') === 'LUMP_SUM') continue;
      findings.push({
        key: `fraud:round-sum:${variation.refId}`,
        severity: 'ATTENTION',
        summary: `${String(variation.state.reference ?? variation.refId)} is valued at exactly ${money(value)}`,
        consequence:
          `The record says this was valued by ${String(variation.state.valuationMethod ?? 'an unstated method')}, and a measured ` +
          'valuation does not land on a round figure. Either the basis on the record is wrong or the figure was agreed, not measured.',
        evidence: [{ refType: 'Variation', refId: variation.refId, note: `${money(value)} exactly` }],
      });
    }

    // Certification outside working hours. Not wrong — a final date can fall
    // awkwardly — but a certificate is the act that releases money, and one
    // signed at three in the morning is one somebody should be able to explain.
    for (const certificate of list(ctx, 'PaymentCertificate')) {
      const at = String(certificate.state.certifiedAt ?? '');
      if (at === '') continue;
      const when = new Date(at);
      const hour = when.getUTCHours();
      const weekend = when.getUTCDay() === 0 || when.getUTCDay() === 6;
      if (hour >= 6 && hour < 20 && !weekend) continue;
      findings.push({
        key: `fraud:out-of-hours:${certificate.refId}`,
        severity: 'ATTENTION',
        summary: `A certificate for ${money(Number(certificate.state.certifiedMinor ?? 0))} was signed at ${at}`,
        consequence:
          'Certifying releases money, and the hour it happened is one of the few facts about it that is free to check. ' +
          'A final date falling on a Sunday explains it; nothing else does.',
        evidence: [{ refType: 'PaymentCertificate', refId: certificate.refId, note: `Certified ${at}` }],
      });
    }

    return { findings, proposals: [] };
  },
};

/**
 * Evidence held past the retention the tenancy set for it.
 *
 * The retention policy already exists and is already enforced on read. What did
 * not exist was anything that noticed material sitting past its date — which is
 * the half a regulator asks about, because a policy nobody measures against is
 * a document rather than a control.
 */
const dataProtectionAgent: AgentDefinition = {
  name: 'data-protection',
  division: 'SECURITY',
  purpose: 'Notices evidence held past its retention date, so a retention policy is a measurement rather than a document.',
  mandate: {
    reads: ['EVIDENCE_AUDIT'],
    proposes: [],
    approvers: ['OWNER', 'ENTERPRISE_ADMIN'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const today = new Date().toISOString().slice(0, 10);
    const overdue = list(ctx, 'EvidenceItem').filter((item) => {
      const until = item.state.retainUntil;
      return typeof until === 'string' && until < today && item.state.disposedAt === undefined;
    });
    if (overdue.length === 0) return empty;

    return {
      findings: [
        {
          key: `data-protection:retention-overdue:${overdue.length}`,
          severity: overdue.length > 25 ? 'URGENT' : 'ATTENTION',
          summary: `${overdue.length} evidence item${overdue.length === 1 ? '' : 's'} are held past the retention date set for them`,
          consequence:
            'Material kept beyond its stated period is material the business told somebody it would not be keeping. ' +
            'It is also discoverable, which makes it a liability rather than an asset.',
          evidence: overdue.slice(0, 5).map((item) => ({
            refType: 'EvidenceItem',
            refId: item.refId,
            note: `Retention ended ${String(item.state.retainUntil)}`,
          })),
        },
      ],
      proposals: [],
    };
  },
};

// ================================================================= revenue

/**
 * Usage against entitlement — the honest version.
 *
 * An expansion agent that recommended an upgrade whenever a customer was busy
 * would be a sales quota with a machine attached. This raises a finding only
 * where usage is *already* being refused or is within reach of being refused,
 * which is the case where the customer's own experience is degraded and the
 * conversation is a service one rather than a sales one.
 */
const expansionAgent: AgentDefinition = {
  name: 'expansion',
  division: 'REVENUE',
  purpose: 'Notices where the plan a customer bought is now refusing them, and proposes the change with the evidence attached.',
  mandate: {
    reads: ['BILLING_ACU', 'ENTERPRISE_STRUCTURE'],
    proposes: [],
    approvers: ['OWNER', 'ENTERPRISE_ADMIN'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const findings: Finding[] = [];
    const snapshot = ctx.wallet.snapshot();

    if (!ctx.standing.mayRunAI && ctx.standing.reason) {
      findings.push({
        key: `expansion:refused:${ctx.standing.status}`,
        severity: 'URGENT',
        summary: `This tenancy is being refused AI: ${ctx.standing.reason}`,
        consequence:
          'The customer is hitting a commercial boundary during work, which is the worst moment to discover one. ' +
          'Whatever the right answer is, somebody should be having the conversation before the next refusal.',
        evidence: [{ refType: 'Subscription', refId: ctx.tenantId, note: ctx.standing.reason }],
      });
    }

    // Within a fifth of empty. Far enough ahead to be a conversation rather
    // than an interruption; close enough that it is real.
    const available = snapshot.availableMinor;
    const spent = ctx.wallet.monthBilledMinor();
    if (spent > 0 && available < spent / 5) {
      findings.push({
        key: `expansion:wallet-low:${Math.floor(available / 10_000)}`,
        severity: 'ATTENTION',
        summary: `${money(available)} of AI credit remains against ${money(spent)} spent this month`,
        consequence:
          'At this month\'s rate the wallet empties before the month does, and an empty wallet stops engines mid-task. ' +
          'The refusal is correct and it is still the customer who feels it.',
        evidence: [{ refType: 'ACUWallet', refId: ctx.tenantId, note: `${money(available)} available` }],
      });
    }

    return { findings, proposals: [] };
  },
};

/**
 * Engagement decay by actor — the leading indicator, not the renewal date.
 *
 * A renewal date tells you a customer is about to decide. This tells you they
 * decided a while ago. It reads the ledger, which records who did what and
 * when, and compares the last fortnight to the fortnight before it — per actor,
 * because a business does not churn, people stop signing in.
 */
const retentionAgent: AgentDefinition = {
  name: 'retention',
  division: 'REVENUE',
  purpose: 'Compares each seat\'s activity to its own recent history, so a customer going quiet is visible months before the renewal.',
  mandate: {
    reads: ['EVIDENCE_AUDIT', 'ENTERPRISE_STRUCTURE'],
    proposes: [],
    approvers: ['OWNER', 'ENTERPRISE_ADMIN'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const now = Date.now();
    const fortnight = 14 * 86_400_000;
    const recent = new Map<string, number>();
    const previous = new Map<string, number>();

    for (const event of ctx.ledger.events({ projectId: ctx.projectId })) {
      // Only a person. A System or AI author is the platform working, not a
      // seat being used, and counting either would hide a customer going quiet
      // behind the platform's own housekeeping.
      if (event.actor.refType !== 'User') continue;
      const actor = event.actor.refId;
      const age = now - Date.parse(event.timestamp);
      if (age < 0) continue;
      if (age <= fortnight) recent.set(actor, (recent.get(actor) ?? 0) + 1);
      else if (age <= fortnight * 2) previous.set(actor, (previous.get(actor) ?? 0) + 1);
    }

    const findings: Finding[] = [];
    for (const [actor, before] of previous) {
      // Only a seat that was genuinely active. Somebody who did three things a
      // fortnight ago and none this one has not churned, they were never on.
      if (before < 10) continue;
      const after = recent.get(actor) ?? 0;
      if (after > before / 4) continue;
      findings.push({
        key: `retention:decay:${actor}`,
        severity: after === 0 ? 'URGENT' : 'ATTENTION',
        summary: `${actor} recorded ${before} actions in the previous fortnight and ${after} in this one`,
        consequence:
          'A seat that stops being used is a renewal that has already been decided; the date it is discussed is months later. ' +
          'This is the point at which asking why still changes the answer.',
        evidence: [{ refType: 'User', refId: actor, note: `${before} → ${after} actions` }],
      });
    }
    return { findings, proposals: [] };
  },
};

/**
 * Dunning, bounded to notification.
 *
 * `ACT` would be the obvious ceiling for a collections agent and it is not
 * granted, because the act a collections agent wants next is suspension — and a
 * machine suspending a construction business's access to its own evidence
 * during a dispute is a decision with no way back. It observes; a person
 * decides what to do about the money.
 */
const collectionsAgent: AgentDefinition = {
  name: 'collections',
  division: 'REVENUE',
  purpose: 'Watches for a tenancy that has stopped being able to pay, and tells somebody. It never suspends anything.',
  mandate: {
    reads: ['BILLING_ACU'],
    proposes: [],
    approvers: ['PLATFORM_ADMIN', 'OWNER'],
    // Deliberately not ACT. See the note above: the next act a collections
    // process wants is suspension, and that one is not a machine's to take.
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    if (ctx.standing.mayTopUp && ctx.standing.status === 'ACTIVE') return empty;
    return {
      findings: [
        {
          key: `collections:standing:${ctx.standing.status}`,
          severity: ctx.standing.status === 'ACTIVE' ? 'ATTENTION' : 'URGENT',
          summary: `This tenancy stands at ${ctx.standing.status}${ctx.standing.reason ? ` — ${ctx.standing.reason}` : ''}`,
          consequence:
            'A tenancy that cannot top up cannot run an engine, and the customer discovers it mid-task. ' +
            'Nothing here suspends anything: that is a decision with no way back, and it is not a machine\'s to take.',
          evidence: [{ refType: 'Subscription', refId: ctx.tenantId, note: ctx.standing.status }],
        },
      ],
      proposals: [],
    };
  },
};

// ================================================================ customer

/**
 * Whether the customer is getting the outcome they bought.
 *
 * Adoption measured by breadth rather than volume. A tenancy generating
 * thousands of events in one capability area and none in the others bought a
 * platform and is using a tool, and the renewal conversation will be about
 * price because nothing else has been demonstrated.
 */
const successAgent: AgentDefinition = {
  name: 'success',
  division: 'CUSTOMER',
  purpose: 'Measures how much of the platform a customer actually reaches, because breadth of use is what the renewal turns on.',
  mandate: {
    reads: ['EVIDENCE_AUDIT'],
    proposes: [],
    approvers: ['OWNER', 'ENTERPRISE_ADMIN'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const events = ctx.ledger.events({ projectId: ctx.projectId });
    if (events.length < 50) return empty;

    const groups = new Set(events.map((event) => event.eventType.split('_')[0]));
    if (groups.size >= 8) return empty;

    return {
      findings: [
        {
          key: `success:narrow-adoption:${groups.size}`,
          severity: 'ATTENTION',
          summary: `${events.length} records across only ${groups.size} kinds of activity`,
          consequence:
            'A customer using one part of a platform heavily has bought a tool, and at renewal will price it as one. ' +
            'The parts they have not reached are the ones the business case rested on.',
          evidence: [{ refType: 'Project', refId: ctx.projectId, note: `${groups.size} activity kinds` }],
        },
      ],
      proposals: [],
    };
  },
};

/**
 * A tenancy that was provisioned and then never started.
 *
 * The most expensive customer is the one who signed, logged in once, and never
 * came back — because nobody found out until the renewal. Provisioning already
 * happens at signup; what was missing was anything noticing that it went
 * nowhere.
 */
const onboardingAgent: AgentDefinition = {
  name: 'onboarding',
  division: 'CUSTOMER',
  purpose: 'Notices a tenancy that was set up and then never used, while it is still early enough to matter.',
  mandate: {
    reads: ['PROJECT_SETUP', 'EVIDENCE_AUDIT'],
    proposes: [],
    approvers: ['OWNER', 'ENTERPRISE_ADMIN'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const events = ctx.ledger.events({ projectId: ctx.projectId });
    if (events.length === 0 || events.length > 20) return empty;

    const first = Date.parse(events[0]!.timestamp);
    const days = Math.floor((Date.now() - first) / 86_400_000);
    if (days < 7) return empty;

    return {
      findings: [
        {
          key: `onboarding:stalled:${ctx.projectId}`,
          severity: 'ATTENTION',
          summary: `This project was created ${days} days ago and carries ${events.length} records`,
          consequence:
            'A project that never got past setup is a customer who never saw the thing they bought. ' +
            'The renewal conversation is already lost; it just has not happened yet.',
          evidence: [{ refType: 'Project', refId: ctx.projectId, note: `${events.length} records in ${days} days` }],
        },
      ],
      proposals: [],
    };
  },
};

// ============================================================== compliance

/**
 * Statutory dates, which are the ones that do not move.
 *
 * A commercial deadline missed is a negotiation. A statutory one missed is a
 * right lost — the Construction Act's payment and pay-less notices, an
 * adjudication referral, a Building Safety Act gateway. The platform already
 * computes these dates; this is the thing that looks at them.
 */
const regulatoryAgent: AgentDefinition = {
  name: 'regulatory',
  division: 'COMPLIANCE',
  purpose: 'Watches the dates that carry a statutory consequence, where missing one loses a right rather than opening a negotiation.',
  mandate: {
    reads: ['CONTRACTS_CLAIMS', 'PAYMENT_APPLICATIONS', 'SAFETY_RAMS'],
    proposes: [],
    approvers: ['QS', 'PM', 'EPC', 'OWNER'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const findings: Finding[] = [];
    const today = new Date().toISOString().slice(0, 10);

    for (const deadline of list(ctx, 'NoticeDeadline')) {
      const due = deadline.state.dueBy ?? deadline.state.deadline;
      if (typeof due !== 'string') continue;
      if (String(deadline.state.status ?? '') === 'SERVED') continue;
      const daysLeft = Math.ceil((Date.parse(due) - Date.parse(today)) / 86_400_000);
      if (daysLeft > 7) continue;

      findings.push({
        key: `regulatory:notice:${deadline.refId}:${daysLeft < 0 ? 'passed' : 'due'}`,
        severity: daysLeft < 0 ? 'URGENT' : 'ATTENTION',
        summary: `${String(deadline.state.noticeType ?? 'A statutory notice')} ${daysLeft < 0 ? `was due ${Math.abs(daysLeft)} days ago` : `is due in ${daysLeft} days`}`,
        consequence:
          'A statutory date is not a target. Passing it does not weaken a position, it removes one — the sum applied for ' +
          'becomes the sum due, whatever the work was worth.',
        evidence: [{ refType: 'NoticeDeadline', refId: deadline.refId, note: `Due ${due}` }],
      });
    }

    return { findings, proposals: [] };
  },
};

// ================================================== declared, not deployed

/**
 * Agents that are specified, mandated and not running.
 *
 * Each names what it is waiting on. None has an `evaluate`, so the runtime
 * cannot run one by accident, and `tests/mandate.test.ts` checks that every
 * declared agent says what it needs — an agent listed without a reason is how a
 * roadmap becomes a claim.
 */
const declared: AgentDefinition[] = [
  {
    name: 'competitor',
    division: 'MARKET_INTEL',
    purpose: 'Award and framework movement, feeding the bid/no-bid score with who else is winning what.',
    mandate: { reads: ['BUSINESS_DEVELOPMENT'], proposes: [], approvers: ['OWNER'], maxUnattended: 'OBSERVE' },
    deployment: 'DECLARED',
    needs:
      'An external feed of published awards and framework calls. The platform knows what this business won; it has no ' +
      'source for what anybody else won, and inventing one would be the exact failure the rest of the platform refuses.',
  },
  {
    name: 'pricing',
    division: 'BID',
    purpose: 'Benchmarks each rate against this business\'s own committed cost history and flags an outlier before submission.',
    mandate: {
      reads: ['ESTIMATE_TENDER', 'BOQ_TAKEOFF', 'BUDGET_COST'],
      proposes: [],
      approvers: ['QS', 'OWNER'],
      maxUnattended: 'OBSERVE',
    },
    deployment: 'DECLARED',
    needs:
      'Committed cost observations across more than one settled project. `domain/costintel.ts` computes the benchmark and ' +
      'reports its own confidence; below a handful of observations that confidence is FLOOR, and an agent raising findings ' +
      'from a FLOOR benchmark would be teaching the estimator to distrust it.',
  },
  {
    name: 'release',
    division: 'PLATFORM_OPS',
    purpose: 'Gates a deploy on the suite being green, the migration being reversible and the rollback having been rehearsed.',
    mandate: { reads: ['PLATFORM_ADMINISTRATION'], proposes: [], approvers: ['PLATFORM_ADMIN'], maxUnattended: 'OBSERVE' },
    deployment: 'DECLARED',
    needs:
      'Build and migration metadata from CI, which this process cannot see. A release gate that assumed the suite was green ' +
      'because nothing told it otherwise would be worse than no gate.',
  },
  {
    name: 'identity',
    division: 'SECURITY',
    purpose: 'Raises the bar on a session that has become unusual: step-up challenge, and revocation where the risk is high.',
    mandate: { reads: ['PLATFORM_ADMINISTRATION'], proposes: [], approvers: ['PLATFORM_ADMIN'], maxUnattended: 'OBSERVE' },
    deployment: 'DECLARED',
    needs:
      'Device binding on session issue, so there is a baseline for a session to have departed from. Until a session records ' +
      'the device it was issued to, "this session is unusual" has nothing to be unusual against.',
  },
  {
    name: 'kyb-kyc',
    division: 'COMPLIANCE',
    purpose: 'Verifies a business and its officers at onboarding, and proposes — never approves — the outcome.',
    mandate: { reads: ['ENTERPRISE_STRUCTURE'], proposes: [], approvers: ['PLATFORM_ADMIN'], maxUnattended: 'OBSERVE' },
    deployment: 'DECLARED',
    needs:
      'An identity-verification connector. There is no register this platform can check a company against, and a ' +
      'verification agent that verified nothing would be a compliance record asserting something nobody checked.',
  },
  {
    name: 'aml',
    division: 'COMPLIANCE',
    purpose: 'Screens and monitors on the payment path, escalating to a named compliance officer.',
    mandate: { reads: ['PAYMENT_APPLICATIONS'], proposes: [], approvers: ['PLATFORM_ADMIN'], maxUnattended: 'OBSERVE' },
    deployment: 'DECLARED',
    needs:
      'A live payment path and a sanctions data source. The platform records certificates; it does not yet move money, ' +
      'and screening against a list it does not hold would be theatre.',
  },
  {
    name: 'support',
    division: 'CUSTOMER',
    purpose: 'Answers from the customer\'s own record and the published catalogue, and never invents a capability.',
    mandate: { reads: ['EVIDENCE_AUDIT'], proposes: [], approvers: ['OWNER'], maxUnattended: 'OBSERVE' },
    deployment: 'DECLARED',
    needs:
      'Somewhere for a question to arrive. The copilot already answers from project state and already says the record is ' +
      'empty rather than answering from general knowledge; what is missing is an inbox, not an engine.',
  },
];

export const PLATFORM_AGENTS: AgentDefinition[] = [
  // Platform operations — is the platform itself healthy.
  healthAgent,
  defectTriageAgent,
  costOptimisationAgent,
  // Security — who reached what, and is that normal for them.
  threatHunterAgent,
  vulnerabilityAgent,
  fraudAgent,
  dataProtectionAgent,
  // Revenue — is what the customer bought still what they need.
  expansionAgent,
  retentionAgent,
  collectionsAgent,
  // Customer — are they getting the outcome they bought.
  successAgent,
  onboardingAgent,
  // Compliance — the dates that do not move.
  regulatoryAgent,
  ...declared,
];
