import { DomainError, ValidationError } from '../core/errors.ts';
import { CURRENCIES, JURISDICTIONS } from '../domain/locale.ts';
import { GROUP_LICENCE, PACKAGES, type PackageTier } from '../billing/seats.ts';
import { raiseOpeningCharge } from '../billing/collection.ts';
import type { SubscriptionTier } from '../billing/subscription.ts';
import type { AuthContext } from '../identity/auth.ts';
import type { Platform, PlatformUser } from '../platform.ts';
import { agreementInForce, agreementOf, chargeModeFor, setAgreement, type AgreementMode, type AgreementParty } from './agreement.ts';
import { attachCompany, createGroup, grantGroupRole, groupBySlug, groupOf, groupRolesFor, requireGroupRole, type Group } from './directory.ts';
import { issuerProfile, legalReadiness } from './profile.ts';

/**
 * Group onboarding as one idempotent act (enterprise specification §15.1,
 * AT-01, AT-44).
 *
 * The operator names the group, the agreement terms and one company with
 * its first administrator. Running it again with the same names creates
 * nothing twice: the group is found by its slug, the company by its cost
 * centre code within the group, the administrator by their address, the
 * agreement by being there already. A run that stops half way is resumed by
 * running it again. Nothing is guessed to make a readiness light green —
 * the registered issuer details are entered by the company afterwards, and
 * the readiness read says so.
 *
 * No customer name appears in this file. Groupe Nseya, ETABLIX and JN
 * Construction are what the operator types in; any other group is onboarded
 * by the same act.
 */

export type CompanyReadiness = {
  operational: { ready: boolean; missing: string[] };
  billing: { ready: boolean; missing: string[] };
  issuance: { ready: boolean; missing: string[] };
};

/** The three readiness lights, kept apart (§15.1): operational, billing, document issuance. */
export function readinessOf(platform: Platform, tenantId: string): CompanyReadiness {
  const tenant = platform.tenant(tenantId);
  const users = platform.users(tenantId);
  const subscription = platform.subscription(tenantId);
  const operationalMissing: string[] = [];
  if (!users.some((user) => user.status === 'ACTIVE' && (user.roles.includes('ENTERPRISE_ADMIN') || user.roles.includes('OWNER')))) operationalMissing.push('an active administrator');
  if (subscription.status !== 'ACTIVE') operationalMissing.push(`an active subscription (it is ${subscription.status.toLowerCase()})`);
  if (tenant.closedAt) operationalMissing.push('the company is closed');

  const billingMissing: string[] = [];
  const group = tenant.groupId ? platform.ledger.get({ refType: 'Group', refId: tenant.groupId })?.state as unknown as Group | undefined : undefined;
  if (!group) billingMissing.push('membership of a group');
  else {
    if (!group.costCentres.some((centre) => centre.tenantId === tenantId)) billingMissing.push('a cost centre in the group');
    if (!agreementInForce(agreementOf(platform, group.id))) billingMissing.push('an approved agreement in force');
  }

  const profile = issuerProfile(platform, tenantId);
  const legal = legalReadiness(profile);
  const issuanceMissing = legal.missing.map((field) => `issuer ${field}`);
  if (Object.keys(profile.numberingRules).length === 0) issuanceMissing.push('at least one numbering rule');

  return {
    operational: { ready: operationalMissing.length === 0, missing: operationalMissing },
    billing: { ready: billingMissing.length === 0, missing: billingMissing },
    issuance: { ready: issuanceMissing.length === 0, missing: issuanceMissing },
  };
}

export type OnboardingInput = {
  group: { displayName: string; slug?: string; currency: string; label?: string };
  agreement?: { mode: AgreementMode; seller: AgreementParty; payer: AgreementParty; cadence?: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' };
  company: {
    displayName: string;
    code: string;
    jurisdiction: string;
    currency: string;
    tier: SubscriptionTier;
    package: PackageTier;
    administrator: { name: string; email: string };
  };
  /** Somebody in the company to hold GROUP_ADMIN — usually the same administrator. */
  groupAdministrator?: string;
};

export type OnboardingResult = {
  group: Group;
  groupCreated: boolean;
  company: { tenantId: string; name: string; code: string; created: boolean };
  administrator: { id: string; email: string; created: boolean };
  agreement: { version: number | null; created: boolean };
  groupRole: { email: string; granted: boolean } | null;
  readiness: CompanyReadiness;
  /** Administrators created in this run, for the invitation the route sends. */
  invited: PlatformUser[];
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function onboardGroup(platform: Platform, actor: AuthContext, input: OnboardingInput): OnboardingResult {
  const company = input.company;
  const email = company.administrator.email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new ValidationError('The administrator needs a valid email address', [{ field: 'company.administrator.email', message: 'not an address' }]);
  if (!JURISDICTIONS[company.jurisdiction]) throw new ValidationError(`${company.jurisdiction} is not a jurisdiction the platform holds rules for`, [{ field: 'company.jurisdiction', message: 'unknown' }]);
  if (!CURRENCIES[company.currency]) throw new ValidationError(`${company.currency} is not a currency the platform counts in`, [{ field: 'company.currency', message: 'unknown' }]);
  const code = company.code.trim().toUpperCase();

  // The group, found or made.
  const slug = (input.group.slug?.trim() || input.group.displayName).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  let group = groupBySlug(platform, slug);
  const groupCreated = !group;
  if (!group) group = createGroup(platform, actor, { displayName: input.group.displayName, slug, currency: input.group.currency });

  // The agreement, set once as a draft the group approves.
  let agreementCreated = false;
  let agreement = agreementOf(platform, group.id);
  if (!agreement && input.agreement) {
    agreement = setAgreement(platform, actor, group.id, { ...input.agreement, currency: input.group.currency });
    agreementCreated = true;
  }

  // The company, found by its cost centre code in this group or created.
  const existing = group.costCentres.find((centre) => centre.code === code);
  let tenantId: string;
  let companyCreated = false;
  if (existing) {
    tenantId = existing.tenantId;
  } else {
    const held = platform.userByEmail(email);
    if (held && !existing) {
      // One human is one identity. An address already on the platform is a
      // person who exists; a second company for them is a membership, added
      // by that company's administrator, not a second first-administrator.
      throw new DomainError('EMAIL_IN_USE', `${email} already holds an identity on this platform; onboard the company with a different first administrator and add this person as a member afterwards`, 409);
    }
    const created = platform.createTenant({
      legalName: company.displayName.trim(),
      jurisdiction: company.jurisdiction,
      defaultCurrency: company.currency,
      tier: company.tier,
      package: company.package,
      enterpriseName: company.displayName.trim(),
      trialGrant: false,
    });
    tenantId = created.tenant.id;
    companyCreated = true;
    const mode = agreementInForce(agreement)?.mode ?? agreement?.versions[agreement.versions.length - 1]?.mode;
    group = attachCompany(platform, actor, group.id, { tenantId, code, chargeMode: mode ? chargeModeFor(mode) : 'INTERNAL' });
  }

  // The administrator, found by address in that company or created there.
  const invited: PlatformUser[] = [];
  let administrator = platform.users(tenantId).find((user) => user.email.toLowerCase() === email);
  let administratorCreated = false;
  if (!administrator) {
    if (platform.userByEmail(email)) throw new DomainError('EMAIL_IN_USE', `${email} already holds an identity in another company; add them to this one as a member instead`, 409);
    administrator = platform.createUser({ tenantId, name: company.administrator.name.trim(), email, roles: ['ENTERPRISE_ADMIN'] });
    administratorCreated = true;
    invited.push(administrator);
  }

  // The first group administrator, once.
  let groupRole: OnboardingResult['groupRole'] = null;
  const groupAdmin = input.groupAdministrator?.trim().toLowerCase();
  if (groupAdmin) {
    const already = groupRolesFor(platform, group.id, groupAdmin).includes('GROUP_ADMIN');
    if (!already) grantGroupRole(platform, actor, group.id, { email: groupAdmin, role: 'GROUP_ADMIN' });
    groupRole = { email: groupAdmin, granted: !already };
  }

  return {
    group,
    groupCreated,
    company: { tenantId, name: platform.tenant(tenantId).legalName, code, created: companyCreated },
    administrator: { id: administrator.id, email: administrator.email, created: administratorCreated },
    agreement: { version: agreement ? agreement.versions[agreement.versions.length - 1]!.version : null, created: agreementCreated },
    groupRole,
    readiness: readinessOf(platform, tenantId),
    invited,
  };
}

// --- the group administrator's own acts -------------------------------------------
//
// The operator onboards a group once. From then on the group runs itself: its
// administrator adds the organisations under it and names who administers
// each. Nothing here reaches into a company's records — a company is created,
// attached and given its first people, and everything after that is theirs.

export type AddCompanyInput = {
  displayName: string;
  /** Cost centre code, 2–8 letters or digits. Derived from the name when omitted. */
  code?: string;
  jurisdiction: string;
  currency: string;
  package: PackageTier;
  /** One or more enterprise administrators for the new company. */
  administrators: Array<{ name: string; email: string }>;
};

export type AddCompanyResult = {
  group: Group;
  company: { tenantId: string; name: string; code: string; slug: string };
  administrators: Array<{ id: string; name: string; email: string; existing: boolean }>;
  /** The first month, owed before the company opens; absent on a free package. */
  openingCharge: { id: string; amountMinor: number; paymentReference: string } | null;
  /** Administrators created in this act, for the invitation the route sends. */
  invited: PlatformUser[];
};

/** The packages a group administrator may put a company on without the operator. */
export const GROUP_COMPANY_PACKAGES: readonly PackageTier[] = ['SOLO', 'CORE_PROJECT', 'PROFESSIONAL_DELIVERY'];

/** What a bank transfer against a subscription charge quotes; the same rule the billing screen shows. */
export function paymentReferenceOf(chargeId: string): string {
  return `CX-${chargeId.slice(-8).toUpperCase()}`;
}

function costCentreCodeFor(name: string, taken: readonly string[]): string {
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const base = letters.slice(0, 3) || 'CO';
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base.slice(0, 6)}${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  throw new DomainError('COST_CENTRE_CODE_INVALID', 'Give the company a cost centre code; none could be derived from its name');
}

/**
 * Where an address stands before it is made an administrator of a company in
 * this group. A stranger is created there. A person already in one of the
 * group's companies gets a second membership — same name, same address, one
 * identity. An address held outside the group is refused: the group does not
 * get to pull somebody else's people in.
 */
function placeAdministrator(
  platform: Platform,
  group: Group,
  tenantId: string,
  person: { name: string; email: string },
  invited: PlatformUser[],
): { id: string; name: string; email: string; existing: boolean } {
  const email = person.email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new ValidationError(`${person.email} is not an email address`, [{ field: 'administrators', message: 'not an address' }]);
  if (person.name.trim().length < 2) throw new ValidationError('An administrator needs a name', [{ field: 'administrators', message: 'name required' }]);
  const already = platform.users(tenantId).find((user) => user.email.toLowerCase() === email && user.status === 'ACTIVE');
  if (already) return { id: already.id, name: already.name, email: already.email, existing: true };
  const held = platform.userByEmail(email);
  if (held) {
    const inGroup = group.costCentres.some((centre) => centre.tenantId === held.tenantId);
    if (!inGroup) {
      throw new DomainError('EMAIL_IN_USE', `${email} already holds an identity outside ${group.displayName}; name a different administrator`, 409);
    }
    const membership = platform.createUser({ tenantId, name: held.name, email: held.email, roles: ['ENTERPRISE_ADMIN'] });
    invited.push(membership);
    return { id: membership.id, name: membership.name, email: membership.email, existing: true };
  }
  const created = platform.createUser({ tenantId, name: person.name.trim(), email, roles: ['ENTERPRISE_ADMIN'] });
  invited.push(created);
  return { id: created.id, name: created.name, email: created.email, existing: false };
}

/**
 * A group administrator adds an organisation to the group: a new tenancy on
 * one of the self-serve paid packages, attached as a cost centre, with the
 * administrators named. The group licence caps the count (`attachCompany`
 * refuses the sixth). Nothing is free unless the package is: the company's
 * first month is charged and it waits for the payment like any signup —
 * the group sees what is owed on the directory, the company's administrator
 * sees it on ACU & Billing, and the operator can record a transfer against
 * the reference.
 */
export function addCompany(platform: Platform, actor: AuthContext, groupId: string, input: AddCompanyInput): AddCompanyResult {
  requireGroupRole(platform, actor, groupId, ['GROUP_ADMIN']);
  let group = groupOf(platform, groupId);
  const displayName = input.displayName.trim();
  if (displayName.length < 2) throw new ValidationError('The company needs a name', [{ field: 'displayName', message: 'required' }]);
  if (!JURISDICTIONS[input.jurisdiction]) throw new ValidationError(`${input.jurisdiction} is not a jurisdiction the platform holds rules for`, [{ field: 'jurisdiction', message: 'unknown' }]);
  if (!CURRENCIES[input.currency]) throw new ValidationError(`${input.currency} is not a currency the platform counts in`, [{ field: 'currency', message: 'unknown' }]);
  if (!GROUP_COMPANY_PACKAGES.includes(input.package)) {
    throw new DomainError(
      'PACKAGE_NOT_SELF_SERVE',
      `${PACKAGES[input.package]?.label ?? input.package} is provisioned with the platform operator, not from the group console`,
    );
  }
  if (!input.administrators?.length) throw new ValidationError('Name at least one administrator for the company', [{ field: 'administrators', message: 'required' }]);
  // Every administrator takes a seat, and the package decides how many there
  // are. Checked before anything exists: a company created with one of its two
  // administrators and a seat refusal for the other is the half-made record
  // this act must never leave behind.
  const seats = PACKAGES[input.package].includedSeats;
  if (seats !== null && input.administrators.length > seats) {
    throw new DomainError(
      'SEAT_LIMIT_REACHED',
      `The ${PACKAGES[input.package].label} package includes ${seats} seat${seats === 1 ? '' : 's'}; name ${seats === 1 ? 'one administrator' : `at most ${seats} administrators`} or choose a larger package`,
      422,
    );
  }
  if (group.costCentres.length >= GROUP_LICENCE.maxCompanies) {
    throw new DomainError('GROUP_FULL', `${group.displayName} already holds ${GROUP_LICENCE.maxCompanies} companies, which is what the group licence covers`, 409);
  }
  // Every address checked before anything is created, so a refusal leaves no
  // half-made company behind.
  const emails = input.administrators.map((person) => person.email.trim().toLowerCase());
  if (new Set(emails).size !== emails.length) throw new ValidationError('The same address is named twice', [{ field: 'administrators', message: 'duplicate' }]);
  for (const person of input.administrators) {
    const email = person.email.trim().toLowerCase();
    if (!EMAIL.test(email)) throw new ValidationError(`${person.email} is not an email address`, [{ field: 'administrators', message: 'not an address' }]);
    const held = platform.userByEmail(email);
    if (held && !group.costCentres.some((centre) => centre.tenantId === held.tenantId)) {
      throw new DomainError('EMAIL_IN_USE', `${email} already holds an identity outside ${group.displayName}; name a different administrator`, 409);
    }
  }
  const code = (input.code?.trim() || costCentreCodeFor(displayName, group.costCentres.map((centre) => centre.code))).toUpperCase();

  const created = platform.createTenant({
    legalName: displayName,
    jurisdiction: input.jurisdiction,
    defaultCurrency: input.currency,
    tier: 'TEAM',
    package: input.package,
    enterpriseName: displayName,
    trialGrant: false,
    opensOn: 'FIRST_PAYMENT',
    // Priced once it is a company of the group: the agreement's rate card
    // applies to the first month like every month after it.
    deferOpeningCharge: true,
  });
  const tenantId = created.tenant.id;
  const agreement = agreementOf(platform, group.id);
  const mode = agreementInForce(agreement)?.mode ?? agreement?.versions[agreement.versions.length - 1]?.mode;
  group = attachCompany(platform, actor, group.id, { tenantId, code, chargeMode: mode ? chargeModeFor(mode) : 'INTERNAL' });
  const opening = raiseOpeningCharge(platform, tenantId)?.charge;

  const invited: PlatformUser[] = [];
  const administrators = input.administrators.map((person) => placeAdministrator(platform, group, tenantId, person, invited));
  const centre = group.costCentres.find((entry) => entry.tenantId === tenantId)!;
  return {
    group,
    company: { tenantId, name: displayName, code: centre.code, slug: centre.slug },
    administrators,
    openingCharge: opening ? { id: opening.id, amountMinor: opening.amountMinor, paymentReference: paymentReferenceOf(opening.id) } : null,
    invited,
  };
}

/**
 * A group administrator names a further administrator for one of the group's
 * companies — the second person who can run it, or the first after the
 * original has left. The company must be one of this group's; a closed one
 * takes nobody new.
 */
export function appointAdministrator(
  platform: Platform,
  actor: AuthContext,
  groupId: string,
  tenantId: string,
  person: { name: string; email: string },
): { administrator: { id: string; name: string; email: string; existing: boolean }; company: { tenantId: string; name: string }; invited: PlatformUser[] } {
  requireGroupRole(platform, actor, groupId, ['GROUP_ADMIN']);
  const group = groupOf(platform, groupId);
  if (!group.costCentres.some((centre) => centre.tenantId === tenantId)) {
    throw new DomainError('NOT_IN_GROUP', `That company is not one of ${group.displayName}'s`, 404);
  }
  const tenant = platform.tenant(tenantId);
  if (tenant.closedAt) throw new DomainError('TENANT_CLOSED', `${tenant.legalName} is closed`, 409);
  const invited: PlatformUser[] = [];
  const administrator = placeAdministrator(platform, group, tenantId, person, invited);
  if (administrator.existing && invited.length === 0) {
    const user = platform.user(administrator.id);
    if (!user.roles.includes('ENTERPRISE_ADMIN')) {
      throw new DomainError('ALREADY_A_MEMBER', `${administrator.email} is already a person in ${tenant.legalName}; its administrator can change their roles from Team & Access`, 409);
    }
    throw new DomainError('ALREADY_A_MEMBER', `${administrator.email} already administers ${tenant.legalName}`, 409);
  }
  return { administrator, company: { tenantId, name: tenant.legalName }, invited };
}
