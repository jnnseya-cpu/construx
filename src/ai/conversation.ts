import { config } from '../config.ts';
import type { EngineContext } from '../engines/context.ts';
import { currentPhase } from '../engines/context.ts';
import { evaluateAccess } from '../identity/abac.ts';
import type { CapabilityArea, Role } from '../identity/roles.ts';
import { accountLayerFor } from '../identity/roles.ts';
import type { LifecyclePhase } from '../lifecycle/phases.ts';
import type { Engine } from './orchestrator.ts';

/**
 * The conversational front door.
 *
 * Three layers of AI operate in the platform, and this is the second:
 *   1. Guided workflow AI — engines invoked from a specific screen or command.
 *   2. Conversational copilot — this module. Interprets a question, routes it to
 *      the right engine, and answers from project state.
 *   3. Grounded knowledge — retrieval over the project's own documents.
 *
 * Two rules make this safe. The copilot answers from materialised Golden Thread
 * state, never from the model's memory of construction generally. And it never
 * performs a state change on its own: it proposes the command, the user runs it.
 */

export type ConversationIntent = {
  engine: Engine;
  capabilityArea: CapabilityArea;
  taskType: string;
  /** Confidence that this intent matches what was asked. */
  match: number;
  /** Suggested command, if the request implies an action rather than a question. */
  suggestedCommand?: string;
};

type IntentRule = {
  engine: Engine;
  capabilityArea: CapabilityArea;
  taskType: string;
  /** Terms that indicate this intent; matched case-insensitively as whole words. */
  terms: string[];
  /** Phase where this intent is most likely, used to break ties. */
  phases?: LifecyclePhase[];
  suggestedCommand?: string;
};

const INTENT_RULES: IntentRule[] = [
  {
    engine: 'TENDER',
    capabilityArea: 'BOQ_TAKEOFF',
    taskType: 'quantity_extraction',
    terms: ['takeoff', 'take-off', 'quantities', 'measure', 'boq', 'bill of quantities', 'quantity'],
    phases: ['DESIGN', 'TENDER'],
    suggestedCommand: 'tender:runTakeoff',
  },
  {
    engine: 'TENDER',
    capabilityArea: 'ESTIMATE_TENDER',
    taskType: 'estimating',
    terms: ['estimate', 'price', 'pricing', 'rate', 'tender sum', 'bid price', 'cost plan'],
    phases: ['TENDER'],
    suggestedCommand: 'tender:buildEstimate',
  },
  {
    engine: 'TENDER',
    capabilityArea: 'PROCUREMENT_AWARD',
    taskType: 'bid_evaluation',
    terms: ['bid', 'bids', 'tender return', 'evaluate', 'compare', 'adjudicate', 'award', 'supplier', 'subcontractor selection'],
    phases: ['TENDER'],
    suggestedCommand: 'tender:evaluateSubmissions',
  },
  {
    engine: 'PLANNING',
    capabilityArea: 'PROGRAMME_BASELINES',
    taskType: 'programme_analysis',
    terms: ['programme', 'schedule', 'critical path', 'cpm', 'float', 'baseline', 'milestone', 'sequence'],
    suggestedCommand: 'planning:recalculateProgramme',
  },
  {
    engine: 'PLANNING',
    capabilityArea: 'PROGRAMME_BASELINES',
    taskType: 'delay_risk_forecast',
    terms: ['delay', 'late', 'slippage', 'behind', 'recovery', 'catch up', 'overrun'],
    phases: ['CONSTRUCTION'],
    suggestedCommand: 'planning:forecastDelay',
  },
  {
    engine: 'RESOURCE_COST',
    capabilityArea: 'BUDGET_COST',
    taskType: 'cost_performance',
    terms: ['cost', 'budget', 'margin', 'cvr', 'evm', 'earned value', 'cpi', 'spi', 'forecast final', 'profit', 'overspend'],
    suggestedCommand: 'cost:publishCVR',
  },
  {
    engine: 'RESOURCE_COST',
    capabilityArea: 'PAYMENT_APPLICATIONS',
    taskType: 'payment_position',
    terms: ['payment', 'application', 'valuation', 'certificate', 'pay less', 'notice', 'cash', 'invoice', 'retention'],
    suggestedCommand: 'cost:noticePosition',
  },
  {
    engine: 'RISK_SAFETY',
    capabilityArea: 'RISK_REGISTER',
    taskType: 'risk_assessment',
    terms: ['risk', 'contingency', 'exposure', 'mitigation', 'probability', 'threat'],
    suggestedCommand: 'safety:assessContingency',
  },
  {
    engine: 'RISK_SAFETY',
    capabilityArea: 'SAFETY_RAMS',
    taskType: 'safety_analysis',
    terms: ['safety', 'safe', 'rams', 'hazard', 'incident', 'near miss', 'ppe', 'method statement', 'accident', 'harm'],
    suggestedCommand: 'safety:forecastSafetyRisk',
  },
  {
    engine: 'BIM_TWIN',
    capabilityArea: 'BIM_TWIN',
    taskType: 'model_analysis',
    terms: ['bim', 'model', 'clash', 'ifc', 'twin', 'as-built', 'as built', '3d', '4d'],
    suggestedCommand: 'bim:detectClashes',
  },
  {
    engine: 'BIM_TWIN',
    capabilityArea: 'DESIGN_INFORMATION',
    taskType: 'drawing_control',
    terms: ['drawing', 'revision', 'superseded', 'markup', 'sheet', 'rfi', 'title block'],
    suggestedCommand: 'bim:registerDrawing',
  },
  {
    engine: 'CONTRACTS_CLAIMS',
    capabilityArea: 'CHANGE_VARIATION',
    taskType: 'change_control',
    terms: ['variation', 'change', 'instruction', 'cci', 'rfc', 'compensation event', 'extra'],
    suggestedCommand: 'claims:submitChangeRequest',
  },
  {
    engine: 'CONTRACTS_CLAIMS',
    capabilityArea: 'CONTRACTS_CLAIMS',
    taskType: 'claim_assessment',
    terms: ['claim', 'entitlement', 'eot', 'extension of time', 'dispute', 'prolongation', 'loss and expense', 'contract', 'clause'],
    suggestedCommand: 'claims:assessDelayClaim',
  },
  {
    engine: 'HANDOVER_OM',
    capabilityArea: 'HANDOVER_OM',
    taskType: 'handover_operations',
    terms: ['handover', 'o&m', 'asset', 'maintenance', 'defect', 'warranty', 'snag', 'commissioning', 'fm', 'operate'],
    phases: ['COMMISSIONING', 'HANDOVER', 'OPERATIONS'],
    suggestedCommand: 'handover:compileHandoverPack',
  },
  {
    engine: 'EXECUTIVE',
    capabilityArea: 'PROJECT_SETUP',
    taskType: 'executive_briefing',
    terms: ['status', 'summary', 'overview', 'dashboard', 'portfolio', 'briefing', 'health check'],
    suggestedCommand: 'executive:projectBriefing',
  },
];

function tokenise(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9&\s-]/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * Classify a natural-language request. Deterministic term matching, weighted by
 * the project's current phase — a question about "programme" during O&M means
 * something different from the same word during construction.
 */
export function classifyIntent(question: string, phase?: LifecyclePhase): ConversationIntent[] {
  const tokens = tokenise(question);
  const normalised = ` ${tokens.join(' ')} `;

  const scored: ConversationIntent[] = [];

  for (const rule of INTENT_RULES) {
    let hits = 0;
    for (const term of rule.terms) {
      if (term.includes(' ')) {
        if (normalised.includes(` ${term} `)) hits += 2;
      } else if (tokens.includes(term)) {
        hits += 1;
      }
    }
    if (hits === 0) continue;

    // Phase relevance breaks ties between engines that share vocabulary.
    const phaseBonus = phase && rule.phases?.includes(phase) ? 0.5 : 0;
    scored.push({
      engine: rule.engine,
      capabilityArea: rule.capabilityArea,
      taskType: rule.taskType,
      match: Number(Math.min(1, (hits + phaseBonus) / 3).toFixed(3)),
      suggestedCommand: rule.suggestedCommand,
    });
  }

  return scored.sort((a, b) => b.match - a.match).slice(0, 3);
}

export type ConversationAnswer = {
  question: string;
  intent?: ConversationIntent;
  /** Alternative readings, so the user can redirect a misclassification. */
  alternatives: ConversationIntent[];
  answer: string;
  /** Facts drawn from project state that ground the answer. */
  grounding: Array<{ label: string; value: string; source: string }>;
  /** Actions the user can take next. The copilot proposes; it does not execute. */
  suggestedActions: Array<{ command: string; description: string; permitted: boolean; reason?: string }>;
  /** Tools available to this user in this context — the context-aware tool router. */
  availableTools: string[];
  acuConsumed: number;
};

/**
 * Answer a question about the project.
 *
 * Grounding comes first: the copilot reads current state, and only then decides
 * what to say. If the project has no data on the subject, it says so rather
 * than producing a plausible answer from general construction knowledge.
 */
export function ask(ctx: EngineContext, question: string): ConversationAnswer {
  const phase = currentPhase(ctx);
  const intents = classifyIntent(question, phase);
  const intent = intents[0];

  const grounding = gatherGrounding(ctx, intent?.engine, phase);
  const availableTools = toolsFor(ctx, phase);

  const suggestedActions = intents
    .filter((candidate) => candidate.suggestedCommand !== undefined)
    .map((candidate) => {
      const decision = evaluateAccess(
        ctx.auth,
        candidate.capabilityArea,
        'X',
        { tenantId: ctx.tenantId, projectId: ctx.projectId, lifecyclePhase: phase },
        { rbacEnabled: config.authz.rbac, scopesEnabled: config.authz.scopes, abacEnabled: config.authz.abac },
      );
      return {
        command: candidate.suggestedCommand as string,
        description: `${candidate.engine} engine — ${candidate.taskType.replace(/_/g, ' ')}`,
        permitted: decision.decision === 'ALLOW',
        reason: decision.decision === 'ALLOW' ? undefined : decision.reason,
      };
    });

  return {
    question,
    intent,
    alternatives: intents.slice(1),
    answer: compose(question, intent, grounding, phase, ctx.auth.roles),
    grounding,
    suggestedActions,
    // Answering from state costs nothing: no provider is called. An ACU charge
    // only arises when the user runs one of the suggested engine commands.
    acuConsumed: 0,
    availableTools,
  };
}

/** Read the project facts relevant to the identified engine. */
function gatherGrounding(
  ctx: EngineContext,
  engine: Engine | undefined,
  phase: LifecyclePhase | undefined,
): Array<{ label: string; value: string; source: string }> {
  const facts: Array<{ label: string; value: string; source: string }> = [];
  const project = ctx.ledger.get({ refType: 'Project', refId: ctx.projectId });

  if (project) {
    facts.push({ label: 'Project', value: String(project.state.name), source: 'Project' });
    facts.push({ label: 'Lifecycle phase', value: phase ?? 'unknown', source: 'Project' });
  }

  const count = (refType: string): number => ctx.ledger.list(ctx.projectId, refType).length;
  const latest = (refType: string): Record<string, unknown> | undefined => {
    const records = ctx.ledger.list(ctx.projectId, refType);
    return records[records.length - 1]?.state;
  };

  switch (engine) {
    case 'TENDER': {
      const estimate = latest('Estimate');
      if (estimate) {
        facts.push({ label: 'Latest estimate', value: `${estimate.totalMinor} minor units (${String(estimate.status)})`, source: 'Estimate' });
      }
      facts.push({ label: 'BoQ items', value: String(count('BoQItem')), source: 'BoQItem' });
      facts.push({ label: 'Supplier submissions', value: String(count('SupplierSubmission')), source: 'SupplierSubmission' });
      const evaluation = latest('BidEvaluation');
      if (evaluation) facts.push({ label: 'Bid recommendation', value: String(evaluation.recommendation), source: 'BidEvaluation' });
      break;
    }
    case 'PLANNING': {
      const baseline = latest('ProgrammeBaseline');
      if (baseline) {
        facts.push({ label: 'Programme duration', value: `${String(baseline.durationDays ?? baseline.projectDurationDays)} days`, source: 'ProgrammeBaseline' });
      }
      facts.push({ label: 'Activities', value: String(count('Task')), source: 'Task' });
      const delay = latest('DelayRiskSnapshot');
      if (delay) {
        facts.push({
          label: 'Forecast delay',
          value: `${String(delay.expectedDelayDays)} days expected, ${String(delay.severity)} severity`,
          source: 'DelayRiskSnapshot',
        });
      }
      break;
    }
    case 'RESOURCE_COST': {
      const cvr = latest('CVR');
      if (cvr) {
        facts.push({ label: 'Forecast margin', value: `${String(cvr.forecastMarginPercent)}%`, source: 'CVR' });
        facts.push({ label: 'Margin erosion', value: `${String(cvr.marginErosionPercent)} points`, source: 'CVR' });
      }
      const evm = latest('EarnedValueSnapshot');
      if (evm) {
        facts.push({ label: 'CPI / SPI', value: `${String(evm.costPerformanceIndex)} / ${String(evm.schedulePerformanceIndex)}`, source: 'EarnedValueSnapshot' });
      }
      break;
    }
    case 'RISK_SAFETY': {
      facts.push({ label: 'Open risks', value: String(count('RiskRegisterItem')), source: 'RiskRegisterItem' });
      const forecast = latest('SafetyForecast');
      if (forecast) {
        facts.push({ label: 'Safety risk index', value: `${String(forecast.riskIndex)} (${String(forecast.severity)})`, source: 'SafetyForecast' });
      }
      facts.push({ label: 'Approved RAMS', value: String(ctx.ledger.list(ctx.projectId, 'RAMS').filter((r) => r.state.status === 'APPROVED').length), source: 'RAMS' });
      break;
    }
    case 'BIM_TWIN': {
      facts.push({ label: 'Models ingested', value: String(count('Model')), source: 'Model' });
      facts.push({ label: 'Open clashes', value: String(ctx.ledger.list(ctx.projectId, 'Clash').filter((c) => c.state.status === 'OPEN').length), source: 'Clash' });
      facts.push({ label: 'Current drawings', value: String(ctx.ledger.list(ctx.projectId, 'Drawing').filter((d) => d.state.status === 'CURRENT').length), source: 'Drawing' });
      break;
    }
    case 'CONTRACTS_CLAIMS': {
      facts.push({ label: 'Variations', value: String(count('Variation')), source: 'Variation' });
      facts.push({ label: 'Delay events', value: String(count('DelayEvent')), source: 'DelayEvent' });
      const claim = latest('Claim');
      if (claim) {
        facts.push({
          label: 'Latest claim',
          value: `${String(claim.assessedDays)} days assessed, entitlement score ${String(claim.entitlementScore)}`,
          source: 'Claim',
        });
      }
      break;
    }
    case 'HANDOVER_OM': {
      facts.push({ label: 'Registered assets', value: String(count('AssetRegisterItem')), source: 'AssetRegisterItem' });
      facts.push({ label: 'Open defects', value: String(ctx.ledger.list(ctx.projectId, 'Defect').filter((d) => d.state.status !== 'CLOSED').length), source: 'Defect' });
      const pack = latest('HandoverPack');
      if (pack) facts.push({ label: 'Handover completeness', value: `${String(pack.completeness)}`, source: 'HandoverPack' });
      break;
    }
    default: {
      facts.push({ label: 'Golden Thread events', value: String(ctx.ledger.events({ projectId: ctx.projectId }).length), source: 'Ledger' });
      facts.push({ label: 'Open risks', value: String(count('RiskRegisterItem')), source: 'RiskRegisterItem' });
      facts.push({ label: 'Variations', value: String(count('Variation')), source: 'Variation' });
    }
  }

  return facts;
}

function compose(
  question: string,
  intent: ConversationIntent | undefined,
  grounding: Array<{ label: string; value: string; source: string }>,
  phase: LifecyclePhase | undefined,
  roles: Role[],
): string {
  if (!intent) {
    return (
      `I could not match "${question}" to one of the seven engines. ` +
      `Try naming what you need — programme, cost, risk, safety, bid comparison, variation, claim, model, or handover. ` +
      `The project is currently in the ${phase ?? 'unknown'} phase.`
    );
  }

  const substantive = grounding.filter((f) => f.label !== 'Project' && f.label !== 'Lifecycle phase' && f.value !== '0');

  if (substantive.length === 0) {
    return (
      `This is a question for the ${intent.engine} engine, but the project holds no ${intent.taskType.replace(/_/g, ' ')} data yet. ` +
      `Rather than answer from general construction knowledge, I'd rather tell you the record is empty. ` +
      `${intent.suggestedCommand ? `Run ${intent.suggestedCommand} to produce it.` : ''}`
    );
  }

  const layer = accountLayerFor(roles);
  const lead =
    layer === 'PLATFORM_ADMIN'
      ? 'From the platform view (delivery detail is withheld from operator accounts):'
      : `From the ${intent.engine} engine, reading current project state:`;

  return `${lead}\n${substantive.map((f) => `  • ${f.label}: ${f.value} [${f.source}]`).join('\n')}`;
}

/**
 * Context-aware tool loading: surface only the tools that make sense for this
 * user, in this role, at this point in the lifecycle.
 */
function toolsFor(ctx: EngineContext, phase: LifecyclePhase | undefined): string[] {
  const byPhase: Record<LifecyclePhase, string[]> = {
    CONCEPT: ['structure:createScopePackage', 'structure:assessDesignMaturity', 'executive:projectBriefing'],
    DESIGN: ['bim:registerDrawing', 'bim:ingestModel', 'bim:detectClashes', 'structure:assessDesignMaturity', 'tender:runTakeoff'],
    TENDER: ['tender:runTakeoff', 'tender:buildEstimate', 'tender:composeTenderPackage', 'procurement:createRFQ', 'tender:evaluateSubmissions', 'tender:adjudicate', 'tender:compileBidPack'],
    CONSTRUCTION: ['planning:recalculateProgramme', 'planning:forecastDelay', 'planning:recordProgress', 'cost:publishCVR', 'cost:submitApplication', 'safety:draftRAMS', 'safety:logSafetyObservation', 'claims:submitChangeRequest', 'bim:updateTwinFromSite'],
    COMMISSIONING: ['handover:recordCommissioningTest', 'handover:raiseSnag', 'handover:dispatchSnags', 'bim:generateAsBuilt'],
    HANDOVER: ['handover:compileHandoverPack', 'handover:registerAsset', 'handover:publishOMManual', 'handover:registerWarranty'],
    OPERATIONS: ['handover:raiseDefect', 'handover:raiseWorkOrder', 'handover:forecastMaintenance', 'audit:replay'],
  };

  const candidates = phase ? (byPhase[phase] ?? []) : [];
  const always = ['audit:replay', 'billing:walletStatus'];

  const areaOfTool: Record<string, CapabilityArea> = {
    structure: 'PROJECT_SETUP',
    tender: 'ESTIMATE_TENDER',
    procurement: 'PROCUREMENT_AWARD',
    planning: 'PROGRAMME_BASELINES',
    cost: 'BUDGET_COST',
    safety: 'SAFETY_RAMS',
    bim: 'BIM_TWIN',
    claims: 'CONTRACTS_CLAIMS',
    handover: 'HANDOVER_OM',
    audit: 'EVIDENCE_AUDIT',
    billing: 'BILLING_ACU',
    executive: 'PROJECT_SETUP',
  };

  return [...new Set([...candidates, ...always])].filter((tool) => {
    const area = areaOfTool[tool.split(':')[0] ?? ''];
    if (!area) return false;
    const decision = evaluateAccess(
      ctx.auth,
      area,
      'R',
      { tenantId: ctx.tenantId, projectId: ctx.projectId, lifecyclePhase: phase },
      { rbacEnabled: config.authz.rbac, scopesEnabled: config.authz.scopes, abacEnabled: config.authz.abac },
    );
    return decision.decision !== 'DENY';
  });
}
