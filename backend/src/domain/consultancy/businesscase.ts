/**
 * The Five Case Model business case — the public-profile deliverable the
 * consultancy agents assemble, built to the spec's validation contract (§7):
 * "Preferred option and alternatives reconcile to model runs. Each scenario
 * reproduces. Economic value and funding are separate."
 *
 * Two layers, and the honesty rule runs between them, exactly as the feasibility
 * brief does it:
 *
 * - The **figures and the prose composed from them are deterministic** — the
 *   break-even, funding gap, option screen and recommendation come from
 *   `model.ts` and `engagement.ts`, never from a model. The Strategic/Economic/
 *   Commercial/Financial/Management narrative is built from those figures so it
 *   cannot drift from the tables beside it.
 * - An **optional AI layer** adds advisory prose for the judgement sections where
 *   a reasoning provider earns its place. It states no figure not computed, is
 *   marked as advisory, and is simply absent where no provider answers (as in
 *   the suite's local mode). Per the spec's conduct rule (§3) this layer applies
 *   a competent specialist's judgement and duty of care **without claiming
 *   chartership, a licence or legal authority**, shows the basis for each claim,
 *   and says what could change the conclusion.
 *
 * Investment readiness is for a specific authority and decision; a polished
 * report cannot by itself confer approval, bankability or compliance. The pack
 * carries that qualification on its face.
 */

import type { DocumentBlock } from '../../export/exporter.ts';
import { HOLISTIC_CRITIQUE_SCHEMA, shapeHolisticCritique } from '../../ai/refine.ts';
import { runAI, type EngineContext } from '../../engines/context.ts';
import {
  recommendDecision,
  screenOptions,
  type AppraisalOption,
  type DecisionRecommendation,
  type MinimumIntake,
  type ScreenedOption,
} from './engagement.ts';
import {
  scenarioRuns,
  serviceBusinessCase,
  type ScenarioRun,
  type ServiceCaseInput,
  type ServiceCaseResult,
} from './model.ts';

/** Minor units to a readable pound string. */
function gbp(minor: number, { compact = false } = {}): string {
  const pounds = minor / 100;
  if (compact && Math.abs(pounds) >= 100_000) return `£${(pounds / 1_000_000).toFixed(2)}m`;
  return `£${Math.round(pounds).toLocaleString('en-GB')}`;
}
const n = (x: number): string => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-GB') : '—');

export type FundingSource = { body: string; amountMinor: number; status?: string };

export type BusinessCaseInput = {
  title: string;
  intake: MinimumIntake;
  /** SMART spending objectives (the strategic case). */
  objectives: string[];
  /** Options for appraisal; screened here against their hard constraints. */
  options: AppraisalOption[];
  /** Named preferred option, if the client has one; otherwise the best-scored eligible option is used. */
  preferredOption?: string;
  /** The service economics (break-even, funding gap). Optional for a purely qualitative case. */
  serviceCase?: ServiceCaseInput;
  /** Capital cost, carried in the financial case (separate from the economic value). */
  capitalCostMinor?: number;
  /** Funding by body and status — the financial case, kept apart from economic value for money. */
  fundingSources?: FundingSource[];
  programmeMonths?: number;
  /** Decision stage (SOC / OBC / FBC or a sector-equivalent gate). */
  stage?: string;
  /** External confirmations still outstanding (operator sign-off, consents) — carried as decision conditions. */
  outstandingConfirmations?: string[];
};

export type AssembledBusinessCase = {
  screened: ScreenedOption[];
  model?: ServiceCaseResult;
  scenarios?: ScenarioRun[];
  decision: DecisionRecommendation;
  blocks: DocumentBlock[];
};

/** The judgement sections an AI layer may write, with the brief put to the model. */
export const FIVE_CASE_SECTIONS: Array<{ key: string; heading: string; brief: string }> = [
  { key: 'strategic', heading: 'Strategic Case', brief: 'the case for change: why the current position is a problem worth solving, and how the preferred direction meets the stated objectives' },
  { key: 'economic', heading: 'Economic Case', brief: 'value for money: how the eligible options compare and why the preferred option is best value, referring only to the appraisal figures supplied' },
  { key: 'commercial', heading: 'Commercial Case', brief: 'commercial viability and deliverability: the route to market, who carries which risk, and what makes the preferred option deliverable' },
  { key: 'financial', heading: 'Financial Case', brief: 'affordability: whether the preferred option can be funded within the cost and funding supplied, and the residual gap if any' },
  { key: 'management', heading: 'Management Case', brief: 'deliverability: governance, the programme, the key risks and the conditions on which the recommendation depends' },
];

/**
 * The spec's professional-conduct instruction (§3), as a prompt preface. It is
 * deliberately *not* the platform's chartered-expert framing: the spec requires
 * a competent specialist's judgement without a claim of chartership or authority.
 */
export const CONSULTANCY_CONDUCT =
  'Apply the judgement and duty of care expected of a competent consultancy specialist in this discipline. ' +
  'Reason only from the evidence and figures supplied; state no figure, date, name or quantity that is not in them. ' +
  'Show the basis for each material claim, and say what could change the conclusion. Do not claim chartership, a ' +
  'licence or legal authority. Two or three sentences of plain prose; no headings, no lists.';

function money(minor: number | undefined): string {
  return minor === undefined ? 'not supplied' : gbp(minor, { compact: true });
}

/**
 * Assemble the business case: screen the options, run the deterministic model,
 * recommend a decision, and build the Five Case document. `narrative` carries
 * any AI-written judgement prose keyed by section; where a key is absent the
 * deterministic prose stands alone, so the pack is complete with or without a
 * model.
 */
export function assembleBusinessCase(
  input: BusinessCaseInput,
  narrative: Record<string, string> = {},
): AssembledBusinessCase {
  const screened = screenOptions(input.options);
  const model = input.serviceCase ? serviceBusinessCase(input.serviceCase) : undefined;
  const scenarios = input.serviceCase?.demandUses !== undefined ? scenarioRuns(input.serviceCase) : undefined;
  const decision = recommendDecision(screened, model, input.outstandingConfirmations ?? [], input.preferredOption);

  const blocks: DocumentBlock[] = [];
  const h = (level: 1 | 2 | 3, text: string): void => { blocks.push({ kind: 'HEADING', level, text }); };
  const para = (text: string): void => { blocks.push({ kind: 'PARAGRAPH', text }); };
  const advisory = (key: string): void => {
    if (narrative[key]) {
      para(narrative[key]!);
      para('The paragraph above is advisory prose from the platform’s reasoning provider over the figures in this case; it states no figure not set out here and confers no approval.');
    }
  };

  // --- Cover & recommendation (deterministic) ---
  h(1, `${input.title} — Business Case`);
  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Client', value: input.intake.client },
      { label: 'Decision requested', value: input.intake.decisionRequested },
      { label: 'Decision authority', value: input.intake.decisionAuthority },
      ...(input.stage ? [{ label: 'Stage', value: input.stage }] : []),
      ...(input.intake.deadline ? [{ label: 'Deadline', value: input.intake.deadline }] : []),
      { label: 'Recommendation', value: decision.recommendation },
      ...(decision.preferredOption ? [{ label: 'Preferred option', value: decision.preferredOption }] : []),
    ],
  });
  para(decision.rationale);
  if (decision.conditions.length > 0) {
    blocks.push({ kind: 'LIST', ordered: false, items: decision.conditions.map((c) => `Condition: ${c}`) });
  }
  para('This business case is prepared to the HM Treasury Green Book Five Case Model (public profile). Investment readiness is for the named authority and decision only; this document does not itself confer approval, funding or regulatory compliance.');

  // --- 1. Strategic Case ---
  h(2, '1. Strategic Case');
  para(
    `The decision requested is: ${input.intake.decisionRequested}. The case for change rests on the current position ` +
    `of ${input.intake.assetOrService} at ${input.intake.location}. The spending objectives this case is measured against are set out below.`,
  );
  if (input.objectives.length > 0) {
    blocks.push({ kind: 'LIST', ordered: true, items: input.objectives });
  }
  advisory('strategic');

  // --- 2. Economic Case (value for money — options & appraisal) ---
  h(2, '2. Economic Case (value for money)');
  para(
    'Options are screened against their hard constraints before any scoring: a weighted score cannot clear a fatal ' +
    'constraint. Eligible options are then compared on value for money.',
  );
  blocks.push({
    kind: 'TABLE',
    caption: 'Options, hard-constraint screen and eligibility',
    headers: ['Option', 'Summary', 'Eligible', 'Excluded by'],
    rows: screened.map((o) => [o.name, o.summary, o.eligible ? 'Yes' : 'No', o.excludedBy.join('; ') || '—']),
  });
  if (model) {
    para(
      `On the preferred option the service breaks even at ${n(model.breakEvenUses)} uses a year from receipts alone; ` +
      `within the available subsidy it needs a minimum of ${n(model.minUsesWithinCap)} uses. ` +
      (model.servedUses !== undefined
        ? `At the central demand of ${n(model.servedUses)} served uses the operating balance is ${gbp(model.operatingBalanceMinor ?? 0)}` +
          `${(model.unmetUses ?? 0) > 0 ? `, with ${n(model.unmetUses ?? 0)} uses of unmet demand beyond capacity` : ''}.`
        : ''),
    );
  }
  if (scenarios && scenarios.length > 0) {
    blocks.push({
      kind: 'TABLE',
      caption: 'Demand scenarios (central, downside, upside)',
      headers: ['Scenario', 'Demand ×', 'Served uses', 'Operating balance', 'Residual gap'],
      rows: scenarios.map((s) => [
        s.name,
        `${s.demandMultiplier}`,
        n(s.result.servedUses ?? 0),
        gbp(s.result.operatingBalanceMinor ?? 0),
        gbp(s.result.residualGapMinor ?? 0),
      ]),
    });
  }
  advisory('economic');

  // --- 3. Commercial Case ---
  h(2, '3. Commercial Case (deliverability)');
  para(
    `Delivery involves ${input.intake.client} and the relevant delivery and approval bodies. The preferred option is ` +
    `${decision.preferredOption ?? 'to be confirmed once an eligible option is selected'}. Risk allocation and the route ` +
    'to market are developed against the preferred option; matters requiring a third-party commitment are carried as conditions, not assumed.',
  );
  advisory('commercial');

  // --- 4. Financial Case (affordability — funding, kept separate from economic value) ---
  h(2, '4. Financial Case (affordability)');
  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Capital cost', value: money(input.capitalCostMinor) },
      { label: 'Annual operating cost', value: money(input.serviceCase?.operatingCostMinor) },
      ...(model ? [{ label: 'Funding gap at central demand', value: gbp(model.fundingGapMinor ?? 0) }] : []),
      ...(model ? [{ label: 'Subsidy drawn', value: gbp(model.subsidyDrawnMinor ?? 0) }] : []),
      ...(model ? [{ label: 'Residual (unfunded) gap', value: gbp(model.residualGapMinor ?? 0) }] : []),
    ],
  });
  if (input.fundingSources && input.fundingSources.length > 0) {
    blocks.push({
      kind: 'TABLE',
      caption: 'Funding sources (financial — separate from economic value for money)',
      headers: ['Body', 'Amount', 'Status'],
      rows: input.fundingSources.map((f) => [f.body, gbp(f.amountMinor), f.status ?? 'indicative']),
    });
  }
  para('Economic value (the Economic Case above) and funding (this case) are reported separately: a case can be good value and still unaffordable within the funding available, and the two questions must not be conflated.');
  advisory('financial');

  // --- 5. Management Case ---
  h(2, '5. Management Case (deliverability & assurance)');
  para(
    `The commission is governed by ${input.intake.decisionAuthority}` +
    `${input.programmeMonths ? ` over approximately ${input.programmeMonths} months` : ''}. ` +
    'Each material finding traces to a cited source, a governed assumption or a reproducible calculation; the figures above ' +
    'are produced by deterministic models and reproduce on re-run. The recommendation carries the conditions listed on the cover.',
  );
  advisory('management');

  return { screened, model, scenarios, decision, blocks };
}

/**
 * The optional AI judgement layer. Best-effort and production-only: where no
 * reasoning provider answers — or the local stand-in does — it returns nothing
 * and the deterministic document stands. Each section is drafted, then an
 * independent pass marks it and the weak ones are rewritten, carrying the spec's
 * Independent Challenge quality lift without ever touching a figure.
 */
export async function businessCaseNarrative(
  ctx: EngineContext,
  input: BusinessCaseInput,
): Promise<{ narrative: Record<string, string>; acuConsumed: number }> {
  const narrative: Record<string, string> = {};
  let acuConsumed = 0;
  const payload = {
    title: input.title,
    decision: input.intake.decisionRequested,
    assetOrService: input.intake.assetOrService,
    location: input.intake.location,
    // The client's own issued brief, where it was attached at intake, so the
    // reasoning layer grounds the narrative in the requirement as written rather
    // than only in the structured fields derived from it.
    ...(input.intake.clientRequirement ? { clientRequirement: input.intake.clientRequirement } : {}),
    objectives: input.objectives,
    options: input.options.map((o) => ({ name: o.name, summary: o.summary })),
    preferredOption: input.preferredOption,
    service: input.serviceCase,
    capitalCostMinor: input.capitalCostMinor,
    fundingSources: input.fundingSources,
  };

  for (const section of FIVE_CASE_SECTIONS) {
    try {
      const draft = await runAI(ctx, {
        engine: 'EXECUTIVE',
        taskType: `business_case_narrative:${section.key}`,
        capability: 'REASONING',
        inputRefs: [],
        request: {
          task: `${CONSULTANCY_CONDUCT} Write the ${section.heading} of a public-sector business case — ${section.brief}.`,
          payload,
        },
        toWrites: () => [],
      });
      acuConsumed += draft.acuConsumed;
      if (draft.synthetic) continue; // the local stand-in reasons about nothing; drop it.
      let text = String((draft.output as { narrative?: unknown; text?: unknown }).narrative ?? (draft.output as { text?: unknown }).text ?? '').trim();

      // Independent Challenge: an independent pass marks the draft; a faulted draft is rewritten.
      const critique = await runAI(ctx, {
        engine: 'EXECUTIVE',
        taskType: `business_case_critique:${section.key}`,
        capability: 'REASONING',
        inputRefs: [],
        request: {
          task:
            `${CONSULTANCY_CONDUCT} A first pass has written the "${section.heading}" below. You did not write it. Judge it: is it ` +
            'specific to the figures supplied rather than generic; is every claim grounded in them; does it overstate certainty or ' +
            'assume a confirmation that is outstanding? Return `sound` and `faults` (one phrase each); no faults if it is sound.',
          payload: { ...payload, draft: text },
          responseSchema: HOLISTIC_CRITIQUE_SCHEMA,
        },
        toWrites: () => [],
      });
      acuConsumed += critique.acuConsumed;
      const { faults } = shapeHolisticCritique(critique.output);
      if (faults.length > 0) {
        const improve = await runAI(ctx, {
          engine: 'EXECUTIVE',
          taskType: `business_case_improve:${section.key}`,
          capability: 'REASONING',
          inputRefs: [],
          request: {
            task:
              `${CONSULTANCY_CONDUCT} Rewrite the "${section.heading}" below to fix exactly the faults named: ground every claim in the ` +
              'figures supplied, cut anything generic, and do not assert a certainty the evidence does not support. Return `narrative`: the rewritten paragraph.',
            payload: { ...payload, draft: text, faults },
            responseSchema: { type: 'object', properties: { narrative: { type: 'string' } }, required: ['narrative'] },
          },
          toWrites: () => [],
        });
        acuConsumed += improve.acuConsumed;
        const rewritten = String((improve.output as { narrative?: unknown }).narrative ?? '').trim();
        if (rewritten.length > 0) text = rewritten;
      }

      if (text.length > 0) narrative[section.key] = text;
    } catch {
      // A provider or wallet failure on one section leaves it to the deterministic prose; the pack still completes.
    }
  }

  return { narrative, acuConsumed };
}
