import { areaDivergence } from '../domain/planning/geometry.ts';
import { evaluations, evaluationStaleness, proposals, ruleVersionPositions, siteVersions } from '../domain/planning/planning.ts';
import type { EngineContext } from '../engines/context.ts';
import { applications, today } from '../domain/planning/applications.ts';
import { obligations } from '../domain/planning/consents.ts';
import { releases } from '../domain/planning/gates.ts';
import type { AgentDefinition, AgentOutput, Finding } from './types.ts';

/**
 * The CONSTRUX Planning watch.
 *
 * Observes and never acts. Every finding is arithmetic over recorded facts: a
 * rule version whose content changed after it was published, an evaluation
 * that no longer describes the project, a drawn red line that disagrees with
 * the confirmed one. Each names the records it was read from.
 */

const empty: AgentOutput = { findings: [], proposals: [] };

export const planningWatchAgent: AgentDefinition = {
  name: 'planning watch',
  agentId: 'AGT-PLANNING-WATCH',
  module: 'PLANNING',
  division: 'COMPLIANCE',
  purpose:
    'Watches the planning record and says where it no longer holds: a rule version changed since it was published, a rule ' +
    'evaluation that is stale against the red line, the proposal or the site facts, and a drawn boundary that disagrees with ' +
    'the confirmed legal area.',
  activeIn: 'ANY',
  triggers: [
    { kind: 'SCHEDULE', at: '06:15' },
    { kind: 'EVENT', eventType: 'PLANNING_SITE_VERSION_RECORDED' },
    { kind: 'EVENT', eventType: 'PLANNING_SITE_FACT_RECORDED' },
    { kind: 'EVENT', eventType: 'PLANNING_PROPOSAL_RECORDED' },
    { kind: 'EVENT', eventType: 'PLANNING_RULE_VERSION_PUBLISHED' },
    { kind: 'EVENT', eventType: 'PLANNING_RELEASE_REVOKED' },
    { kind: 'EVENT', eventType: 'PLANNING_OBLIGATION_DUE' },
  ],
  inputs: ['Red-line revisions', 'Site facts', 'Proposals and their evaluations', 'Published rule versions'],
  outputs: [
    'Rule versions changed since publication',
    'Stale evaluations',
    'Proposals never evaluated',
    'Material red-line area discrepancies',
    'Works releases revoked',
    'Works recorded on a programme task with no live planning release',
    'Obligations due or falling due',
    'Applications past their determination date',
  ],
  emits: [],
  hitl: 'REVIEW',
  // Every finding is a comparison of recorded values; there is no judgement in it.
  confidenceFloor: 0.9,
  acuTier: 'LOW',
  memory: { reads: ['PROJECT'], writes: [] },
  mandate: {
    reads: ['PLANNING_CONSENT'],
    proposes: [],
    approvers: ['OWNER'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx: EngineContext): AgentOutput {
    const sites = siteVersions(ctx);
    const findings: Finding[] = [];

    for (const rule of ruleVersionPositions(ctx)) {
      if (rule.status !== 'CHANGED_SINCE_PUBLISHED' || !rule.record) continue;
      findings.push({
        key: `planning:rule-changed:${rule.version}`,
        severity: 'URGENT',
        summary: `${rule.version} has changed since it was published on ${String(rule.record.publishedAt ?? '').slice(0, 10)}.`,
        consequence:
          'The content the company checked and published is not the content now in force, so nothing it produces is relied on until it is checked and published again.',
        evidence: [{ refType: 'PlanningRuleVersion', refId: rule.record.id, note: `Published hash ${rule.record.hash.slice(0, 12)}` }],
      });
    }

    // Releases: revoked ones, and works recorded where nothing is released.
    const allReleases = releases(ctx);
    for (const release of allReleases.filter((entry) => entry.status === 'REVOKED')) {
      const reinstated = allReleases.some((entry) => entry.status === 'APPROVED' && entry.gate === release.gate && entry.phase === release.phase && entry.operation === release.operation);
      if (reinstated) continue;
      findings.push({
        key: `planning:revoked:${release.id}`,
        severity: 'URGENT',
        summary: `${release.reference} (${release.phase}, ${release.operation.toLowerCase().replace('_', ' ')}) was revoked: ${(release.revoked?.reasons ?? []).slice(0, 2).join(' ')}`,
        consequence: 'Delivery no longer has a planning release for this phase and operation; works that rely on it are at risk of breaching the permission.',
        evidence: [{ refType: 'PlanningRelease', refId: release.id, note: `Revoked ${String(release.revoked?.at ?? '').slice(0, 10)}` }],
      });
    }
    for (const release of allReleases.filter((entry) => entry.programmeTaskId && entry.status !== 'APPROVED')) {
      const task = ctx.ledger.get({ refType: 'Task', refId: release.programmeTaskId! });
      const progress = Number(task?.state.percentComplete ?? 0);
      if (!task || progress <= 0) continue;
      if (allReleases.some((entry) => entry.status === 'APPROVED' && entry.programmeTaskId === release.programmeTaskId)) continue;
      findings.push({
        key: `planning:unreleased-works:${release.programmeTaskId}`,
        severity: 'URGENT',
        summary: `${String(task.state.name)} is ${progress}% complete on the programme, and ${release.reference} for it is ${release.status.toLowerCase()}.`,
        consequence: 'Work is recorded against a task with no live planning release — the conditions it depends on may not be discharged.',
        evidence: [
          { refType: 'Task', refId: task.refId, note: `${progress}% complete` },
          { refType: 'PlanningRelease', refId: release.id, note: release.status },
        ],
      });
    }

    // Obligations: due now, or falling due on a date within 30 days.
    const soon = new Date(Date.parse(`${today()}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
    for (const obligation of obligations(ctx).filter((entry) => entry.status !== 'SATISFIED')) {
      const dated = obligation.triggers.find((trigger) => trigger.event === 'DATE' && trigger.on && trigger.on <= soon);
      if (!obligation.dueSince && !dated) continue;
      findings.push({
        key: `planning:obligation-due:${obligation.id}`,
        severity: obligation.dueSince || (dated && dated.on! <= today()) ? 'URGENT' : 'ATTENTION',
        summary: `${obligation.reference} (${obligation.instrument} ${obligation.clause}: ${obligation.description}) is ${obligation.dueSince ? `due since ${obligation.dueSince}` : `due on ${dated!.on}`}, owned by ${obligation.owner}.`,
        consequence: 'An obligation not met on its trigger is a breach of the agreement, and can carry interest, enforcement or a stop on occupation.',
        evidence: [{ refType: 'PlanningObligation', refId: obligation.id, note: obligation.status }],
      });
    }

    // Applications past the date they should have been decided by.
    for (const application of applications(ctx).filter((entry) => entry.status === 'VALID')) {
      const due = application.extension?.agreedTo ?? application.clock?.statutoryTargetOn;
      if (!due || due >= today()) continue;
      findings.push({
        key: `planning:overdue:${application.id}`,
        severity: 'ATTENTION',
        summary: `${application.reference} passed its ${application.extension ? 'agreed extension' : 'statutory determination date'} (${due}) undecided.`,
        consequence: 'The applicant may agree a further extension or appeal against non-determination; the land option and the programme are exposed meanwhile.',
        evidence: [{ refType: 'PlanningApplication', refId: application.id, note: `Validated ${application.validatedOn}` }],
      });
    }

    if (sites.length === 0) return findings.length ? { findings, proposals: [] } : empty;

    const site = sites.at(-1)!;
    const divergence = areaDivergence(site.calculatedAreaM2, site.confirmedAreaM2);
    if (divergence.material) {
      findings.push({
        key: `planning:area:${site.id}`,
        severity: 'ATTENTION',
        summary: `Red line revision ${site.revision}: ${divergence.reasons.join(' ')}`,
        consequence: 'Area thresholds decide major development, flood risk assessment, EIA screening and the outline fee; the two areas have to be reconciled before any of those is relied on.',
        evidence: [{ refType: 'PlanningSiteVersion', refId: site.id, note: `Drawn ${site.calculatedAreaM2} m², confirmed ${site.confirmedAreaM2} m²` }],
      });
    }

    const all = proposals(ctx);
    const latestVersions = all.filter((entry) => !all.some((other) => other.scenarioName === entry.scenarioName && other.version > entry.version));
    for (const subject of latestVersions) {
      if (evaluations(ctx).some((evaluation) => evaluation.proposalId === subject.id)) continue;
      findings.push({
        key: `planning:unevaluated:${subject.id}`,
        severity: 'ATTENTION',
        summary: `${subject.scenarioName} v${subject.version} has not been evaluated against the rules.`,
        consequence: 'Whatever the screen says about major development, flood risk, EIA or the determination period comes from an earlier version, or from nothing.',
        evidence: [{ refType: 'PlanningProposal', refId: subject.id, note: `Recorded ${subject.recordedAt.slice(0, 10)}` }],
      });
    }
    for (const evaluation of evaluations(ctx)) {
      const subject = all.find((entry) => entry.id === evaluation.proposalId);
      // Only the latest evaluation of the latest version of each scenario is worth a finding.
      if (!subject || all.some((entry) => entry.scenarioName === subject.scenarioName && entry.version > subject.version)) continue;
      if (evaluations(ctx).some((other) => other.proposalId === evaluation.proposalId && other.evaluatedAt > evaluation.evaluatedAt)) continue;
      const stale = evaluationStaleness(ctx, evaluation);
      if (stale.length === 0) continue;
      findings.push({
        key: `planning:stale:${evaluation.id}`,
        severity: 'ATTENTION',
        summary: `The rule evaluation of ${subject.scenarioName} v${subject.version} is stale: ${stale.join(' ')}`,
        consequence: 'Its findings describe a project that no longer exists; a gate or a budget read from them would rest on the old inputs.',
        evidence: [{ refType: 'PlanningEvaluation', refId: evaluation.id, note: `Evaluated ${evaluation.evaluatedAt.slice(0, 10)}` }],
      });
    }
    return { findings, proposals: [] };
  },
};

export const PLANNING_AGENTS: AgentDefinition[] = [planningWatchAgent];
