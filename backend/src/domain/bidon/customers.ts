import { DomainError } from '../../core/errors.ts';
import { formatRef, ulid } from '../../core/ids.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import { requireModule, requireModuleReadable } from '../../identity/modules.ts';
import type { EntityRecord } from '../../goldenthread/ledger.ts';
import { engagementsOf, type Engagement } from './engagements.ts';

/**
 * The provider's external customers, each in its own workspace.
 *
 * ## The wall this file exists to build
 *
 * A provider using Bid-On is writing bids for firms that compete with each
 * other. Two SME electrical contractors chasing the same grid framework may
 * both be customers of the same bid writer, and each has handed over its
 * accident statistics, its insurance values, its case studies and its CVs.
 *
 * Tenant isolation does not help here: both customers are inside *one* tenancy,
 * the provider's. So the boundary has to be a second one, enforced the same way
 * — on every read, from the record rather than from a filter somebody
 * remembered to apply. That is what `assignedStaff` and `visibleCustomers` are
 * for, and it is why a customer's evidence and company profile hang off the
 * customer account rather than off the tenant.
 *
 * ## Why staff assignment is restrictive by default
 *
 * A new customer is visible to nobody but whoever opened it until somebody is
 * assigned. The opposite default — everybody sees everything unless excluded —
 * is one forgotten exclusion away from a competitor's evidence on the wrong
 * screen, and nothing about the failure would be visible until it mattered.
 *
 * ## Guests, and who confirms a declaration
 *
 * The customer's own people are guests: CONSTRUX's existing guest mechanism,
 * where the gateway refuses a guest every tenant-scoped route that has not
 * declared itself safe. They are *in* the provider's tenancy and they can see
 * exactly one customer account — their own.
 *
 * That matters most for declarations. Insurance cover, legal statements and
 * accident figures are things a company says about itself to a buyer, under its
 * own name. A provider's bid writer who confirmed one would be making a
 * representation on behalf of a company whose facts they do not have. So
 * `confirmDeclaration` refuses anybody who is not a guest of that customer
 * account — not by role, which a provider could grant itself, but by whose
 * company the person belongs to.
 */

export type CustomerStatus = 'ACTIVE' | 'CLOSED';

/**
 * What the customer is, as the questionnaires will need it.
 *
 * Held per customer rather than per tenant because it is the *customer's*
 * company profile, and the provider has one of these for each of its customers.
 * Every prequalification asks the same first twenty questions — legal name,
 * company number, headcount, turnover band, SIC codes, where it works — and
 * the point of holding them is that nobody retypes them per bid.
 */
export type CustomerProfile = {
  legalName: string;
  companyNumber?: string;
  sicCodes: string[];
  headcount?: number;
  turnoverBand?: string;
  sectors: string[];
  regions: string[];
  /** Updated by the customer's own people or by assigned staff; always attributed. */
  updatedAt?: string;
  updatedBy?: string;
};

export type DeclarationKind =
  | 'INSURANCE'
  | 'ACCIDENT_STATISTICS'
  | 'LEGAL_STATEMENT'
  | 'FINANCIAL'
  | 'OTHER';

/**
 * A fact the customer states about itself, confirmed by the customer.
 *
 * Separate from evidence on purpose. Evidence is a document that exists; a
 * declaration is an assertion somebody is accountable for, and the accountable
 * party is the only one who may make it. The scorer treats an unconfirmed
 * declaration as a hard red, because a submission resting on an unconfirmed
 * insurance value is a submission nobody has stood behind.
 */
export type Declaration = {
  id: string;
  kind: DeclarationKind;
  statement: string;
  /** The figure, where the declaration is one. Kept as text: "£10m each and every claim" is the answer. */
  value?: string;
  confirmedAt: string;
  /** The guest who confirmed it. Never a member of the provider's staff. */
  confirmedBy: string;
  /** Whose company that person belongs to, recorded so the record is readable years later. */
  confirmedByOrganisation: string;
  /** A confirmation goes stale; an insurance declaration is true until renewal. */
  validUntil?: string;
  supersedes?: string;
};

export type CustomerAccount = {
  id: string;
  reference: string;
  legalName: string;
  status: CustomerStatus;
  profile: CustomerProfile;
  /**
   * The provider's own people who may see this customer. Restrictive by
   * default: an empty list means nobody but whoever opened it.
   */
  assignedStaff: string[];
  /** The customer's own people, as guest actor ids. */
  guests: Array<{ actorId: string; organisation: string; role: 'CUSTOMER_ADMIN' | 'CUSTOMER_CONTRIBUTOR'; invitedAt: string; invitedBy: string }>;
  declarations: Declaration[];
  openedAt: string;
  openedBy: string;
  closedAt?: string;
  closedBy?: string;
  closedReason?: string;
};

const NAME_MIN = 3;
const REASON_MIN = 12;
const STATEMENT_MIN = 12;

function requireText(value: string, min: number, code: string, what: string): string {
  const text = value.trim();
  if (text.length < min) throw new DomainError(code, `${what} needs at least ${min} characters`, 400);
  return text;
}

export function customersOf(ctx: EngineContext): CustomerAccount[] {
  return ctx.ledger
    .listByTenant(ctx.tenantId, 'BidOnCustomer')
    .map((record) => record.state as unknown as CustomerAccount);
}

function requireCustomerRecord(ctx: EngineContext, customerId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'BidOnCustomer', refId: customerId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('BID_ON_CUSTOMER_NOT_FOUND', `No customer ${customerId}`, 404);
  }
  return record;
}

/**
 * Whether this person may see this customer at all.
 *
 * The second boundary, and the one tenant isolation cannot provide. Three ways
 * in and no fourth:
 *
 *   - a guest of that customer account, who sees exactly their own;
 *   - a member of the provider's staff who has been assigned to it;
 *   - whoever opened it, so a customer is never created invisible to its author.
 *
 * Deliberately not "anybody with `BID_SERVICES` `R`". A provider admin reads
 * every customer by being assigned to them, which leaves a record of who was
 * given access to whose evidence — and that record is the whole point.
 */
export function maySeeCustomer(customer: CustomerAccount, actorId: string): boolean {
  if (customer.guests.some((guest) => guest.actorId === actorId)) return true;
  if (customer.assignedStaff.includes(actorId)) return true;
  return customer.openedBy === actorId;
}

/**
 * Whether this person may see that customer, without refusing if they may not.
 *
 * For the places that are **filtering** rather than loading: a lookup across a
 * library has to skip what the caller cannot see, and `requireVisibleCustomer`
 * refuses instead of answering. Both read the same rule, so there is no second
 * definition of who may see a customer.
 */
export function customerVisible(ctx: EngineContext, customerId: string): boolean {
  try {
    requireVisibleCustomer(ctx, customerId);
    return true;
  } catch {
    return false;
  }
}

/** Load a customer this person is allowed to see, or refuse as a denial rather than a 404. */
export function requireVisibleCustomer(ctx: EngineContext, customerId: string): CustomerAccount {
  const customer = requireCustomerRecord(ctx, customerId).state as unknown as CustomerAccount;
  if (!maySeeCustomer(customer, ctx.auth.actorId)) {
    throw new DomainError(
      'BID_ON_CUSTOMER_NOT_ASSIGNED',
      `${customer.reference} is not a customer you are assigned to. A provider's customers compete with each other, ` +
        'so access is per customer and is recorded.',
      403,
    );
  }
  return customer;
}

// --- Opening a workspace -----------------------------------------------------

/** Open a customer workspace. `G` on `BID_SERVICES` — this is the commercial relationship. */
export function openCustomer(
  ctx: EngineContext,
  input: {
    legalName: string;
    companyNumber?: string;
    sicCodes?: string[];
    headcount?: number;
    turnoverBand?: string;
    sectors?: string[];
    regions?: string[];
    assignStaff?: string[];
  },
): CustomerAccount {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'G', { dataSensitivity: 'COMMERCIAL_L3' });

  const legalName = requireText(input.legalName, NAME_MIN, 'BID_ON_NAME_TOO_SHORT', 'A legal name');

  // Two customers with one name is how one firm's evidence reaches the other's
  // bid. Refused on the name rather than deduplicated silently, because which
  // of the two is the real one is not a question the platform can answer.
  const existing = customersOf(ctx).find(
    (entry) => entry.legalName.toLowerCase() === legalName.toLowerCase() && entry.status === 'ACTIVE',
  );
  if (existing) {
    throw new DomainError(
      'BID_ON_CUSTOMER_EXISTS',
      `${existing.reference} is already open for ${existing.legalName}. Work in that workspace rather than opening a ` +
        'second one — two workspaces for one firm is how its evidence library ends up split in half.',
      409,
    );
  }

  const id = ulid();
  const at = new Date().toISOString();
  const customer: CustomerAccount = {
    id,
    reference: formatRef('CUS', customersOf(ctx).length + 1),
    legalName,
    status: 'ACTIVE',
    profile: {
      legalName,
      ...(input.companyNumber?.trim() ? { companyNumber: input.companyNumber.trim() } : {}),
      sicCodes: (input.sicCodes ?? []).map((code) => code.trim()).filter(Boolean),
      ...(input.headcount === undefined ? {} : { headcount: input.headcount }),
      ...(input.turnoverBand ? { turnoverBand: input.turnoverBand } : {}),
      sectors: (input.sectors ?? []).map((s) => s.trim()).filter(Boolean),
      regions: (input.regions ?? []).map((r) => r.trim()).filter(Boolean),
      updatedAt: at,
      updatedBy: ctx.auth.actorId,
    },
    // Whoever opened it can always see it; assignment is additive to that.
    assignedStaff: [...new Set([ctx.auth.actorId, ...(input.assignStaff ?? [])])],
    guests: [],
    declarations: [],
    openedAt: at,
    openedBy: ctx.auth.actorId,
  };

  write(ctx, {
    eventType: 'BID_ON_CUSTOMER_OPENED',
    entity: { refType: 'BidOnCustomer', refId: id },
    nextState: { ...customer },
  });

  return customer;
}

/** Assign or unassign the provider's staff. `G` — it is a grant of access to a third party's evidence. */
export function assignStaff(
  ctx: EngineContext,
  customerId: string,
  input: { add?: string[]; remove?: string[] },
): CustomerAccount {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'G', { dataSensitivity: 'COMMERCIAL_L3' });

  const customer = requireCustomerRecord(ctx, customerId).state as unknown as CustomerAccount;
  const removing = new Set(input.remove ?? []);

  // The author keeps access. Removing them would leave a workspace whose own
  // creation nobody can account for, and the audit trail already names them.
  if (removing.has(customer.openedBy)) {
    throw new DomainError(
      'BID_ON_CANNOT_UNASSIGN_AUTHOR',
      'Whoever opened a customer workspace keeps access to it. The record already says they created it, and hiding ' +
        'it from them would not unsay that.',
      409,
    );
  }

  const assignedStaff = [
    ...new Set([...customer.assignedStaff.filter((id) => !removing.has(id)), ...(input.add ?? [])]),
  ];
  const next: CustomerAccount = { ...customer, assignedStaff };

  write(ctx, {
    eventType: 'BID_ON_STAFF_ASSIGNED',
    entity: { refType: 'BidOnCustomer', refId: customerId },
    nextState: { ...next },
  });
  return next;
}

/** Invite one of the customer's own people as a guest. `G` on `BID_SERVICES`. */
export function inviteGuest(
  ctx: EngineContext,
  customerId: string,
  input: { actorId: string; organisation: string; role: 'CUSTOMER_ADMIN' | 'CUSTOMER_CONTRIBUTOR' },
): CustomerAccount {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'G', { dataSensitivity: 'COMMERCIAL_L3' });

  const customer = requireVisibleCustomer(ctx, customerId);
  if (customer.status === 'CLOSED') {
    throw new DomainError('BID_ON_CUSTOMER_CLOSED', `${customer.reference} is closed.`, 409);
  }
  if (customer.guests.some((guest) => guest.actorId === input.actorId)) {
    throw new DomainError(
      'BID_ON_GUEST_EXISTS',
      'That person is already a guest of this workspace. Change their role rather than inviting them twice.',
      409,
    );
  }

  // A person cannot be a guest of two of the provider's customers. They would
  // be able to see two competitors' evidence through one account, which is the
  // exact failure this whole file is built to prevent.
  const elsewhere = customersOf(ctx).find(
    (entry) => entry.id !== customerId && entry.guests.some((guest) => guest.actorId === input.actorId),
  );
  if (elsewhere) {
    throw new DomainError(
      'BID_ON_GUEST_ELSEWHERE',
      `That person is already a guest of ${elsewhere.reference}. One account cannot see two customers' evidence — ` +
        'invite them under their own login for this workspace.',
      409,
    );
  }

  const next: CustomerAccount = {
    ...customer,
    guests: [
      ...customer.guests,
      {
        actorId: input.actorId,
        organisation: requireText(input.organisation, NAME_MIN, 'BID_ON_NAME_TOO_SHORT', 'An organisation'),
        role: input.role,
        invitedAt: new Date().toISOString(),
        invitedBy: ctx.auth.actorId,
      },
    ],
  };

  write(ctx, {
    eventType: 'BID_ON_CUSTOMER_UPDATED',
    entity: { refType: 'BidOnCustomer', refId: customerId },
    nextState: { ...next },
  });
  return next;
}

/** Keep the customer's standing facts current. `U` — the guest's own people may do this. */
export function updateCustomerProfile(
  ctx: EngineContext,
  customerId: string,
  input: Partial<Omit<CustomerProfile, 'updatedAt' | 'updatedBy'>>,
): CustomerAccount {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const customer = requireVisibleCustomer(ctx, customerId);
  if (customer.status === 'CLOSED') {
    throw new DomainError('BID_ON_CUSTOMER_CLOSED', `${customer.reference} is closed.`, 409);
  }

  const next: CustomerAccount = {
    ...customer,
    profile: {
      ...customer.profile,
      ...(input.legalName?.trim() ? { legalName: input.legalName.trim() } : {}),
      ...(input.companyNumber === undefined ? {} : { companyNumber: input.companyNumber.trim() }),
      ...(input.sicCodes === undefined ? {} : { sicCodes: input.sicCodes.map((c) => c.trim()).filter(Boolean) }),
      ...(input.headcount === undefined ? {} : { headcount: input.headcount }),
      ...(input.turnoverBand === undefined ? {} : { turnoverBand: input.turnoverBand }),
      ...(input.sectors === undefined ? {} : { sectors: input.sectors.map((s) => s.trim()).filter(Boolean) }),
      ...(input.regions === undefined ? {} : { regions: input.regions.map((r) => r.trim()).filter(Boolean) }),
      updatedAt: new Date().toISOString(),
      updatedBy: ctx.auth.actorId,
    },
  };

  write(ctx, {
    eventType: 'BID_ON_CUSTOMER_UPDATED',
    entity: { refType: 'BidOnCustomer', refId: customerId },
    nextState: { ...next },
  });
  return next;
}

// --- Declarations ------------------------------------------------------------

/**
 * Confirm a fact the customer states about itself.
 *
 * **Refused for anybody who is not a guest of this customer account**, and
 * that refusal is the load-bearing rule of the whole module. An insurance
 * value, an accident rate or a legal statement is a representation to a buyer
 * made under the customer's name. A bid writer confirming one on their
 * customer's behalf is a representation by somebody who does not have the
 * facts and cannot be held to them.
 *
 * Checked against the guest list rather than against a role, deliberately. A
 * role is something the provider grants itself; being a guest of this customer
 * account means belonging to that company. `CUSTOMER_CONTRIBUTOR` is refused
 * too — the customer's own staff may upload and comment, and only the admin
 * speaks for the company.
 */
export function confirmDeclaration(
  ctx: EngineContext,
  customerId: string,
  input: { kind: DeclarationKind; statement: string; value?: string; validUntil?: string; supersedes?: string },
): Declaration {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const customer = requireVisibleCustomer(ctx, customerId);
  const guest = customer.guests.find((entry) => entry.actorId === ctx.auth.actorId);

  if (!guest) {
    throw new DomainError(
      'BID_ON_DECLARATION_NOT_YOURS',
      `A declaration is a statement ${customer.legalName} makes about itself to a buyer. It can only be confirmed by ` +
        'somebody from that company, never by the provider writing the bid and never by an agent — whoever confirms ' +
        'it is who the buyer will hold to it.',
      403,
    );
  }
  if (guest.role !== 'CUSTOMER_ADMIN') {
    throw new DomainError(
      'BID_ON_DECLARATION_NEEDS_ADMIN',
      'Only the customer’s own admin confirms a declaration. A contributor may upload evidence and comment, because ' +
        'speaking for the company is a different act from helping assemble the pack.',
      403,
    );
  }

  const statement = requireText(input.statement, STATEMENT_MIN, 'BID_ON_STATEMENT_TOO_SHORT', 'A declaration');
  if (input.supersedes && !customer.declarations.some((entry) => entry.id === input.supersedes)) {
    throw new DomainError('BID_ON_DECLARATION_NOT_FOUND', `No declaration ${input.supersedes}`, 404);
  }

  const declaration: Declaration = {
    id: ulid(),
    kind: input.kind,
    statement,
    ...(input.value?.trim() ? { value: input.value.trim() } : {}),
    confirmedAt: new Date().toISOString(),
    confirmedBy: ctx.auth.actorId,
    confirmedByOrganisation: guest.organisation,
    ...(input.validUntil ? { validUntil: input.validUntil } : {}),
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
  };

  // Nothing is removed. A superseded declaration is what the company said last
  // year, and a bid that went out on it said it too.
  const next: CustomerAccount = { ...customer, declarations: [...customer.declarations, declaration] };

  write(ctx, {
    eventType: 'BID_ON_CUSTOMER_UPDATED',
    entity: { refType: 'BidOnCustomer', refId: customerId },
    nextState: { ...next },
  });

  return declaration;
}

/**
 * Which declaration is the live one of its kind, judged on a date.
 *
 * Read against the bid's deadline rather than today, the same rule the evidence
 * claim register follows: a confirmation that lapses the week before the buyer
 * reads the submission is not a confirmation for that submission.
 */
export function liveDeclarations(customer: CustomerAccount, asAt: string): Declaration[] {
  const superseded = new Set(
    customer.declarations.map((entry) => entry.supersedes).filter((id): id is string => Boolean(id)),
  );
  return customer.declarations
    .filter((entry) => !superseded.has(entry.id))
    .filter((entry) => !entry.validUntil || entry.validUntil >= asAt.slice(0, 10));
}

// --- Closing -----------------------------------------------------------------

/** Close a customer workspace. Nothing is deleted; its bids become read-only. */
export function closeCustomer(ctx: EngineContext, customerId: string, input: { reason: string }): CustomerAccount {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'G', { dataSensitivity: 'COMMERCIAL_L3' });

  const customer = requireCustomerRecord(ctx, customerId).state as unknown as CustomerAccount;
  if (customer.status === 'CLOSED') {
    throw new DomainError('BID_ON_CUSTOMER_CLOSED', `${customer.reference} is already closed.`, 409);
  }

  // An open engagement is live commercial work. Closing the customer under it
  // would leave work nobody is accountable for and a fee still running.
  const open = engagementsOf(ctx).filter(
    (entry: Engagement) =>
      entry.customerAccountId === customerId && (entry.status === 'ACTIVE' || entry.status === 'PAUSED'),
  );
  if (open.length > 0) {
    throw new DomainError(
      'BID_ON_ENGAGEMENTS_OPEN',
      `${customer.reference} has ${open.length} engagement(s) still open: ${open.map((e) => e.reference).join(', ')}. ` +
        'Complete or cancel them first, so the record says what happened to the work rather than leaving it running ' +
        'under a closed customer.',
      409,
    );
  }

  const closed: CustomerAccount = {
    ...customer,
    status: 'CLOSED',
    closedAt: new Date().toISOString(),
    closedBy: ctx.auth.actorId,
    closedReason: requireText(input.reason, REASON_MIN, 'BID_ON_REASON_TOO_SHORT', 'A reason'),
  };

  write(ctx, {
    eventType: 'BID_ON_CUSTOMER_CLOSED',
    entity: { refType: 'BidOnCustomer', refId: customerId },
    nextState: { ...closed },
  });
  return closed;
}

// --- Reads -------------------------------------------------------------------

export type CustomerSummary = {
  id: string;
  reference: string;
  legalName: string;
  status: CustomerStatus;
  profile: CustomerProfile;
  assignedStaff: string[];
  guestCount: number;
  declarationCount: number;
  liveDeclarationCount: number;
  engagements: Array<Pick<Engagement, 'id' | 'reference' | 'name' | 'type' | 'status'>>;
  openedAt: string;
};

export type CustomerRegister = {
  customers: CustomerSummary[];
  limits: string[];
  summary: string;
};

/**
 * The customers this person may see — never the tenancy's whole list.
 *
 * The filter is the boundary, so it is applied here rather than left to a
 * caller. A register that returned everything and trusted the screen to hide
 * the rest would leak through the API the moment anybody called it directly.
 */
export function customerRegister(ctx: EngineContext, asAt?: string): CustomerRegister {
  // Readable after the agreement ends, and refused for a tenancy that never
  // held the module. See `requireModuleReadable` for why the two differ.
  requireModuleReadable(ctx.grantedModules, ctx.heldModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const day = (asAt ?? new Date().toISOString()).slice(0, 10);
  const all = customersOf(ctx);
  const visible = all.filter((customer) => maySeeCustomer(customer, ctx.auth.actorId));
  const engagements = engagementsOf(ctx);

  const customers: CustomerSummary[] = visible
    .map((customer) => ({
      id: customer.id,
      reference: customer.reference,
      legalName: customer.legalName,
      status: customer.status,
      profile: customer.profile,
      assignedStaff: customer.assignedStaff,
      guestCount: customer.guests.length,
      declarationCount: customer.declarations.length,
      liveDeclarationCount: liveDeclarations(customer, day).length,
      engagements: engagements
        .filter((entry) => entry.customerAccountId === customer.id)
        .map((entry) => ({
          id: entry.id,
          reference: entry.reference,
          name: entry.name,
          type: entry.type,
          status: entry.status,
        })),
      openedAt: customer.openedAt,
    }))
    .sort((a, b) => a.legalName.localeCompare(b.legalName));

  const limits: string[] = [];
  const hidden = all.length - visible.length;
  if (hidden > 0) {
    // Said rather than hidden. "You are seeing four of nine" is a true and
    // useful statement; a list of four that looks like all of them is not.
    limits.push(
      `${hidden} further customer(s) exist in this tenancy that you are not assigned to. A provider's customers ` +
        'compete with each other, so access is per customer.',
    );
  }
  const noGuests = visible.filter((customer) => customer.status === 'ACTIVE' && customer.guests.length === 0).length;
  if (noGuests > 0) {
    limits.push(
      `${noGuests} customer(s) have no guest invited, so nobody from that company can confirm a declaration — and a ` +
        'declaration is the one thing the provider cannot confirm on their behalf.',
    );
  }
  const idle = visible.filter(
    (customer) =>
      customer.status === 'ACTIVE' &&
      !engagements.some((entry) => entry.customerAccountId === customer.id && entry.status === 'ACTIVE'),
  ).length;
  if (idle > 0) {
    limits.push(`${idle} customer(s) have no active engagement, so no work can be done for them yet.`);
  }

  return {
    customers,
    limits,
    summary:
      customers.length === 0
        ? 'No customer workspace you can see. Each external customer gets its own, and its evidence stays inside it.'
        : `${customers.filter((c) => c.status === 'ACTIVE').length} active customer(s) of ${customers.length} you are ` +
          'assigned to.',
  };
}

/** One customer in full, for the screen that works on it. */
export function customerWorkspace(ctx: EngineContext, customerId: string, asAt?: string): CustomerAccount & {
  liveDeclarations: Declaration[];
  engagements: Engagement[];
} {
  requireModuleReadable(ctx.grantedModules, ctx.heldModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const customer = requireVisibleCustomer(ctx, customerId);
  const day = (asAt ?? new Date().toISOString()).slice(0, 10);
  return {
    ...customer,
    liveDeclarations: liveDeclarations(customer, day),
    engagements: engagementsOf(ctx).filter((entry) => entry.customerAccountId === customerId),
  };
}
