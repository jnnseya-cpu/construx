import { DomainError } from '../../core/errors.ts';
import { CATALOGUE, draftable, formByKey, formLabel } from './catalogue.ts';
import { hasOwnSchedule } from './schedules.ts';

/**
 * Which form suits the job: a ranked shortlist with the reason for each.
 *
 * Deterministic on purpose. The choice turns on a handful of facts — what is
 * being bought, who designs it, how it is priced, how big it is, whether it is
 * international — and the conventional answers to those are well known (RICS's
 * contract-selection guidance sets them out). A model adds nothing to that but
 * the chance of a confident wrong edition. The shortlist is a starting point:
 * the person confirms the exact form and edition, and the commercial and legal
 * reviewers stand behind it, not the platform.
 *
 * A form the tender names comes first, whatever the rules would say — the
 * client chose it, and a bid on a different form is a qualified bid.
 */

export const PACKAGES = ['MAIN_WORKS', 'SUBCONTRACT', 'CONSULTANCY', 'SUPPLY', 'TERM_SERVICES', 'HOMEOWNER'] as const;
export const DESIGN = ['EMPLOYER', 'SHARED', 'CONTRACTOR'] as const;
export const PRICING = ['LUMP_SUM_WITH_QUANTITIES', 'LUMP_SUM_WITHOUT_QUANTITIES', 'ACTIVITY_SCHEDULE', 'REMEASURED', 'TARGET_COST', 'COST_REIMBURSABLE'] as const;
export const VALUE_BANDS = ['SMALL', 'MEDIUM', 'LARGE', 'MAJOR'] as const;
export const SUITES = ['JCT', 'NEC', 'FIDIC'] as const;

export type SelectionInput = {
  package: (typeof PACKAGES)[number];
  design?: (typeof DESIGN)[number];
  pricing?: (typeof PRICING)[number];
  valueBand?: (typeof VALUE_BANDS)[number];
  international?: boolean;
  preferredSuite?: (typeof SUITES)[number];
  tenderNamedFormKey?: string;
};

export type Recommendation = { key: string; label: string; status: string; ownSchedule: boolean; reasons: string[] };

const NEC4 = 'nec:nec4-jan-2023-revision';
const FIDIC17 = 'fidic:2017-2022-reprint';

/** Every key the rules can name, so a test can hold them to the catalogue. */
export const RULE_KEYS: readonly string[] = [
  'jct:2021:ho-b', 'jct:2021:ho-c', 'jct:2024:ca', 'jct:2024:mtc', 'jct:2024:rm', 'jct:2024:dbsub-a', 'jct:2024:sbcsub-a', 'jct:2024:icsub-a', 'jct:2024:shortsub',
  'jct:2024:mw', 'jct:2024:mwd', 'jct:2024:ic', 'jct:2024:icd', 'jct:2024:sbc-q', 'jct:2024:sbc-xq', 'jct:2024:sbc-aq', 'jct:2024:db', 'jct:2024:mp', 'jct:2024:tcc', 'jct:2024:pcc',
  `${NEC4}:ecc`, `${NEC4}:ecsc`, `${NEC4}:ecs`, `${NEC4}:ecss`, `${NEC4}:psc`, `${NEC4}:pssc`, `${NEC4}:tsc`, `${NEC4}:tssc`, `${NEC4}:sc`, `${NEC4}:ssc`,
  `${FIDIC17}:red`, `${FIDIC17}:yellow`, `${FIDIC17}:silver`, 'fidic:2021-second-edition:green', 'fidic:2017-fifth-edition:white',
];

export function recommendForms(input: SelectionInput): { recommendations: Recommendation[]; missing: string[]; note: string } {
  if (!(PACKAGES as readonly string[]).includes(input.package)) {
    throw new DomainError('CONTRACT_SELECTION_PACKAGE', `What is being bought: ${PACKAGES.join(', ')}.`, 422, [{ field: 'package', message: 'choose one' }]);
  }
  const scores = new Map<string, { score: number; reasons: string[] }>();
  const add = (key: string, score: number, reason: string) => {
    const entry = scores.get(key) ?? { score: 0, reasons: [] };
    entry.score += score;
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
    scores.set(key, entry);
  };
  const small = input.valueBand === 'SMALL';
  const big = input.valueBand === 'LARGE' || input.valueBand === 'MAJOR';
  const missing: string[] = [];

  switch (input.package) {
    case 'HOMEOWNER':
      add('jct:2021:ho-b', 5, 'Work for a homeowner, with no consultant administering it.');
      add('jct:2021:ho-c', 4, 'Work for a homeowner where an architect or surveyor administers it.');
      break;
    case 'CONSULTANCY':
      add(small ? `${NEC4}:pssc` : `${NEC4}:psc`, 5, small ? 'A straightforward, low-value appointment.' : 'A professional services appointment.');
      add('jct:2024:ca', 3, 'A consultant appointment on a public sector project.');
      if (input.international) add('fidic:2017-fifth-edition:white', 6, 'An international consultancy appointment.');
      break;
    case 'SUPPLY':
      add(small ? `${NEC4}:ssc` : `${NEC4}:sc`, 5, small ? 'Supply of goods of modest value and complexity.' : 'Supply of high-value goods or plant.');
      break;
    case 'TERM_SERVICES':
      add(small ? `${NEC4}:tssc` : `${NEC4}:tsc`, 5, 'Services over a term rather than a single project.');
      add('jct:2024:mtc', 4, 'Measured maintenance and minor works over a term.');
      if (small) add('jct:2024:rm', 3, 'Repair and maintenance of modest scope.');
      break;
    case 'SUBCONTRACT':
      if (!input.preferredSuite) missing.push('preferredSuite');
      if (input.preferredSuite !== 'JCT') add(small ? `${NEC4}:ecss` : `${NEC4}:ecs`, input.preferredSuite === 'NEC' ? 6 : 3, 'Back-to-back with an NEC4 main contract.');
      if (input.preferredSuite !== 'NEC') {
        if (small) add('jct:2024:shortsub', 4, 'A short, simple subcontract.');
        if (input.design === 'CONTRACTOR') add('jct:2024:dbsub-a', 5, 'The subcontractor designs, under a JCT design and build main contract.');
        else if (input.valueBand === 'MEDIUM') add('jct:2024:icsub-a', 4, 'Under a JCT Intermediate main contract.');
        else add('jct:2024:sbcsub-a', 4, 'Under a JCT Standard Building main contract.');
      }
      break;
    case 'MAIN_WORKS': {
      if (!input.design) missing.push('design');
      if (!input.pricing) missing.push('pricing');
      if (!input.valueBand) missing.push('valueBand');
      if (input.international || input.preferredSuite === 'FIDIC') {
        const why = input.international ? 'International works, where FIDIC is the usual basis.' : 'The FIDIC suite is preferred.';
        if (small) add('fidic:2021-second-edition:green', 6, `${why} Short and simple works.`);
        else if (input.design === 'CONTRACTOR') add(`${FIDIC17}:yellow`, 7, `${why} The contractor designs, including plant.`);
        else add(`${FIDIC17}:red`, 7, `${why} The employer designs.`);
        if (input.design === 'CONTRACTOR' && big) add(`${FIDIC17}:silver`, 4, `${why} A turnkey project where the contractor takes the risk of the whole.`);
      }
      if (input.pricing === 'TARGET_COST') {
        add(`${NEC4}:ecc`, 6, 'A target cost: NEC4 ECC options C or D.');
        add('jct:2024:tcc', 4, 'A target cost on JCT terms.');
      } else if (input.pricing === 'COST_REIMBURSABLE') {
        add(`${NEC4}:ecc`, 5, 'Paid at cost: NEC4 ECC option E.');
        add('jct:2024:pcc', 4, 'A prime cost building contract.');
      } else if (input.pricing === 'ACTIVITY_SCHEDULE') {
        add(small ? `${NEC4}:ecsc` : `${NEC4}:ecc`, 6, small ? 'Priced by activity on simple works.' : 'Priced by an activity schedule: NEC4 ECC option A.');
      }
      if (input.design === 'CONTRACTOR') {
        if (input.valueBand === 'MAJOR') add('jct:2024:mp', 5, 'A major project where the contractor designs, for an experienced employer.');
        if (small) add('jct:2024:mwd', 5, 'Minor works where the contractor designs part.');
        else add('jct:2024:db', 6, 'The contractor designs and builds.');
        add(`${NEC4}:ecc`, 3, 'NEC4 ECC with the contractor’s design in the Scope.');
      } else if (input.design === 'SHARED') {
        if (small) add('jct:2024:mwd', 5, 'Minor works with a contractor-designed portion.');
        else if (input.valueBand === 'MEDIUM') add('jct:2024:icd', 6, 'A contractor-designed portion within intermediate works.');
        else add(input.pricing === 'LUMP_SUM_WITH_QUANTITIES' ? 'jct:2024:sbc-q' : 'jct:2024:sbc-xq', 5, 'Large works with a contractor’s designed portion.');
      } else if (input.design === 'EMPLOYER') {
        if (input.pricing === 'REMEASURED') {
          add('jct:2024:sbc-aq', 6, 'Design not complete enough for firm quantities; remeasured.');
          add(`${NEC4}:ecc`, 4, 'Remeasured: NEC4 ECC option B.');
        } else if (small) add('jct:2024:mw', 6, 'Minor works, designed by the employer.');
        else if (input.valueBand === 'MEDIUM') add('jct:2024:ic', 6, 'Intermediate works, designed by the employer.');
        else if (input.pricing === 'LUMP_SUM_WITH_QUANTITIES') add('jct:2024:sbc-q', 6, 'Large works, designed by the employer, with a bill of quantities.');
        else add('jct:2024:sbc-xq', 6, 'Large works, designed by the employer, priced on drawings and specification.');
        if (input.pricing === 'LUMP_SUM_WITH_QUANTITIES') add(`${NEC4}:ecc`, 3, 'Priced by a bill of quantities: NEC4 ECC option B.');
      }
      if (!input.international && input.preferredSuite !== 'FIDIC' && !scores.has(`${NEC4}:ecc`) && !small) add(`${NEC4}:ecc`, 2, 'The NEC alternative for any works contract.');
      if (small && !scores.has(`${NEC4}:ecsc`)) add(`${NEC4}:ecsc`, 2, 'The NEC alternative for simple works.');
      break;
    }
  }
  if (input.preferredSuite) {
    const prefix = input.preferredSuite.toLowerCase();
    for (const [key, entry] of scores) if (key.startsWith(`${prefix}:`)) entry.score += 2;
  }
  if (input.tenderNamedFormKey) {
    const named = formByKey(input.tenderNamedFormKey);
    if (!named) throw new DomainError('CONTRACT_FORM_NOT_FOUND', 'The form the tender names is not in the catalogue.', 404);
    add(named.key, 100, 'The tender names this form: it is used unless the client agrees otherwise.');
  }
  const recommendations = [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 6)
    .map(([key, entry]) => {
      const form = formByKey(key)!;
      return { key, label: formLabel(form), status: form.status, ownSchedule: hasOwnSchedule(key), reasons: entry.reasons };
    })
    .filter((entry) => draftable(formByKey(entry.key)!));
  return {
    recommendations,
    missing,
    note: 'A starting point from what was described, not advice: confirm the exact form and edition, and the amendments, with whoever is accountable for the contract.',
  };
}

/** The catalogue, filtered, as the screen browses it. */
export function browse(filter: { q?: string; publisher?: string; type?: string; status?: string }): typeof CATALOGUE {
  const q = filter.q?.trim().toLowerCase();
  return CATALOGUE.filter(
    (entry) =>
      (!filter.publisher || entry.publisher === filter.publisher) &&
      (!filter.type || entry.type === filter.type) &&
      (!filter.status || entry.status === filter.status) &&
      (!q || `${entry.publisher} ${entry.code} ${entry.title} ${entry.edition}`.toLowerCase().includes(q)),
  );
}
