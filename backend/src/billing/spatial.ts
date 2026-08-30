import { ulid } from '../core/ids.ts';
import { config } from '../config.ts';
import type { ACUWallet } from './acu.ts';

/**
 * What the spatial stages cost, and how they are charged.
 *
 * The site-capture module runs three pieces of real compute: reconstructing
 * geometry from feature tracks, segmenting a surface into regions, and
 * measuring the volume between two captures. None of them calls a model — they
 * are arithmetic this platform performs — and all three were, until now, free.
 *
 * Free is the wrong answer twice over. It is wrong commercially, because a
 * customer scanning a two-hectare site every week is consuming real compute
 * nobody is paying for. And it is wrong for the *customer*, because the ACU
 * statement is where they see what the platform is doing on their behalf, and a
 * stage that never appears on it is a stage they cannot account for.
 *
 * ---
 *
 * **Charged like a document render, not like an AI call.** `export/render.ts`
 * set the pattern and it is the right one: reserve before the work, do the
 * work, settle after it, with `LOCAL` as the provider. The customer sees a
 * spatial stage beside an AI call in the same units, and the same markup
 * applies, so there is one price list rather than two.
 *
 * **Sized by the work actually done.** A base per stage plus a rate per
 * thousand primitives. Four hundred tracks and forty thousand tracks are not
 * the same job, and a flat fee makes the small site pay for the large one.
 *
 * **Reserved before, settled after.** A tenancy with an empty wallet is refused
 * before the compute runs rather than after, and a stage that throws releases
 * its hold without charge — nothing is billed for an answer the customer never
 * received.
 */

export type SpatialStage = 'RECONSTRUCTION' | 'SEGMENTATION' | 'CHANGE_VOLUME';

export const SPATIAL_STAGE_LABEL: Record<SpatialStage, string> = {
  RECONSTRUCTION: 'Reconstruct geometry from the capture',
  SEGMENTATION: 'Segment the ground into regions',
  CHANGE_VOLUME: 'Measure the volume between two captures',
};

/**
 * Provider cost for one run of a stage, before markup.
 *
 * Never below one minor unit: a settlement of zero is refused by the wallet —
 * deliberately, since a completed run cost something — and a stage over a
 * handful of triangles would otherwise round to nothing and fail at the
 * settle rather than at the quote.
 */
export function spatialStageRawCostMinor(stage: SpatialStage, primitives: number): number {
  const base = config.billing.spatialStageRawCostMinor[stage];
  const counted = Number.isFinite(primitives) && primitives > 0 ? primitives : 0;
  const size = Math.ceil((counted / 1000) * config.billing.spatialRawCostMinorPerThousandPrimitives);
  return Math.max(1, base + size);
}

export type MeteredStage<T> = {
  result: T;
  /** What the customer was charged, in minor units, after markup. */
  chargedMinor: number;
  stage: SpatialStage;
  /** How the charge was sized, so the statement line can be explained. */
  primitives: number;
};

/**
 * Run a spatial stage, charging for it.
 *
 * The primitive count has to be known *before* the work, because the hold is
 * taken before the work. That is why it is a parameter rather than something
 * read off the result: sizing the charge from the output would let an expensive
 * run that produced little escape being charged for what it cost, and would
 * mean reserving nothing at all before starting.
 */
export function meterSpatialStage<T>(
  wallet: ACUWallet,
  input: { stage: SpatialStage; primitives: number; projectId?: string; userId?: string },
  work: () => T,
): MeteredStage<T> {
  // One figure, read once, used for both the hold and the settlement. Reading
  // it twice is how a hold and a settlement come to disagree — a hold larger
  // than the charge refuses work the tenancy could afford, and a smaller one
  // undercharges, and neither shows up in a test that only inspects the final
  // number.
  const rawCostMinor = spatialStageRawCostMinor(input.stage, input.primitives);

  const hold = wallet.reserve({
    aiRequestId: ulid(),
    estimatedRawCostMinor: rawCostMinor,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
    module: 'SITE_CAPTURE',
    feature: `spatial_${input.stage.toLowerCase()}`,
  });

  let result: T;
  try {
    result = work();
  } catch (error) {
    // Nothing was produced, so nothing is charged.
    wallet.release(hold.holdId, `Spatial stage ${input.stage} failed`);
    throw error;
  }

  const entry = wallet.settle(hold.holdId, rawCostMinor, 'LOCAL');
  return { result, chargedMinor: entry.billedMinor, stage: input.stage, primitives: input.primitives };
}
