import { config } from '../config.ts';
import { abbreviateMoney } from '../domain/locale.ts';
import type { EngineContext } from '../engines/context.ts';
import { currentPhase } from '../engines/context.ts';
import { evaluateAccess } from '../identity/abac.ts';
import { classifyEntity } from '../identity/entityAccess.ts';
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

  // --- The workface --------------------------------------------------------
  //
  // Three rules, and until they existed the copilot could not be asked a
  // question by the person the platform is hardest to reach. Everything above
  // is a question somebody asks at a desk: the estimate, the cash position, the
  // clash list. A person standing at the work asks whether a permit is open,
  // who is inducted, what the ITP says about this pour, and what the diary
  // recorded yesterday — and every one of those fell through to "try naming
  // what you need", which is the platform telling a site manager to rephrase.
  //
  // They route to engines that already exist rather than adding an eighth. A
  // site record is the planning engine's subject; permits and briefings are the
  // safety engine's. What is new is the grounding: `gatherGrounding` reads the
  // registers a workface question is answered from, which nothing did.
  {
    engine: 'PLANNING',
    capabilityArea: 'FIELD_EXECUTION',
    taskType: 'site_record',
    terms: ['diary', 'daily log', 'log', 'shift', 'labour', 'plant', 'delivery', 'deliveries', 'site record', 'workface', 'lookahead', 'promise', 'ppc', 'yesterday', 'today'],
    phases: ['CONSTRUCTION', 'COMMISSIONING'],
    suggestedCommand: 'planning:recordSiteDiary',
  },
  {
    engine: 'RISK_SAFETY',
    capabilityArea: 'SAFETY_RAMS',
    taskType: 'permit_and_briefing',
    terms: ['permit', 'permit to work', 'ptw', 'induction', 'inducted', 'toolbox', 'toolbox talk', 'briefing', 'briefed', 'competency', 'ticket', 'confined space', 'hot work', 'excavation', 'lifting'],
    phases: ['CONSTRUCTION', 'COMMISSIONING'],
    suggestedCommand: 'safety:issuePermit',
  },
  {
    engine: 'RISK_SAFETY',
    capabilityArea: 'QUALITY_COMMISSIONING',
    taskType: 'quality_control',
    terms: ['itp', 'inspection', 'inspect', 'hold point', 'witness point', 'ncr', 'non-conformance', 'nonconformance', 'snag', 'pour', 'test'],
    phases: ['CONSTRUCTION', 'COMMISSIONING'],
    // No suggested command, deliberately. "What does the ITP say about this
    // pour" is answered, not actioned, and offering `raiseNCR` beside the
    // answer would suggest the question implied a failure.
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
    // Each token scores once for a rule however many of the rule's terms it
    // matches. Without this a rule listing both `bid` and `bids` scored twice
    // for one word, which is a tiebreak decided by how a term list was written.
    const counted = new Set<string>();

    for (const term of rule.terms) {
      if (term.includes(' ')) {
        // Plural on the phrase as well as the word. "Hold points not released"
        // is how anybody asks about hold points, and the term is written
        // singular — so the phrase that matters most on a quality question
        // matched nothing at all.
        const phrase = normalised.includes(` ${term} `)
          ? term
          : normalised.includes(` ${term}s `)
            ? `${term}s`
            : undefined;
        if (phrase && !counted.has(phrase)) {
          counted.add(phrase);
          hits += 2;
        }
        continue;
      }

      // A register is spoken about in the plural as often as the singular.
      // "Are there any permits open" is the same question as "is there a permit
      // open", and `hold points` is how anybody refers to them — both matched
      // nothing at all, because the terms are written singular and the match
      // was exact. Listing every plural is a rule nobody would maintain; this is
      // a trailing `s`, which is the whole of the problem in English for the
      // vocabulary this platform uses.
      const matched = tokens.includes(term) ? term : tokens.includes(`${term}s`) ? `${term}s` : undefined;
      if (matched && !counted.has(matched)) {
        counted.add(matched);
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

/**
 * One fact the answer is grounded in, and where it came from.
 *
 * `source` is the register; `refId` is the record, where a single record is the
 * source. A count over a register has no `refId` and correctly carries none —
 * "eleven permits" is read from eleven records and pointing at one of them
 * would be a citation that does not support the claim. Where the fact *is* one
 * record — the last diary, this permit, that non-conformance — the id is there
 * so the answer can be opened rather than believed.
 */
export type GroundingFact = { label: string; value: string; source: string; refId?: string };

export type ConversationAnswer = {
  question: string;
  intent?: ConversationIntent;
  /** Alternative readings, so the user can redirect a misclassification. */
  alternatives: ConversationIntent[];
  answer: string;
  /**
   * How sure the copilot is that it understood *the question* — not the answer.
   *
   * The distinction matters and is easy to blur. Every figure below is
   * arithmetic over materialised state, so there is nothing to be unsure about
   * once the subject is settled; what can be wrong is which subject the question
   * was about. A low number here means "check I have read you right", never
   * "these figures are approximate". Absent where nothing matched at all.
   */
  confidence?: number;
  /** Facts drawn from project state that ground the answer. */
  grounding: GroundingFact[];
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

  const grounding = gatherGrounding(ctx, intent, phase);
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
    ...(intent ? { confidence: intent.match } : {}),
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
  intent: ConversationIntent | undefined,
  phase: LifecyclePhase | undefined,
): GroundingFact[] {
  const facts: GroundingFact[] = [];
  const engine = intent?.engine;
  const project = ctx.ledger.get({ refType: 'Project', refId: ctx.projectId });

  if (project) {
    facts.push({ label: 'Project', value: String(project.state.name), source: 'Project' });
    facts.push({ label: 'Lifecycle phase', value: phase ?? 'unknown', source: 'Project' });
  }

  const currency = String(project?.state.currency ?? 'GBP');

  /**
   * Money in the project's currency. The copilot quotes figures a person will
   * repeat in a meeting, and "224865000 minor units" is not one of them.
   */
  const gbp = (minor: number): string => abbreviateMoney(minor, currency);

  const count = (refType: string): number => ctx.ledger.list(ctx.projectId, refType).length;
  const latest = (refType: string): Record<string, unknown> | undefined => {
    const records = ctx.ledger.list(ctx.projectId, refType);
    return records[records.length - 1]?.state;
  };

  switch (engine) {
    case 'TENDER': {
      const estimate = latest('Estimate');
      if (estimate) {
        facts.push({ label: 'Latest estimate', value: `${gbp(Number(estimate.totalMinor))} (${String(estimate.status)})`, source: 'Estimate' });
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

      // Certified and paid come from the certificates and ledger entries, not
      // from what an application asked for — the difference is the answer to
      // "are we actually getting paid".
      const certificates = ctx.ledger.list(ctx.projectId, 'PaymentCertificate');
      if (certificates.length > 0) {
        const certified = certificates.reduce((sum, c) => sum + Number(c.state.certifiedMinor ?? 0), 0);
        const paid = ctx.ledger
          .list(ctx.projectId, 'LedgerEntry')
          .filter((e) => e.state.type === 'PAYMENT')
          .reduce((sum, e) => sum + Number(e.state.amountMinor ?? 0), 0);
        const withheld = certificates.reduce((sum, c) => sum + Number(c.state.withheldMinor ?? 0), 0);

        facts.push({ label: 'Certified to date', value: gbp(certified), source: 'PaymentCertificate' });
        facts.push({ label: 'Paid to date', value: gbp(paid), source: 'LedgerEntry' });
        if (certified > paid) {
          facts.push({ label: 'Outstanding against certificates', value: gbp(certified - paid), source: 'PaymentCertificate' });
        }
        if (withheld > 0) {
          facts.push({ label: 'Withheld on certification', value: gbp(withheld), source: 'PaymentCertificate' });
        }
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

  // --- The workface --------------------------------------------------------
  //
  // Keyed on the capability area rather than the engine, because two of the
  // three workface questions route to engines that already have a block above
  // and answer a different question inside it. The safety engine's block is
  // about the risk register and the safety forecast; somebody asking whether
  // they can start in the chamber wants the permit.
  //
  // These are the facts, not a register listing. `AGT-FIELD-ANSWERS` reports
  // which registers would come back empty; this answers out of them when they
  // are not.
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  if (intent?.capabilityArea === 'FIELD_EXECUTION') {
    const diaries = ctx.ledger.list(ctx.projectId, 'SiteDiary');
    const recorded = diaries.filter((record) => record.state.status !== 'DRAFT');
    // The newest recorded day, cited by its own record. A diary is the answer to
    // most "what happened" questions and it is openable, so the citation carries
    // the id rather than the register name.
    const newest = [...recorded].sort((a, b) =>
      String(a.state.diaryDate ?? '').localeCompare(String(b.state.diaryDate ?? '')),
    ).at(-1);
    if (newest) {
      facts.push({
        label: 'Last day recorded',
        value: `${String(newest.state.diaryDate)} — ${String(newest.state.progressNarrative ?? '').slice(0, 120)}`,
        source: 'SiteDiary',
        refId: newest.refId,
      });
    }
    facts.push({ label: 'Days recorded', value: String(recorded.length), source: 'SiteDiary' });

    const drafts = diaries.filter((record) => record.state.status === 'DRAFT').length;
    if (drafts > 0) {
      facts.push({ label: 'Logs still on a device', value: String(drafts), source: 'SiteDiary' });
    }

    const plan = [...ctx.ledger.list(ctx.projectId, 'LookaheadPlan')]
      .sort((a, b) => String(a.state.weekStarting ?? '').localeCompare(String(b.state.weekStarting ?? '')))
      .at(-1);
    if (plan) {
      const commitments = (plan.state.commitments ?? []) as Array<{ status?: string }>;
      facts.push({
        label: 'This week’s plan',
        value: `week of ${String(plan.state.weekStarting)}, ${commitments.length} promise(s), ${String(plan.state.status)}`,
        source: 'LookaheadPlan',
        refId: plan.refId,
      });
    }
    facts.push({ label: 'Open constraints', value: String(ctx.ledger.list(ctx.projectId, 'Constraint').filter((c) => c.state.status !== 'CLOSED').length), source: 'Constraint' });
  }

  if (intent?.capabilityArea === 'SAFETY_RAMS') {
    // Open *today*, not open at all. "Is there a permit on the chamber" asked at
    // eight in the morning is a question about this shift, and a permit that
    // expired on Friday answers it wrongly while looking like an answer.
    const live = ctx.ledger
      .list(ctx.projectId, 'Permit')
      .filter((record) => record.state.status === 'ISSUED' && String(record.state.validTo ?? '') >= today);
    facts.push({ label: 'Permits valid today', value: String(live.length), source: 'Permit' });
    for (const permit of live.slice(0, 3)) {
      facts.push({
        label: String(permit.state.reference ?? 'Permit'),
        value: `${String(permit.state.activity)} at ${String(permit.state.location)}, to ${String(permit.state.validTo)}`,
        source: 'Permit',
        refId: permit.refId,
      });
    }

    facts.push({
      label: 'Inducted and current',
      value: String(ctx.ledger.list(ctx.projectId, 'Induction').filter((i) => String(i.state.validUntil ?? '') >= today).length),
      source: 'Induction',
    });
    facts.push({
      label: 'Tickets in date',
      value: String(ctx.ledger.list(ctx.projectId, 'Competency').filter((c) => String(c.state.expiresAt ?? '') >= now).length),
      source: 'Competency',
    });

    const talks = ctx.ledger.list(ctx.projectId, 'ToolboxTalk');
    facts.push({
      label: 'Toolbox talks given',
      value: String(talks.filter((t) => t.state.status !== 'DRAFTED').length),
      source: 'ToolboxTalk',
    });
    const waiting = talks.filter((t) => t.state.status === 'DRAFTED');
    if (waiting.length > 0) {
      facts.push({
        label: 'Drafted, not yet given',
        value: waiting.map((t) => String(t.state.subject)).slice(0, 3).join('; '),
        source: 'ToolboxTalk',
        refId: waiting[0]!.refId,
      });
    }
  }

  if (intent?.capabilityArea === 'QUALITY_COMMISSIONING') {
    const plans = ctx.ledger.list(ctx.projectId, 'InspectionPlan');
    const agreed = plans.filter((p) => p.state.approvalStatus === 'APPROVED');
    facts.push({ label: 'Inspection plans agreed', value: `${agreed.length} of ${plans.length}`, source: 'InspectionPlan' });
    const newest = agreed.at(-1);
    if (newest) {
      facts.push({
        label: 'Latest agreed plan',
        value: `${String(newest.state.title)} — ${((newest.state.stages ?? []) as unknown[]).length} stage(s)`,
        source: 'InspectionPlan',
        refId: newest.refId,
      });
    }
    facts.push({
      label: 'Hold points not released',
      value: String(ctx.ledger.list(ctx.projectId, 'HoldPointRelease').filter((h) => h.state.status !== 'RELEASED').length),
      source: 'HoldPointRelease',
    });
    const open = ctx.ledger.list(ctx.projectId, 'NCR').filter((n) => n.state.status === 'OPEN');
    facts.push({ label: 'Non-conformances open', value: String(open.length), source: 'NCR' });
    for (const ncr of open.slice(0, 2)) {
      facts.push({
        label: String(ncr.state.reference ?? 'NCR'),
        value: `${String(ncr.state.severity)} — ${String(ncr.state.description ?? '').slice(0, 100)}`,
        source: 'NCR',
        refId: ncr.refId,
      });
    }
  }

  return withheld(ctx, facts);
}

/**
 * The registers that are the project itself rather than a record inside it.
 *
 * `Project` is the envelope the actor is already scoped to — `projectContext`
 * would not have built a context for a project they cannot reach — and `Ledger`
 * is a count of events rather than a register at all. Everything else has to
 * classify and pass.
 */
const ENVELOPE_SOURCES = new Set(['Project', 'Ledger']);

/**
 * Drop the facts this actor is not allowed to read, and say that they were
 * dropped.
 *
 * `ask` performs no authorisation of its own — it did not before this and it
 * still does not, because a question is not a command and refusing to answer at
 * all would be the wrong shape. What it must not do is *answer out of records
 * the asker cannot open*, and it did: `gatherGrounding` read the ledger
 * directly, so a role with no commercial capability could ask about margin and
 * be told the forecast erosion, and a subcontractor seat could ask about safety
 * and be handed the SAFETY_L2 register.
 *
 * The classification is the same one the entity read, the audit feed and the
 * device sync all use — one place where a record's content is authorised, and
 * this was a fourth reader that had never been connected to it. An unclassified
 * register denies, so a new record type is invisible to the copilot until
 * somebody classifies it rather than quotable until somebody notices.
 *
 * Withholding is *stated* rather than silent. A shorter answer with no
 * explanation reads as a thin project; a shorter answer that says two registers
 * were withheld from this role reads as the permission model working.
 */
function withheld(ctx: EngineContext, facts: GroundingFact[]): GroundingFact[] {
  const allowed = new Map<string, boolean>();
  const mayRead = (refType: string): boolean => {
    if (ENVELOPE_SOURCES.has(refType)) return true;
    const cached = allowed.get(refType);
    if (cached !== undefined) return cached;

    const classification = classifyEntity(refType);
    const decision = classification
      ? evaluateAccess(
          ctx.auth,
          classification.area,
          'R',
          { tenantId: ctx.tenantId, projectId: ctx.projectId, dataSensitivity: classification.sensitivity },
          { rbacEnabled: config.authz.rbac, scopesEnabled: config.authz.scopes, abacEnabled: config.authz.abac },
        ).decision === 'ALLOW'
      : false;
    allowed.set(refType, decision);
    return decision;
  };

  const kept = facts.filter((fact) => mayRead(fact.source));
  const lost = [...new Set(facts.filter((fact) => !mayRead(fact.source)).map((fact) => fact.source))];
  if (lost.length > 0) {
    kept.push({
      label: 'Withheld from your role',
      value: `${lost.length} register${lost.length === 1 ? '' : 's'} — ${lost.join(', ')}`,
      source: 'Project',
    });
  }
  return kept;
}

function compose(
  question: string,
  intent: ConversationIntent | undefined,
  grounding: GroundingFact[],
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
