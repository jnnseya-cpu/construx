import { DomainError, ValidationError } from '../core/errors.ts';
import { CURRENCIES, JURISDICTIONS } from '../domain/locale.ts';
import type { PackageTier } from '../billing/seats.ts';
import type { SubscriptionTier } from '../billing/subscription.ts';
import type { AuthContext } from '../identity/auth.ts';
import type { Platform, PlatformUser } from '../platform.ts';
import { agreementInForce, agreementOf, chargeModeFor, setAgreement, type AgreementMode, type AgreementParty } from './agreement.ts';
import { attachCompany, createGroup, grantGroupRole, groupBySlug, groupRolesFor, type Group } from './directory.ts';
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
