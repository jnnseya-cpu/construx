import { areaDivergence } from '../domain/planning/geometry.ts';
import { evaluations, evaluationStaleness, proposals, ruleVersionPositions, siteVersions } from '../domain/planning/planning.ts';
import type { EngineContext } from '../engines/context.ts';
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
  ],
  inputs: ['Red-line revisions', 'Site facts', 'Proposals and their evaluations', 'Published rule versions'],
  outputs: ['Rule versions changed since publication', 'Stale evaluations', 'Proposals never evaluated', 'Material red-line area discrepancies'],
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
