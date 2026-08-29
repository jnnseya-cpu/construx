import type { EngineContext } from '../engines/context.ts';
import type { AgentDefinition, AgentOutput, Finding } from './types.ts';

/**
 * The lifecycle fleet: the agents the specification names by `AGT-` id.
 *
 * `registry.ts` holds the twelve that grew with the platform and answer "is
 * this project going wrong"; `platform.ts` holds the ones that watch the
 * platform rather than a job. These are the rest of the specification's
 * thirty-five, and they are in their own file for the same reason those two
 * are separate: they are organised by lifecycle stage rather than by division,
 * and mixing them into the delivery registry would hide that a third of the
 * fleet only ever runs before a spade goes in the ground.
 *
 * Two rules hold across all of them, and they are the reason this fleet is
 * worth trusting.
 *
 * **The trigger is arithmetic over the record.** No agent here asks a model
 * whether something is wrong. Each applies a stated threshold to materialised
 * state, so the same project always produces the same findings and a person can
 * check the working. Models contribute narrative and classification *inside*
 * the engines these agents propose to run — never the decision to run one.
 *
 * **An agent that cannot see its inputs is `DECLARED`, not deployed.** Three of
 * them need a data source this platform does not hold — a planning portal, a
 * carbon factor database. They appear in the manifest with their full contract,
 * so the fleet's shape and blast radius stay inspectable, and the runtime never
 * runs them. A fleet that listed thirty-five agents when three were reading
 * from nothing would be a lie told in a table.
 */

const list = (ctx: EngineContext, refType: string) => ctx.ledger.list(ctx.projectId, refType);
const states = (ctx: EngineContext, refType: string) => list(ctx, refType).map((r) => r.state);
const empty: AgentOutput = { findings: [], proposals: [] };

/** One finding, with the evidence it was read from. */
function finding(
  key: string,
  severity: Finding['severity'],
  summary: string,
  consequence: string,
  evidence: Finding['evidence'],
  confidence?: number,
): Finding {
  return { key, severity, summary, consequence, evidence, ...(confidence === undefined ? {} : { confidence }) };
}

/** Evidence from a set of records, capped so a finding stays readable. */
const cite = (ctx: EngineContext, refType: string, note: string, limit = 5): Finding['evidence'] =>
  list(ctx, refType)
    .slice(0, limit)
    .map((r) => ({ refType, refId: r.refId, note }));

// ── Concept ─────────────────────────────────────────────────────────────────

const feasibilityAgent: AgentDefinition = {
  name: 'feasibility',
  agentId: 'AGT-FEASIBILITY',
  division: 'BID',
  purpose: 'Reads the site record against the brief and names what would stop the scheme before money is spent on it.',
  activeIn: ['CONCEPT'],
  triggers: [{ kind: 'EVENT', eventType: 'BRIEF_BASELINED' }, { kind: 'ON_DEMAND' }],
  inputs: ['Site surveys', 'Site constraints', 'Brief baseline', 'Due diligence reviews'],
  outputs: ['Site appraisal', 'Constraint map', 'Showstopper flags'],
  emits: ['CONSTRAINT_IDENTIFIED'],
  hitl: 'REVIEW',
  confidenceFloor: 0.6,
  acuTier: 'HIGH',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT'] },
  mandate: {
    reads: ['PROJECT_SETUP'],
    proposes: [],
    approvers: ['OWNER', 'DEVELOPMENT_MANAGER', 'PROJECT_DIRECTOR'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const constraints = states(ctx, 'SiteConstraint');
    const surveys = states(ctx, 'SiteSurvey');
    const brief = states(ctx, 'BriefBaseline').at(-1);
    if (!brief) return empty;

    const findings: Finding[] = [];

    // A constraint nobody has resolved and nobody owns is the one that surfaces
    // at planning, which is the most expensive place to find it.
    const unowned = constraints.filter((c) => c.status !== 'RESOLVED' && !c.ownerId);
    if (unowned.length > 0) {
      findings.push(
        finding(
          'feasibility:unowned-constraints',
          'ATTENTION',
          `${unowned.length} site constraint(s) are open with nobody named against them.`,
          'A constraint with no owner is not being worked. At concept these are cheap to resolve and at planning they are not.',
          cite(ctx, 'SiteConstraint', 'open, no owner'),
        ),
      );
    }

    // The showstopper test: a brief that commits to something the site record
    // says is constrained, with no survey covering the discipline that would
    // settle it.
    const covered = new Set(surveys.map((s) => String(s.discipline ?? '').toUpperCase()));
    const uncovered = constraints
      .filter((c) => c.status !== 'RESOLVED')
      .map((c) => String(c.discipline ?? c.category ?? '').toUpperCase())
      .filter((d) => d && !covered.has(d));
    if (uncovered.length > 0) {
      findings.push(
        finding(
          'feasibility:unsurveyed',
          'URGENT',
          `No live survey covers ${[...new Set(uncovered)].join(', ')}, and an open constraint sits in each.`,
          'The scheme is being appraised against an assumption. If the survey contradicts it the option set changes, not the design.',
          cite(ctx, 'SiteSurvey', 'surveys held'),
        ),
      );
    }
    return { findings, proposals: [] };
  },
};

const benchCostAgent: AgentDefinition = {
  name: 'bench-cost',
  agentId: 'AGT-BENCH-COST',
  division: 'BID',
  purpose: 'Prices each feasibility option from the organisation rate library and says how sure it is per element.',
  activeIn: ['CONCEPT', 'DESIGN'],
  triggers: [{ kind: 'EVENT', eventType: 'OPTION_CREATED' }, { kind: 'ON_DEMAND' }],
  inputs: ['Feasibility options', 'Organisation rate library', 'Concept cost plan', 'Areas schedule'],
  outputs: ['Cost plan v0 per option', 'Elemental rate per m²', 'Confidence per element'],
  emits: ['COST_PLAN_CREATED'],
  hitl: 'REVIEW',
  confidenceFloor: 0.55,
  acuTier: 'HIGH',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT'] },
  mandate: {
    reads: ['PROJECT_SETUP', 'BUDGET_COST'],
    proposes: [],
    approvers: ['OWNER', 'COMMERCIAL_MANAGER', 'QS'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const options = states(ctx, 'FeasibilityOption');
    const plans = states(ctx, 'ConceptCostPlan');
    if (options.length === 0) return empty;

    const priced = new Set(plans.map((p) => String(p.optionId ?? '')));
    const unpriced = options.filter((o) => !priced.has(String(o.id)));
    if (unpriced.length === 0) return empty;

    return {
      findings: [
        finding(
          'bench-cost:unpriced-options',
          'ATTENTION',
          `${unpriced.length} of ${options.length} option(s) carry no cost plan.`,
          'An option appraisal that compares a priced option against an unpriced one is not a comparison. The cheapest option is always the one nobody costed.',
          cite(ctx, 'FeasibilityOption', 'option under appraisal'),
        ),
      ],
      proposals: [],
    };
  },
};

const consentsAgent: AgentDefinition = {
  name: 'consents',
  agentId: 'AGT-CONSENTS',
  division: 'BID',
  purpose: 'Recommends the consent route and the probability of approval from planning policy and precedent.',
  activeIn: ['CONCEPT', 'DESIGN'],
  triggers: [{ kind: 'EVENT', eventType: 'DUE_DILIGENCE_REVIEWED' }],
  inputs: ['Planning policy', 'Precedent applications', 'Site history'],
  outputs: ['Consent route recommendation', 'Approval probability', 'Pre-application question list'],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.6,
  acuTier: 'MED',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT'] },
  mandate: {
    reads: ['PROJECT_SETUP'],
    proposes: [],
    approvers: ['OWNER', 'DEVELOPMENT_MANAGER'],
    maxUnattended: 'OBSERVE',
  },
  deployment: 'DECLARED',
  needs:
    'A planning authority feed. Approval probability from precedent requires the decisions of comparable applications, ' +
    'and this platform holds no planning data at all — inferring a probability from the project record alone would be ' +
    'a number with nothing behind it.',
};

const carbonAgent: AgentDefinition = {
  name: 'carbon-esg',
  agentId: 'AGT-CARBON-ESG',
  division: 'BID',
  purpose: 'Estimates embodied and operational carbon per option and lists the BREEAM gap.',
  activeIn: ['CONCEPT', 'DESIGN'],
  triggers: [{ kind: 'EVENT', eventType: 'OPTION_CREATED' }],
  inputs: ['Areas schedule', 'Material assumptions', 'Energy strategy'],
  outputs: ['Embodied and operational carbon per option', 'BREEAM gap list'],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.6,
  acuTier: 'MED',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT'] },
  mandate: {
    reads: ['PROJECT_SETUP'],
    proposes: [],
    approvers: ['OWNER', 'DEVELOPMENT_MANAGER', 'PRINCIPAL_DESIGNER'],
    maxUnattended: 'OBSERVE',
  },
  deployment: 'DECLARED',
  needs:
    'A carbon factor database. Embodied carbon is a quantity multiplied by a published factor per material, and the ' +
    'platform holds the quantities and none of the factors. A figure produced without them would be arithmetic on an ' +
    'invented constant, which is worse than no figure on a number somebody may report externally.',
};

const conceptRiskAgent: AgentDefinition = {
  name: 'concept-risk',
  agentId: 'AGT-CONCEPT-RISK',
  division: 'BID',
  purpose: 'Seeds the risk register at concept and reports what moved each week.',
  activeIn: ['CONCEPT'],
  triggers: [{ kind: 'CONTINUOUS' }, { kind: 'SCHEDULE', at: '07:00', days: [1] }],
  inputs: ['Concept objects and events', 'Risk register', 'Constraints', 'Due diligence'],
  outputs: ['Seeded risk register', 'Weekly risk delta digest'],
  emits: ['RISK_REGISTERED'],
  hitl: 'REVIEW',
  confidenceFloor: 0.5,
  acuTier: 'LOW',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT'] },
  mandate: {
    reads: ['PROJECT_SETUP', 'RISK_REGISTER'],
    proposes: [],
    approvers: ['OWNER', 'PM', 'PROJECT_DIRECTOR'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const risks = states(ctx, 'RiskRegisterItem');
    const constraints = states(ctx, 'SiteConstraint').filter((c) => c.status !== 'RESOLVED');
    if (constraints.length === 0) return empty;

    // A constraint the register has never heard of. The two are different
    // objects on purpose — a constraint is a fact about the site, a risk is a
    // consequence somebody has priced — and the gap between them is where a
    // concept-stage surprise comes from.
    const described = risks.map((r) => String(r.title ?? '').toLowerCase()).join(' | ');
    const unregistered = constraints.filter((c) => {
      const word = String(c.description ?? c.category ?? '').toLowerCase().split(/\s+/)[0] ?? '';
      return word.length > 3 && !described.includes(word);
    });
    if (unregistered.length === 0) return empty;

    return {
      findings: [
        finding(
          'concept-risk:unregistered-constraints',
          'ATTENTION',
          `${unregistered.length} open site constraint(s) have no matching entry in the risk register.`,
          'A constraint carries no cost or programme consequence until somebody registers it as a risk. Until then the option appraisal is comparing schemes as though the constraint were free.',
          cite(ctx, 'SiteConstraint', 'open constraint'),
          0.65,
        ),
      ],
      proposals: [],
    };
  },
};

// ── Design ──────────────────────────────────────────────────────────────────

const scopeGapAgent: AgentDefinition = {
  name: 'scope-gap',
  agentId: 'AGT-SCOPE-GAP',
  division: 'BID',
  purpose: 'Finds scope that no package covers, and scope that two packages both claim.',
  activeIn: ['DESIGN', 'TENDER'],
  triggers: [{ kind: 'EVENT', eventType: 'PACKAGE_CREATED' }, { kind: 'CONTINUOUS' }],
  inputs: ['Scope packages', 'Design packages', 'Tender packages', 'Specification clauses'],
  outputs: ['Gap and overlap report between packages', 'Unallocated scope list'],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.6,
  acuTier: 'HIGH',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT'] },
  mandate: {
    reads: ['PROJECT_SETUP', 'DESIGN_INFORMATION', 'PROCUREMENT_AWARD'],
    proposes: [],
    approvers: ['QS', 'COMMERCIAL_MANAGER', 'PM', 'EPC'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const packages = states(ctx, 'ScopePackage');
    if (packages.length < 2) return empty;

    // Two packages naming the same exclusion is a gap: each has priced on the
    // assumption the other carries it, and the client owns the difference.
    const exclusions = new Map<string, string[]>();
    for (const p of packages) {
      for (const raw of (p.exclusions as string[] | undefined) ?? []) {
        const key = raw.toLowerCase().trim();
        exclusions.set(key, [...(exclusions.get(key) ?? []), String(p.name ?? p.id)]);
      }
    }
    const shared = [...exclusions.entries()].filter(([, owners]) => owners.length > 1);
    if (shared.length === 0) return empty;

    return {
      findings: [
        finding(
          'scope-gap:shared-exclusions',
          'URGENT',
          `${shared.length} item(s) are excluded by more than one package: ${shared.slice(0, 3).map(([k]) => k).join('; ')}.`,
          'Nobody has priced it. Each package assumed the other carried it, and the difference lands as a variation or as the client’s own cost.',
          cite(ctx, 'ScopePackage', 'package with exclusions'),
          0.75,
        ),
      ],
      proposals: [],
    };
  },
};

const specIntelAgent: AgentDefinition = {
  name: 'spec-intel',
  agentId: 'AGT-SPEC-INTEL',
  division: 'BID',
  purpose: 'Turns specification text into a clause register, a submittal register and the ambiguities worth an RFI.',
  activeIn: ['DESIGN', 'TENDER', 'CONSTRUCTION'],
  triggers: [{ kind: 'EVENT', eventType: 'SPECIFICATION_INGESTED' }, { kind: 'ON_DEMAND' }],
  inputs: ['Specifications', 'Specification clauses', 'Material submittals'],
  outputs: ['Clause register', 'Submittal register', 'Ambiguity RFIs', 'RAMS hazard seeds'],
  emits: ['RFI_RAISED'],
  hitl: 'REVIEW',
  confidenceFloor: 0.6,
  acuTier: 'MED',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT'] },
  mandate: {
    reads: ['DESIGN_INFORMATION'],
    proposes: [],
    approvers: ['PM', 'DESIGNER', 'PRINCIPAL_DESIGNER', 'QAQC'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const clauses = states(ctx, 'SpecClause');
    const submittals = states(ctx, 'MaterialSubmittal');
    if (clauses.length === 0) return empty;

    // A clause that calls for a submittal, with no submittal raised against it.
    const requiring = clauses.filter((c) => c.requiresSubmittal === true);
    const raised = new Set(submittals.map((s) => String(s.clauseId ?? '')));
    const outstanding = requiring.filter((c) => !raised.has(String(c.id)));
    if (outstanding.length === 0) return empty;

    return {
      findings: [
        finding(
          'spec-intel:submittals-outstanding',
          'ATTENTION',
          `${outstanding.length} specification clause(s) require a submittal that has not been raised.`,
          'A material installed against a clause whose submittal was never approved is a non-conformance waiting for an inspection to find it.',
          cite(ctx, 'SpecClause', 'clause requiring a submittal'),
          0.8,
        ),
      ],
      proposals: [],
    };
  },
};

const costPlanAgent: AgentDefinition = {
  name: 'cost-plan',
  agentId: 'AGT-COST-PLAN',
  division: 'BID',
  purpose: 'Watches cost plan drift against the design revision that caused it.',
  activeIn: ['DESIGN', 'TENDER'],
  triggers: [{ kind: 'EVENT', eventType: 'DESIGN_CHANGE_PROPOSED' }, { kind: 'CONTINUOUS' }],
  inputs: ['Concept cost plan', 'Design changes', 'Budget', 'Design baseline'],
  outputs: ['Drift alerts with causal revision', 'Next cost plan draft', 'Value engineering impact model'],
  emits: [],
  hitl: 'APPROVAL',
  confidenceFloor: 0.65,
  acuTier: 'HIGH',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT'] },
  mandate: {
    reads: ['BUDGET_COST', 'DESIGN_INFORMATION'],
    proposes: [],
    approvers: ['COMMERCIAL_MANAGER', 'OWNER', 'PROJECT_DIRECTOR'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const changes = states(ctx, 'DesignChange').filter((c) => c.status !== 'REJECTED');
    const budget = states(ctx, 'Budget').at(-1);
    if (!budget || changes.length === 0) return empty;

    const uncosted = changes.filter((c) => c.costImpactMinor === undefined || c.costImpactMinor === null);
    if (uncosted.length === 0) return empty;

    return {
      findings: [
        finding(
          'cost-plan:uncosted-changes',
          'URGENT',
          `${uncosted.length} live design change(s) carry no cost impact.`,
          'The cost plan is being reported as current while carrying changes nobody has priced. The drift is real and invisible.',
          cite(ctx, 'DesignChange', 'change with no cost impact'),
          0.85,
        ),
      ],
      proposals: [],
    };
  },
};

const bimTwinAgent: AgentDefinition = {
  name: 'bim-twin',
  agentId: 'AGT-BIM-TWIN',
  division: 'DELIVERY',
  purpose: 'Validates the model against the asset information the operator will need, before it is too late to ask.',
  activeIn: ['DESIGN', 'CONSTRUCTION', 'COMMISSIONING', 'HANDOVER'],
  triggers: [{ kind: 'EVENT', eventType: 'MODEL_INGESTED' }, { kind: 'CONTINUOUS' }],
  inputs: ['Models', 'Federation sets', 'Asset information links', 'Asset register'],
  outputs: ['Model-to-data validation', 'Asset information gap list', 'COBie pre-check'],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.6,
  acuTier: 'MED',
  memory: { reads: ['PROJECT', 'ASSET'], writes: ['PROJECT'] },
  mandate: {
    reads: ['BIM_TWIN', 'HANDOVER_OM'],
    proposes: [],
    approvers: ['BIM', 'PM', 'FM'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const models = states(ctx, 'Model');
    const links = states(ctx, 'AssetInformationLink');
    if (models.length === 0) return empty;
    if (links.length > 0) return empty;

    return {
      findings: [
        finding(
          'bim-twin:no-asset-links',
          'ATTENTION',
          `${models.length} model(s) are held and nothing in them is linked to an asset record.`,
          'At handover the operator is given geometry and no data. The link is cheap to make while the designer is still engaged and expensive to reconstruct afterwards.',
          cite(ctx, 'Model', 'model held'),
        ),
      ],
      proposals: [],
    };
  },
};

const designRiskAgent: AgentDefinition = {
  name: 'design-risk',
  agentId: 'AGT-DESIGN-RISK',
  division: 'DELIVERY',
  purpose: 'Lists unresolved design risk by discipline and scores readiness for the design gate.',
  activeIn: ['DESIGN', 'TENDER'],
  triggers: [{ kind: 'CONTINUOUS' }],
  inputs: ['Design risk reviews', 'Constructability reviews', 'Design maturity assessments'],
  outputs: ['Unresolved design risk by discipline', 'Gate readiness score'],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.55,
  acuTier: 'LOW',
  memory: { reads: ['PROJECT'], writes: ['PROJECT'] },
  mandate: {
    reads: ['DESIGN_INFORMATION', 'RISK_REGISTER'],
    proposes: [],
    approvers: ['PRINCIPAL_DESIGNER', 'DESIGNER', 'PM'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const maturity = states(ctx, 'DesignMaturityAssessment').at(-1);
    if (!maturity) return empty;

    const scores = (maturity.disciplineScores as Array<Record<string, unknown>> | undefined) ?? [];
    const immature = scores.filter((d) => Number(d.completenessPercent ?? 0) < 70 || d.frozen !== true);
    if (immature.length === 0) return empty;

    return {
      findings: [
        finding(
          'design-risk:immature-disciplines',
          'ATTENTION',
          `${immature.length} discipline(s) are below 70% complete or unfrozen: ${immature.map((d) => String(d.discipline)).join(', ')}.`,
          'Pricing an unfrozen discipline puts the definition risk in the contractor’s number, and it comes back as a variation with the client’s name on it.',
          cite(ctx, 'DesignMaturityAssessment', 'maturity assessment'),
          0.8,
        ),
      ],
      proposals: [],
    };
  },
};

// ── Tender ──────────────────────────────────────────────────────────────────

const tenderIntelAgent: AgentDefinition = {
  name: 'tender-intel',
  agentId: 'AGT-TENDER-INTEL',
  division: 'BID',
  purpose: 'Reads the invitation to tender and states the scope, the risk and whether the job is worth chasing.',
  activeIn: ['TENDER'],
  triggers: [{ kind: 'EVENT', eventType: 'ITT_ANALYSED' }, { kind: 'ON_DEMAND' }],
  inputs: ['ITT documents', 'Specifications', 'Drawings', 'Draft contract'],
  outputs: ['Scope extraction', 'Risk flags', 'Missing-information list', 'Bid/no-bid recommendation'],
  emits: [],
  hitl: 'APPROVAL',
  confidenceFloor: 0.7,
  acuTier: 'HIGH',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT'] },
  mandate: {
    reads: ['BUSINESS_DEVELOPMENT', 'ESTIMATE_TENDER'],
    proposes: [],
    approvers: ['OWNER', 'EPC', 'COMMERCIAL_MANAGER', 'PROJECT_DIRECTOR'],
    maxUnattended: 'OBSERVE',
  },
  /**
   * This agent could not raise a finding, and nothing said so.
   *
   * Its only branch read `analysis.missingInformation`, which `analyseITT` has
   * never written — the field does not appear anywhere in `domain/itt.ts`. So
   * the read returned `undefined`, the length check fell through to `empty`,
   * and an agent declared, triggered on `ITT_ANALYSED`, given a HIGH ACU tier
   * and an approver list was structurally incapable of ever saying anything.
   * It looked alive in the fleet register and in every run report, because a
   * silent agent and an agent with nothing to report are indistinguishable
   * from the outside.
   *
   * What the analysis actually carries is the answer to the two questions a
   * bid manager asks first, and they are now what this reports:
   *
   * **A barred term ends the bid before pricing starts.** `analyseITT`
   * classifies terms as BAR, SEVERE, MATERIAL or ROUTINE, and a BAR is not a
   * negotiation — it is fitness-for-purpose design liability on a job the
   * business insures for reasonable skill and care, or unlimited consequential
   * loss. Finding that out at settlement is finding out too late.
   *
   * **A mandatory requirement with no evidence behind it is a disqualification
   * waiting to happen.** Not a scored weakness — a pass/fail the business
   * fails, and the bid cost is spent before anybody reads the price.
   *
   * The clarifications are reported at ATTENTION rather than URGENT because
   * they have a deadline of their own that is earlier than the return, and
   * missing that deadline is what turns a question into a qualification.
   */
  evaluate(ctx) {
    const analysis = states(ctx, 'ITTAnalysis').at(-1);
    if (!analysis) return empty;

    const reference = String(analysis.reference ?? 'the invitation');
    const bars = (analysis.bars as string[] | undefined) ?? [];
    const mandatoryGaps = (analysis.mandatoryGaps as Array<{ reference?: unknown }> | undefined) ?? [];
    const clarifications = (analysis.clarifications as string[] | undefined) ?? [];
    const exposureMinor = Number(analysis.quantifiedExposureMinor ?? 0);
    const findings = [];

    if (bars.length > 0) {
      findings.push(
        finding(
          'tender-intel:barred-terms',
          'URGENT',
          `${reference} carries ${bars.length} term(s) this business does not accept: ${bars.join('; ')}.`,
          'A bar is not a negotiation. Either it is struck out before the return or the bid is a no-bid, and the ' +
            'cost of finding that out at settlement is the whole bid.',
          cite(ctx, 'ITTAnalysis', 'ITT analysis'),
          0.9,
        ),
      );
    }

    if (mandatoryGaps.length > 0) {
      const named = mandatoryGaps
        .map((gap) => String(gap.reference ?? ''))
        .filter(Boolean)
        .slice(0, 4);
      findings.push(
        finding(
          'tender-intel:mandatory-gaps',
          'URGENT',
          `${mandatoryGaps.length} mandatory requirement(s) have no evidence behind them${named.length > 0 ? `: ${named.join(', ')}` : ''}.`,
          'These are pass/fail. A bid that fails one is disqualified before anybody opens the price, and the bid ' +
            'cost is spent either way.',
          cite(ctx, 'ITTAnalysis', 'ITT analysis'),
          0.9,
        ),
      );
    }

    if (analysis.readyToPrice === false && bars.length === 0 && mandatoryGaps.length === 0) {
      // Not priceable, and not for either reason above — worth saying on its
      // own rather than leaving somebody to infer it from a quiet screen.
      findings.push(
        finding(
          'tender-intel:not-priceable',
          'ATTENTION',
          `${reference} is not yet in a state that can be priced.`,
          'The compliance matrix names what is outstanding. Pricing around a gap is pricing a guess.',
          cite(ctx, 'ITTAnalysis', 'ITT analysis'),
          0.8,
        ),
      );
    }

    if (clarifications.length > 0) {
      findings.push(
        finding(
          'tender-intel:clarifications',
          'ATTENTION',
          `${clarifications.length} question(s) should go to the buyer before the return: ${clarifications.slice(0, 3).join('; ')}.`,
          'The clarification deadline falls before the return. A question asked after it becomes a qualification ' +
            'on the bid, which buyers are entitled to disregard.',
          cite(ctx, 'ITTAnalysis', 'ITT analysis'),
          0.8,
        ),
      );
    }

    if (exposureMinor > 0 && findings.length > 0) {
      findings.push(
        finding(
          'tender-intel:quantified-exposure',
          'ATTENTION',
          `The terms carry £${Math.round(exposureMinor / 100).toLocaleString()} of quantified exposure against this tender.`,
          'Damages, bond and retention priced as a number rather than described as a risk, so it can be set ' +
            'against the margin the job is expected to carry.',
          cite(ctx, 'ITTAnalysis', 'ITT analysis'),
          0.75,
        ),
      );
    }

    return { findings, proposals: [] };
  },
};

/**
 * The clerical half of reading an invitation, done unattended.
 *
 * The first agent on this platform declared eligible to *act* rather than
 * propose, and the reasoning for where the line falls is the whole of why it
 * exists.
 *
 * Reading an ITT is two jobs wearing one name. One is transcription: forty
 * return items, each with a format, a page limit, a channel, a signature or
 * bond requirement and a date, copied out of a document without losing any of
 * them. It is slow, it is exactly the work a machine is good at, and a mistake
 * in it is visible and fixable on a screen the bid team opens daily. The other
 * is judgement: whether a requirement is really pass/fail, whether fitness for
 * purpose is acceptable against the cover this business holds, whether the job
 * is worth chasing at all. A mistake in *that* is a bid submitted on terms
 * nobody checked.
 *
 * So the line is drawn between them, and it is drawn in the event catalogue
 * rather than here: `TENDER_REQUIREMENTS_EXTRACTED` is `aiAllowed`,
 * `ITT_ANALYSED` is not. This agent can therefore only ever reach the register,
 * whatever it or a future envelope tries — the ledger refuses the other outright
 * to an AI author, and `assertCommandMayBeAutomated` refuses it at grant time
 * before anyone gets that far.
 *
 * **Nothing here confers the authority.** `maxUnattended: 'ACT'` says this
 * agent *may be* trusted; whether it *is* comes from an envelope a person with
 * governance authority granted, with an end date, revocable, on the record.
 * Without one this agent behaves exactly like every other: it proposes, and the
 * runtime says so in the proposal — "queued rather than run".
 *
 * **The confidence floor is the second gate.** A reading the model is not sure
 * about does not become an unattended act; it becomes a finding with no
 * proposal attached, which is the runtime's ordinary behaviour below the floor.
 * The floor is high here — higher than the analyst's — because the whole
 * argument for acting rests on the transcription being reliable.
 */
const ittRegisterAgent: AgentDefinition = {
  name: 'itt-register',
  agentId: 'AGT-ITT-REGISTER',
  division: 'BID',
  purpose:
    'Files the return register off an invitation the platform has read: what must go back, in what format, by when ' +
    'and to whom. Never the compliance matrix, which is a judgement a person takes.',
  activeIn: ['TENDER'],
  triggers: [{ kind: 'EVENT', eventType: 'PERCEPTION_DRAFT_PRODUCED' }, { kind: 'ON_DEMAND' }],
  inputs: ['ITT documents', 'Perception drafts'],
  outputs: ['Return register'],
  emits: ['TENDER_REQUIREMENTS_EXTRACTED'],
  // REVIEW rather than APPROVAL, and the distinction is exactly the decision
  // taken here: a person reads the register afterwards on the screen they work
  // from daily, rather than being asked to approve each line before it exists.
  // The judgement half of the same reading still carries APPROVAL, on the
  // analyst, where it belongs.
  hitl: 'REVIEW',
  confidenceFloor: 0.8,
  acuTier: 'LOW',
  memory: { reads: ['PROJECT'], writes: ['PROJECT'] },
  mandate: {
    reads: ['ESTIMATE_TENDER', 'EVIDENCE_AUDIT'],
    proposes: ['ESTIMATE_TENDER'],
    approvers: ['OWNER', 'QS', 'COMMERCIAL_MANAGER', 'PROJECT_DIRECTOR'],
    maxUnattended: 'ACT',
    envelope: {
      commands: ['tenderintake:extractRequirements'],
      // A return register carries no money. Zero is the honest ceiling, not a
      // placeholder: filing it commits nobody to a price, a programme or a term.
      valueCeilingMinor: 0,
      because:
        'Files the return items an invitation asks for, off a reading the platform already holds and against an ' +
        'invitation that already exists. Every line stays editable, nothing is committed commercially, and the ' +
        'compliance matrix and commercial assessment are outside this envelope and cannot be put inside it.',
    },
  },
  evaluate(ctx) {
    // An unconfirmed reading of an invitation, and the invitation it belongs to.
    const drafts = states(ctx, 'PerceptionDraft').filter(
      (draft) => draft.task === 'ITT_REQUIREMENTS' && draft.status === 'DRAFT',
    );
    if (drafts.length === 0) return empty;

    const invitations = states(ctx, 'TenderInvitation');
    const findings: Finding[] = [];
    const proposals: AgentOutput['proposals'] = [];

    for (const draft of drafts) {
      const extraction = (draft.extraction ?? {}) as { deliverables?: Array<Record<string, unknown>>; reference?: unknown };
      const deliverables = extraction.deliverables ?? [];
      if (deliverables.length === 0) continue;

      // Matched on the buyer's own reference. Guessing which invitation a
      // reading belongs to would be the one mistake that cannot be seen on a
      // screen — a register filed against the wrong tender looks entirely
      // normal until the wrong deadline is missed.
      const reference = String(extraction.reference ?? '');
      const invitation = invitations.find((record) => String(record.reference ?? '') === reference);
      if (!invitation) continue;
      if (invitation.requirementsExtracted === true) continue;

      const key = `itt-register:${String(invitation.id)}`;
      const mandatory = deliverables.filter((deliverable) => deliverable.mandatory === true).length;

      findings.push(
        finding(
          key,
          'ATTENTION',
          `${reference} was read with ${deliverables.length} return item(s), ${mandatory} of them mandatory, and the register is empty.`,
          'A return item nobody has written down is a return item nobody owns, and the bids lost this way are lost ' +
            'with a correct price inside them.',
          [{ refType: 'PerceptionDraft', refId: String(draft.id), note: 'the reading this came from' }],
          typeof draft.confidence === 'number' ? draft.confidence : undefined,
        ),
      );

      proposals.push({
        findingKey: key,
        autonomy: 'ACT',
        command: {
          command: 'tenderintake:extractRequirements',
          area: 'ESTIMATE_TENDER',
          code: 'U',
          input: { invitationId: String(invitation.id), deliverables },
          effect: `Files ${deliverables.length} return item(s) on ${reference}. The compliance matrix is not part of this and still needs a person.`,
          ifDeclined: 'The register stays empty and each return item is transcribed by hand from the invitation.',
          estimatedAcuMinor: 0,
        },
      });
    }

    return { findings, proposals };
  },
};

const returnIntelAgent: AgentDefinition = {
  name: 'return-intel',
  agentId: 'AGT-RETURN-INTEL',
  division: 'BID',
  purpose: 'Normalises tender returns onto one basis so they can actually be compared.',
  activeIn: ['TENDER', 'CONSTRUCTION'],
  triggers: [{ kind: 'EVENT', eventType: 'TENDER_RECEIVED' }],
  inputs: ['Tender responses', 'Return comparisons', 'Enquiries'],
  outputs: ['Normalised comparison', 'Variance RAG', 'Clarification drafts', 'Bidder ranking'],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.65,
  acuTier: 'HIGH',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT'] },
  mandate: {
    reads: ['PROCUREMENT_AWARD', 'ESTIMATE_TENDER'],
    proposes: [],
    approvers: ['QS', 'COMMERCIAL_MANAGER', 'PM'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const responses = states(ctx, 'TenderResponse');
    if (responses.length < 2) return empty;

    // A return carrying qualifications is not on the same basis as one that is
    // not, and ranking them by price alone is the classic way a cheap bid wins
    // and is not cheap.
    const qualified = responses.filter((r) => ((r.qualifications as string[] | undefined) ?? []).length > 0);
    if (qualified.length === 0) return empty;

    return {
      findings: [
        finding(
          'return-intel:qualified-returns',
          'ATTENTION',
          `${qualified.length} of ${responses.length} return(s) carry qualifications and are not on a like-for-like basis.`,
          'Ranking on price alone puts the most heavily qualified bid at the top. The qualifications are the difference between the price and the cost.',
          cite(ctx, 'TenderResponse', 'return with qualifications'),
          0.8,
        ),
      ],
      proposals: [],
    };
  },
};

const contractRiskAgent: AgentDefinition = {
  name: 'contract-risk',
  agentId: 'AGT-CONTRACT-RISK',
  division: 'BID',
  purpose: 'Reads the draft contract clause by clause and reports what it costs to accept as drafted.',
  activeIn: ['TENDER', 'CONSTRUCTION'],
  triggers: [{ kind: 'EVENT', eventType: 'CONTRACT_INGESTED' }, { kind: 'ON_DEMAND' }],
  inputs: ['Contract', 'Contract clauses', 'Standard form baseline'],
  outputs: ['Clause-level onerosity report', 'LD and cap analysis', 'Negotiation position list'],
  emits: [],
  hitl: 'APPROVAL',
  confidenceFloor: 0.75,
  acuTier: 'PREMIUM',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT'] },
  mandate: {
    reads: ['CONTRACTS_CLAIMS'],
    proposes: [],
    approvers: ['COMMERCIAL_MANAGER', 'OWNER', 'PROJECT_DIRECTOR'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const contract = states(ctx, 'Contract').at(-1);
    if (!contract) return empty;

    const findings: Finding[] = [];
    const cap = Number(contract.ldCapPercent ?? 0);
    const sum = Number(contract.contractSumMinor ?? 0);

    // An uncapped or high-capped LD is the single clause most likely to exceed
    // the margin on the job it is attached to.
    if (cap === 0 || cap > 10) {
      findings.push(
        finding(
          'contract-risk:ld-cap',
          'URGENT',
          cap === 0
            ? 'Liquidated damages carry no cap.'
            : `Liquidated damages are capped at ${cap}% of the contract sum.`,
          cap === 0
            ? 'Uncapped delay damages can exceed the whole value of the contract. This is the clause to negotiate before signature, not after.'
            : `At ${cap}% the exposure is ${Math.round((sum * cap) / 100 / 100).toLocaleString()} — compare that with the margin on this job before accepting it.`,
          [{ refType: 'Contract', refId: String(contract.id), note: 'executed or draft contract' }],
          0.9,
        ),
      );
    }
    return { findings, proposals: [] };
  },
};

const bidProgrammeAgent: AgentDefinition = {
  name: 'bid-programme',
  agentId: 'AGT-BID-PROG',
  division: 'BID',
  purpose: 'Checks the bid programme is resourced and that its cashflow is survivable before the bid goes in.',
  activeIn: ['TENDER'],
  triggers: [{ kind: 'EVENT', eventType: 'BID_PROGRAMME_APPROVED' }, { kind: 'ON_DEMAND' }],
  inputs: ['Bid programme', 'Cashflow forecast', 'Estimate', 'Resource demand'],
  outputs: ['Resource-levelled baseline programme', 'Cashflow', 'Feasibility flags'],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.6,
  acuTier: 'HIGH',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT'] },
  mandate: {
    reads: ['PROGRAMME_BASELINES', 'ESTIMATE_TENDER', 'BUDGET_COST'],
    proposes: [],
    approvers: ['PLANNER', 'PM', 'COMMERCIAL_MANAGER'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const programmes = states(ctx, 'BidProgramme');
    const cashflows = states(ctx, 'CashflowForecast');
    if (programmes.length === 0) return empty;
    if (cashflows.length > 0) return empty;

    return {
      findings: [
        finding(
          'bid-programme:no-cashflow',
          'URGENT',
          'A bid programme exists and no cash-flow model has been built against it.',
          'The bid may be profitable and unfundable. A job that runs out of working capital in month seven fails whatever its margin says.',
          cite(ctx, 'BidProgramme', 'bid programme'),
          0.85,
        ),
      ],
      proposals: [],
    };
  },
};

// ── Construction ────────────────────────────────────────────────────────────

const changeAgent: AgentDefinition = {
  name: 'change',
  agentId: 'AGT-CHANGE',
  // Variations are still being valued while the final account is negotiated,
  // which is after the works are complete.
  division: 'DELIVERY',
  purpose: 'Finds change hiding in site records and RFIs before it becomes work done for nothing.',
  activeIn: ['CONSTRUCTION', 'COMMISSIONING', 'HANDOVER'],
  triggers: [{ kind: 'CONTINUOUS' }, { kind: 'EVENT', eventType: 'RFI_ANSWERED' }],
  inputs: ['RFIs', 'Site diaries', 'Instructions', 'Change requests', 'Variations'],
  outputs: ['Variation opportunities from site records', 'Unapproved exposure', 'Instruction traceability'],
  emits: ['CHANGE_REQUEST_SUBMITTED'],
  hitl: 'APPROVAL',
  confidenceFloor: 0.7,
  acuTier: 'MED',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT'] },
  mandate: {
    reads: ['CHANGE_VARIATION', 'DESIGN_INFORMATION', 'FIELD_EXECUTION'],
    proposes: [],
    approvers: ['QS', 'COMMERCIAL_MANAGER', 'PM'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const instructions = states(ctx, 'Instruction');
    const variations = states(ctx, 'Variation');
    if (instructions.length === 0) return empty;

    // An instruction with no variation against it is work being done on the
    // client's say-so with no route to being paid for it.
    const covered = new Set(variations.map((v) => String(v.instructionId ?? '')));
    const uncovered = instructions.filter((i) => i.status !== 'WITHDRAWN' && !covered.has(String(i.id)));
    if (uncovered.length === 0) return empty;

    return {
      findings: [
        finding(
          'change:instructions-without-variation',
          'URGENT',
          `${uncovered.length} instruction(s) have no variation raised against them.`,
          'Work instructed and not valued is work done for nothing. The time bar on most forms runs from the instruction, not from noticing it.',
          cite(ctx, 'Instruction', 'instruction with no variation'),
          0.85,
        ),
      ],
      proposals: [],
    };
  },
};

const paymentAgent: AgentDefinition = {
  name: 'payment',
  agentId: 'AGT-PAYMENT',
  // The final certificate and the second half of retention fall due long after
  // practical completion, and the statutory clock runs on both.
  division: 'DELIVERY',
  purpose: 'Watches the statutory payment clock and the notices that have to be served on it.',
  activeIn: ['CONSTRUCTION', 'COMMISSIONING', 'HANDOVER', 'OPERATIONS'],
  triggers: [{ kind: 'SCHEDULE', at: '06:00' }, { kind: 'EVENT', eventType: 'APPLICATION_SUBMITTED' }],
  inputs: ['Payment cycles', 'Applications', 'Certificates', 'Notices', 'Notice deadlines'],
  outputs: ['Notice validity checks', 'Deadline countdowns', 'Smash-and-grab risk', 'Application readiness'],
  emits: ['PAYMENT_NOTICE_ISSUED'],
  hitl: 'APPROVAL',
  confidenceFloor: 0.8,
  acuTier: 'MED',
  memory: { reads: ['PROJECT'], writes: ['PROJECT'] },
  mandate: {
    reads: ['PAYMENT_APPLICATIONS', 'CONTRACTS_CLAIMS'],
    proposes: [],
    approvers: ['QS', 'COMMERCIAL_MANAGER'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const deadlines = states(ctx, 'NoticeDeadline').filter((d) => d.status !== 'SERVED');
    if (deadlines.length === 0) return empty;

    const today = new Date().toISOString().slice(0, 10);
    const due = deadlines.filter((d) => String(d.dueOn ?? '') <= today);
    if (due.length === 0) return empty;

    return {
      findings: [
        finding(
          'payment:notice-overdue',
          'URGENT',
          `${due.length} payment notice deadline(s) have passed without a notice served.`,
          'Under the Construction Act a missing payment or pay-less notice makes the sum applied for the sum due. This is the exposure that becomes a smash-and-grab adjudication.',
          cite(ctx, 'NoticeDeadline', 'deadline passed, nothing served'),
          0.95,
        ),
      ],
      proposals: [],
    };
  },
};

const qualityAgent: AgentDefinition = {
  name: 'quality',
  agentId: 'AGT-QUALITY',
  // The defects liability period is the year in which defects actually appear,
  // and a repeating one is the cause worth finding.
  division: 'DELIVERY',
  purpose: 'Clusters defects to find the cause rather than logging them one at a time.',
  activeIn: ['CONSTRUCTION', 'COMMISSIONING', 'HANDOVER', 'OPERATIONS'],
  triggers: [{ kind: 'CONTINUOUS' }, { kind: 'EVENT', eventType: 'NCR_RAISED' }],
  inputs: ['Non-conformances', 'Defects', 'Quality inspections', 'Subcontracts'],
  outputs: ['Defect classification and clustering', 'Subcontractor quality scores', 'Specification hot spots'],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.6,
  acuTier: 'MED',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT', 'ORGANISATION'] },
  mandate: {
    reads: ['QUALITY_COMMISSIONING'],
    proposes: [],
    approvers: ['QAQC', 'PM', 'CONSTRUCTION_MANAGER'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const ncrs = states(ctx, 'NCR');
    if (ncrs.length < 3) return empty;

    // Three or more against one party is a pattern rather than three incidents,
    // and the response to a pattern is different from the response to an event.
    const byParty = new Map<string, number>();
    for (const n of ncrs) {
      const who = String(n.responsiblePartyId ?? n.subcontractId ?? '').trim();
      if (who) byParty.set(who, (byParty.get(who) ?? 0) + 1);
    }
    const repeat = [...byParty.entries()].filter(([, count]) => count >= 3);
    if (repeat.length === 0) return empty;

    return {
      findings: [
        finding(
          'quality:repeat-ncr',
          'ATTENTION',
          `${repeat.length} part(y/ies) carry three or more non-conformances: ${repeat.map(([w, c]) => `${w} (${c})`).join(', ')}.`,
          'Three from one party is a method or a competence problem, not three accidents. Closing them individually fixes none of it.',
          cite(ctx, 'NCR', 'non-conformance'),
          0.75,
        ),
      ],
      proposals: [],
    };
  },
};

const claimsAgent: AgentDefinition = {
  name: 'claims',
  agentId: 'AGT-CLAIMS',
  // A claim can be pursued for years after completion, and the chronology it
  // rests on gets harder to assemble every month nobody assembles it.
  division: 'DELIVERY',
  purpose: 'Assembles the chronology and evidence a delay claim stands or falls on.',
  activeIn: ['CONSTRUCTION', 'COMMISSIONING', 'HANDOVER', 'OPERATIONS'],
  triggers: [{ kind: 'EVENT', eventType: 'DELAYEVENT_RECORDED' }, { kind: 'ON_DEMAND' }],
  inputs: ['Delay events', 'Claims', 'Site diaries', 'Instructions', 'Programme baselines'],
  outputs: ['Evidence mapping and chronology', 'Delay attribution', 'Claim probability score'],
  emits: [],
  hitl: 'APPROVAL',
  confidenceFloor: 0.75,
  acuTier: 'PREMIUM',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT'] },
  mandate: {
    reads: ['CONTRACTS_CLAIMS', 'PROGRAMME_BASELINES', 'FIELD_EXECUTION'],
    proposes: [],
    approvers: ['COMMERCIAL_MANAGER', 'QS', 'PROJECT_DIRECTOR'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const delays = states(ctx, 'DelayEvent');
    const diaries = states(ctx, 'SiteDiary');
    if (delays.length === 0) return empty;

    // A delay event with no diary on the day it happened has no contemporaneous
    // record, which is the first thing the other side asks for.
    const days = new Set(diaries.map((d) => String(d.diaryDate ?? '').slice(0, 10)));
    const unevidenced = delays.filter((d) => {
      const when = String(d.startedOn ?? d.occurredOn ?? '').slice(0, 10);
      return when && !days.has(when);
    });
    if (unevidenced.length === 0) return empty;

    return {
      findings: [
        finding(
          'claims:no-contemporaneous-record',
          'URGENT',
          `${unevidenced.length} delay event(s) have no site diary on the day they occurred.`,
          'A delay claim rests on the contemporaneous record. Reconstructing it afterwards is what turns a good entitlement into a settled one.',
          cite(ctx, 'DelayEvent', 'delay event'),
          0.85,
        ),
      ],
      proposals: [],
    };
  },
};

// ── Commissioning and handover ──────────────────────────────────────────────

const commissioningAgent: AgentDefinition = {
  name: 'commissioning',
  agentId: 'AGT-COMMISSIONING',
  division: 'DELIVERY',
  purpose: 'Scores each system for readiness and finds the test sequence conflicts before the witness turns up.',
  activeIn: ['CONSTRUCTION', 'COMMISSIONING', 'HANDOVER'],
  triggers: [{ kind: 'CONTINUOUS' }, { kind: 'EVENT', eventType: 'TEST_PACK_REQUIRED' }],
  inputs: ['System nodes', 'Test packs', 'Pre-functional checks', 'Functional tests'],
  outputs: ['Readiness score per system', 'Test-sequence conflicts', 'Witness schedule'],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.6,
  acuTier: 'MED',
  memory: { reads: ['PROJECT', 'ASSET'], writes: ['PROJECT'] },
  mandate: {
    reads: ['QUALITY_COMMISSIONING'],
    proposes: [],
    approvers: ['QAQC', 'PM', 'CONSTRUCTION_MANAGER', 'FM'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const systems = states(ctx, 'SystemNode');
    const packs = states(ctx, 'TestPack');
    if (systems.length === 0) return empty;

    const covered = new Set(packs.map((p) => String(p.systemId ?? '')));
    const uncovered = systems.filter((s) => !covered.has(String(s.id)));
    if (uncovered.length === 0) return empty;

    return {
      findings: [
        finding(
          'commissioning:systems-without-packs',
          'ATTENTION',
          `${uncovered.length} of ${systems.length} system(s) have no test pack.`,
          'A system with no test pack cannot be witnessed, cannot be accepted, and will be found at the completion inspection rather than before it.',
          cite(ctx, 'SystemNode', 'system with no test pack'),
          0.8,
        ),
      ],
      proposals: [],
    };
  },
};

const omChaseAgent: AgentDefinition = {
  name: 'om-chase',
  agentId: 'AGT-OM-CHASE',
  division: 'DELIVERY',
  purpose: 'Tracks O&M completeness per package and names who owes what.',
  activeIn: ['COMMISSIONING', 'HANDOVER', 'OPERATIONS'],
  triggers: [{ kind: 'SCHEDULE', at: '08:00', days: [1] }, { kind: 'CONTINUOUS' }],
  inputs: ['O&M manual structure', 'O&M manuals', 'Warranties', 'Subcontracts'],
  outputs: ['Per-package O&M completeness', 'Chase list', 'Warranty register'],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.55,
  acuTier: 'LOW',
  memory: { reads: ['PROJECT', 'ASSET'], writes: ['PROJECT'] },
  mandate: {
    reads: ['HANDOVER_OM'],
    proposes: [],
    approvers: ['FM', 'PM', 'QAQC'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const structure = states(ctx, 'OMManualStructure').at(-1);
    const manuals = states(ctx, 'OMManual');
    if (!structure) return empty;

    const required = (structure.sections as Array<Record<string, unknown>> | undefined) ?? [];
    const held = new Set(manuals.map((m) => String(m.sectionId ?? m.section ?? '')));
    const outstanding = required.filter((s) => !held.has(String(s.id ?? s.name ?? '')));
    if (outstanding.length === 0) return empty;

    return {
      findings: [
        finding(
          'om-chase:sections-outstanding',
          'ATTENTION',
          `${outstanding.length} of ${required.length} O&M section(s) have nothing against them.`,
          'The O&M is assembled from what subcontractors owe, and they are hardest to reach after their final account is settled. Chase before, not after.',
          cite(ctx, 'OMManual', 'O&M content held'),
          0.75,
        ),
      ],
      proposals: [],
    };
  },
};

const cobieAgent: AgentDefinition = {
  name: 'cobie',
  agentId: 'AGT-COBIE',
  division: 'DELIVERY',
  purpose: 'Validates the asset exchange against the information requirements before it is handed over.',
  activeIn: ['HANDOVER', 'OPERATIONS'],
  triggers: [{ kind: 'EVENT', eventType: 'ASSET_EXCHANGE_EXPORTED' }, { kind: 'ON_DEMAND' }],
  inputs: ['Asset exchanges', 'Asset validations', 'Asset register', 'Handover requirements'],
  outputs: ['Validation report', 'Gap list with fixes', 'Exchange conformance score'],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.65,
  acuTier: 'MED',
  memory: { reads: ['PROJECT', 'ASSET'], writes: ['ASSET'] },
  mandate: {
    reads: ['HANDOVER_OM', 'BIM_TWIN'],
    proposes: [],
    approvers: ['FM', 'BIM', 'PM'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const validations = states(ctx, 'AssetValidation');
    const validation = validations.at(-1);
    if (!validation) return empty;

    const failures = Number(validation.failureCount ?? ((validation.failures as unknown[] | undefined) ?? []).length);
    if (failures === 0) return empty;

    return {
      findings: [
        finding(
          'cobie:validation-failures',
          'URGENT',
          `The latest asset exchange validation carries ${failures} failure(s).`,
          'An exchange that fails validation is handed to an operator whose system will reject it, and the fix costs more once the delivery team has demobilised.',
          cite(ctx, 'AssetValidation', 'validation run'),
          0.85,
        ),
      ],
      proposals: [],
    };
  },
};

const pcReadinessAgent: AgentDefinition = {
  name: 'pc-readiness',
  agentId: 'AGT-PC-READINESS',
  division: 'DELIVERY',
  purpose: 'States whether practical completion can honestly be certified, and what is blocking it.',
  activeIn: ['COMMISSIONING', 'HANDOVER'],
  triggers: [{ kind: 'CONTINUOUS' }, { kind: 'ON_DEMAND' }],
  inputs: ['Completion readiness', 'Commissioning exceptions', 'Snags', 'Handover requirements'],
  outputs: ['PC readiness report with evidence bundle', 'Blocking-item list with owners'],
  emits: [],
  hitl: 'APPROVAL',
  confidenceFloor: 0.8,
  acuTier: 'HIGH',
  memory: { reads: ['PROJECT', 'ASSET'], writes: ['PROJECT'] },
  mandate: {
    reads: ['QUALITY_COMMISSIONING', 'HANDOVER_OM'],
    proposes: [],
    approvers: ['OWNER', 'PROJECT_DIRECTOR', 'PM'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const exceptions = states(ctx, 'CommissioningException').filter((e) => e.status !== 'CLOSED');
    const snags = states(ctx, 'Snag').filter((s) => s.status !== 'CLOSED');
    if (exceptions.length === 0 && snags.length === 0) return empty;

    return {
      findings: [
        finding(
          'pc-readiness:open-items',
          'URGENT',
          `${exceptions.length} commissioning exception(s) and ${snags.length} snag(s) are open.`,
          'Certifying practical completion over open items transfers them to the defects period, where the contractor is off site and the client owns the coordination.',
          [...cite(ctx, 'CommissioningException', 'open exception', 3), ...cite(ctx, 'Snag', 'open snag', 3)],
          0.9,
        ),
      ],
      proposals: [],
    };
  },
};

const goldenThreadAgent: AgentDefinition = {
  name: 'golden-thread',
  agentId: 'AGT-GOLDEN-THREAD',
  division: 'COMPLIANCE',
  purpose: 'Checks the safety information a building must be handed over with is present, current and consistent.',
  activeIn: 'ANY',
  triggers: [{ kind: 'CONTINUOUS' }, { kind: 'SCHEDULE', at: '05:30' }],
  inputs: ['Golden thread transfers', 'Regulatory packs', 'CDM documents', 'As-built sets'],
  outputs: ['Missing, conflicting or outdated safety information', 'Gateway readiness', 'Transfer manifest'],
  emits: [],
  hitl: 'APPROVAL',
  confidenceFloor: 0.85,
  acuTier: 'PREMIUM',
  memory: { reads: ['PROJECT', 'ASSET', 'ORGANISATION'], writes: ['PROJECT'] },
  mandate: {
    reads: ['EVIDENCE_AUDIT', 'SAFETY_RAMS', 'HANDOVER_OM'],
    proposes: [],
    approvers: ['OWNER', 'SAFETY', 'PROJECT_DIRECTOR'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const documents = states(ctx, 'CDMDocument');
    if (documents.length === 0) return empty;

    // A document drafted and never approved is not in force. Under CDM the
    // distinction is the whole point of the document.
    const unapproved = documents.filter((d) => d.status !== 'APPROVED');
    if (unapproved.length === 0) return empty;

    return {
      findings: [
        finding(
          'golden-thread:unapproved-documents',
          'URGENT',
          `${unapproved.length} safety document(s) are drafted and not approved.`,
          'A method statement or plan that nobody has approved is not a control. Under CDM and the Building Safety Act the approval is what puts it in force.',
          cite(ctx, 'CDMDocument', 'drafted, not approved'),
          0.95,
        ),
      ],
      proposals: [],
    };
  },
};

const fmAssetAgent: AgentDefinition = {
  name: 'fm-asset',
  agentId: 'AGT-FM-ASSET',
  division: 'DELIVERY',
  purpose: 'Watches the operating asset for readings outside their declared bounds.',
  activeIn: ['OPERATIONS'],
  triggers: [{ kind: 'EVENT', eventType: 'SENSOR_READING_INGESTED' }, { kind: 'SCHEDULE', at: '04:00' }],
  inputs: ['Sensor readings', 'Asset register', 'Maintenance forecast', 'Operating cost'],
  outputs: ['Readings outside bounds', 'Assets with no maintenance forecast'],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.6,
  acuTier: 'MED',
  memory: { reads: ['ASSET', 'ORGANISATION'], writes: ['ASSET'] },
  mandate: {
    reads: ['HANDOVER_OM'],
    proposes: [],
    approvers: ['FM', 'OWNER'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const assets = states(ctx, 'AssetRegisterItem');
    const forecasts = states(ctx, 'MaintenanceForecast');
    if (assets.length === 0) return empty;

    const forecast = new Set(forecasts.map((f) => String(f.assetId ?? '')));
    const unforecast = assets.filter((a) => !forecast.has(String(a.id)));
    if (unforecast.length === 0) return empty;

    return {
      findings: [
        finding(
          'fm-asset:no-maintenance-forecast',
          'ATTENTION',
          `${unforecast.length} of ${assets.length} asset(s) have no maintenance forecast.`,
          'An asset with no forecast is one whose replacement lands as an unbudgeted cost in the year it fails.',
          cite(ctx, 'AssetRegisterItem', 'asset with no forecast'),
          0.7,
        ),
      ],
      proposals: [],
    };
  },
};

const lessonsAgent: AgentDefinition = {
  name: 'lessons',
  agentId: 'AGT-LESSONS',
  division: 'DELIVERY',
  purpose: 'Turns what this job learned into something the next one is told.',
  activeIn: 'ANY',
  triggers: [{ kind: 'SCHEDULE', at: '09:00', days: [5] }, { kind: 'EVENT', eventType: 'LESSON_CAPTURED' }],
  inputs: ['Lessons learned', 'Non-conformances', 'Variations', 'Delay events'],
  outputs: ['Structured lessons into organisation memory', 'Rate and productivity feedback', 'Supplier performance'],
  emits: ['LESSON_CAPTURED'],
  hitl: 'REVIEW',
  confidenceFloor: 0.55,
  acuTier: 'MED',
  // The one agent that writes organisation memory, and the reason read and
  // write are separate on the contract: what it writes is what every future
  // project on every other job will be told.
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['ORGANISATION'] },
  mandate: {
    reads: ['EVIDENCE_AUDIT', 'CHANGE_VARIATION', 'QUALITY_COMMISSIONING'],
    proposes: [],
    approvers: ['PM', 'PROJECT_DIRECTOR', 'OWNER'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const lessons = states(ctx, 'LessonLearned');
    const ncrs = states(ctx, 'NCR');
    const variations = states(ctx, 'Variation');
    const material = ncrs.length + variations.length;
    if (material < 5 || lessons.length > 0) return empty;

    return {
      findings: [
        finding(
          'lessons:nothing-captured',
          'ATTENTION',
          `${material} non-conformance(s) and variation(s) are recorded and no lesson has been captured.`,
          'The cost of learning this was already paid. Not writing it down means paying it again on the next job.',
          [...cite(ctx, 'NCR', 'non-conformance', 3), ...cite(ctx, 'Variation', 'variation', 3)],
          0.7,
        ),
      ],
      proposals: [],
    };
  },
};

/**
 * The lifecycle fleet, in stage order.
 *
 * Ordered by when they run rather than by division, because that is how the
 * manifest is read: somebody asking "what watches my project right now" wants
 * the answer grouped by where the project is.
 */
export const LIFECYCLE_AGENTS: AgentDefinition[] = [
  feasibilityAgent,
  benchCostAgent,
  consentsAgent,
  carbonAgent,
  conceptRiskAgent,
  scopeGapAgent,
  specIntelAgent,
  costPlanAgent,
  bimTwinAgent,
  designRiskAgent,
  tenderIntelAgent,
  ittRegisterAgent,
  returnIntelAgent,
  contractRiskAgent,
  bidProgrammeAgent,
  changeAgent,
  paymentAgent,
  qualityAgent,
  claimsAgent,
  commissioningAgent,
  omChaseAgent,
  cobieAgent,
  pcReadinessAgent,
  goldenThreadAgent,
  fmAssetAgent,
  lessonsAgent,
];
