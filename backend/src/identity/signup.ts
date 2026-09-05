import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';
import { ulid } from '../core/ids.ts';
import { DomainError, NotFoundError, ValidationError } from '../core/errors.ts';
import { CURRENCIES, JURISDICTIONS } from '../domain/locale.ts';
import type { Platform } from '../platform.ts';
import { acusFromMinor, subscriptionAcuAllocationMinor } from '../billing/acu.ts';
import { GROUP_LICENCE, PACKAGES, type PackageTier } from '../billing/seats.ts';
import type { AuthContext } from './auth.ts';
import { attachCompany, createGroup, grantGroupRole, groupBySlug } from '../group/directory.ts';
import type { Role } from './roles.ts';

/**
 * Public registration.
 *
 * The one place an unauthenticated stranger creates state. Everything about it
 * is written on the assumption that the caller is hostile until an address is
 * proved, because on a public endpoint that is the only safe assumption.
 *
 * ---
 *
 * **A registration is not an account.** It is a pending record with a hashed
 * token against it. Nothing is charged, no seat is consumed, no tenancy exists
 * and no credential works until an address has been proved. The alternative —
 * creating the tenant first and marking it unverified — means anybody can
 * create unlimited tenancies by typing addresses they do not own, and every one
 * of them lands in the billing tables.
 *
 * **Registering an address that already exists returns the same answer as
 * registering a new one.** A public endpoint that distinguishes the two is an
 * account-enumeration oracle: it tells an attacker which of a leaked address
 * list are customers here. The person who genuinely owns the address gets an
 * email either way — a verification link, or a note that an account already
 * exists and how to get back into it.
 *
 * **Verification tokens are stored hashed.** The token goes to the address and
 * only the HMAC is kept, so a dump of platform state does not let the holder
 * activate somebody else's registration. Comparison is constant-time.
 *
 * **No token, no session.** Completing a registration produces an account, not
 * an authenticated session; the person then signs in through the ordinary
 * `/v1/auth/login` and MFA path like every other client. This is the invariant
 * the console-session hole broke, and the public-surface test enforces it.
 */

/** How long a verification link is good for. */
export const VERIFICATION_TTL_MINUTES = 60 * 24;

/**
 * The account types a stranger may select.
 *
 * Deliberately not every `PackageTier`. `ENTERPRISE` is sold, negotiated and
 * provisioned — a self-serve route into it would create tenancies nobody has
 * agreed terms with, on a package whose price is "contact us". Asking for it
 * registers an enterprise *enquiry* instead, which is the honest version of the
 * same button.
 */
export const SELF_SERVE_PACKAGES: PackageTier[] = ['FREE_TRIAL', 'SOLO', 'CORE_PROJECT', 'PROFESSIONAL_DELIVERY'];

export type AccountType = {
  package: PackageTier;
  label: string;
  targetCustomer: string;
  /** `null` is unlimited, and is kept as null: zero would read as "none". */
  includedSeats: number | null;
  monthlyPriceMinor: number;
  storageGb: number;
  export: boolean;
  apiAccess: boolean;
  /** Whether a stranger can provision this without talking to anybody. */
  selfServe: boolean;
  /** The share of the plan credited to the AI wallet, in minor units. */
  aiAllowanceMinor: number;
  /** The same figure in ACUs. One ACU is one minor unit, so £1 is 100. */
  aiAllowanceAcus: number;
};

/** Every account type, with what it includes and whether it is self-serve. */
export function accountTypes(): AccountType[] {
  return (Object.keys(PACKAGES) as PackageTier[]).map((code) => {
    const definition = PACKAGES[code];
    return {
      package: code,
      label: definition.label,
      targetCustomer: definition.targetCustomer,
      includedSeats: definition.includedSeats,
      monthlyPriceMinor: definition.monthlyPriceMinor,
      storageGb: definition.storageGb,
      export: definition.export,
      apiAccess: definition.apiAccess,
      selfServe: SELF_SERVE_PACKAGES.includes(code),
      // Published rather than left implicit: a customer choosing a plan is
      // choosing an AI budget, and a plan that does not say how much AI it
      // includes is one they will discover the answer to when it stops.
      aiAllowanceMinor: subscriptionAcuAllocationMinor(definition.monthlyPriceMinor),
      aiAllowanceAcus: acusFromMinor(subscriptionAcuAllocationMinor(definition.monthlyPriceMinor)),
    };
  });
}

export type RegistrationStatus = 'PENDING_VERIFICATION' | 'VERIFIED' | 'EXPIRED' | 'SUPERSEDED';

/** What is being set up: a single company, or a group that will hold several. */
export type AccountStructure = 'COMPANY' | 'GROUP';
export const ACCOUNT_STRUCTURES: readonly AccountStructure[] = ['COMPANY', 'GROUP'];

/** The same slug rule the group directory applies, so a name maps to one slug everywhere. */
function slugOf(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'group';
}

/** A cost centre code for the founding company: its first letters, 'CO' where a name has none. */
function codeOf(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'CO';
}

export type Registration = {
  id: string;
  /** Lower-cased. The address is the identity of a registration. */
  email: string;
  contactName: string;
  organisationName: string;
  jurisdiction: string;
  currency: string;
  package: PackageTier;
  /**
   * One company, or a group of companies. A group signup creates the group
   * with this organisation as its first company and the person as its first
   * group administrator; the other organisations are added from the Group
   * console afterwards. Absent on registrations made before the choice existed.
   */
  structure?: AccountStructure;
  /** The referral code the signup link carried, if any. Fixed at registration. */
  referralCode?: string;
  status: RegistrationStatus;
  createdAt: string;
  expiresAt: string;
  verifiedAt?: string;
  /** Set once the registration has been turned into a tenancy. */
  tenantId?: string;
  userId?: string;
};

/** What a caller gets back. Never the token, and never whether the address was new. */
export type RegistrationReceipt = {
  registrationId?: string;
  status: 'SENT';
  message: string;
  /** Outside production only, so local work needs no mailbox. */
  devToken?: string;
};

const registrations = new Map<string, Registration>();
/** id → HMAC of the token. The token itself is never stored. */
const tokenHashes = new Map<string, string>();

/** Cleared between tests and on restart; registrations are pending state, not a record. */
export function resetRegistrations(): void {
  registrations.clear();
  tokenHashes.clear();
  trialsTaken.clear();
}

function hashToken(token: string): string {
  return createHmac('sha256', config.auth.jwtSecret).update(token).digest('hex');
}

function tokensMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(hashToken(supplied), 'hex');
  const b = Buffer.from(expected, 'hex');
  // Length must match before timingSafeEqual, which throws on a mismatch.
  return a.length === b.length && timingSafeEqual(a, b);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Email domains that have already taken a free trial.
 *
 * Every `createTenant` grants the trial credit, and signup creates a tenancy per
 * verified address. Nothing counted, so a handful of addresses at one company —
 * or one address with plus-suffixes, or a disposable-mail domain — took a fresh
 * grant each time. Individually small; automated, unbounded, and every pound of
 * it buys real provider compute.
 *
 * Keyed on the domain rather than the address for exactly that reason: the
 * address is trivially varied and the domain is the organisation, which is what
 * the trial is offered to. Free-mail domains are the deliberate exception —
 * refusing a second trial to everyone at gmail.com would refuse it to every
 * sole trader in the country — so those are counted per address instead.
 */
const trialsTaken = new Map<string, number>();

/**
 * Domains where one organisation does not mean one customer.
 *
 * A trial per address is right here; a trial per domain would be one trial for
 * every sole trader using a free mailbox, which is most of them.
 */
const SHARED_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'gmx.com',
  'yandex.com',
]);

/**
 * The key a trial is counted against.
 *
 * Plus-addressing is stripped: `rowan+one@acme.com` and `rowan+two@acme.com`
 * are one mailbox at every major provider, and treating them as two customers
 * is the cheapest way to farm the grant.
 */
export function trialKey(email: string): string {
  const [local = '', domain = ''] = normaliseEmail(email).split('@');
  if (SHARED_MAIL_DOMAINS.has(domain)) {
    const withoutTag = local.split('+')[0] ?? local;
    // Dots are not significant in a Gmail address either.
    return `${domain === 'gmail.com' || domain === 'googlemail.com' ? withoutTag.replaceAll('.', '') : withoutTag}@${domain}`;
  }
  return domain;
}

/** How many free trials this organisation or mailbox has already taken. */
export function trialsTakenBy(email: string): number {
  return trialsTaken.get(trialKey(email)) ?? 0;
}

/** Record that a trial has been taken. Called once, when a tenancy is provisioned. */
export function recordTrialTaken(email: string): void {
  const key = trialKey(email);
  trialsTaken.set(key, (trialsTaken.get(key) ?? 0) + 1);
}

/** Whether this address is entitled to the free grant at all. */
export function trialGrantAllowed(email: string): boolean {
  return trialsTakenBy(email) < config.billing.trialsPerOrganisation;
}

export function findByEmail(email: string): Registration | undefined {
  const wanted = normaliseEmail(email);
  return [...registrations.values()].find((r) => r.email === wanted && r.status === 'PENDING_VERIFICATION');
}

export function registration(id: string): Registration | undefined {
  return registrations.get(id);
}

export function pendingRegistrations(): Registration[] {
  return [...registrations.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Begin a registration.
 *
 * Returns the same receipt whether or not the address is already in use. The
 * caller cannot tell, and that is the point.
 */
export function register(
  platform: Platform,
  input: {
    email: string;
    contactName: string;
    organisationName: string;
    jurisdiction: string;
    currency: string;
    package: PackageTier;
    /** One company (the default) or a group of companies. */
    structure?: AccountStructure;
    /**
     * A referral code from the link they arrived on.
     *
     * Carried through verification onto the tenancy, so attribution is fixed at
     * the moment somebody signs up rather than assigned afterwards by whoever
     * is looking at the numbers.
     */
    referralCode?: string;
  },
): { receipt: RegistrationReceipt; outcome: 'NEW' | 'ALREADY_REGISTERED'; registration?: Registration; token?: string } {
  const email = normaliseEmail(input.email);

  if (!EMAIL.test(email)) throw new ValidationError('A valid email address is required');
  if (input.contactName.trim().length < 2) throw new ValidationError('A contact name is required');
  if (input.organisationName.trim().length < 2) throw new ValidationError('An organisation name is required');
  if (!CURRENCIES[input.currency]) {
    throw new ValidationError(`${input.currency} is not a currency the platform counts in`);
  }
  if (!JURISDICTIONS[input.jurisdiction]) {
    throw new ValidationError(`${input.jurisdiction} is not a jurisdiction the platform holds rules for`);
  }
  if (!SELF_SERVE_PACKAGES.includes(input.package)) {
    throw new DomainError(
      'PACKAGE_NOT_SELF_SERVE',
      `${PACKAGES[input.package]?.label ?? input.package} is provisioned with an agreement rather than a form. ` +
        'Register an enterprise enquiry instead.',
    );
  }

  // The uniform receipt. Identical in both branches, deliberately.
  const receipt: RegistrationReceipt = {
    status: 'SENT',
    message:
      'If that address can receive mail, a message is on its way. ' +
      'Follow the link inside it to finish setting up the account.',
  };

  // Already a user? Say nothing different. The address owner is told by email.
  if (platform.userByEmail(email)) {
    return { receipt, outcome: 'ALREADY_REGISTERED' };
  }

  // A second attempt supersedes the first rather than creating a duplicate, so
  // an impatient person who presses the button twice does not end up with two
  // live links and a confusing pair of emails.
  for (const existing of registrations.values()) {
    if (existing.email === email && existing.status === 'PENDING_VERIFICATION') {
      existing.status = 'SUPERSEDED';
      // The hash is kept rather than deleted. Somebody holding the older token
      // is the genuine address owner clicking their first email, and they get
      // "a newer link was issued" instead of "not valid", which is the
      // difference between a person retrying and a person giving up. A caller
      // without the token still gets an undifferentiated 404, so this explains
      // nothing to anybody who did not receive the mail.
    }
  }

  const id = ulid();
  const token = randomBytes(32).toString('base64url');
  const now = new Date();

  const record: Registration = {
    id,
    email,
    contactName: input.contactName.trim(),
    organisationName: input.organisationName.trim(),
    jurisdiction: input.jurisdiction,
    currency: input.currency,
    package: input.package,
    structure: input.structure ?? 'COMPANY',
    referralCode: input.referralCode?.trim() || undefined,
    status: 'PENDING_VERIFICATION',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + VERIFICATION_TTL_MINUTES * 60_000).toISOString(),
  };

  registrations.set(id, record);
  tokenHashes.set(id, hashToken(token));

  return {
    receipt: { ...receipt, registrationId: id, ...(config.env === 'production' ? {} : { devToken: token }) },
    outcome: 'NEW',
    registration: record,
    token,
  };
}

/** The link that goes in the verification email. */
export function verificationUrl(registrationId: string, token: string): string {
  return `${config.publicBaseUrl}/verify?r=${encodeURIComponent(registrationId)}&t=${encodeURIComponent(token)}`;
}

export type Activation = {
  registration: Registration;
  tenantId: string;
  userId: string;
  enterpriseName: string;
  /**
   * What the wallet opened with. Zero where the organisation had already had
   * its trial, or where the month's trial allocation is spent — and in either
   * case the person is told, because a wallet that opens empty with no word
   * reads as AI that does not work. Always zero on a paid package: nothing is
   * free unless the package is.
   */
  trialGrantMinor: number;
  /** One company, or the first company of a group founded by this signup. */
  structure: AccountStructure;
  /** The group founded by this signup, with what its licence covers. Null on a single company. */
  group: { id: string; slug: string; displayName: string; maxCompanies: number } | null;
  /**
   * A paid package: the tenancy exists and opens when the first month is paid.
   * `amountDueMinor` is that month, in the billing currency, and `chargeId`
   * the charge that paying settles.
   */
  awaitingPayment: boolean;
  amountDueMinor: number;
  chargeId?: string;
};

/**
 * Complete a registration: prove the address, then create the tenancy.
 *
 * The tenancy is created here and not at `register()` because until this point
 * nobody has shown they own the address. The administrator is the first user
 * and holds `ENTERPRISE_ADMIN` — somebody has to be able to invite the rest,
 * and it is their organisation.
 */
export function verify(
  platform: Platform,
  input: { registrationId: string; token: string; correlationId: string },
): Activation {
  const record = registrations.get(input.registrationId);
  const expected = tokenHashes.get(input.registrationId);

  // A missing registration and a wrong token answer the same way. Distinguishing
  // them tells a caller which ids are real.
  if (!record || !expected) throw new NotFoundError('That verification link is not valid');
  if (!tokensMatch(input.token, expected)) throw new NotFoundError('That verification link is not valid');

  if (record.status === 'VERIFIED') {
    throw new DomainError('ALREADY_VERIFIED', 'That account has already been set up. Sign in instead.');
  }
  if (record.status === 'SUPERSEDED') {
    throw new DomainError('LINK_SUPERSEDED', 'A newer verification link was issued. Use the most recent email.');
  }
  if (new Date(record.expiresAt).getTime() < Date.now()) {
    record.status = 'EXPIRED';
    tokenHashes.delete(record.id);
    throw new DomainError('LINK_EXPIRED', 'That verification link has expired. Request a new one.');
  }

  // Between registering and verifying, somebody else may have taken the address
  // through another route. The registration loses; it never held it.
  if (platform.userByEmail(record.email)) {
    throw new DomainError('EMAIL_IN_USE', 'An account already exists for that address. Sign in instead.');
  }

  // One free trial per organisation. Checked here rather than in `createTenant`
  // because this is the only path a stranger can reach, and an operator
  // provisioning a customer should not be second-guessed by it.
  const grantTrial = trialGrantAllowed(record.email);

  const { tenant, trialGrantMinor, openingCharge } = platform.createTenant({
    trialGrant: grantTrial,
    legalName: record.organisationName,
    jurisdiction: record.jurisdiction,
    defaultCurrency: record.currency,
    tier: 'FREE_TRIAL',
    package: record.package,
    enterpriseName: record.organisationName,
    // Carried from the registration rather than read here, so the code that
    // credits a partner is the one the person actually arrived on — not
    // whatever link happened to be open when they finished verifying.
    referralCode: record.referralCode,
    // A stranger on a paid package has proved an address and nothing else.
    // The tenancy waits for its first month; a free package opens now.
    opensOn: 'FIRST_PAYMENT',
  });

  const roles: Role[] = ['ENTERPRISE_ADMIN'];
  const user = platform.createUser({
    tenantId: tenant.id,
    name: record.contactName,
    email: record.email,
    roles,
  });

  // Branding is a precondition for every export, and refusing to export is the
  // correct behaviour rather than substituting a default. Seeding the
  // organisation's own name gives a working starting point they can replace,
  // and nothing here invents a logo.
  platform.exports.setBranding(tenant.id, {
    clientName: record.organisationName,
    // The party carrying the duty on every document this organisation issues.
    // Seeded to their own name because at signup that is exactly who it is;
    // per-project branding overrides `clientName` later, and this stays theirs.
    issuingEntity: record.organisationName,
    primaryColour: '#ff6600',
    documentReferencePrefix: record.organisationName.slice(0, 3).toUpperCase().padEnd(3, 'X'),
    legalFooter: `${record.organisationName} · registered in ${record.jurisdiction}`,
  });

  // Taken only if something was actually given. An organisation that arrived
  // after the month's allocation was spent has not had its trial.
  if (grantTrial && trialGrantMinor > 0) recordTrialTaken(record.email);

  // A group signup: the group exists from the first moment, with this
  // organisation as its first company and this person as its first group
  // administrator. The other organisations are theirs to add from the Group
  // console — up to what the group licence covers — with the administrators
  // they name. The acts are the directory's own, under the new
  // administrator's identity, so the chain says who founded the group.
  let group: Activation['group'] = null;
  if (record.structure === 'GROUP') {
    const founder: AuthContext = {
      actorId: user.id,
      tenantId: tenant.id,
      partyId: user.partyId,
      roles: user.roles,
      scopes: [],
      tokenId: 'signup',
      mfaSatisfied: true,
      regulatorAiEnabled: false,
      expiresAt: Date.now(),
    };
    // Two groups may share a name; a slug is unique, so a second "Northgate"
    // becomes "northgate-2" rather than a refusal on the one page a stranger
    // cannot retry from.
    let candidate = record.organisationName;
    for (let n = 2; groupBySlug(platform, slugOf(candidate)); n++) candidate = `${record.organisationName} ${n}`;
    const created = createGroup(platform, founder, { displayName: record.organisationName, slug: slugOf(candidate), currency: record.currency });
    attachCompany(platform, founder, created.id, { tenantId: tenant.id, code: codeOf(record.organisationName) });
    grantGroupRole(platform, founder, created.id, { email: user.email, role: 'GROUP_ADMIN' });
    group = { id: created.id, slug: created.slug, displayName: created.displayName, maxCompanies: GROUP_LICENCE.maxCompanies };
  }

  record.status = 'VERIFIED';
  record.verifiedAt = new Date().toISOString();
  record.tenantId = tenant.id;
  record.userId = user.id;
  // The token is spent. Keeping it would leave a second working link.
  tokenHashes.delete(record.id);

  return {
    registration: record,
    tenantId: tenant.id,
    userId: user.id,
    enterpriseName: record.organisationName,
    trialGrantMinor,
    awaitingPayment: openingCharge !== undefined,
    amountDueMinor: openingCharge?.amountMinor ?? 0,
    ...(openingCharge ? { chargeId: openingCharge.id } : {}),
    structure: record.structure ?? 'COMPANY',
    group,
  };
}
