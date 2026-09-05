import { DomainError, ValidationError } from '../core/errors.ts';
import { CURRENCIES, JURISDICTIONS } from '../domain/locale.ts';
import { GROUP_LICENCE, PACKAGES, type PackageTier } from '../billing/seats.ts';
import type { SubscriptionTier } from '../billing/subscription.ts';
import type { AuthContext } from '../identity/auth.ts';
import type { Platform, PlatformUser } from '../platform.ts';
import { agreementInForce, agreementOf, chargeModeFor, setAgreement, type AgreementMode, type AgreementParty } from './agreement.ts';
import { attachCompany, createGroup, grantGroupRole, groupBySlug, groupOf, groupRolesFor, groups as allGroups, requireGroupRole, type Group } from './directory.ts';
import { issuerProfile, legalReadiness } from './profile.ts';
import { codeOf, slugOf } from '../identity/signup.ts';
import { PLATFORM_TENANT_ID } from '../platform.ts';

/**
 * Found a group from a company that already exists.
 *
 * The signup form offers "a group of companies", but a company that signed up
 * before that choice existed — or chose "one company" and grew — arrived as a
 * plain tenancy with no Group screen and no way to add a second organisation.
 * This is the same act the group signup performs at verification, run later by
 * the company's own administrator: the group is created and named after the
 * company (or as named), the company becomes its first cost centre, and the
 * administrator who pressed the button holds GROUP_ADMIN. Nothing about the
 * company changes — its people, records, wallet and subscription are as they
 * were; it has simply become the first of up to the licence's count.
 *
 * Refused for a company already in a group (a company belongs to one group,
 * and moving between them is a reviewed transfer, not a button), and for the
 * platform's own tenancy.
 */
export function foundGroup(
  platform: Platform,
  actor: AuthContext,
  input: { displayName?: string } = {},
): { group: Group; company: { tenantId: string; name: string; code: string }; maxCompanies: number } {
  if (!actor.roles.includes('ENTERPRISE_ADMIN') && !actor.roles.includes('OWNER')) {
    throw new DomainError('ADMINISTRATOR_REQUIRED', 'Only the company’s administrator may found a group from it.', 403);
  }
  if (actor.tenantId === PLATFORM_TENANT_ID) {
    throw new DomainError('NOT_A_COMPANY', 'The platform’s own tenancy is not a company and cannot found a group.', 422);
  }
  const tenant = platform.tenant(actor.tenantId);
  if (tenant.groupId) {
    const held = groupOf(platform, tenant.groupId);
    throw new DomainError('ALREADY_IN_GROUP', `${tenant.legalName} is already a company of ${held.displayName}. A company belongs to one group; moving between groups is a reviewed transfer.`, 409);
  }
  if (tenant.closedAt) throw new DomainError('COMPANY_CLOSED', `${tenant.legalName} is closed.`, 409);

  const displayName = (input.displayName?.trim() || tenant.legalName).slice(0, 200);
  if (displayName.length < 2) throw new ValidationError('A group needs a name of at least two characters', [{ field: 'displayName', message: 'too short' }]);

  let candidate = displayName;
  for (let n = 2; groupBySlug(platform, slugOf(candidate)); n++) candidate = `${displayName} ${n}`;
  const group = createGroup(platform, actor, { displayName, slug: slugOf(candidate), currency: tenant.defaultCurrency });
  const code = codeOf(tenant.legalName);
  const attached = attachCompany(platform, actor, group.id, { tenantId: tenant.id, code });
  const user = platform.user(actor.actorId);
  grantGroupRole(platform, actor, group.id, { email: user.email, role: 'GROUP_ADMIN' });

  return { group: groupOf(platform, attached.id), company: { tenantId: tenant.id, name: tenant.legalName, code }, maxCompanies: GROUP_LICENCE.maxCompanies };
}

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
  /**
   * Ignored when given. A company of a group is on the group's package — the
   * primary company's — and covered by that subscription; the field stays so
   * a caller written against the earlier contract is not refused.
   */
  package?: PackageTier;
  /** One or more enterprise administrators for the new company. */
  administrators: Array<{ name: string; email: string }>;
};

export type AddCompanyResult = {
  group: Group;
  company: { tenantId: string; name: string; code: string; slug: string };
  administrators: Array<{ id: string; name: string; email: string; existing: boolean }>;
  /** Always null now: a company of a group owes no first month of its own. Kept so the shape does not move under a caller. */
  openingCharge: { id: string; amountMinor: number; paymentReference: string } | null;
  /** Whose subscription carries this company, and on which package. */
  coveredBy: { tenantId: string; name: string; package: PackageTier; packageLabel: string };
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
 * the group's package — the primary company's — attached as a cost centre,
 * covered by the primary's subscription, with the administrators named. The
 * group licence caps the count (`attachCompany` refuses the sixth). The
 * company opens at once and is billed nothing: the enterprise account carries
 * the subscription and the package, and AI credit is a top-up on the
 * company's own wallet.
 */
export function addCompany(platform: Platform, actor: AuthContext, groupId: string, input: AddCompanyInput): AddCompanyResult {
  requireGroupRole(platform, actor, groupId, ['GROUP_ADMIN']);
  let group = groupOf(platform, groupId);
  const displayName = input.displayName.trim();
  if (displayName.length < 2) throw new ValidationError('The company needs a name', [{ field: 'displayName', message: 'required' }]);
  if (!JURISDICTIONS[input.jurisdiction]) throw new ValidationError(`${input.jurisdiction} is not a jurisdiction the platform holds rules for`, [{ field: 'jurisdiction', message: 'unknown' }]);
  if (!CURRENCIES[input.currency]) throw new ValidationError(`${input.currency} is not a currency the platform counts in`, [{ field: 'currency', message: 'unknown' }]);
  // The group's package: the primary company's, whatever the caller said. The
  // customer's rule, stated more than once: the enterprise account carries the
  // subscription and the package; the companies under it carry neither.
  const primary = primaryCompanyOf(platform, group);
  if (!primary) throw new DomainError('GROUP_HAS_NO_COMPANY', `${group.displayName} has no open company to carry the subscription`, 409);
  const pkg = PACKAGES[primary.package];
  if (!input.administrators?.length) throw new ValidationError('Name at least one administrator for the company', [{ field: 'administrators', message: 'required' }]);
  // Every administrator takes a seat, and the package decides how many there
  // are. Checked before anything exists: a company created with one of its two
  // administrators and a seat refusal for the other is the half-made record
  // this act must never leave behind.
  const seats = pkg.includedSeats;
  if (seats !== null && input.administrators.length > seats) {
    throw new DomainError(
      'SEAT_LIMIT_REACHED',
      `${primary.name}'s ${pkg.label} package includes ${seats} seat${seats === 1 ? '' : 's'}, and every company of the group is on it; name ${seats === 1 ? 'one administrator' : `at most ${seats} administrators`}, or ask the operator to move the group to a larger package`,
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
    tier: primary.tier,
    package: primary.package,
    enterpriseName: displayName,
    trialGrant: false,
    // A company under a group opens at once. Its administrators pay nothing:
    // the primary company's subscription covers it. It used to wait
    // AWAITING_PAYMENT with its own administrators told to pay the first
    // month — the rule the group exists to replace.
    opensOn: 'CREATION',
    // No first month of its own: the grant below says who covers it, and the
    // raise would only be written off again.
    deferOpeningCharge: true,
  });
  const tenantId = created.tenant.id;
  const agreement = agreementOf(platform, group.id);
  const mode = agreementInForce(agreement)?.mode ?? agreement?.versions[agreement.versions.length - 1]?.mode;
  group = attachCompany(platform, actor, group.id, { tenantId, code, chargeMode: mode ? chargeModeFor(mode) : 'INTERNAL' });
  // Covered by the primary's subscription, on the record with the reason.
  coverCompany(platform, group, tenantId);

  const invited: PlatformUser[] = [];
  const administrators = input.administrators.map((person) => placeAdministrator(platform, group, tenantId, person, invited));
  const centre = group.costCentres.find((entry) => entry.tenantId === tenantId)!;
  return {
    group,
    company: { tenantId, name: displayName, code: centre.code, slug: centre.slug },
    administrators,
    openingCharge: null,
    coveredBy: { tenantId: primary.tenantId, name: primary.name, package: primary.package, packageLabel: pkg.label },
    invited,
  };
}

/**
 * The company whose subscription the group runs on: the first cost centre
 * still open. For a group founded at signup or from an existing company that
 * is the company that founded it — the enterprise account the customer means
 * when they say "everything is on the enterprise administrator".
 */
export function primaryCompanyOf(platform: Platform, group: Group): { tenantId: string; name: string; package: PackageTier; tier: SubscriptionTier } | undefined {
  for (const centre of group.costCentres) {
    const tenant = platform.tenant(centre.tenantId);
    if (tenant.closedAt || tenant.deletedAt) continue;
    const subscription = platform.subscription(centre.tenantId);
    return { tenantId: centre.tenantId, name: tenant.legalName, package: subscription.package, tier: subscription.tier };
  }
  return undefined;
}

const COVERED_BY = 'billing:group';

/**
 * Bring one company under the group's subscription: the primary company's
 * package, granted free of charge because the primary's subscription covers it.
 * Idempotent — a company already on that footing produces no event — and
 * refused, not forced, where the primary's package cannot hold the people the
 * company already has; the refusal is returned rather than thrown so a run
 * over a whole estate names it and carries on.
 */
export function coverCompany(platform: Platform, group: Group, tenantId: string, now: Date = new Date()): { changed: boolean; refused?: string } {
  const primary = primaryCompanyOf(platform, group);
  if (!primary || primary.tenantId === tenantId) return { changed: false };
  const tenant = platform.tenant(tenantId);
  if (tenant.closedAt || tenant.deletedAt) return { changed: false };
  const subscription = platform.subscription(tenantId);
  if (subscription.package === primary.package && subscription.grantedFree === true && subscription.status !== 'AWAITING_PAYMENT') return { changed: false };
  try {
    platform.setSubscriptionPackage({
      tenantId,
      package: primary.package,
      reason: `Company of ${group.displayName}: covered by ${primary.name}'s ${PACKAGES[primary.package].label} subscription, which the group pays. Nothing is billed to the company; AI credit is topped up on its own wallet. (${now.toISOString().slice(0, 10)})`,
      decidedBy: COVERED_BY,
      grantFree: true,
    });
    return { changed: true };
  } catch (error) {
    return { changed: false, refused: (error as Error).message };
  }
}

/**
 * Every group's companies, brought under the group's subscription.
 *
 * Run before each billing pass and once at boot, so a company created before
 * this rule existed — waiting for a first month its own administrators were
 * asked to pay — opens and is covered the next time the platform looks, with
 * nothing anybody has to press. Reports what it changed and what it could not.
 */
export function coverGroupCompanies(platform: Platform, now: Date = new Date()): { covered: Array<{ groupId: string; tenantId: string }>; refused: Array<{ groupId: string; tenantId: string; because: string }> } {
  const covered: Array<{ groupId: string; tenantId: string }> = [];
  const refused: Array<{ groupId: string; tenantId: string; because: string }> = [];
  for (const group of allGroups(platform)) {
    for (const centre of group.costCentres) {
      const outcome = coverCompany(platform, group, centre.tenantId, now);
      if (outcome.changed) covered.push({ groupId: group.id, tenantId: centre.tenantId });
      if (outcome.refused) refused.push({ groupId: group.id, tenantId: centre.tenantId, because: outcome.refused });
    }
  }
  return { covered, refused };
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
