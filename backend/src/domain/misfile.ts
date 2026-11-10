/**
 * The misfile guard — stop a document going into the wrong project.
 *
 * With several live engagements in one tenancy, the real operational risk is not
 * cross-tenant leakage (the platform already prevents that) but putting the right
 * document against the *wrong* engagement: pasting one tender's brief into
 * another's workspace, or filing evidence for scheme A under scheme B. That
 * misattribution is silent and expensive — it corrupts the Golden Thread with a
 * record that looks legitimate.
 *
 * This is a pure, deterministic check. It compares a document's own identity
 * signals — the client, authority, asset/service and location words it actually
 * contains, and any reference codes it cites — against the engagement it is being
 * filed under, and against the other engagements in the same project. It raises:
 *
 *   - CONFLICT when the document matches *another* engagement far better than the
 *     one it is being filed under, or cites a reference that is not this
 *     engagement's — a block that must be explicitly overridden.
 *   - REVIEW when the document mentions none of this engagement's identity at all
 *     — a warning, not a block.
 *   - OK otherwise.
 *
 * It names no number it cannot see in the text, and it never guesses: a weak or
 * absent signal yields OK or REVIEW, never a false CONFLICT.
 */

export type PlacementIdentity = {
  reference?: string;
  client?: string;
  authority?: string;
  assetOrService?: string;
  location?: string;
};

export type PlacementVerdict = 'OK' | 'REVIEW' | 'CONFLICT';

export type PlacementAssessment = {
  verdict: PlacementVerdict;
  reason: string;
  /** This engagement's identity words that appear in the document. */
  matchedTokens: string[];
  /** Reference codes in the document that are not this engagement's. */
  foreignReferences: string[];
  /** Where the document looks like it really belongs, when a conflict is found. */
  likelyBelongsTo?: { reference?: string; client?: string };
};

// Words too generic to discriminate one infrastructure engagement from another.
const GENERIC = new Set([
  'council', 'authority', 'combined', 'mayoral', 'service', 'services', 'project',
  'projects', 'limited', 'company', 'rail', 'road', 'vehicle', 'vehicles', 'north',
  'south', 'east', 'west', 'city', 'borough', 'district', 'county', 'region',
  'regional', 'network', 'national', 'england', 'scotland', 'wales', 'united',
  'kingdom', 'framework', 'tender', 'study', 'business', 'case', 'feasibility',
]);

// Reference codes: ITT-900, TM0000000265-1, DN834055, CA18/5956, C-25-040, etc.
// Letters, then digits (optionally separated), with any number of -/ digit groups.
const REF_RE = /\b[A-Z]{1,4}[-/]?\d{2,}(?:[-/]\d+)*\b/g;

function tokens(value: string | undefined): string[] {
  if (!value) return [];
  const out = new Set<string>();
  for (const w of value.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 4 && !GENERIC.has(w)) out.add(w);
  }
  return [...out];
}

/** The distinctive identity words of an engagement. */
export function identityTokens(id: PlacementIdentity): string[] {
  const out = new Set<string>();
  for (const field of [id.client, id.authority, id.assetOrService, id.location]) {
    for (const w of tokens(field)) out.add(w);
  }
  return [...out];
}

/** Reference-shaped codes present in a block of text, upper-cased and de-duplicated. */
export function extractReferences(text: string): string[] {
  const out = new Set<string>();
  for (const m of (text ?? '').toUpperCase().matchAll(REF_RE)) out.add(m[0]);
  return [...out];
}

function hitCount(idTokens: string[], haystack: string): string[] {
  const low = haystack.toLowerCase();
  return idTokens.filter((tk) => low.includes(tk));
}

/**
 * Assess whether `documentText` belongs on the `target` engagement, given the
 * other engagements in the same project.
 */
export function assessPlacement(
  target: PlacementIdentity,
  documentText: string,
  others: PlacementIdentity[] = [],
): PlacementAssessment {
  const text = documentText ?? '';
  const matched = hitCount(identityTokens(target), text);
  const docRefs = extractReferences(text);
  const targetRefs = extractReferences(target.reference ?? '');
  const foreignReferences = docRefs.filter((r) => !targetRefs.includes(r));
  const substantial = text.replace(/\s+/g, ' ').trim().length >= 200;

  // The strongest signal: the document matches another engagement's identity far
  // more closely than the one it is being filed under.
  let best: { id: PlacementIdentity; score: number } | undefined;
  for (const o of others) {
    const score = hitCount(identityTokens(o), text).length;
    if (!best || score > best.score) best = { id: o, score };
  }
  if (best && best.score >= 2 && best.score >= matched.length + 2) {
    return {
      verdict: 'CONFLICT',
      reason: `This document matches another engagement (${best.id.reference ?? best.id.client ?? 'another project'}) far more closely than this one — it may belong there.`,
      matchedTokens: matched,
      foreignReferences,
      likelyBelongsTo: { reference: best.id.reference, client: best.id.client },
    };
  }

  // A reference conflict: the document cites codes, none of which are this
  // engagement's, and this engagement has a reference of its own to compare.
  if (targetRefs.length > 0 && foreignReferences.length > 0 && !docRefs.some((r) => targetRefs.includes(r))) {
    return {
      verdict: 'CONFLICT',
      reason: `The document cites reference(s) ${foreignReferences.join(', ')}, not this engagement's (${targetRefs.join(', ')}).`,
      matchedTokens: matched,
      foreignReferences,
    };
  }

  // Nothing ties a substantial document to this engagement — warn, do not block.
  if (matched.length === 0 && substantial) {
    return {
      verdict: 'REVIEW',
      reason: "The document does not mention this engagement's client, authority, service or location — check it belongs here.",
      matchedTokens: matched,
      foreignReferences,
    };
  }

  return {
    verdict: 'OK',
    reason: "The document is consistent with this engagement's identity.",
    matchedTokens: matched,
    foreignReferences,
  };
}
