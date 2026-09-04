import { DomainError, ForbiddenError, NotFoundError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { GROUP_LICENCE, PACKAGES } from '../billing/seats.ts';
import { chargesFor } from '../billing/collection.ts';
import type { AuthContext } from '../identity/auth.ts';
import type { Platform, PlatformUser, Tenant } from '../platform.ts';

/**
 * The Group: one licence agreement, one bill, several legal entities.
 *
 * GN-SPEC-TENANCY-001 §2 settles the shape and this module holds to it. A
 * Company is a tenancy — the isolation boundary every read on this platform
 * already applies — and is never shared between legal entities. The Group
 * sits above the tenancies: it owns the billing account, holds one cost
 * centre per company, carries the group-level roles, and is where the
 * consolidated figures are read from. Nothing operational lives at group
 * level: a group role opens the group console and not one company's records,
 * and operational access always needs a membership (§4).
 *
 * A person is one identity across the group (§4): the same address in more
 * than one company is one person with several memberships, and the company
 * switcher moves between them without a second sign-in. The user records stay
 * per company, because that is what the isolation boundary is made of; what
 * the group adds is the link between them.
 *
 * The group's own records are kept under the group's id as their tenancy, on
 * the governance chain like everything else, so a restart brings them back
 * and the audit feed shows who did what. Cross-company reads here — the
 * statement, the usage table — are the "separate reporting role" §7 asks for:
 * they read each company's records by that company's id, one at a time, and
 * publish figures rather than records.
 */

export type GroupRoleName = 'GROUP_ADMIN' | 'GROUP_FINANCE' | 'GROUP_VIEWER';
export const GROUP_ROLES: readonly GroupRoleName[] = ['GROUP_ADMIN', 'GROUP_FINANCE', 'GROUP_VIEWER'];

export type ChargeMode = 'INTERNAL' | 'INTERCOMPANY' | 'EXTERNAL';
export type RateCard = 'GROUP_INTERNAL' | 'ENTERPRISE_GROUP' | 'RETAIL';
export type InvoiceMode = 'CONSOLIDATED' | 'PER_COMPANY';

/** A company's place in the group: its cost centre, as §9.1 defines it. */
export type CostCentre = {
  tenantId: string;
  /** Short, stable, unique within the group — 'ETX', 'JNC'. */
  code: string;
  slug: string;
  chargeMode: ChargeMode;
  rateCard: RateCard;
  joinedAt: string;
  joinedBy: string;
};

export type Group = {
  id: string;
  slug: string;
  displayName: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  billing: {
    currency: string;
    invoiceMode: InvoiceMode;
    termsDays: number;
    /** The payment provider's customer reference, once one exists. Empty until then. */
    paymentCustomerRef: string;
  };
  costCentres: CostCentre[];
  /**
   * Companies that were in the group and left (enterprise specification §4,
   * GroupTenantRelation): the relation is effective-dated, not overwritten.
   * Absent on groups written before a company ever left one.
   */
  history?: FormerCostCentre[];
  createdAt: string;
  createdBy: string;
  updatedAt?: string;
};

export type FormerCostCentre = CostCentre & { leftAt: string; leftBy: string; reason: string };

export type GroupRole = {
  id: string;
  groupId: string;
  /** The person, by the one thing that is the same in every company: their address. */
  email: string;
  role: GroupRoleName;
  grantedBy: string;
  grantedAt: string;
  revokedAt?: string;
  revokedBy?: string;
};

/** One of a person's companies, as the switcher shows it. */
export type Membership = {
  userId: string;
  tenantId: string;
  companyName: string;
  slug: string | null;
  roles: string[];
  status: string;
  active: boolean;
};

const governance = (groupId: string) => `${groupId}-governance`;

export function groupOf(platform: Platform, groupId: string): Group {
  const record = platform.ledger.get({ refType: 'Group', refId: groupId });
  if (!record) throw new NotFoundError(`No group ${groupId}`);
  return record.state as unknown as Group;
}

export function groups(platform: Platform): Group[] {
  return platform.ledger.entitiesOfType('Group').map((record) => record.state as unknown as Group);
}

export function groupBySlug(platform: Platform, slug: string): Group | undefined {
  return groups(platform).find((group) => group.slug === slug);
}

/** The group a tenancy belongs to, or nothing for a company standing alone. */
export function groupOfTenant(platform: Platform, tenantId: string): Group | undefined {
  const tenant = platform.tenant(tenantId);
  return tenant.groupId ? groupOf(platform, tenant.groupId) : undefined;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function commitGroup(platform: Platform, actorId: string, group: Group, eventType: 'GROUP_CREATED' | 'GROUP_UPDATED'): void {
  platform.ledger.commit({
    tenantId: group.id,
    projectId: governance(group.id),
    actor: { refType: 'User', refId: actorId },
    source: 'WEB',
    correlationId: ulid(),
    eventType,
    entity: { refType: 'Group', refId: group.id },
    nextState: { ...group } as unknown as Record<string, unknown>,
  });
}

// --- the group -----------------------------------------------------------------

export function createGroup(
  platform: Platform,
  actor: AuthContext,
  input: { displayName: string; slug?: string; currency: string; invoiceMode?: InvoiceMode; termsDays?: number },
): Group {
  const displayName = input.displayName.trim();
  if (!displayName) throw new DomainError('GROUP_NAME_REQUIRED', 'A group needs a name');
  const slug = slugify(input.slug?.trim() || displayName);
  if (!slug) throw new DomainError('GROUP_SLUG_INVALID', 'The slug needs at least one letter or digit');
  if (groupBySlug(platform, slug)) throw new DomainError('GROUP_EXISTS', `A group with the slug ${slug} already exists`, 409);
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new DomainError('CURRENCY_INVALID', 'The billing currency is a three-letter code');
  const group: Group = {
    id: ulid(),
    slug,
    displayName,
    status: 'ACTIVE',
    billing: {
      currency: input.currency,
      invoiceMode: input.invoiceMode ?? 'CONSOLIDATED',
      termsDays: input.termsDays ?? 14,
      paymentCustomerRef: '',
    },
    costCentres: [],
    createdAt: new Date().toISOString(),
    createdBy: actor.actorId,
  };
  commitGroup(platform, actor.actorId, group, 'GROUP_CREATED');
  return group;
}

export function updateGroupBilling(
  platform: Platform,
  actor: AuthContext,
  groupId: string,
  input: { invoiceMode?: InvoiceMode; termsDays?: number; paymentCustomerRef?: string; displayName?: string },
): Group {
  const group = groupOf(platform, groupId);
  if (input.termsDays !== undefined && (input.termsDays < 0 || input.termsDays > 120)) {
    throw new DomainError('TERMS_INVALID', 'Payment terms are between 0 and 120 days');
  }
  const updated: Group = {
    ...group,
    displayName: input.displayName?.trim() || group.displayName,
    billing: {
      ...group.billing,
      ...(input.invoiceMode ? { invoiceMode: input.invoiceMode } : {}),
      ...(input.termsDays !== undefined ? { termsDays: input.termsDays } : {}),
      ...(input.paymentCustomerRef !== undefined ? { paymentCustomerRef: input.paymentCustomerRef.trim() } : {}),
    },
    updatedAt: new Date().toISOString(),
  };
  commitGroup(platform, actor.actorId, updated, 'GROUP_UPDATED');
  return updated;
}

/**
 * Bring a company into the group. The tenancy keeps everything it has —
 * users, wallet, projects, package — and gains a cost centre. A tenancy is in
 * one group at most, the platform's own tenancy is in none, and a closed
 * tenancy is not a company anybody trades through.
 */
export function attachCompany(
  platform: Platform,
  actor: AuthContext,
  groupId: string,
  input: { tenantId: string; code: string; slug?: string; chargeMode?: ChargeMode; rateCard?: RateCard },
): Group {
  const group = groupOf(platform, groupId);
  if (group.status !== 'ACTIVE') throw new DomainError('GROUP_NOT_ACTIVE', `${group.displayName} is ${group.status.toLowerCase()}`, 409);
  const tenant = platform.tenant(input.tenantId);
  if (tenant.id === 'platform') throw new DomainError('PLATFORM_TENANCY', "The platform's own tenancy is not a company", 422);
  if (tenant.closedAt) throw new DomainError('TENANT_CLOSED', `${tenant.legalName} is closed`, 409);
  if (tenant.groupId && tenant.groupId !== groupId) {
    throw new DomainError('ALREADY_IN_GROUP', `${tenant.legalName} is already in another group`, 409);
  }
  if (group.costCentres.some((centre) => centre.tenantId === tenant.id)) {
    throw new DomainError('ALREADY_IN_GROUP', `${tenant.legalName} is already in ${group.displayName}`, 409);
  }
  if (group.costCentres.length >= GROUP_LICENCE.maxCompanies) {
    throw new DomainError(
      'GROUP_FULL',
      `${group.displayName} already holds ${GROUP_LICENCE.maxCompanies} companies, which is what the group licence covers`,
      409,
    );
  }
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(code)) throw new DomainError('COST_CENTRE_CODE_INVALID', 'A cost centre code is 2 to 8 letters or digits');
  if (group.costCentres.some((centre) => centre.code === code)) throw new DomainError('COST_CENTRE_EXISTS', `${code} is already in use in this group`, 409);
  const slug = slugify(input.slug?.trim() || tenant.legalName);
  if (group.costCentres.some((centre) => centre.slug === slug)) throw new DomainError('COMPANY_SLUG_EXISTS', `${slug} is already in use in this group`, 409);

  const centre: CostCentre = {
    tenantId: tenant.id,
    code,
    slug,
    chargeMode: input.chargeMode ?? 'INTERNAL',
    rateCard: input.rateCard ?? 'GROUP_INTERNAL',
    joinedAt: new Date().toISOString(),
    joinedBy: actor.actorId,
  };
  const updated: Group = { ...group, costCentres: [...group.costCentres, centre], updatedAt: centre.joinedAt };
  commitGroup(platform, actor.actorId, updated, 'GROUP_UPDATED');
  platform.groupTenant(actor.actorId, tenant.id, group.id, slug);
  return updated;
}

/**
 * Take a company out of the group, keeping the relation on the record with
 * the date it ended. The tenancy keeps everything it has — its people,
 * records, wallet, issued documents — and stands alone until another group
 * takes it in. Called by the transfer workflow; not a route of its own.
 */
export function detachCompany(platform: Platform, actor: AuthContext, groupId: string, tenantId: string, reason: string): Group {
  const group = groupOf(platform, groupId);
  const centre = group.costCentres.find((candidate) => candidate.tenantId === tenantId);
  if (!centre) throw new NotFoundError(`${tenantId} is not a company in ${group.displayName}`);
  const leftAt = new Date().toISOString();
  const updated: Group = {
    ...group,
    costCentres: group.costCentres.filter((candidate) => candidate.tenantId !== tenantId),
    history: [...(group.history ?? []), { ...centre, leftAt, leftBy: actor.actorId, reason }],
    updatedAt: leftAt,
  };
  commitGroup(platform, actor.actorId, updated, 'GROUP_UPDATED');
  platform.ungroupTenant(actor.actorId, tenantId);
  return updated;
}

export function setCostCentre(
  platform: Platform,
  actor: AuthContext,
  groupId: string,
  tenantId: string,
  input: { chargeMode?: ChargeMode; rateCard?: RateCard; code?: string },
): Group {
  const group = groupOf(platform, groupId);
  const centre = group.costCentres.find((candidate) => candidate.tenantId === tenantId);
  if (!centre) throw new NotFoundError(`${tenantId} is not a company in ${group.displayName}`);
  const code = input.code ? input.code.trim().toUpperCase() : centre.code;
  if (!/^[A-Z0-9]{2,8}$/.test(code)) throw new DomainError('COST_CENTRE_CODE_INVALID', 'A cost centre code is 2 to 8 letters or digits');
  if (code !== centre.code && group.costCentres.some((candidate) => candidate.code === code)) {
    throw new DomainError('COST_CENTRE_EXISTS', `${code} is already in use in this group`, 409);
  }
  const updated: Group = {
    ...group,
    costCentres: group.costCentres.map((candidate) =>
      candidate.tenantId === tenantId
        ? { ...candidate, code, chargeMode: input.chargeMode ?? candidate.chargeMode, rateCard: input.rateCard ?? candidate.rateCard }
        : candidate,
    ),
    updatedAt: new Date().toISOString(),
  };
  commitGroup(platform, actor.actorId, updated, 'GROUP_UPDATED');
  return updated;
}

// --- group roles ---------------------------------------------------------------

export function groupRoles(platform: Platform, groupId: string): GroupRole[] {
  return platform.ledger
    .listByTenant(groupId, 'GroupRole')
    .map((record) => record.state as unknown as GroupRole)
    .filter((role) => !role.revokedAt);
}

export function groupRolesFor(platform: Platform, groupId: string, email: string): GroupRoleName[] {
  const address = email.toLowerCase();
  return groupRoles(platform, groupId)
    .filter((role) => role.email === address)
    .map((role) => role.role);
}

/**
 * Grant a group role. The person must already be somebody in one of the
 * group's companies — a group role is a view over companies, not a way into
 * the platform for an address nobody has invited.
 */
export function grantGroupRole(
  platform: Platform,
  actor: AuthContext,
  groupId: string,
  input: { email: string; role: GroupRoleName },
): GroupRole {
  const group = groupOf(platform, groupId);
  if (!GROUP_ROLES.includes(input.role)) throw new DomainError('GROUP_ROLE_UNKNOWN', `${input.role} is not a group role`);
  const email = input.email.trim().toLowerCase();
  const member = membershipsByEmail(platform, email).some((membership) => group.costCentres.some((centre) => centre.tenantId === membership.tenantId));
  if (!member) {
    throw new DomainError('NOT_A_MEMBER', `${email} is not a person in any of ${group.displayName}'s companies. Add them to a company first.`, 422);
  }
  if (groupRolesFor(platform, groupId, email).includes(input.role)) {
    throw new DomainError('GROUP_ROLE_HELD', `${email} already holds ${input.role} in ${group.displayName}`, 409);
  }
  const role: GroupRole = {
    id: ulid(),
    groupId,
    email,
    role: input.role,
    grantedBy: actor.actorId,
    grantedAt: new Date().toISOString(),
  };
  platform.ledger.commit({
    tenantId: groupId,
    projectId: governance(groupId),
    actor: { refType: 'User', refId: actor.actorId },
    source: 'WEB',
    correlationId: ulid(),
    eventType: 'GROUP_ROLE_GRANTED',
    entity: { refType: 'GroupRole', refId: role.id },
    nextState: { ...role },
  });
  return role;
}

export function revokeGroupRole(platform: Platform, actor: AuthContext, groupId: string, roleId: string): GroupRole {
  const record = platform.ledger.get({ refType: 'GroupRole', refId: roleId });
  if (!record || record.tenantId !== groupId) throw new NotFoundError(`No group role ${roleId}`);
  const role = record.state as unknown as GroupRole;
  if (role.revokedAt) throw new DomainError('GROUP_ROLE_REVOKED', 'That role is already revoked', 409);
  if (role.role === 'GROUP_ADMIN' && groupRoles(platform, groupId).filter((held) => held.role === 'GROUP_ADMIN').length <= 1) {
    throw new DomainError('LAST_GROUP_ADMIN', 'A group needs at least one administrator', 409);
  }
  const revoked: GroupRole = { ...role, revokedAt: new Date().toISOString(), revokedBy: actor.actorId };
  platform.ledger.commit({
    tenantId: groupId,
    projectId: governance(groupId),
    actor: { refType: 'User', refId: actor.actorId },
    source: 'WEB',
    correlationId: ulid(),
    eventType: 'GROUP_ROLE_REVOKED',
    entity: { refType: 'GroupRole', refId: roleId },
    nextState: { ...revoked },
  });
  return revoked;
}

/**
 * Which group this actor may see, and how. The actor's own company must be
 * in the group — an address with a group role but no membership in any of
 * its companies cannot have signed in to anything — and the role must be one
 * of those asked for.
 */
export function requireGroupRole(platform: Platform, actor: AuthContext, groupId: string, roles: readonly GroupRoleName[]): GroupRoleName[] {
  const user = platform.user(actor.actorId);
  const group = groupOf(platform, groupId);
  const inGroup = group.costCentres.some((centre) => centre.tenantId === user.tenantId);
  const held = inGroup ? groupRolesFor(platform, groupId, user.email) : [];
  if (!held.some((role) => roles.includes(role))) {
    throw new ForbiddenError(
      `This needs a group role (${roles.join(' or ')}) in ${group.displayName}`,
      'GROUP_ROLE_REQUIRED',
    );
  }
  return held;
}

// --- one identity, several companies --------------------------------------------

/** Every company this address is a person in, closed tenancies and erased records aside. */
export function membershipsByEmail(platform: Platform, email: string): Membership[] {
  const address = email.toLowerCase();
  return platform
    .allUsers()
    .filter((user) => user.email.toLowerCase() === address && !user.erasedAt)
    .map((user) => {
      const tenant = platform.tenant(user.tenantId);
      const group = tenant.groupId ? groupOf(platform, tenant.groupId) : undefined;
      return {
        userId: user.id,
        tenantId: user.tenantId,
        companyName: tenant.legalName,
        slug: group?.costCentres.find((centre) => centre.tenantId === tenant.id)?.slug ?? null,
        roles: user.roles,
        status: user.status,
        active: user.status === 'ACTIVE' && !tenant.closedAt,
      };
    });
}

/**
 * The person as the switcher sees them: every membership, the group and the
 * roles held in it, and what the active company is entitled to. Memberships
 * outside the active company's group are still the person's — one identity
 * — but a company outside any group has no group to show.
 */
export function whoAmI(platform: Platform, actor: AuthContext): {
  user: { id: string; name: string; email: string; tenantId: string; roles: string[] };
  activeCompany: { tenantId: string; name: string; slug: string | null };
  memberships: Membership[];
  group: { id: string; slug: string; displayName: string; roles: GroupRoleName[] } | null;
  entitlements: string[];
} {
  const user = platform.user(actor.actorId);
  const tenant = platform.tenant(user.tenantId);
  const group = tenant.groupId ? groupOf(platform, tenant.groupId) : undefined;
  return {
    user: { id: user.id, name: user.name, email: user.email, tenantId: user.tenantId, roles: user.roles },
    activeCompany: {
      tenantId: tenant.id,
      name: tenant.legalName,
      slug: group?.costCentres.find((centre) => centre.tenantId === tenant.id)?.slug ?? null,
    },
    memberships: membershipsByEmail(platform, user.email),
    group: group ? { id: group.id, slug: group.slug, displayName: group.displayName, roles: groupRolesFor(platform, group.id, user.email) } : null,
    entitlements: entitlementClaims(platform, tenant.id),
  };
}

/**
 * Add a person who already exists in one company to another company in the
 * same group: the same address, a second membership, no second person. The
 * new record is a user of that company like any other — it takes a seat
 * there, holds that company's roles, and is what that company's isolation
 * boundary sees, holding exactly the roles the administrator names.
 */
export function addMembership(
  platform: Platform,
  actor: AuthContext,
  input: { email: string; roles?: PlatformUser['roles'] },
): PlatformUser {
  const email = input.email.trim().toLowerCase();
  const existing = membershipsByEmail(platform, email);
  if (existing.length === 0) throw new DomainError('NO_SUCH_PERSON', `${email} is not a person in any company. Add them to this company instead.`, 422);
  if (existing.some((membership) => membership.tenantId === actor.tenantId)) {
    throw new DomainError('ALREADY_A_MEMBER', `${email} is already a person in this company`, 409);
  }
  const group = groupOfTenant(platform, actor.tenantId);
  if (!group) throw new DomainError('NOT_IN_GROUP', 'Memberships across companies are a group feature; this company is not in a group', 422);
  const sameGroup = existing.some((membership) => group.costCentres.some((centre) => centre.tenantId === membership.tenantId));
  if (!sameGroup) throw new DomainError('NOT_IN_GROUP', `${email} is not a person in any company of ${group.displayName}`, 422);
  // Least privilege is a choice the administrator makes, not a default the
  // platform picks: the role catalogue has no bare viewer, and quietly
  // handing over the least of the real roles would still be handing over a
  // role nobody chose.
  if (!input.roles || input.roles.length === 0) throw new DomainError('ROLES_REQUIRED', 'Say which roles this membership holds here');
  const source = platform.user(existing[0]!.userId);
  return platform.createUser({
    tenantId: actor.tenantId,
    name: source.name,
    email: source.email,
    roles: input.roles,
  });
}

/** The entitlement claims a token for this company would carry (§4). CONSTRUX is the one product here. */
export function entitlementClaims(platform: Platform, tenantId: string): string[] {
  const subscription = platform.subscription(tenantId);
  const claims = [`construx:plan:${subscription.package.toLowerCase()}`];
  if (subscription.status !== 'ACTIVE') claims.push(`construx:plan:${subscription.status.toLowerCase()}`);
  for (const moduleId of platform.grantedModules(tenantId)) claims.push(`construx:module:${moduleId.toLowerCase()}`);
  return claims;
}

/** Everything a company holds, as one record: product, plan, modules, seats, standing (§5). */
export function entitlementsOf(platform: Platform, tenantId: string): {
  company: { tenantId: string; name: string };
  product: { product: 'construx'; plan: string; planLabel: string; status: string; validFrom: string; validTo: string | null };
  modules: Array<{ moduleKey: string; status: 'ACTIVE' }>;
  seats: { included: number | null; used: number };
  claims: string[];
} {
  const tenant = platform.tenant(tenantId);
  const subscription = platform.subscription(tenantId);
  const pkg = PACKAGES[subscription.package];
  return {
    company: { tenantId, name: tenant.legalName },
    product: {
      product: 'construx',
      plan: subscription.package,
      planLabel: pkg.label,
      status: subscription.status,
      validFrom: subscription.startedAt,
      validTo: subscription.status === 'ACTIVE' ? null : subscription.renewsAt,
    },
    modules: platform.grantedModules(tenantId).map((moduleKey) => ({ moduleKey, status: 'ACTIVE' as const })),
    seats: { included: pkg.includedSeats, used: subscription.assignedIdentities.length },
    claims: entitlementClaims(platform, tenantId),
  };
}

// --- usage and the consolidated statement ---------------------------------------

export type CompanyUsage = {
  tenantId: string;
  code: string;
  name: string;
  chargeMode: ChargeMode;
  rateCard: RateCard;
  meters: {
    acu: { rawMinor: number; billedMinor: number; units: number; byModule: Record<string, number> };
    seat: { active: number; included: number | null };
    document: number;
    storageBytes: number;
  };
};

function inWindow(timestamp: string, from: string, to: string): boolean {
  return timestamp >= from && timestamp < to;
}

/** One company's meters over a window, from its own records (§9.2). */
export function companyUsage(platform: Platform, group: Group, centre: CostCentre, from: string, to: string): CompanyUsage {
  const tenant = platform.tenant(centre.tenantId);
  const subscription = platform.subscription(centre.tenantId);
  const byModule: Record<string, number> = {};
  let rawMinor = 0;
  let billedMinor = 0;
  let units = 0;
  for (const entry of platform.wallet(centre.tenantId).entries()) {
    if (entry.type !== 'DEBIT' || !inWindow(entry.timestamp, from, to)) continue;
    rawMinor += entry.rawCostMinor;
    billedMinor += entry.billedMinor;
    units += entry.acuUnits;
    const key = entry.module ?? 'platform';
    byModule[key] = (byModule[key] ?? 0) + entry.billedMinor;
  }
  const documents = platform.ledger
    .listByTenant(centre.tenantId, 'Export')
    .filter((record) => inWindow(String(record.state.generatedAt ?? ''), from, to)).length;
  return {
    tenantId: centre.tenantId,
    code: centre.code,
    name: tenant.legalName,
    chargeMode: centre.chargeMode,
    rateCard: centre.rateCard,
    meters: {
      acu: { rawMinor, billedMinor, units, byModule },
      seat: { active: platform.users(centre.tenantId).filter((user) => user.status === 'ACTIVE').length, included: PACKAGES[subscription.package].includedSeats },
      document: documents,
      storageBytes: platform.evidence.usage(centre.tenantId),
    },
  };
}

export function groupUsage(platform: Platform, groupId: string, from: string, to: string): { group: Pick<Group, 'id' | 'slug' | 'displayName'>; from: string; to: string; companies: CompanyUsage[] } {
  const group = groupOf(platform, groupId);
  return {
    group: { id: group.id, slug: group.slug, displayName: group.displayName },
    from,
    to,
    companies: group.costCentres.map((centre) => companyUsage(platform, group, centre, from, to)),
  };
}

function monthWindow(month: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new DomainError('MONTH_INVALID', 'The month is YYYY-MM');
  const [year, mm] = month.split('-').map(Number) as [number, number];
  const from = new Date(Date.UTC(year, mm - 1, 1)).toISOString();
  const to = new Date(Date.UTC(year, mm, 1)).toISOString();
  return { from, to };
}

export type StatementSection = CompanyUsage & {
  plan: { package: string; label: string; listPriceMinor: number; chargedMinor: number; chargeStatus: string | null };
  acuBilledMinor: number;
  invoiced: boolean;
  totalMinor: number;
  /** The part of the month the company was in the group; absent when it was the whole month. */
  membership?: { from: string; to: string; left: boolean };
};

/**
 * The consolidated statement for a month (§9.4): one section per cost centre
 * with plan, seats, ACU, storage and documents, and a total across the group.
 * The plan line is what the platform actually raised for the period, where
 * it raised one, and the list price otherwise so the group can see what a
 * waived subscription would have cost. Usage is always shown whatever the
 * charge mode — waiving a subscription does not remove the AI cost, and the
 * group must see it. The statement is group-branded, and says which
 * companies it covers (§8.1). It is a statement, not an invoice: nothing here
 * moves money, and the payment provider is not integrated.
 */
export function groupStatement(platform: Platform, groupId: string, month: string): {
  group: { id: string; slug: string; displayName: string; currency: string; invoiceMode: InvoiceMode; termsDays: number };
  month: string;
  companiesIncluded: string[];
  sections: StatementSection[];
  totals: { planMinor: number; acuBilledMinor: number; totalMinor: number; invoicedMinor: number; trackedOnlyMinor: number };
} {
  const group = groupOf(platform, groupId);
  const { from, to } = monthWindow(month);
  // Effective-dated: a company that joined or left during the month is
  // metered for the part of the month it was in the group, and a former
  // company appears on the statement of the month it left, not after.
  const current = group.costCentres.map((centre) => ({ centre, from: centre.joinedAt > from ? centre.joinedAt : from, to, left: false }));
  const former = (group.history ?? [])
    .filter((centre) => centre.leftAt > from && centre.joinedAt < to && !group.costCentres.some((live) => live.tenantId === centre.tenantId))
    .map((centre) => ({ centre, from: centre.joinedAt > from ? centre.joinedAt : from, to: centre.leftAt < to ? centre.leftAt : to, left: true }));
  const sections: StatementSection[] = [...current, ...former].map(({ centre, from: windowFrom, to: windowTo, left }) => {
    const usage = companyUsage(platform, group, centre, windowFrom, windowTo);
    const subscription = platform.subscription(centre.tenantId);
    const pkg = PACKAGES[subscription.package];
    const charge = chargesFor(platform, centre.tenantId).find((candidate) => candidate.periodStart.slice(0, 7) === month);
    const chargedMinor = charge?.amountMinor ?? 0;
    const invoiced = centre.chargeMode !== 'INTERNAL';
    const totalMinor = (charge ? chargedMinor : 0) + usage.meters.acu.billedMinor;
    const partial = windowFrom !== from || windowTo !== to;
    return {
      ...usage,
      plan: {
        package: subscription.package,
        label: pkg.label,
        listPriceMinor: pkg.monthlyPriceMinor,
        chargedMinor,
        chargeStatus: charge?.status ?? null,
      },
      acuBilledMinor: usage.meters.acu.billedMinor,
      invoiced,
      totalMinor,
      ...(partial ? { membership: { from: windowFrom, to: windowTo, left } } : {}),
    };
  });
  const planMinor = sections.reduce((sum, section) => sum + section.plan.chargedMinor, 0);
  const acuBilledMinor = sections.reduce((sum, section) => sum + section.acuBilledMinor, 0);
  const invoicedMinor = sections.filter((section) => section.invoiced).reduce((sum, section) => sum + section.totalMinor, 0);
  const totalMinor = planMinor + acuBilledMinor;
  return {
    group: {
      id: group.id,
      slug: group.slug,
      displayName: group.displayName,
      currency: group.billing.currency,
      invoiceMode: group.billing.invoiceMode,
      termsDays: group.billing.termsDays,
    },
    month,
    companiesIncluded: sections.map((section) => section.name),
    sections,
    totals: { planMinor, acuBilledMinor, totalMinor, invoicedMinor, trackedOnlyMinor: totalMinor - invoicedMinor },
  };
}

/** The statement as CSV, one row per company, for finance (§9.4). */
export function statementCsv(statement: ReturnType<typeof groupStatement>, onlyTenantId?: string): string {
  const escape = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
  const rows = [
    ['group', 'month', 'currency', 'cost_centre', 'company', 'charge_mode', 'rate_card', 'package', 'plan_list_price_minor', 'plan_charged_minor', 'charge_status', 'active_seats', 'acu_units', 'acu_raw_minor', 'acu_billed_minor', 'documents', 'storage_bytes', 'total_minor', 'invoiced'],
    ...statement.sections
      .filter((section) => !onlyTenantId || section.tenantId === onlyTenantId)
      .map((section) => [
        statement.group.displayName,
        statement.month,
        statement.group.currency,
        section.code,
        section.name,
        section.chargeMode,
        section.rateCard,
        section.plan.package,
        section.plan.listPriceMinor,
        section.plan.chargedMinor,
        section.plan.chargeStatus ?? '',
        section.meters.seat.active,
        section.meters.acu.units,
        section.meters.acu.rawMinor,
        section.meters.acu.billedMinor,
        section.meters.document,
        section.meters.storageBytes,
        section.totalMinor,
        section.invoiced ? 'yes' : 'no',
      ]),
  ];
  return rows.map((row) => row.map(escape).join(',')).join('\n') + '\n';
}

/** The directory (§10): every company with its standing, package, entitlements and seats. */
export function groupDirectory(platform: Platform, groupId: string): {
  group: Group;
  companies: Array<{
    tenantId: string;
    name: string;
    slug: string;
    code: string;
    jurisdiction: string;
    status: 'ACTIVE' | 'CLOSED';
    chargeMode: ChargeMode;
    rateCard: RateCard;
    entitlements: ReturnType<typeof entitlementsOf>;
    people: number;
    administrators: number;
    walletAvailableMinor: number;
    hardLimitMinor: number | null;
  }>;
  roles: GroupRole[];
} {
  const group = groupOf(platform, groupId);
  return {
    group,
    companies: group.costCentres.map((centre) => {
      const tenant: Tenant = platform.tenant(centre.tenantId);
      const users = platform.users(centre.tenantId);
      const wallet = platform.wallet(centre.tenantId).snapshot();
      return {
        tenantId: centre.tenantId,
        name: tenant.legalName,
        slug: centre.slug,
        code: centre.code,
        jurisdiction: tenant.jurisdiction,
        status: tenant.closedAt ? 'CLOSED' : 'ACTIVE',
        chargeMode: centre.chargeMode,
        rateCard: centre.rateCard,
        entitlements: entitlementsOf(platform, centre.tenantId),
        people: users.filter((user) => user.status === 'ACTIVE').length,
        administrators: users.filter((user) => user.status === 'ACTIVE' && (user.roles.includes('ENTERPRISE_ADMIN') || user.roles.includes('OWNER'))).length,
        walletAvailableMinor: wallet.availableMinor,
        hardLimitMinor: wallet.caps.monthlyMinor ?? null,
      };
    }),
    roles: groupRoles(platform, groupId),
  };
}
