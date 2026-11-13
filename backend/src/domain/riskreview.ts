import { DomainError } from '../core/errors.ts';
import { authorise, currentPhase, runAI, type EngineContext } from '../engines/context.ts';
import { expertBriefing } from '../ai/expertise.ts';
import { CRITIQUE_SCHEMA, partitionByCritique, shapeCritiques } from '../ai/refine.ts';

/**
 * Review a project's risk register as a chartered risk manager, and propose the
 * risks worth adding or the entries worth strengthening.
 *
 * The register scores what is on it — a probability, an impact, an expected cost.
 * It does not read the project the way a risk manager does and ask what is *not*
 * on it: the ground risk nobody has owned, the long-lead item with no trigger,
 * the client-side risk priced into the bid by mistake, the event recorded with no
 * cause so nothing can mitigate it. This is that read — a CMIRM risk manager going
 * through the live register before the contingency is set.
 *
 * It carries the same guards as the rest of the AI surface. It reasons only over
 * the register and project context supplied and cites what each proposal rests
 * on; `requireModel` refuses the local stand-in before a penny is charged; and it
 * proposes only — nothing reaches the register here, because adding or re-scoring
 * a risk is a person's act. And it is verified: an independent reviewer marks each
 * proposed risk and the weak ones are sharpened or dropped before a person sees
 * them.
 */

export type ProposedRisk = {
  /** A short label for the register. */
  subject: string;
  /** One of the register's risk categories, as a guide. */
  category: string;
  /** Cause → event → impact as one line, so the risk has a handle a control can act on. */
  cause: string;
  /** Who should carry it — client, contractor or shared, and the named owner where one is clear. */
  owner: string;
  /** The early-warning trigger that says it is materialising. */
  trigger: string;
  /** The proportionate control. */
  mitigation: string;
  /** Why it belongs, or what is weak about the current entry — grounded in the register or project. */
  basis: string;
};

export type RiskReview = {
  /** False when no model could run (no provider, empty wallet). */
  available: boolean;
  proposed: ProposedRisk[];
  /** How many open register items the review read. */
  registerReviewed: number;
  acuConsumed: number;
  note: string;
};

/**
 * Shape and guard the model's output: keep only a real risk with a real cause and
 * control, de-duplicate, and cap. Pure, so the guard is tested without a provider.
 */
export function shapeProposedRisks(output: Record<string, unknown>): ProposedRisk[] {
  const raw = Array.isArray((output as { risks?: unknown }).risks) ? (output as { risks: unknown[] }).risks : [];
  const seen = new Set<string>();
  const out: ProposedRisk[] = [];
  for (const entry of raw) {
    const row = (entry ?? {}) as Record<string, unknown>;
    const subject = String(row.subject ?? '').trim();
    const cause = String(row.cause ?? '').trim();
    const mitigation = String(row.mitigation ?? '').trim();
    const basis = String(row.basis ?? '').trim();
    // A real risk with a cause→event→impact and a control behind it — not an event
    // with no handle, and not a risk with nothing to act on.
    if (cause.length < 12 || mitigation.length < 6 || basis.length < 8) continue;
    const key = (subject || cause).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      subject: subject || cause.slice(0, 60),
      category: String(row.category ?? '').trim(),
      cause,
      owner: String(row.owner ?? '').trim(),
      trigger: String(row.trigger ?? '').trim(),
      mitigation,
      basis,
    });
    if (out.length >= 10) break;
  }
  return out;
}

const RISKS_SCHEMA = {
  type: 'object',
  properties: {
    risks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          category: { type: 'string' },
          cause: { type: 'string' },
          owner: { type: 'string' },
          trigger: { type: 'string' },
          mitigation: { type: 'string' },
          basis: { type: 'string' },
        },
        required: ['subject', 'cause', 'mitigation', 'basis'],
      },
    },
  },
  required: ['risks'],
} as const;

/**
 * The verify-and-improve pass. An independent senior reviewer marks each proposed
 * risk against the bar it has to clear — material, specific as cause→event→impact,
 * with the right owner, trigger and proportionate control, and not already on the
 * register. What passes is kept; what is real but loose is rewritten to the fault
 * named; what is immaterial, a duplicate of a register entry, or generic is
 * dropped. Best-effort: a failure mid-pass leaves the first-pass risks standing.
 */
async function refineRisks(
  ctx: EngineContext,
  proposed: ProposedRisk[],
  register: unknown,
  project: unknown,
): Promise<{ risks: ProposedRisk[]; acuConsumed: number; droppedCount: number; sharpenedCount: number }> {
  let acuConsumed = 0;

  const critique = await runAI(ctx, {
    engine: 'RISK_SAFETY',
    taskType: 'risk_register_critique',
    capability: 'REASONING',
    inputRefs: [],
    request: {
      task:
        `${expertBriefing('RISK_MANAGER')} ` +
        'A first pass has proposed the risks below for a project whose live register and context are also supplied. You ' +
        'did not propose them. Mark each as the risk manager who owns the register would before adding it. For each, ' +
        'return its `index`, a `verdict`, and the `fault` in one sentence. KEEP a risk that is material, stated as a ' +
        'real cause→event→impact with a proportionate control, and not already on the register. SHARPEN one that is ' +
        'real but loose — an event with no cause, no owner, no trigger, or a control that does not act on the cause — ' +
        'and name what to fix. DROP one that is immaterial, duplicates a register entry, misallocates a client risk to ' +
        'the contractor or back, or is generic enough to fit any project.',
      payload: { proposed: proposed.map((r, index) => ({ index, ...r })), register, project },
      responseSchema: CRITIQUE_SCHEMA,
    },
    toWrites: () => [],
  });
  acuConsumed += critique.acuConsumed;

  const critiques = shapeCritiques(critique.output, proposed.length);
  const { keep, sharpen, droppedCount } = partitionByCritique(proposed, critiques);

  let sharpened: ProposedRisk[] = [];
  if (sharpen.length > 0) {
    const improve = await runAI(ctx, {
      engine: 'RISK_SAFETY',
      taskType: 'risk_register_sharpen',
      capability: 'REASONING',
      inputRefs: [],
      request: {
        task:
          `${expertBriefing('RISK_MANAGER')} ` +
          'Each risk below was judged real but not yet good enough, with the fault named. Rewrite each to fix exactly ' +
          'that fault: state it as cause→event→impact, give it the right owner (client, contractor or shared) and an ' +
          'early-warning trigger, and a control that acts on the cause rather than watching the event. Keep it within ' +
          'what the register and project support. Return `risks`: an array of { subject, category, cause, owner, ' +
          'trigger, mitigation, basis } in the same shape.',
        payload: { toSharpen: sharpen.map((entry) => ({ ...entry.item, fault: entry.fault })), register, project },
        responseSchema: RISKS_SCHEMA,
      },
      toWrites: () => [],
    });
    acuConsumed += improve.acuConsumed;
    sharpened = shapeProposedRisks(improve.output);
  }

  const risks = shapeProposedRisks({ risks: [...keep, ...sharpened] });
  return { risks, acuConsumed, droppedCount, sharpenedCount: sharpen.length };
}

export async function reviewProjectRisks(ctx: EngineContext): Promise<RiskReview> {
  authorise(ctx, 'RISK_REGISTER', 'R', { lifecyclePhase: currentPhase(ctx) });

  const project = ctx.ledger.require({ refType: 'Project', refId: ctx.projectId });
  const openItems = ctx.ledger
    .list(ctx.projectId, 'RiskRegisterItem')
    .map((record) => record.state as Record<string, unknown>)
    .filter((state) => String(state.status ?? 'OPEN') === 'OPEN');

  // A bounded, honest view of the live register — enough for the reviewer to see
  // what is already covered and what the gaps are, without the scoring internals.
  const register = openItems.slice(0, 120).map((state) => ({
    title: String(state.title ?? ''),
    category: String(state.category ?? ''),
    cause: String(state.cause ?? ''),
    allocation: String(state.allocation ?? ''),
    severity: String(state.severity ?? ''),
    hasOwner: Boolean(state.ownerPartyId),
    hasMitigation: Array.isArray(state.mitigations) && (state.mitigations as unknown[]).length > 0,
  }));

  const projectContext = {
    phase: String(project.state.phase ?? ''),
    sector: String(project.state.sectorType ?? project.state.sector ?? ''),
    openRisks: register.length,
  };

  try {
    const result = await runAI(ctx, {
      engine: 'RISK_SAFETY',
      taskType: 'risk_register_review',
      capability: 'REASONING',
      inputRefs: [],
      request: {
        task:
          `${expertBriefing('RISK_MANAGER')} ` +
          'Review this project’s live risk register against the project context supplied. Propose the risks a competent ' +
          'risk manager would raise or strengthen: a material risk the register is missing given the phase and sector; ' +
          'an entry recorded as an event with no cause, no owner or no trigger; a control that watches the event rather ' +
          'than acting on the cause; and a risk allocated to the wrong party so it is double-counted into the price or ' +
          'left unfunded. State each as cause→event→impact, give it a category, the owner (client, contractor or ' +
          'shared), an early-warning trigger and a proportionate control, and in the basis say what it rests on — the ' +
          'register entry it strengthens or why the gap matters. Do NOT restate a risk already well captured. Return at ' +
          'most ten, the most material first. If the register is complete and well formed, return an empty list — that ' +
          'is a valid and useful answer.',
        payload: { register, project: projectContext },
        responseSchema: RISKS_SCHEMA,
      },
      requireModel: {
        code: 'NO_REASONING_PROVIDER',
        message:
          'This deployment is running the local stand-in, which reads nothing. A risk-register review has to come from a ' +
          'model that actually read the register — configure a reasoning provider and set AI_MODE=production, or review ' +
          'the register by hand.',
      },
      // Advisory: it writes no state. Adding or re-scoring a risk is a person's act.
      toWrites: () => [],
    });

    const proposed = shapeProposedRisks(result.output);

    // Verify and improve: an independent reviewer marks each proposed risk and the
    // weak ones are sharpened or dropped before a person sees them.
    let risks = proposed;
    let refineAcu = 0;
    let droppedCount = 0;
    let sharpenedCount = 0;
    let refined = false;
    if (proposed.length > 0) {
      try {
        const refinement = await refineRisks(ctx, proposed, register, projectContext);
        risks = refinement.risks;
        refineAcu = refinement.acuConsumed;
        droppedCount = refinement.droppedCount;
        sharpenedCount = refinement.sharpenedCount;
        refined = true;
      } catch {
        // A provider or wallet failure mid-review: keep the first-pass risks.
      }
    }

    const reviewedNote = refined && (droppedCount > 0 || sharpenedCount > 0)
      ? ` An independent review dropped ${droppedCount} and sharpened ${sharpenedCount} before they reached you.`
      : '';

    return {
      available: true,
      proposed: risks,
      registerReviewed: register.length,
      acuConsumed: result.acuConsumed + refineAcu,
      note:
        risks.length === 0
          ? proposed.length === 0
            ? 'The review read the register and found it complete and well formed for this phase — every risk a cause→' +
              'event→impact with an owner and a control. That is a real answer, not a gap.'
            : 'A first pass proposed risks, but an independent senior review found none of them material, well formed and ' +
              'not already captured once it checked each against the register. There is nothing here to add.'
          : `${risks.length} risk${risks.length === 1 ? '' : 's'} proposed from the register and project.${reviewedNote} ` +
            'Each says what it rests on — verify it, then add or re-score the ones worth carrying. Nothing was changed on ' +
            'the register; that stays your act.',
    };
  } catch (error) {
    if (error instanceof DomainError && error.code === 'NO_REASONING_PROVIDER') {
      return {
        available: false,
        proposed: [],
        registerReviewed: register.length,
        acuConsumed: 0,
        note:
          'The expert risk review needs a reasoning AI provider, and none is configured on this deployment (or the ' +
          'wallet is empty). Nothing was charged. Configure a provider, or review the register by hand.',
      };
    }
    throw error;
  }
}
