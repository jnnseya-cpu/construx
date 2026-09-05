import { DomainError, ForbiddenError } from '../../core/errors.ts';
import { authorise, type EngineContext } from '../../engines/context.ts';
import type { AuthContext } from '../../identity/auth.ts';
import { requireModule } from '../../identity/modules.ts';
import { scopesForRoles } from '../../identity/scopes.ts';
import type { Platform } from '../../platform.ts';
import { cashPosition } from './cash.ts';
import { commandCentre } from './commandcentre.ts';
import { assessValuation, commercialPosition } from './commercial.ts';
import type { SupplierEngagement } from './procurement.ts';

/**
 * §13 Supplier Portal — the supplier's own sign-in.
 *
 * The portal had been an internal view: a Meridian buyer chose a supplier from
 * a list and saw that supplier's obligations. What was missing was the other
 * direction — a person from the supplier signing in and seeing their own firm
 * and nobody else's. The pieces existed separately: external project
 * invitations create a full identity with the `SUPPLIER` role, and every
 * identity carries a `partyId` that the token describes as "the supplier
 * confinement anchor". This file is the join.
 *
 * **The link is the party.** A supplier on the register has a `partyId`; an
 * invitation that names the supplier gives the accepted identity the same
 * `partyId`; the portal resolves the signed-in person to their firm by it. No
 * second table of "who belongs to whom", and nothing a person types at
 * sign-in decides which firm they see.
 *
 * **A supplier sees one firm.** A `SUPPLIER` caller is scoped to the firm the
 * party resolves to, whatever `supplierId` the request carries, and a request
 * naming another firm is refused rather than ignored. A `SUPPLIER` whose party
 * resolves to nothing is refused with the reason, not shown an empty portal.
 *
 * **The reads run under the reading authority the panel needs, and the caller's
 * own authority is checked first.** The `SUPPLIER` role holds no
 * `SITE_SERVICES` capability, deliberately: granting it would open every
 * site-services read on the project — the brief, every package, every firm's
 * engagement — to every supplier. So the portal authorises the caller on
 * `SUPPLIER_SUBMISSION`, then assembles the panel under a commercial reader
 * and hands back only what is filtered to the one firm. The panel filter is
 * `commandCentre`'s own; the payment state below is filtered here by the
 * lines the firm's award attaches to.
 *
 * **Payment state is attributed by award.** A contract line belongs to the
 * firm whose engagement on the line's package reached Contracted. What a
 * certificate carries for those lines is the accepted movement on them, less
 * any approved service credit against them. Where a certificate also carries
 * other firms' lines, what has been paid on it is apportioned by the firm's
 * share of the certified sum, and the record says the figure is apportioned.
 */

export type SupplierIdentity = { supplierId: string; legalName: string; partyId: string };

type RegisteredSupplier = { id: string; legalName: string; partyId?: string; status: string };

const AWARDED = new Set(['CONTRACTED', 'MOBILISING', 'OPERATIONAL', 'CLOSED']);

function register(platform: Platform, tenantId: string): RegisteredSupplier[] {
  return platform.ledger.listByTenant(tenantId, 'Supplier').map((record) => record.state as unknown as RegisteredSupplier);
}

/** The firm a signed-in identity belongs to, by party. Nothing where the party matches no supplier. */
export function linkedSupplier(platform: Platform, auth: AuthContext): SupplierIdentity | undefined {
  if (!auth.partyId) return undefined;
  const found = register(platform, auth.tenantId).find((entry) => entry.partyId === auth.partyId);
  return found ? { supplierId: found.id, legalName: found.legalName, partyId: auth.partyId } : undefined;
}

/**
 * The authority the panel is assembled under: a commercial reader's, with that
 * role's own scopes, on the caller's own identity. Reads only — nothing here
 * writes, so nothing is attributed to the reader that they did not do.
 */
function readerContext(platform: Platform, ctx: EngineContext): EngineContext {
  return platform.context(
    { ...ctx.auth, roles: ['COMMERCIAL_MANAGER'], scopes: scopesForRoles(['COMMERCIAL_MANAGER']) },
    ctx.projectId,
    { correlationId: ctx.correlationId, source: ctx.source },
  );
}

export type PaymentState = {
  /** The lines the firm's award attaches to. */
  lines: { id: string; reference: string; description: string; packageId: string; commitmentMinor: number; earnedMinor: number; certifiedMinor: number }[];
  valuations: {
    id: string;
    reference: string;
    periodTo: string;
    status: string;
    payer?: string;
    /** Certified for this firm's lines on this valuation. */
    certifiedMinor: number;
    /** Paid on this valuation, apportioned to the firm where the valuation carries others' lines too. */
    paidMinor: number;
    outstandingMinor: number;
    apportioned: boolean;
  }[];
  totals: { commitmentMinor: number; earnedMinor: number; certifiedMinor: number; paidMinor: number; outstandingMinor: number; accruedMinor: number };
  statement: string;
};

export type SupplierPortal = {
  supplier: SupplierIdentity | { supplierId: string; legalName: string };
  /** How the caller came to see this firm. */
  scopedBy: 'SIGN_IN' | 'CHOICE';
  panel: ReturnType<typeof commandCentre>;
  payment: PaymentState;
};

function paymentState(reader: EngineContext, supplierId: string): PaymentState {
  const engagements = reader.ledger
    .list(reader.projectId, 'SupplierEngagement')
    .map((record) => record.state as unknown as SupplierEngagement)
    .filter((entry) => entry.supplierId === supplierId);
  const awardedPackages = new Set(
    engagements.filter((entry) => AWARDED.has(entry.state) || entry.history.some((step) => AWARDED.has(step.state))).map((entry) => entry.packageId),
  );

  const money = commercialPosition(reader);
  const cash = cashPosition(reader);
  const lines = money.lines.filter((line) => awardedPackages.has(line.packageId));
  const lineIds = new Set(lines.map((line) => line.id));

  // Certified per line, from the certificates themselves: the accepted
  // movement each certificate carried for the line, less any approved credit
  // against it. `commercialPosition` declines to split a certificate by line
  // because it has no line-level certificate to point at; this is the same
  // arithmetic the certificate was issued on, read back per line, and it is
  // what a firm asking "what was certified for me" actually means.
  const certifiedByLine = new Map<string, number>();
  const valuations: PaymentState['valuations'] = [];
  for (const held of cash.valuations) {
    if (held.status !== 'CERTIFIED') continue;
    const assessment = assessValuation(reader, held.id);
    let movement = 0;
    for (const line of assessment.lines) {
      if (!lineIds.has(line.lineId)) continue;
      movement += line.movementMinor;
      certifiedByLine.set(line.lineId, (certifiedByLine.get(line.lineId) ?? 0) + line.movementMinor);
    }
    let credits = 0;
    for (const entry of assessment.exceptions) {
      if (entry.kind !== 'KPI_DEDUCTION' || !lineIds.has(entry.lineId)) continue;
      credits += entry.effectMinor;
      certifiedByLine.set(entry.lineId, (certifiedByLine.get(entry.lineId) ?? 0) + entry.effectMinor);
    }
    const own = movement + credits;
    if (own === 0 && !assessment.lines.some((line) => lineIds.has(line.lineId))) continue;
    const apportioned = held.certifiedMinor !== own;
    const paid = held.certifiedMinor > 0 ? Math.round((held.paidMinor * own) / held.certifiedMinor) : 0;
    valuations.push({
      id: held.id,
      reference: held.reference,
      periodTo: assessment.periodTo,
      status: held.status,
      ...(held.payer ? { payer: held.payer } : {}),
      certifiedMinor: own,
      paidMinor: paid,
      outstandingMinor: Math.max(0, own - paid),
      apportioned,
    });
  }

  const totals = {
    commitmentMinor: lines.reduce((sum, line) => sum + line.commitmentMinor, 0),
    earnedMinor: lines.reduce((sum, line) => sum + line.earnedMinor, 0),
    certifiedMinor: valuations.reduce((sum, entry) => sum + entry.certifiedMinor, 0),
    paidMinor: valuations.reduce((sum, entry) => sum + entry.paidMinor, 0),
    outstandingMinor: valuations.reduce((sum, entry) => sum + entry.outstandingMinor, 0),
    accruedMinor: 0,
  };
  totals.accruedMinor = Math.max(0, totals.earnedMinor - totals.certifiedMinor);

  const major = (minor: number): string => `${lines[0]?.currency ?? 'GBP'} ${(minor / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const statement =
    lines.length === 0
      ? 'No contract line is attached to this firm’s award on this project, so nothing is owed against one.'
      : `${lines.length} contract line${lines.length === 1 ? '' : 's'} under award: ${major(totals.earnedMinor)} earned, ${major(totals.certifiedMinor)} certified, ${major(totals.paidMinor)} paid, ${major(totals.outstandingMinor)} certified and unpaid.${
          totals.accruedMinor > 0 ? ` ${major(totals.accruedMinor)} earned above certified is accrual, not cash.` : ''
        }${valuations.some((entry) => entry.apportioned) ? ' Where a certificate carries other firms’ lines too, what was paid on it is apportioned by this firm’s share of the certified sum.' : ''}`;

  return {
    lines: lines.map((line) => ({
      id: line.id,
      reference: line.reference,
      description: line.description,
      packageId: line.packageId,
      commitmentMinor: line.commitmentMinor,
      earnedMinor: line.earnedMinor,
      certifiedMinor: certifiedByLine.get(line.id) ?? 0,
    })),
    valuations,
    totals,
    statement,
  };
}

/**
 * The portal, for whoever is asking.
 *
 * A `SUPPLIER` sees the firm their party resolves to and no other. Anyone else
 * needs the site-services read and has to name the firm — the internal view
 * the buyer already had, now carrying the payment state too.
 */
export function supplierPortal(platform: Platform, ctx: EngineContext, options: { supplierId?: string; today?: string } = {}): SupplierPortal {
  requireModule(ctx.grantedModules, 'ETABLIX');

  if (ctx.auth.roles.includes('SUPPLIER')) {
    authorise(ctx, 'SUPPLIER_SUBMISSION', 'R');
    const own = linkedSupplier(platform, ctx.auth);
    if (!own) {
      throw new ForbiddenError(
        'This sign-in belongs to no firm on the supply-chain register. A supplier identity is linked to its firm by the invitation that created it; ask whoever invited you to link it.',
        'SUPPLIER_UNLINKED',
      );
    }
    if (options.supplierId !== undefined && options.supplierId !== own.supplierId) {
      throw new ForbiddenError(`This sign-in is ${own.legalName}’s. It sees ${own.legalName}’s obligations and nobody else’s.`, 'SUPPLIER_SCOPE');
    }
    const reader = readerContext(platform, ctx);
    return {
      supplier: own,
      scopedBy: 'SIGN_IN',
      panel: commandCentre(reader, 'SUPPLIER_PORTAL', { supplierId: own.supplierId, ...(options.today ? { today: options.today } : {}) }),
      payment: paymentState(reader, own.supplierId),
    };
  }

  authorise(ctx, 'SITE_SERVICES', 'R');
  if (options.supplierId === undefined) {
    throw new DomainError(
      'SUPPLIER_REQUIRED',
      'The supplier portal is one supplier’s obligations. Name the supplier: an unscoped portal would show every supplier their competitors’ position.',
    );
  }
  const named = register(platform, ctx.tenantId).find((entry) => entry.id === options.supplierId);
  if (!named) throw new DomainError('SUPPLIER_NOT_FOUND', 'No such supplier on the register', 404);
  // The internal reader holds the site-services read; the payment state is
  // commercial and is read under the same commercial standing every other
  // commercial read on the screen needs.
  authorise(ctx, 'SITE_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  return {
    supplier: { supplierId: named.id, legalName: named.legalName },
    scopedBy: 'CHOICE',
    panel: commandCentre(ctx, 'SUPPLIER_PORTAL', { supplierId: named.id, ...(options.today ? { today: options.today } : {}) }),
    payment: paymentState(ctx, named.id),
  };
}
