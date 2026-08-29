import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';

/**
 * Who is responsible for what, between the client and every contractor.
 *
 * The platform already knew which firm held which package: an award records
 * that, and a subcontract executes it. What it could not answer was the
 * question that is actually argued about on site, which is not *whose package
 * is this* but **whose duty is this** — and the two come apart in exactly the
 * places that cost money.
 *
 * Four failures, and this module exists to name them rather than to render a
 * table. A responsibility matrix that only lists what everybody already agrees
 * on is a document nobody opens twice.
 *
 * **Scope in nobody's package.** Between the piling package and the substructure
 * package there is a pile trim, and it is in neither. Both contractors priced
 * without it, both are right, and the argument happens with the excavation open.
 *
 * **Scope in two packages.** The reverse, and it is worse commercially: two
 * firms priced the same work, one of them will be paid for doing it, and the
 * other has a claim for being prevented from it.
 *
 * **A design responsibility marked SHARED and never split.** `createScopePackage`
 * accepts `CLIENT`, `CONTRACTOR` or `SHARED`, and `SHARED` is the single most
 * common origin of "I thought you were doing it". It is a legitimate answer to
 * the commercial question and an illegitimate answer to the technical one:
 * somebody has to produce each drawing.
 *
 * **A client obligation with no date.** Free issue, access, permits, existing
 * services, a decision. These are the client's own duties, they are the most
 * common cause of contractor delay claims, and an obligation with no date on it
 * is one nobody can be late on — which means it cannot be managed and cannot be
 * claimed against either.
 *
 * ---
 *
 * **Owned by the project manager and the construction manager.** Both hold
 * `C`, `U` and `A` on `WORKPACKAGES_TASKS`, and between them they are the two
 * people who answer for the interface: the PM to the client and the contract,
 * the construction manager to the sequence and the site. Recording it against a
 * narrower area would have put it with somebody who does not run the interface;
 * a wider one would have let anyone reading a project restate its obligations.
 *
 * **Derived where the platform already knows.** The packages come from
 * `ScopePackage` and the firms from the awards against them; this module records
 * only what neither can state — the obligation, the party carrying it, and where
 * in the contract it comes from. A second copy of the package list would be a
 * second thing to keep right.
 */

// --- Parties -----------------------------------------------------------------

/**
 * Three kinds of party, and the distinction is not cosmetic.
 *
 * The client is not a contractor with a different name: nothing is awarded to
 * them, no subcontract binds them, and their obligations are the ones this
 * business claims *against* rather than manages. The principal contractor is
 * this business, carrying whatever is not passed down. A subcontractor is a
 * named firm on the supply chain register, and naming it by id rather than by
 * text is what stops "Murphy" and "J Murphy & Sons" being two parties.
 */
export const PARTY_KIND = ['CLIENT', 'PRINCIPAL_CONTRACTOR', 'SUBCONTRACTOR'] as const;
export type PartyKind = (typeof PARTY_KIND)[number];

export type ResponsibleParty = {
  kind: PartyKind;
  /** As it would be written on a letter. */
  name: string;
  /** The supply chain register id, where the party is a firm on it. */
  supplierId?: string;
};

/**
 * What kind of obligation this is.
 *
 * Deliberately not a free-text label. The categories are the ones that carry
 * different consequences when they are missed: works is programme, design is
 * information, and the four after them are the client-side duties that turn
 * into delay claims.
 */
export const RESPONSIBILITY_CATEGORY = [
  'WORKS',
  'DESIGN',
  'TEMPORARY_WORKS',
  'FREE_ISSUE',
  'ACCESS',
  'PERMIT_OR_CONSENT',
  'EXISTING_SERVICES',
  'TESTING_AND_COMMISSIONING',
  'INSURANCE',
  'DECISION',
] as const;
export type ResponsibilityCategory = (typeof RESPONSIBILITY_CATEGORY)[number];

/** The categories that are an obligation *on* somebody by a date, not works. */
const DATED_CATEGORIES = new Set<ResponsibilityCategory>([
  'FREE_ISSUE',
  'ACCESS',
  'PERMIT_OR_CONSENT',
  'EXISTING_SERVICES',
  'DECISION',
]);

export type ResponsibilityItem = {
  id: string;
  /** The contractor's own reference for the line, e.g. `RM-014`. */
  reference: string;
  description: string;
  category: ResponsibilityCategory;
  party: ResponsibleParty;
  /** The scope package this sits in, where it sits in one. */
  packageId?: string;
  /** When the obligation falls due, for the categories that carry a date. */
  dueBy?: string;
  /** The clause or document it comes from. An assertion with no source is an opinion. */
  source?: string;
  assignedAt: string;
  assignedBy: string;
};

// --- Recording ---------------------------------------------------------------

function requireParty(input: { partyKind: PartyKind; partyName: string; supplierId?: string }): ResponsibleParty {
  const name = input.partyName.trim();
  if (name === '') {
    throw new DomainError('RESPONSIBILITY_PARTY_UNNAMED', 'A responsibility with no party against it is a note');
  }
  if (input.partyKind === 'SUBCONTRACTOR' && !input.supplierId) {
    throw new DomainError(
      'RESPONSIBILITY_SUPPLIER_REQUIRED',
      'A subcontractor is named from the supply chain register, not typed. Two spellings of one firm are two parties ' +
        'on this matrix and one firm on the job.',
    );
  }
  return {
    kind: input.partyKind,
    name,
    ...(input.supplierId ? { supplierId: input.supplierId } : {}),
  };
}

/**
 * Record that one obligation belongs to one party.
 *
 * Refuses a dated category with no date. That is the whole point of separating
 * free issue from works: an obligation nobody can be late on cannot be managed
 * and cannot be claimed against, and recording it without a date would produce
 * a matrix that looks complete and protects nobody.
 */
export function assignResponsibility(
  ctx: EngineContext,
  input: {
    reference: string;
    description: string;
    category: ResponsibilityCategory;
    partyKind: PartyKind;
    partyName: string;
    supplierId?: string;
    packageId?: string;
    dueBy?: string;
    source?: string;
  },
): { itemId: string } {
  authorise(ctx, 'WORKPACKAGES_TASKS', 'C');

  const reference = input.reference.trim();
  if (reference === '') {
    throw new DomainError('RESPONSIBILITY_REFERENCE_REQUIRED', 'Every line on the matrix carries its own reference');
  }

  const existing = ctx.ledger
    .list(ctx.projectId, 'ResponsibilityItem')
    .map((record) => record.state as unknown as ResponsibilityItem);

  if (existing.some((item) => item.reference === reference)) {
    throw new DomainError(
      'RESPONSIBILITY_REFERENCE_TAKEN',
      `${reference} is already on this matrix. Reassign it rather than adding a second line — two lines with one ` +
        'reference is how a matrix stops being able to answer who holds something.',
    );
  }

  if (DATED_CATEGORIES.has(input.category) && !input.dueBy) {
    throw new DomainError(
      'RESPONSIBILITY_DATE_REQUIRED',
      `A ${input.category.toLowerCase().replace(/_/g, ' ')} obligation needs the date it falls due. Without one ` +
        'nobody can be late on it, which means it cannot be chased and cannot be claimed against.',
    );
  }

  const party = requireParty(input);
  const itemId = ulid();

  write(ctx, {
    eventType: 'RESPONSIBILITY_ASSIGNED',
    entity: { refType: 'ResponsibilityItem', refId: itemId },
    nextState: {
      id: itemId,
      reference,
      description: input.description,
      category: input.category,
      party,
      ...(input.packageId ? { packageId: input.packageId } : {}),
      ...(input.dueBy ? { dueBy: input.dueBy } : {}),
      ...(input.source ? { source: input.source } : {}),
      assignedAt: new Date().toISOString(),
      assignedBy: ctx.auth.actorId,
    },
  });

  return { itemId };
}

/**
 * Move an obligation from one party to another, with the reason on the record.
 *
 * A separate command rather than an edit, and a separate event, because this is
 * the act somebody will be asked to justify. "It was always theirs" and "we
 * moved it to them in March" are different positions, and a matrix that
 * overwrote the first with the second could not tell them apart.
 */
export function reassignResponsibility(
  ctx: EngineContext,
  itemId: string,
  input: { partyKind: PartyKind; partyName: string; supplierId?: string; reason: string },
): { itemId: string; from: ResponsibleParty; to: ResponsibleParty } {
  authorise(ctx, 'WORKPACKAGES_TASKS', 'U');

  const record = ctx.ledger.get({ refType: 'ResponsibilityItem', refId: itemId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('RESPONSIBILITY_NOT_FOUND', `No responsibility item ${itemId}`, 404);
  }
  if (input.reason.trim().length < 8) {
    throw new DomainError(
      'RESPONSIBILITY_REASON_REQUIRED',
      'Moving a duty from one party to another is a position to be defended later. Say why.',
    );
  }

  const from = record.state.party as ResponsibleParty;
  const to = requireParty(input);

  write(ctx, {
    eventType: 'RESPONSIBILITY_REASSIGNED',
    entity: { refType: 'ResponsibilityItem', refId: itemId },
    reason: input.reason,
    nextState: {
      ...(record.state as Record<string, unknown>),
      party: to,
      reassignedAt: new Date().toISOString(),
      reassignedBy: ctx.auth.actorId,
      reassignedFrom: from,
      reassignmentReason: input.reason,
    },
  });

  return { itemId, from, to };
}

// --- Reading -----------------------------------------------------------------

export type ResponsibilityConcern = {
  kind: 'SCOPE_UNASSIGNED' | 'SCOPE_DOUBLE_ASSIGNED' | 'SHARED_DESIGN_UNSPLIT' | 'OBLIGATION_UNDATED';
  subject: string;
  /** What goes wrong if it stays like this, in the words somebody would use. */
  consequence: string;
};

export type ResponsibilityMatrix = {
  items: ResponsibilityItem[];
  /** Every party carrying anything, and how much of it. */
  parties: Array<ResponsibleParty & { items: number; dated: number; overdueOrUndated: number }>;
  concerns: ResponsibilityConcern[];
  summary: string;
};

/**
 * The matrix, and what is wrong with it.
 *
 * The concerns are the output. A reader who wants the table can read the table;
 * a project manager who opens this on a Monday wants the four lines that say
 * where this project is about to argue with itself.
 */
export function responsibilityMatrix(ctx: EngineContext, today?: string): ResponsibilityMatrix {
  authorise(ctx, 'WORKPACKAGES_TASKS', 'R');

  const items = ctx.ledger
    .list(ctx.projectId, 'ResponsibilityItem')
    .map((record) => record.state as unknown as ResponsibilityItem)
    .sort((a, b) => a.reference.localeCompare(b.reference));

  const packages = ctx.ledger.list(ctx.projectId, 'ScopePackage').map((record) => record.state);
  const day = (today ?? new Date().toISOString()).slice(0, 10);
  const concerns: ResponsibilityConcern[] = [];

  // A package nobody has been made responsible for. Derived rather than
  // recorded: the packages are already on the project, so a matrix that simply
  // omitted one would look complete.
  const covered = new Set(items.map((item) => item.packageId).filter(Boolean));
  for (const scopePackage of packages) {
    const id = String(scopePackage.id ?? '');
    if (id === '' || covered.has(id)) continue;
    concerns.push({
      kind: 'SCOPE_UNASSIGNED',
      subject: `${String(scopePackage.name ?? id)} has no party against it`,
      consequence:
        'Every firm on the job priced around this package and none of them priced it. The work still has to be ' +
        'done, and whoever is nearest to it when that is noticed will be asked to absorb it.',
    });
  }

  // The same package held by two different parties. Not an error at recording
  // time — a package legitimately splits — but two *whole* holdings of one
  // package is two firms who both think it is theirs.
  const byPackage = new Map<string, Set<string>>();
  for (const item of items) {
    if (!item.packageId || item.category !== 'WORKS') continue;
    const key = item.party.supplierId ?? `${item.party.kind}:${item.party.name}`;
    const held = byPackage.get(item.packageId) ?? new Set<string>();
    held.add(key);
    byPackage.set(item.packageId, held);
  }
  for (const [packageId, holders] of byPackage) {
    if (holders.size < 2) continue;
    const name = String(packages.find((p) => String(p.id) === packageId)?.name ?? packageId);
    const names = items
      .filter((item) => item.packageId === packageId && item.category === 'WORKS')
      .map((item) => item.party.name);
    concerns.push({
      kind: 'SCOPE_DOUBLE_ASSIGNED',
      subject: `${name} is held by ${[...new Set(names)].join(' and ')}`,
      consequence:
        'Two firms have priced the same works. One will be paid for doing it and the other has a claim for being ' +
        'prevented from it, and both are entitled to make it.',
    });
  }

  // A design responsibility recorded as SHARED with nothing splitting it.
  // SHARED is a real commercial answer and never a technical one.
  for (const scopePackage of packages) {
    if (scopePackage.designResponsibility !== 'SHARED') continue;
    const id = String(scopePackage.id ?? '');
    const split = items.some((item) => item.packageId === id && item.category === 'DESIGN');
    if (split) continue;
    concerns.push({
      kind: 'SHARED_DESIGN_UNSPLIT',
      subject: `${String(scopePackage.name ?? id)} carries shared design responsibility and no split`,
      consequence:
        'Shared is an answer to who pays and not to who draws it. Somebody has to produce each drawing, and the ' +
        'gap is found at the point the drawing is needed.',
    });
  }

  // A client-side obligation that has come due, or is undated despite the
  // recording rule — the latter only reachable on data recorded before the rule
  // existed, and worth reporting rather than assuming away.
  for (const item of items) {
    if (!DATED_CATEGORIES.has(item.category)) continue;
    if (!item.dueBy) {
      concerns.push({
        kind: 'OBLIGATION_UNDATED',
        subject: `${item.reference} — ${item.description} — carries no date`,
        consequence: 'Nobody can be late on it, so it cannot be chased and cannot be claimed against.',
      });
      continue;
    }
    if (item.dueBy >= day) continue;
    concerns.push({
      kind: 'OBLIGATION_UNDATED',
      subject: `${item.reference} — ${item.party.name} was due to provide "${item.description}" by ${item.dueBy}`,
      consequence:
        item.party.kind === 'CLIENT'
          ? 'A client obligation past its date is the most common root of a contractor delay claim, and the notice ' +
            'clock has usually already started.'
          : 'An obligation past its date on a party this business is responsible for is this business’s delay.',
    });
  }

  // Every party carrying something, with the shape of what they carry.
  const parties = new Map<string, ResponsibleParty & { items: number; dated: number; overdueOrUndated: number }>();
  for (const item of items) {
    const key = item.party.supplierId ?? `${item.party.kind}:${item.party.name}`;
    const entry = parties.get(key) ?? { ...item.party, items: 0, dated: 0, overdueOrUndated: 0 };
    entry.items += 1;
    if (DATED_CATEGORIES.has(item.category)) {
      entry.dated += 1;
      if (!item.dueBy || item.dueBy < day) entry.overdueOrUndated += 1;
    }
    parties.set(key, entry);
  }

  const summary =
    items.length === 0
      ? `Nothing is recorded against a party on this project${packages.length > 0 ? `, and ${packages.length} scope package(s) are waiting for one` : ''}.`
      : `${items.length} obligation(s) across ${parties.size} part${parties.size === 1 ? 'y' : 'ies'}` +
        `${concerns.length > 0 ? `, and ${concerns.length} thing(s) this project has not settled` : ', with nothing outstanding'}.`;

  return {
    items,
    parties: [...parties.values()].sort((a, b) => b.items - a.items),
    concerns,
    summary,
  };
}
