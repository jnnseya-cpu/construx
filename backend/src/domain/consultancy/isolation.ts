/**
 * Buyer/bidder workspace isolation — the per-party view of a shared procurement.
 *
 * The spec (§1) is categorical: "A party acting as a bidder must not see buyer
 * deliberations or another bidder's data," and C03: "Buyer and bidder have access
 * to same procurement. Each sees only entitled records. Evaluations and bidder
 * margins stay compartmentalised." Tenant isolation already keeps different
 * organisations' records apart; this is the finer rule that applies when buyer
 * and bidders look at the *same* procurement object — a deterministic filter that
 * returns only what the viewer is entitled to, so compartmentalisation is a
 * computed guarantee rather than a convention a screen is trusted to honour.
 *
 * The rule, made exact:
 *
 * - **Published** procurement detail (title, scope, deadline, the issued pack) is
 *   visible to everyone — that is the point of a procurement.
 * - **Buyer deliberations** and **evaluations** are the buyer's; no bidder sees
 *   either.
 * - A **bidder** sees **only their own submission**, including their own margin;
 *   never another bidder's submission, and never any bidder's margin but their
 *   own.
 * - The **buyer** sees every submission's content, but **not** any bidder's
 *   internal margin — a bidder's margin is compartmentalised to that bidder, so
 *   it is stripped even from the buyer's view.
 */

export type Submission = {
  bidderId: string;
  content: string;
  /** The bidder's internal margin — visible only to that bidder, never to the buyer or other bidders. */
  marginMinor?: number;
};

export type Evaluation = { bidderId: string; score: number; note?: string };

export type Procurement = {
  id: string;
  reference: string;
  /** Visible to every party. */
  published: { title: string; scope: string; deadline: string };
  /** The buyer's private deliberations. */
  buyerDeliberations: string[];
  /** One per bidder; each bidder sees only their own. */
  submissions: Submission[];
  /** The buyer's scored evaluations. */
  evaluations: Evaluation[];
};

export type Viewer = { side: 'BUYER' | 'BIDDER'; partyId: string };

export type PartyView = {
  reference: string;
  published: Procurement['published'];
  /** Present only for the buyer. */
  deliberations?: string[];
  /** The buyer sees all submissions (margins stripped); a bidder sees only their own (margin kept). */
  submissions: Submission[];
  /** Present only for the buyer. */
  evaluations?: Evaluation[];
};

/** A submission with the internal margin removed. */
function withoutMargin(s: Submission): Submission {
  const { marginMinor: _margin, ...rest } = s;
  return rest;
}

/**
 * The view a given party is entitled to. Pure and total: the same procurement and
 * viewer always yield the same view, and nothing a viewer is not entitled to can
 * appear in it, because it is never copied in rather than hidden by a flag.
 */
export function partyView(procurement: Procurement, viewer: Viewer): PartyView {
  const base = { reference: procurement.reference, published: procurement.published };

  if (viewer.side === 'BUYER') {
    return {
      ...base,
      deliberations: procurement.buyerDeliberations,
      // Every submission, but never a bidder's internal margin.
      submissions: procurement.submissions.map(withoutMargin),
      evaluations: procurement.evaluations,
    };
  }

  // A bidder: only their own submission (margin kept), and nothing of the buyer's
  // deliberations, the evaluations, or any other bidder's data.
  return {
    ...base,
    submissions: procurement.submissions.filter((s) => s.bidderId === viewer.partyId),
  };
}

/**
 * Whether a view has leaked anything it must not carry — a self-check a caller or
 * test can run over any `PartyView`. Returns the leaks (empty when clean). This
 * exists so the guarantee is testable as a property, not just per field.
 */
export function isolationLeaks(view: PartyView, viewer: Viewer): string[] {
  const leaks: string[] = [];
  if (viewer.side === 'BIDDER') {
    if (view.deliberations !== undefined) leaks.push('a bidder can see buyer deliberations');
    if (view.evaluations !== undefined) leaks.push('a bidder can see evaluations');
    if (view.submissions.some((s) => s.bidderId !== viewer.partyId)) leaks.push("a bidder can see another bidder's submission");
  } else {
    if (view.submissions.some((s) => s.marginMinor !== undefined)) leaks.push("the buyer can see a bidder's internal margin");
  }
  return leaks;
}
