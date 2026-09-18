import { DomainError } from '../core/errors.ts';
import { hashEvidence } from '../core/canonical.ts';
import { ulid } from '../core/ids.ts';
import { authorise, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import type { LifecyclePhase } from '../lifecycle/phases.ts';

/**
 * What tender information is allowed to do after the job is won.
 *
 * ## The failure this exists to prevent
 *
 * A drawing issued during a tender is a *proposal*. It was produced to price
 * the work, by a designer who may not have been appointed, against information
 * that may not have been complete, and nobody has checked it against the
 * contract because there was no contract.
 *
 * Winning the job does not change any of that. But the moment a project
 * converts to delivery, every one of those drawings is sitting in the same
 * project as the construction information — same register, same search, same
 * "latest revision" — and the only thing standing between a tender proposal and
 * somebody building from it is that a person happens to remember which is which.
 *
 * That is a physical-safety exposure rather than a data one. It is also the
 * specification's §6.2, in its own words: *a document marked Proposed during
 * Tender cannot become Approved for Construction solely because the project was
 * won.*
 *
 * ## How it is prevented
 *
 * Every piece of information that existed before award gets an **inheritance
 * decision** at the moment of conversion, and every one of them starts at
 * `REQUIRES_VALIDATION`. Not `ACCEPTED_CONTRACT`, not "approved", not "carried
 * over". Conversion is not permitted to grant authority — it can only record
 * that the question now exists.
 *
 * `constructionAuthority()` is the single function that answers "may somebody
 * build from this", and it answers no for everything except an item a named
 * person has explicitly accepted into the contract, with a rationale, after
 * award.
 *
 * ## Inherited by reference, never copied
 *
 * §6 is explicit and it is right: the system must not copy uncontrolled
 * document binaries merely to change their stage. A decision points at the
 * source item and the source version. The drawing stays exactly where it is, at
 * the revision it was, and the decision is a separate record beside it — so the
 * tender record remains readable as what was actually tendered, which is the
 * whole reason the tender baseline is frozen.
 */

/**
 * The eight dispositions, and what each permits.
 *
 * A closed table. `constructionAuthority` and every screen read `authority`
 * from here rather than deciding for themselves, so there is one answer to what
 * a disposition means — and adding a ninth disposition is a decision somebody
 * makes here rather than a string somebody types at a call site.
 */
export const DISPOSITION = {
  ACCEPTED_CONTRACT: {
    label: 'Accepted into the contract',
    meaning: 'Explicitly incorporated into the contract',
    /** The only one that may drive contractual or construction controls. */
    authority: true,
    /** Whether it still needs somebody to do something. */
    open: false,
    /** Whether it is visible in active delivery views. */
    active: true,
  },
  REQUIRES_VALIDATION: {
    label: 'Requires validation',
    meaning: 'Relevant, but not validated for delivery. Visible with a warning; cannot be construction authority.',
    authority: false,
    open: true,
    active: true,
  },
  REQUIRES_REDESIGN: {
    label: 'Requires redesign',
    meaning: 'The tender solution must be developed or replaced. Creates a design action with an owner.',
    authority: false,
    open: true,
    active: true,
  },
  SUPERSEDED: {
    label: 'Superseded',
    meaning: 'Replaced by a later controlled item. Read-only history.',
    authority: false,
    open: false,
    active: false,
  },
  REJECTED: {
    label: 'Rejected',
    meaning: 'Not accepted into delivery. Excluded from active views, retained in history.',
    authority: false,
    open: false,
    active: false,
  },
  INFORMATION_ONLY: {
    label: 'Information only',
    meaning: 'Context. Cannot trigger an approval or a payment.',
    authority: false,
    open: false,
    active: true,
  },
  AWAITING_CLIENT: {
    label: 'Awaiting client confirmation',
    meaning: 'Needs the client to confirm. Creates an RFI or a decision action.',
    authority: false,
    open: true,
    active: true,
  },
  NOT_APPLICABLE: {
    label: 'Not applicable after award',
    meaning: 'Not relevant once the contract was signed. Retained with the reason.',
    authority: false,
    open: false,
    active: false,
  },
} as const;

export type Disposition = keyof typeof DISPOSITION;

export const DISPOSITION_CODES = Object.keys(DISPOSITION) as Disposition[];

/**
 * The entity types that carry pre-award information into delivery.
 *
 * A fixed list rather than "everything in the ledger", for the reason every
 * fixed list on this platform exists: a set that silently grew when an
 * unrelated feature shipped would make two projects' inheritance registers
 * incomparable, and "we validated the inherited information" would mean
 * something different each time.
 *
 * These are the ones a person can build, price or certify from. A payment
 * certificate is not on the list because nobody designs from one.
 */
export const INHERITABLE: ReadonlyArray<{ refType: string; what: string }> = [
  { refType: 'Drawing', what: 'a drawing issued for the tender' },
  { refType: 'Specification', what: 'a specification supplied with the tender' },
  { refType: 'InformationContainer', what: 'a container deposited before award' },
  { refType: 'BoQItem', what: 'a measured item from the tender take-off' },
  { refType: 'DesignMaturityAssessment', what: 'a maturity assessment made while pricing' },
  { refType: 'ScopePackage', what: 'a scope package defined before award' },
  { refType: 'RiskRegisterItem', what: 'a risk priced into the tender' },
];

const INHERITABLE_TYPES = new Set(INHERITABLE.map((entry) => entry.refType));

/** One inherited item, as §6.1 requires it to be recorded. */
export type InheritanceRecord = {
  id: string;
  projectId: string;
  /** What it points at — never a copy of it. */
  sourceRefType: string;
  sourceItemId: string;
  sourceVersion: number;
  /** Where it came from, so a reader knows what kind of information this was. */
  sourceStage: LifecyclePhase;
  sourceWorkstream: string;
  originatingOrganisation?: string;
  author?: string;
  receivedAt?: string;
  effectiveAt?: string;
  tenderReference?: string;
  contractIncorporationReference?: string;
  disposition: Disposition;
  decidedBy?: string;
  decidedAt?: string;
  rationale?: string;
  supersededByItemId?: string;
  /** A human label, so a register is readable without resolving every id. */
  label: string;
};

/**
 * Open the inheritance register at conversion.
 *
 * Called by `convertToDelivery`, once, with everything the project held before
 * award. Every record starts `REQUIRES_VALIDATION` — the one thing this
 * function must never do is grant authority, because granting authority
 * automatically at award is precisely the defect the register exists to stop.
 *
 * Returns the number of items, which the conversion receipt carries: "forty-one
 * inherited items awaiting validation" is a number somebody acts on, and a
 * register nobody knows exists is a register nobody opens.
 */
export function openInheritanceRegister(
  ctx: EngineContext,
  input: { sourceStage: LifecyclePhase; at: string },
): { registerId: string; items: number } {
  const records: InheritanceRecord[] = [];

  for (const { refType } of INHERITABLE) {
    for (const record of ctx.ledger.list(ctx.projectId, refType)) {
      const state = record.state as Record<string, unknown>;
      records.push({
        id: ulid(),
        projectId: ctx.projectId,
        sourceRefType: refType,
        sourceItemId: record.refId,
        // The version at award. A later revision of the same item is a
        // different thing and gets its own decision rather than inheriting
        // this one's — which is what stops an accepted drawing silently
        // covering the revision that replaced it.
        sourceVersion: Number(record.version ?? 1),
        sourceStage: input.sourceStage,
        sourceWorkstream: 'TENDER',
        originatingOrganisation: (state.originatingOrganisation as string | undefined) ?? undefined,
        author: (state.author as string | undefined) ?? (state.registeredBy as string | undefined) ?? undefined,
        receivedAt: (state.registeredAt as string | undefined) ?? (state.createdAt as string | undefined) ?? undefined,
        effectiveAt: undefined,
        tenderReference: (state.reference as string | undefined) ?? undefined,
        contractIncorporationReference: undefined,
        // §6.2, and the whole point of the module.
        disposition: 'REQUIRES_VALIDATION',
        decidedBy: undefined,
        decidedAt: undefined,
        rationale: undefined,
        label: describe(refType, state),
      });
    }
  }

  const registerId = ulid();
  write(ctx, {
    eventType: 'INHERITANCE_REGISTER_OPENED',
    entity: { refType: 'InheritanceRegister', refId: registerId },
    nextState: {
      id: registerId,
      projectId: ctx.projectId,
      openedAt: input.at,
      openedBy: ctx.auth.actorId,
      sourceStage: input.sourceStage,
      records,
    },
  });

  return { registerId, items: records.length };
}

/** A readable name for an item, from whichever field its type calls its name. */
function describe(refType: string, state: Record<string, unknown>): string {
  const number = state.drawingNumber ?? state.reference ?? state.code;
  const title = state.title ?? state.name ?? state.description;
  const revision = state.revision ? ` rev ${String(state.revision)}` : '';
  if (number && title) return `${String(number)}${revision} — ${String(title)}`;
  if (title) return String(title);
  if (number) return `${String(number)}${revision}`;
  return refType;
}

/**
 * Decide what one inherited item may be used for.
 *
 * The rationale is required on every disposition, not only on the permissive
 * one. "Why is this only information" is asked as often as "why did we accept
 * this", and an inheritance register full of decisions with no reasons is a
 * register that proves somebody clicked rather than that somebody looked.
 *
 * Accepting an item into the contract additionally requires the contract
 * reference it was incorporated by, because "accepted into the contract" with
 * nothing naming where is the claim this register exists to make checkable.
 */
export function decideInheritance(
  ctx: EngineContext,
  input: {
    registerId: string;
    recordId: string;
    disposition: Disposition;
    rationale: string;
    /** Required for ACCEPTED_CONTRACT: the clause, appendix or schedule it entered by. */
    contractIncorporationReference?: string;
    supersededByItemId?: string;
  },
): { recordId: string; disposition: Disposition; authority: boolean } {
  /*
   * `A` on DESIGN_INFORMATION, not `U`.
   *
   * Deciding that a tender drawing may be built from is an approval, and the
   * specification's §9 gives design-information acceptance to the design
   * manager rather than to anybody who can edit a record. The permission matrix
   * already draws that line; this reads it rather than inventing a second one.
   */
  authorise(ctx, 'DESIGN_INFORMATION', 'A');

  if (!DISPOSITION[input.disposition]) {
    throw new DomainError('DISPOSITION_UNKNOWN', `"${input.disposition}" is not a disposition`, 422, [
      { field: 'disposition', message: `Expected one of ${DISPOSITION_CODES.join(', ')}` },
    ]);
  }
  if (input.rationale.trim().length < 10) {
    throw new DomainError(
      'INHERITANCE_RATIONALE_REQUIRED',
      'Say why. A register of decisions with no reasons proves somebody clicked, not that somebody looked.',
      422,
      [{ field: 'rationale', message: 'Required, and long enough to be read' }],
    );
  }
  if (input.disposition === 'ACCEPTED_CONTRACT' && !(input.contractIncorporationReference ?? '').trim()) {
    throw new DomainError(
      'CONTRACT_REFERENCE_REQUIRED',
      'Accepting tender information into the contract needs the clause, appendix or schedule it was incorporated by. ' +
        '"Accepted into the contract" with nothing naming where is the claim this register exists to make checkable.',
      422,
      [{ field: 'contractIncorporationReference', message: 'Required when accepting into the contract' }],
    );
  }

  const register = ctx.ledger.require({ refType: 'InheritanceRegister', refId: input.registerId });
  const records = (register.state.records as InheritanceRecord[]) ?? [];
  const target = records.find((record) => record.id === input.recordId);
  if (!target) {
    throw new DomainError('INHERITANCE_RECORD_UNKNOWN', `No inherited item ${input.recordId} on this register`, 404);
  }

  const now = new Date().toISOString();
  const evidence = registerEvidence(ctx, {
    type: 'INHERITANCE_DECISION',
    hash: hashEvidence(JSON.stringify({ record: input.recordId, disposition: input.disposition, rationale: input.rationale })),
    description: `${target.label}: ${DISPOSITION[input.disposition].label}`,
    linkedEntities: [{ refType: target.sourceRefType, refId: target.sourceItemId }],
  });

  write(ctx, {
    eventType: 'INHERITANCE_DECIDED',
    entity: { refType: 'InheritanceRegister', refId: input.registerId },
    nextState: {
      ...register.state,
      records: records.map((record) =>
        record.id === input.recordId
          ? {
              ...record,
              disposition: input.disposition,
              rationale: input.rationale,
              decidedBy: ctx.auth.actorId,
              decidedAt: now,
              contractIncorporationReference: input.contractIncorporationReference,
              supersededByItemId: input.supersededByItemId,
            }
          : record,
      ),
    },
    evidenceRefs: [evidence],
  });

  return { recordId: input.recordId, disposition: input.disposition, authority: DISPOSITION[input.disposition].authority };
}

/**
 * May somebody build from this item?
 *
 * The single answer, so no screen and no engine decides for itself. An item
 * that was never inherited — produced after award, under the contract — is not
 * this module's business and gets `true`: the register governs what came *from*
 * the tender, not everything that exists.
 *
 * An item that *was* inherited gets its disposition's answer, which is `false`
 * for seven of the eight.
 */
export function constructionAuthority(
  ctx: EngineContext,
  source: { refType: string; refId: string },
): { permitted: boolean; disposition?: Disposition; reason: string } {
  if (!INHERITABLE_TYPES.has(source.refType)) {
    return { permitted: true, reason: 'Not a type this register governs.' };
  }

  const register = ctx.ledger.list(ctx.projectId, 'InheritanceRegister').at(-1);
  if (!register) {
    return { permitted: true, reason: 'This project has not been through a contract award, so nothing was inherited.' };
  }

  const records = (register.state.records as InheritanceRecord[]) ?? [];
  const found = records.find((record) => record.sourceItemId === source.refId);
  if (!found) {
    return { permitted: true, reason: 'Produced after award, so it is not inherited tender information.' };
  }

  const meta = DISPOSITION[found.disposition];
  return {
    permitted: meta.authority,
    disposition: found.disposition,
    reason: meta.authority
      ? `Accepted into the contract${found.contractIncorporationReference ? ` by ${found.contractIncorporationReference}` : ''}.`
      : `${found.label} is tender information marked "${meta.label}". ${meta.meaning}`,
  };
}

/**
 * Refuse an act that would treat unvalidated tender information as authority.
 *
 * The enforcement point. `constructionAuthority` answers the question; this one
 * is what a command calls when the answer has to stop it — FR-016 and BR-006,
 * which is to say: a tender drawing cannot become issued-for-construction by
 * anything other than a person deciding it is.
 */
export function assertConstructionAuthority(
  ctx: EngineContext,
  source: { refType: string; refId: string },
): void {
  const answer = constructionAuthority(ctx, source);
  if (answer.permitted) return;
  throw new DomainError('INHERITANCE_UNDECIDED', answer.reason, 422, [
    { field: 'disposition', message: 'Decide this item into the contract before building from it' },
  ]);
}

/**
 * The eight dispositions as a screen needs them — code, label, what it means,
 * and whether choosing it grants construction authority.
 *
 * Published rather than restated in the browser. A console that held its own
 * copy of this list would be a second answer to what a disposition permits, and
 * the first time the two disagreed the form would offer somebody an option that
 * means something different from what it says.
 */
export function dispositionCatalogue(): Array<{
  code: Disposition;
  label: string;
  meaning: string;
  authority: boolean;
  open: boolean;
}> {
  return DISPOSITION_CODES.map((code) => ({
    code,
    label: DISPOSITION[code].label,
    meaning: DISPOSITION[code].meaning,
    authority: DISPOSITION[code].authority,
    open: DISPOSITION[code].open,
  }));
}

/** The register as a position, with what is still open named. */
export function inheritanceRegister(ctx: EngineContext): {
  registerId?: string;
  records: InheritanceRecord[];
  open: number;
  authoritative: number;
  completePercent: number | null;
  dispositions: ReturnType<typeof dispositionCatalogue>;
  summary: string;
} | null {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const register = ctx.ledger.list(ctx.projectId, 'InheritanceRegister').at(-1);
  if (!register) return null;

  const records = (register.state.records as InheritanceRecord[]) ?? [];
  const open = records.filter((record) => DISPOSITION[record.disposition].open).length;
  const authoritative = records.filter((record) => DISPOSITION[record.disposition].authority).length;

  return {
    registerId: register.refId,
    records,
    open,
    authoritative,
    completePercent: records.length === 0 ? null : Math.round(((records.length - open) / records.length) * 1000) / 10,
    dispositions: dispositionCatalogue(),
    summary:
      `${records.length} item${records.length === 1 ? '' : 's'} inherited from the tender, ` +
      `${open} still awaiting a decision, ${authoritative} accepted into the contract.`,
  };
}

/**
 * Inherited items that still cannot be built from.
 *
 * The list rather than the count, because a start-work authorisation that says
 * "three items are unvalidated" sends somebody looking, and one that names them
 * sends somebody to the right three.
 *
 * `open` rather than `!authority`: an item marked `REJECTED` or `NOT_APPLICABLE`
 * has been decided and is not holding anything up. What blocks a start is an
 * item nobody has looked at yet.
 */
export function unvalidatedTenderInformation(ctx: EngineContext): InheritanceRecord[] {
  const register = ctx.ledger.list(ctx.projectId, 'InheritanceRegister').at(-1);
  if (!register) return [];
  const records = (register.state.records as InheritanceRecord[]) ?? [];
  return records.filter((record) => DISPOSITION[record.disposition].open);
}
