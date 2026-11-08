/**
 * The verify-and-improve loop that lifts a first-pass draft to the quality a
 * highly experienced professional would put their name to.
 *
 * The author drafts; an INDEPENDENT reviewer — a different posture, often the
 * party on the other side of the table — marks each item against the bar the
 * deliverable actually has to clear, and says exactly what is wrong; then the
 * author rewrites only what was faulted, or drops what cannot be saved. This is
 * the mechanism that turns a reasonable answer into a defensible one. The framing
 * asks for quality; this checks for it, which is the difference between an agent
 * that is *called* experienced and work that *is*.
 *
 * This module is the reusable core: the critique vocabulary, the response shape a
 * reviewer returns, and the pure merge that applies a critique to a draft. Each
 * deliverable supplies its own author, reviewer and rewrite prompts; the control
 * flow and the honest guards are the same everywhere, which is what lets the loop
 * roll from one deliverable to the next without re-deriving it.
 */

export type CritiqueVerdict = 'KEEP' | 'SHARPEN' | 'DROP';

export type DraftCritique = {
  index: number;
  verdict: CritiqueVerdict;
  /** What is wrong, specifically — the fault the rewrite has to fix. Empty for a KEEP. */
  fault: string;
};

/**
 * The response schema a reviewer returns: one verdict per drafted item, by index.
 * Shared so every reviewer prompt answers in the same shape.
 */
export const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    reviews: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          verdict: { type: 'string', enum: ['KEEP', 'SHARPEN', 'DROP'] },
          fault: { type: 'string' },
        },
        required: ['index', 'verdict'],
      },
    },
  },
  required: ['reviews'],
} as const;

/**
 * Shape the reviewer's output into one clean critique per drafted item. An item
 * the reviewer did not mark is kept — silence is not a cut — and a verdict the
 * reviewer did not recognise defaults to KEEP, so a malformed review never
 * silently discards work. Pure, so the merge is tested without a provider.
 */
export function shapeCritiques(output: Record<string, unknown>, count: number): DraftCritique[] {
  const raw = Array.isArray((output as { reviews?: unknown }).reviews) ? (output as { reviews: unknown[] }).reviews : [];
  const byIndex = new Map<number, DraftCritique>();
  for (const entry of raw) {
    const row = (entry ?? {}) as Record<string, unknown>;
    const index = Number(row.index);
    if (!Number.isInteger(index) || index < 0 || index >= count) continue;
    const upper = String(row.verdict ?? '').toUpperCase();
    const verdict: CritiqueVerdict = upper === 'DROP' ? 'DROP' : upper === 'SHARPEN' ? 'SHARPEN' : 'KEEP';
    byIndex.set(index, { index, verdict, fault: String(row.fault ?? '').trim() });
  }
  const out: DraftCritique[] = [];
  for (let i = 0; i < count; i++) {
    out.push(byIndex.get(i) ?? { index: i, verdict: 'KEEP', fault: '' });
  }
  return out;
}

export type Partitioned<T> = {
  /** Items the reviewer passed as-is. */
  keep: T[];
  /** Items worth keeping but not yet good enough, each with the fault to fix. */
  sharpen: Array<{ index: number; item: T; fault: string }>;
  /** How many the reviewer cut — the cull doing its job. */
  droppedCount: number;
};

/**
 * Apply a critique to a draft set: keep what passed, queue what must be sharpened
 * with its fault, and drop what the reviewer cut. Pure.
 */
export function partitionByCritique<T>(items: readonly T[], critiques: readonly DraftCritique[]): Partitioned<T> {
  const keep: T[] = [];
  const sharpen: Array<{ index: number; item: T; fault: string }> = [];
  let droppedCount = 0;
  for (let i = 0; i < items.length; i++) {
    const critique = critiques.find((c) => c.index === i) ?? { index: i, verdict: 'KEEP' as const, fault: '' };
    const item = items[i] as T;
    if (critique.verdict === 'DROP') droppedCount += 1;
    else if (critique.verdict === 'SHARPEN') sharpen.push({ index: i, item, fault: critique.fault });
    else keep.push(item);
  }
  return { keep, sharpen, droppedCount };
}
