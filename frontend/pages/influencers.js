import { programme } from './partners.js';

/**
 * The growth programme — the influencer half.
 *
 * The same records, the same routes and the same screen as the partner
 * programme, because they are one mechanism with different terms and building
 * them twice would guarantee they drifted. What differs is the term: an
 * influencer is paid a fixed amount for each tenancy they bring that goes on to
 * pay something, rather than a share of what it pays.
 *
 * A separate navigation entry rather than a tab, because the two are read for
 * different reasons and by different people — a partner is a relationship
 * somebody manages, a campaign is a thing somebody measures.
 */
export async function influencers(root) {
  await programme(root, {
    kind: 'INFLUENCER',
    title: 'Influencers',
    intent:
      'People with an audience, paid once for each tenancy they bring that goes on to pay something. A bounty per ' +
      'conversion, not a share of revenue — and the conversion is a settled receipt, never a signup.',
    redraw: influencers,
  });
}
