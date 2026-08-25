import { AIOrchestrator } from './ai/orchestrator.ts';
import { EvidenceStore } from './evidence/store.ts';
import { SigningAuthority } from './signing/signature.ts';
import { ExportService } from './export/exporter.ts';
import { SyncEngine } from './field/sync.ts';
import { ACUWallet, type ACUCaps, type ACUEntry } from './billing/acu.ts';
import { buildInvoice, type Invoice } from './billing/invoice.ts';
import { assignIdentity, packageForTier, revokeIdentity, TIERS, type Subscription, type SubscriptionTier } from './billing/subscription.ts';
import { standing } from './billing/entitlement.ts';
import {
  BILLING_CURRENCY,
  assertBillablePeriod,
  assertCreditableAmount,
  normaliseReference,
  type PaymentMethod,
  type PaymentReceipt,
  type TopUpIntent,
} from './billing/payments.ts';
import { PACKAGES, UNCHARGED_ROLES, type PackageTier } from './billing/seats.ts';
import * as storage from './billing/storage.ts';
import { config } from './config.ts';
import { DomainError, ForbiddenError, NotFoundError } from './core/errors.ts';
import { hashEvidence } from './core/canonical.ts';
import { ulid } from './core/ids.ts';
import type { EngineContext } from './engines/context.ts';
import { GoldenThreadLedger } from './goldenthread/ledger.ts';
import type { EventSource } from './goldenthread/types.ts';
import type { AuthContext } from './identity/auth.ts';
import { issueTokens, type TokenPair } from './identity/auth.ts';
import type { Role } from './identity/roles.ts';
import { dueAt, graceDays, isDue, pseudonym, retentionBasis } from './identity/erasure.ts';

/**
 * Platform assembly — one object that owns the ledger, the wallets, the
 * subscriptions and the AI control plane, and hands out per-request engine
 * contexts. Everything else in the system depends on interfaces, not on this.
 */

/**
 * Operator accounts are filed under this reserved tenancy so that "which tenant
 * is this identity in" always has an answer, and so no customer tenant can ever
 * collide with it — tenant ids are ULIDs.
 */
export const PLATFORM_TENANT_ID = 'platform';

export type Tenant = {
  id: string;
  legalName: string;
  jurisdiction: string;
  defaultCurrency: string;
  enterpriseId?: string;
  createdAt: string;
};

export type PlatformUser = {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  roles: Role[];
  partyId?: string;
  status: 'ACTIVE' | 'SUSPENDED';
  /**
   * Erasure. Absent on an identity nobody has asked to remove, which is almost
   * all of them, so the fields are optional rather than a nested object that
   * would exist empty on every user.
   */
  erasureRequestedAt?: string;
  erasureDueAt?: string;
  erasureRequestedBy?: string;
  /** Set once the identity has been pseudonymised. Never unset. */
  erasedAt?: string;
};

export class Platform {
  readonly ledger = new GoldenThreadLedger();
  readonly orchestrator: AIOrchestrator;
  /** Offline-first field sync. Devices push batches and pull by cursor. */
  readonly sync: SyncEngine;
  /** Every document that leaves the platform is branded, hashed and recorded. */
  readonly exports: ExportService;
  /**
   * The bytes behind the evidence hashes. Empty root means the ledger records
   * that a document with a given hash was the evidence and the platform does
   * not hold it — a state the register reports rather than hides.
   */
  readonly evidence: EvidenceStore;
  /**
   * The key the platform witnesses signatures with. Unconfigured means signing
   * is refused rather than done with a key nobody can verify against tomorrow.
   */
  readonly signing: SigningAuthority;

  readonly #wallets = new Map<string, ACUWallet>();
  /**
   * Where wallet entries are made durable. Attached to every wallet the
   * platform creates, so a tenancy provisioned after boot is journalled too —
   * the failure this prevents is a wallet that is durable only if it happened
   * to exist when the process started.
   */
  #walletSink: ((entry: ACUEntry) => void) | undefined;

  /** Attach the durable sink for ACU entries. Applies to existing wallets too. */
  attachWalletSink(sink: (entry: ACUEntry) => void): void {
    this.#walletSink = sink;
    for (const wallet of this.#wallets.values()) wallet.attachSink(sink);
  }
  readonly #subscriptions = new Map<string, Subscription>();
  /** Top-up requests, keyed by id. Intents only — none of these is money. */
  readonly #topUpIntents = new Map<string, TopUpIntent>();
  /**
   * Every payment ever recorded, keyed by its reference.
   *
   * Keyed by reference rather than by id because the reference is the
   * uniqueness rule: it is what makes a replayed webhook credit nothing, and a
   * map keyed on anything else would need a scan to enforce it.
   */
  readonly #receiptsByReference = new Map<string, PaymentReceipt>();
  readonly #tenants = new Map<string, Tenant>();
  readonly #users = new Map<string, PlatformUser>();

  constructor(
    orchestrator = new AIOrchestrator(),
    evidence = new EvidenceStore(),
    signing = new SigningAuthority(),
  ) {
    this.orchestrator = orchestrator;
    this.evidence = evidence;
    this.signing = signing;
    this.sync = new SyncEngine(this.ledger);
    // The exporter asks whether a tenant may take a document out; the platform
    // is what knows. A tenant with no subscription on record is refused rather
    // than allowed — the failure of a lookup should not open the gate.
    // Delegated to `billing/entitlement.ts`, which is now the single answer to
    // "what may this tenancy do". This gate used to be the only one that read
    // `subscription.status` at all — writes, AI execution and top-ups read
    // none of it — so the same tenancy could be refused an export and still
    // append to the ledger, run engines and buy credit. One function, asked the
    // same way by every gate, is what stops that happening again.
    //
    // The exemptions it applies are the ones this gate established: the
    // platform operator is not a customer and has no package to be limited by,
    // and a regulator's access is one the asset owner is obliged to provide —
    // refusing it because the contractor has not paid would be this platform
    // enforcing a commercial term against a statutory right.
    this.exports = new ExportService(this.ledger, (tenantId, roles) => {
      const position = standing(this.#subscriptions.get(tenantId), roles);
      return position.mayExport
        ? { permitted: true }
        : { permitted: false, ...(position.reason ? { reason: position.reason } : {}) };
    });
  }

  // --- Tenancy ---------------------------------------------------------------

  /**
   * Onboard a tenant. Only the platform operator does this — the separation
   * that stops enterprise admins from minting their own tenancies and stops
   * platform staff from seeing project data.
   */
  createTenant(input: {
    legalName: string;
    jurisdiction: string;
    defaultCurrency: string;
    tier: SubscriptionTier;
    /** Commercial package. Defaults from the tier so existing callers keep working. */
    package?: PackageTier;
    enterpriseName: string;
    /**
     * Whether this tenancy gets the free trial grant.
     *
     * Defaults to true, which is right for an operator provisioning a customer.
     * Public signup passes the answer from `trialGrantAllowed`, because it was
     * granting afresh for every address that verified — so one company took a
     * grant per employee, and one person took one per plus-suffix.
     */
    trialGrant?: boolean;
  }): { tenant: Tenant; subscription: Subscription; wallet: ACUWallet } {
    const tenantId = ulid();
    const enterpriseId = ulid();

    const tenant: Tenant = {
      id: tenantId,
      legalName: input.legalName,
      jurisdiction: input.jurisdiction,
      defaultCurrency: input.defaultCurrency,
      enterpriseId,
      createdAt: new Date().toISOString(),
    };
    this.#tenants.set(tenantId, tenant);

    const subscription: Subscription = {
      id: ulid(),
      tenantId,
      tier: input.tier,
      package: input.package ?? packageForTier(input.tier),
      status: 'ACTIVE',
      assignedIdentities: [],
      startedAt: new Date().toISOString(),
      renewsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    };
    this.#subscriptions.set(tenantId, subscription);

    const wallet = new ACUWallet(tenantId, { volumeIncentive: input.tier === 'ENTERPRISE' || input.tier === 'SOVEREIGN' });
    if (this.#walletSink) wallet.attachSink(this.#walletSink);
    // Every tenant, paid or trial, starts with the trial grant so AI can be
    // tried without a payment method — and stops when it runs out. Unless this
    // organisation has already had one: the grant is an offer to a customer,
    // not a per-mailbox entitlement.
    if (input.trialGrant !== false) wallet.grantTrialCredit();
    // A paid plan additionally credits its AI allowance for the first period.
    // A free plan allocates nothing and therefore has only the trial grant,
    // which is the whole reason AI stops working on a trial that runs out
    // rather than continuing on credit nobody paid for.
    wallet.allocateFromSubscription(
      PACKAGES[subscription.package].monthlyPriceMinor,
      new Date().toISOString().slice(0, 7),
    );
    this.#wallets.set(tenantId, wallet);

    const systemActor = { refType: 'System' as const, refId: 'platform' };
    const governanceProject = `${tenantId}-governance`;

    this.ledger.commit({
      tenantId,
      projectId: governanceProject,
      actor: systemActor,
      source: 'SYSTEM',
      correlationId: ulid(),
      eventType: 'TENANT_CREATED',
      entity: { refType: 'Tenant', refId: tenantId },
      nextState: {
        id: tenantId,
        legalName: input.legalName,
        jurisdiction: input.jurisdiction,
        defaultCurrency: input.defaultCurrency,
        enterpriseId,
      },
    });

    this.ledger.commit({
      tenantId,
      projectId: governanceProject,
      actor: systemActor,
      source: 'SYSTEM',
      correlationId: ulid(),
      eventType: 'ENTERPRISE_CREATED',
      entity: { refType: 'Enterprise', refId: enterpriseId },
      nextState: { id: enterpriseId, tenantId, name: input.enterpriseName },
    });

    this.ledger.commit({
      tenantId,
      projectId: governanceProject,
      actor: systemActor,
      source: 'SYSTEM',
      correlationId: ulid(),
      eventType: 'SUBSCRIPTION_ACTIVATED',
      entity: { refType: 'Subscription', refId: subscription.id },
      nextState: {
        id: subscription.id,
        tenantId,
        tier: subscription.tier,
        package: subscription.package,
        includedSeats: PACKAGES[subscription.package].includedSeats,
        monthlyPriceMinor: PACKAGES[subscription.package].monthlyPriceMinor,
        status: 'ACTIVE',
        assignedIdentities: [],
      },
    });

    // The wallet is opened on the ledger too, so that every later top-up,
    // hold and debit has a created entity to attach to.
    this.ledger.commit({
      tenantId,
      projectId: governanceProject,
      actor: systemActor,
      source: 'SYSTEM',
      correlationId: ulid(),
      eventType: 'ACU_WALLET_OPENED',
      entity: { refType: 'ACUWallet', refId: tenantId },
      nextState: {
        id: tenantId,
        tenantId,
        balanceMinor: wallet.snapshot().balanceMinor,
        openedAt: new Date().toISOString(),
      },
    });

    // Exports carry the client's identity, so branding is established at
    // onboarding rather than discovered missing at the moment of export.
    this.exports.setBranding(tenantId, {
      clientName: input.legalName,
      primaryColour: 'rgba(255, 102, 0, 1)',
      legalFooter: `${input.legalName} · registered in ${input.jurisdiction}`,
      documentReferencePrefix: input.legalName
        .split(/\s+/)
        .map((word) => word[0])
        .join('')
        .toUpperCase()
        .slice(0, 4),
    });

    return { tenant, subscription, wallet };
  }

  /**
   * Create a platform operator. Operators belong to no customer tenant, take no
   * seat against any subscription, and are barred by ABAC from every delivery
   * capability area — the separation between running the platform and seeing
   * what customers build on it is structural, not a setting someone can relax.
   */
  createOperator(input: { name: string; email: string }): PlatformUser {
    const userId = ulid();

    const user: PlatformUser = {
      id: userId,
      tenantId: PLATFORM_TENANT_ID,
      name: input.name,
      email: input.email,
      roles: ['PLATFORM_ADMIN'],
      status: 'ACTIVE',
    };
    this.#users.set(userId, user);

    this.ledger.commit({
      tenantId: PLATFORM_TENANT_ID,
      projectId: `${PLATFORM_TENANT_ID}-governance`,
      actor: { refType: 'System', refId: 'platform' },
      source: 'SYSTEM',
      correlationId: ulid(),
      eventType: 'USER_CREATED',
      entity: { refType: 'User', refId: userId },
      nextState: {
        id: userId,
        tenantId: PLATFORM_TENANT_ID,
        name: input.name,
        email: input.email,
        roles: ['PLATFORM_ADMIN'],
        status: 'ACTIVE',
      },
    });

    return user;
  }

  /** Every operator account on the platform. */
  operators(): PlatformUser[] {
    return [...this.#users.values()].filter((u) => u.tenantId === PLATFORM_TENANT_ID);
  }

  createUser(input: { tenantId: string; name: string; email: string; roles: Role[]; partyId?: string }): PlatformUser {
    const subscription = this.subscription(input.tenantId);
    const userId = ulid();

    const user: PlatformUser = {
      id: userId,
      tenantId: input.tenantId,
      name: input.name,
      email: input.email,
      roles: input.roles,
      partyId: input.partyId,
      status: 'ACTIVE',
    };

    // Seat assignment can fail on a tier limit; the user is not created if so.
    const updated = assignIdentity(subscription, userId, input.roles);
    this.#subscriptions.set(input.tenantId, updated);
    this.#users.set(userId, user);

    this.ledger.commit({
      tenantId: input.tenantId,
      projectId: `${input.tenantId}-governance`,
      actor: { refType: 'System', refId: 'platform' },
      source: 'SYSTEM',
      correlationId: ulid(),
      eventType: 'USER_CREATED',
      entity: { refType: 'User', refId: userId },
      nextState: {
        id: userId,
        tenantId: input.tenantId,
        name: input.name,
        email: input.email,
        roles: input.roles,
        partyId: input.partyId,
        status: 'ACTIVE',
      },
    });

    // Roles that consume no seat produce no seat event. A regulator whose
    // access the asset owner is obliged to provide is not a billable identity,
    // and recording an unchanged subscription would be a no-op in the ledger.
    if (updated !== subscription) {
      this.ledger.commit({
        tenantId: input.tenantId,
        projectId: `${input.tenantId}-governance`,
        actor: { refType: 'System', refId: 'platform' },
        source: 'SYSTEM',
        correlationId: ulid(),
        eventType: 'IDENTITY_SEAT_ASSIGNED',
        entity: { refType: 'Subscription', refId: updated.id },
        nextState: {
          id: updated.id,
          tenantId: updated.tenantId,
          tier: updated.tier,
          package: updated.package,
          includedSeats: PACKAGES[updated.package].includedSeats,
          monthlyPriceMinor: PACKAGES[updated.package].monthlyPriceMinor,
          status: updated.status,
          assignedIdentities: updated.assignedIdentities,
        },
      });
    }

    return user;
  }

  /**
   * Change what somebody is allowed to do.
   *
   * People move. A quantity surveyor takes on commercial management, a safety
   * lead leaves and somebody covers, a supervisor is promoted. Until now the
   * roles a person was created with were the roles they had forever, which is
   * not a security model so much as an absence of one: the only way to change
   * them was to suspend the identity and issue a new one, losing the link
   * between the person and everything they had already authored.
   *
   * Three rules, all of them separation of duties rather than convenience:
   *
   * **Nobody changes their own roles.** Self-elevation is the first thing an
   * insider tries and the easiest to prevent.
   *
   * **A tenant identity never receives an operator role.** The account layers
   * are separate by construction, and `PLATFORM_ADMIN` on a delivery identity
   * would collapse that in one call.
   *
   * **A reason is required**, because a role change is the kind of thing an
   * auditor asks about a year later and nobody remembers.
   */
  assignRoles(
    actor: AuthContext,
    input: { userId: string; roles: Role[]; reason: string },
  ): { userId: string; previousRoles: Role[]; roles: Role[] } {
    const user = this.#users.get(input.userId);
    if (!user) throw new NotFoundError(`No user ${input.userId}`);
    if (user.tenantId !== actor.tenantId) throw new NotFoundError(`No user ${input.userId}`);

    if (actor.actorId === input.userId) {
      throw new DomainError(
        'SELF_ROLE_CHANGE',
        'An identity cannot change its own roles. Somebody else with the permission has to do it.',
        403,
      );
    }
    if (input.roles.length === 0) {
      throw new DomainError('ROLES_REQUIRED', 'An identity with no role can do nothing; revoke the seat instead');
    }
    if (input.roles.includes('PLATFORM_ADMIN')) {
      throw new ForbiddenError(
        'A delivery identity cannot be given an operator role — the account layers are separate by construction',
        'ACCOUNT_LAYER_SEPARATION',
      );
    }
    if (input.reason.trim().length < 10) {
      throw new DomainError('ROLE_CHANGE_UNEXPLAINED', 'Say why the roles are changing');
    }

    const previousRoles = [...user.roles];

    // Seats are priced by role, so a change is a revoke and a re-assign rather
    // than an edit. If the new roles do not fit the tier this throws and the
    // identity keeps the roles it had.
    const subscription = this.subscription(actor.tenantId);
    const reseated = assignIdentity(revokeIdentity(subscription, input.userId), input.userId, input.roles);
    this.#subscriptions.set(actor.tenantId, reseated);
    user.roles = input.roles;

    this.ledger.commit({
      tenantId: actor.tenantId,
      projectId: `${actor.tenantId}-governance`,
      actor: { refType: 'User', refId: actor.actorId },
      source: 'WEB',
      correlationId: ulid(),
      eventType: 'USER_ROLE_ASSIGNED',
      entity: { refType: 'User', refId: input.userId },
      nextState: {
        id: input.userId,
        tenantId: user.tenantId,
        name: user.name,
        email: user.email,
        roles: input.roles,
        previousRoles,
        partyId: user.partyId,
        status: user.status,
        reason: input.reason,
        changedBy: actor.actorId,
        changedAt: new Date().toISOString(),
      },
    });

    return { userId: input.userId, previousRoles, roles: input.roles };
  }

  /**
   * Ask for an identity to be erased.
   *
   * The request starts a grace period rather than doing anything immediately —
   * see `identity/erasure.ts` for why the delay is a safety feature and not a
   * dark pattern. The seat is revoked at once, so the account stops working
   * straight away and stops being billed for, but the identity is still there
   * to be restored if the request was not genuine.
   *
   * A person may ask for their own erasure. An administrator may ask on their
   * behalf — somebody has to be able to act on a written request from an
   * employee who has already left — and the record says which it was.
   */
  requestErasure(actor: AuthContext, input: { userId: string; reason: string }): { userId: string; dueAt: string } {
    const user = this.#users.get(input.userId);
    if (!user) throw new NotFoundError(`No user ${input.userId}`);
    if (user.tenantId !== actor.tenantId) throw new NotFoundError(`No user ${input.userId}`);
    if (user.erasedAt !== undefined) {
      throw new DomainError('ALREADY_ERASED', 'That identity has already been erased', 409);
    }
    if (user.erasureRequestedAt !== undefined) {
      throw new DomainError('ERASURE_ALREADY_REQUESTED', 'An erasure request is already outstanding', 409);
    }

    const requestedAt = new Date().toISOString();
    const due = dueAt(requestedAt);

    // The seat goes now. Waiting until the grace period expired would keep
    // charging for an account whose owner has asked to leave.
    this.revokeUserSeat(actor.tenantId, input.userId);

    user.erasureRequestedAt = requestedAt;
    user.erasureDueAt = due;
    user.erasureRequestedBy = actor.actorId;

    this.ledger.commit({
      tenantId: actor.tenantId,
      projectId: `${actor.tenantId}-governance`,
      actor: { refType: 'User', refId: actor.actorId },
      source: 'WEB',
      correlationId: ulid(),
      eventType: 'USER_ERASURE_REQUESTED',
      entity: { refType: 'User', refId: input.userId },
      nextState: {
        id: input.userId,
        tenantId: user.tenantId,
        // The name and address are still here, because the identity has not
        // been erased yet — this event records that somebody asked.
        name: user.name,
        email: user.email,
        roles: user.roles,
        status: 'SUSPENDED',
        erasureRequestedAt: requestedAt,
        erasureDueAt: due,
        requestedBy: actor.actorId,
        onOwnBehalf: actor.actorId === input.userId,
        reason: input.reason,
        graceDays: graceDays(),
      },
    });

    return { userId: input.userId, dueAt: due };
  }

  /** Call off an outstanding request. Only possible before it is carried out. */
  cancelErasure(actor: AuthContext, input: { userId: string; reason: string }): { userId: string } {
    const user = this.#users.get(input.userId);
    if (!user) throw new NotFoundError(`No user ${input.userId}`);
    if (user.tenantId !== actor.tenantId) throw new NotFoundError(`No user ${input.userId}`);
    if (user.erasedAt !== undefined) {
      throw new DomainError('ALREADY_ERASED', 'That identity has already been erased and cannot be restored', 409);
    }
    if (user.erasureRequestedAt === undefined) {
      throw new DomainError('NO_ERASURE_REQUEST', 'There is no outstanding erasure request to cancel', 409);
    }

    delete user.erasureRequestedAt;
    delete user.erasureDueAt;
    delete user.erasureRequestedBy;
    user.status = 'ACTIVE';

    this.ledger.commit({
      tenantId: actor.tenantId,
      projectId: `${actor.tenantId}-governance`,
      actor: { refType: 'User', refId: actor.actorId },
      source: 'WEB',
      correlationId: ulid(),
      eventType: 'USER_ERASURE_CANCELLED',
      entity: { refType: 'User', refId: input.userId },
      nextState: {
        id: input.userId,
        tenantId: user.tenantId,
        name: user.name,
        email: user.email,
        roles: user.roles,
        status: 'ACTIVE',
        cancelledBy: actor.actorId,
        cancelledAt: new Date().toISOString(),
        reason: input.reason,
      },
    });

    // The seat has to be re-assigned, because requesting revoked it. If the
    // tier has since filled up this throws and the cancellation still stands:
    // the identity is restored and un-seated, which is recoverable, rather
    // than erased, which is not.
    const subscription = this.subscription(actor.tenantId);
    this.#subscriptions.set(actor.tenantId, assignIdentity(subscription, input.userId, user.roles));

    return { userId: input.userId };
  }

  /** Identities whose grace period has expired and are waiting to be erased. */
  dueErasures(now = new Date()): PlatformUser[] {
    return [...this.#users.values()].filter((user) =>
      isDue({ requestedAt: user.erasureRequestedAt, dueAt: user.erasureDueAt, erasedAt: user.erasedAt }, now),
    );
  }

  /**
   * Carry out an erasure.
   *
   * Name, email and mobile are replaced with a token that identifies nobody.
   * Every event the identity authored keeps referring to the same actor id, so
   * the hash chain still verifies and the sequence of who-did-what still reads
   * — it just no longer resolves to a person.
   *
   * `force` skips the grace period. It exists because a supervisory authority
   * can order immediate erasure and because a person who has confirmed through
   * a second channel should not have to wait, and it is recorded on the event
   * so an auditor can see the window was deliberately not served.
   */
  eraseUser(
    actor: AuthContext,
    input: { userId: string; force?: boolean; now?: Date },
  ): { userId: string; erasedAt: string } {
    const now = input.now ?? new Date();
    const user = this.#users.get(input.userId);
    if (!user) throw new NotFoundError(`No user ${input.userId}`);
    if (user.tenantId !== actor.tenantId) throw new NotFoundError(`No user ${input.userId}`);
    if (user.erasedAt !== undefined) {
      throw new DomainError('ALREADY_ERASED', 'That identity has already been erased', 409);
    }
    if (user.erasureRequestedAt === undefined) {
      throw new DomainError('NO_ERASURE_REQUEST', 'Erasure has not been requested for that identity', 409);
    }
    if (input.force !== true && !isDue({ dueAt: user.erasureDueAt }, now)) {
      throw new DomainError(
        'ERASURE_NOT_DUE',
        `The grace period runs until ${String(user.erasureDueAt)}. Erasing now discards the window that lets the real owner stop it.`,
        409,
      );
    }

    const basis = retentionBasis();
    const replacement = pseudonym(input.userId);
    const erasedAt = now.toISOString();

    // The event is written before the identity is overwritten, so it can still
    // record what was there — and it records the pseudonym rather than the
    // name, because an "erasure" event carrying the erased name in its payload
    // would put the data straight back into the ledger it was removed from.
    this.ledger.commit({
      tenantId: actor.tenantId,
      projectId: `${actor.tenantId}-governance`,
      actor: { refType: 'User', refId: actor.actorId },
      source: 'WEB',
      correlationId: ulid(),
      eventType: 'USER_ERASED',
      entity: { refType: 'User', refId: input.userId },
      nextState: {
        id: input.userId,
        tenantId: user.tenantId,
        name: replacement.name,
        email: replacement.email,
        roles: user.roles,
        status: 'SUSPENDED',
        erasedAt,
        erasedBy: actor.actorId,
        graceServed: input.force !== true,
        removed: basis.removed,
        retained: basis.retained,
        lawfulBasis: basis.lawfulBasis,
      },
    });

    user.name = replacement.name;
    user.email = replacement.email;
    user.status = 'SUSPENDED';
    user.erasedAt = erasedAt;

    return { userId: input.userId, erasedAt };
  }

  revokeUserSeat(tenantId: string, userId: string): void {
    const subscription = this.subscription(tenantId);
    const updated = revokeIdentity(subscription, userId);
    this.#subscriptions.set(tenantId, updated);

    const user = this.#users.get(userId);
    if (user) user.status = 'SUSPENDED';

    this.ledger.commit({
      tenantId,
      projectId: `${tenantId}-governance`,
      actor: { refType: 'System', refId: 'platform' },
      source: 'SYSTEM',
      correlationId: ulid(),
      eventType: 'IDENTITY_SEAT_REVOKED',
      entity: { refType: 'Subscription', refId: updated.id },
      nextState: {
        id: updated.id,
        tenantId: updated.tenantId,
        tier: updated.tier,
        includedIdentities: TIERS[updated.tier].includedIdentities,
        monthlyPriceUsd: TIERS[updated.tier].monthlyPriceUsd,
        status: updated.status,
        assignedIdentities: updated.assignedIdentities,
      },
    });
  }

  /**
   * Suspend, cancel or reactivate a tenancy's subscription.
   *
   * The mechanism the entitlement gates need in order not to be theatre.
   * Nothing could change `Subscription.status` before this existed: the field
   * was declared with three values, one function read it, and no code path set
   * it to either of the two that mean "stopped paying". So a customer who
   * cancelled kept writing, kept running engines and kept buying credit.
   *
   * Operator-only, and it stays that way when a payment provider is wired: the
   * provider's webhook calls this, rather than reaching into the map itself, so
   * a dunning failure and an operator's decision leave the same record.
   *
   * The reason is required and is recorded as evidence, because this is the
   * event that turns off a paying customer's platform, and "who decided, when,
   * and on what basis" is the first question asked when it turns out to have
   * been wrong.
   */
  setSubscriptionStatus(input: {
    tenantId: string;
    status: Subscription['status'];
    reason: string;
    /** The operator or system that decided. `billing` for a provider webhook. */
    decidedBy: string;
  }): Subscription {
    if (!input.reason.trim()) {
      throw new DomainError('SUBSCRIPTION_REASON_REQUIRED', 'Changing a subscription status requires a reason');
    }

    const subscription = this.subscription(input.tenantId);
    if (subscription.status === input.status) return subscription;

    const updated: Subscription = { ...subscription, status: input.status };
    this.#subscriptions.set(input.tenantId, updated);

    const evidenceId = ulid();
    const projectId = `${input.tenantId}-governance`;
    const decidedAt = new Date().toISOString();

    this.ledger.commit({
      tenantId: input.tenantId,
      projectId,
      actor: { refType: 'System', refId: 'billing' },
      source: 'SYSTEM',
      correlationId: ulid(),
      eventType: 'EVIDENCE_REGISTERED',
      entity: { refType: 'EvidenceItem', refId: evidenceId },
      nextState: {
        id: evidenceId,
        type: 'SUBSCRIPTION_STATUS_AUTHORITY',
        hash: hashEvidence(
          JSON.stringify({ tenantId: input.tenantId, from: subscription.status, to: input.status, decidedAt }),
        ),
        description: `Subscription ${subscription.status} → ${input.status}: ${input.reason}`,
        linkedEntities: [],
        capturedAt: decidedAt,
        capturedBy: input.decidedBy,
      },
    });

    this.ledger.commit({
      tenantId: input.tenantId,
      projectId,
      actor: { refType: 'System', refId: 'billing' },
      source: 'SYSTEM',
      correlationId: ulid(),
      eventType: 'SUBSCRIPTION_STATUS_CHANGED',
      entity: { refType: 'Subscription', refId: updated.id },
      nextState: {
        ...updated,
        previousStatus: subscription.status,
        statusChangedAt: decidedAt,
        statusChangedBy: input.decidedBy,
        statusReason: input.reason,
      },
      evidenceRefs: [{ refType: 'EvidenceItem', refId: evidenceId }],
    });

    return updated;
  }

  // --- Accessors -------------------------------------------------------------

  tenant(tenantId: string): Tenant {
    const tenant = this.#tenants.get(tenantId);
    if (!tenant) throw new NotFoundError(`Tenant ${tenantId} not found`);
    return tenant;
  }

  /**
   * Rebuild the identity and billing model from a restored ledger.
   *
   * The ledger restores projects; this restores the people who can reach them.
   * Without it a journal replay produced 363 events, 293 entities and nobody
   * who could sign in — the projects were there and orphaned, because tenants,
   * users, subscriptions and wallets live in these maps rather than in the
   * chain.
   *
   * Every one of them is already written to the ledger as an entity, so this
   * is a projection over records that exist, not a second store. It runs after
   * `ledger.restore()` and before the gateway listens.
   */
  rehydrate(walletEntries: ReadonlyMap<string, readonly ACUEntry[]> = new Map()): {
    tenants: number;
    users: number;
    subscriptions: number;
    wallets: number;
  } {
    for (const record of this.ledger.entitiesOfType('Tenant')) {
      const state = record.state as unknown as Tenant;
      this.#tenants.set(state.id, state);
    }

    for (const record of this.ledger.entitiesOfType('User')) {
      const state = record.state as unknown as PlatformUser;
      this.#users.set(state.id, state);
    }

    for (const record of this.ledger.entitiesOfType('Subscription')) {
      const state = record.state as unknown as Subscription;
      // The entity is re-committed on every seat assignment, so the restored
      // copy already carries the current identities; recomputing them from the
      // users would be a second opinion about the same fact.
      this.#subscriptions.set(state.tenantId, {
        ...state,
        startedAt: state.startedAt ?? new Date().toISOString(),
        renewsAt: state.renewsAt ?? new Date(Date.now() + 30 * 86_400_000).toISOString(),
      });
    }

    for (const record of this.ledger.entitiesOfType('ACUWallet')) {
      const tenantId = record.tenantId;
      const subscription = this.#subscriptions.get(tenantId);
      const wallet = new ACUWallet(tenantId, {
        volumeIncentive: subscription?.tier === 'ENTERPRISE' || subscription?.tier === 'SOVEREIGN',
      });
      // Folded from the entries rather than read from a stored total. A stored
      // balance is a second source of truth for the same money, and the two
      // disagree the first time either is rebuilt. No trial grant is re-issued
      // here: the original grant is one of the entries.
      wallet.restoreEntries(walletEntries.get(tenantId) ?? []);
      // Attached after the replay, so restoring does not re-journal what is
      // already on disk.
      if (this.#walletSink) wallet.attachSink(this.#walletSink);
      this.#wallets.set(tenantId, wallet);
    }

    return {
      tenants: this.#tenants.size,
      users: this.#users.size,
      subscriptions: this.#subscriptions.size,
      wallets: this.#wallets.size,
    };
  }

  tenants(): Tenant[] {
    return [...this.#tenants.values()];
  }

  user(userId: string): PlatformUser {
    const user = this.#users.get(userId);
    if (!user) throw new NotFoundError(`User ${userId} not found`);
    return user;
  }

  userByEmail(email: string): PlatformUser | undefined {
    return [...this.#users.values()].find((u) => u.email.toLowerCase() === email.toLowerCase());
  }

  users(tenantId: string): PlatformUser[] {
    return [...this.#users.values()].filter((u) => u.tenantId === tenantId);
  }

  /**
   * Every registered identity, across every tenancy.
   *
   * Only the platform layer has any business calling this — it crosses the
   * tenant boundary that every other read respects. It exists for the two
   * platform-to-person concerns that are genuinely global: who is registered,
   * and who may be written to.
   */
  allUsers(): PlatformUser[] {
    return [...this.#users.values()];
  }

  wallet(tenantId: string): ACUWallet {
    const wallet = this.#wallets.get(tenantId);
    if (!wallet) throw new NotFoundError(`No ACU wallet for tenant ${tenantId}`);
    return wallet;
  }

  subscription(tenantId: string): Subscription {
    const subscription = this.#subscriptions.get(tenantId);
    if (!subscription) throw new NotFoundError(`No subscription for tenant ${tenantId}`);
    return subscription;
  }

  // --- Billing ---------------------------------------------------------------

  /**
   * Ask to add credit. Records the intent and moves no money.
   *
   * This is what a customer pressing "top up" does. It used to credit the
   * wallet directly from the amount in the request body, which made the button
   * a mint: no payment provider, no ceiling, and every ACU spent from it bought
   * real provider compute. Credit now appears only when a receipt says money
   * arrived — see `creditFromPayment`.
   */
  requestTopUp(input: {
    tenantId: string;
    amountMinor: number;
    requestedBy: string;
  }): TopUpIntent {
    // The same subscription gate as before: taking somebody's money for AI on a
    // platform they may not use is worse than the loophole it closes, because
    // the credit would be unspendable and the transaction a charge for nothing.
    const position = standing(this.#subscriptions.get(input.tenantId), []);
    if (!position.mayTopUp) {
      throw new DomainError(
        'SUBSCRIPTION_NOT_ACTIVE',
        `${position.reason ?? 'This subscription is not active'} Credit cannot be purchased until it is.`,
        402,
      );
    }

    assertCreditableAmount(input.amountMinor);

    const intent: TopUpIntent = {
      id: ulid(),
      tenantId: input.tenantId,
      amountMinor: input.amountMinor,
      currency: BILLING_CURRENCY,
      requestedBy: input.requestedBy,
      requestedAt: new Date().toISOString(),
      status: 'AWAITING_PAYMENT',
    };
    this.#topUpIntents.set(intent.id, intent);

    this.ledger.commit({
      tenantId: input.tenantId,
      projectId: `${input.tenantId}-governance`,
      actor: { refType: 'User', refId: input.requestedBy },
      source: 'WEB',
      correlationId: ulid(),
      eventType: 'TOPUP_REQUESTED',
      entity: { refType: 'TopUpIntent', refId: intent.id },
      nextState: { ...intent },
    });

    return intent;
  }

  /**
   * Credit a wallet against money that has actually been received.
   *
   * The only path by which a balance goes up, and it is operator-only — or, when
   * one is wired, a payment provider's webhook calling the same method rather
   * than reaching into wallet state, so a card settlement and a bank transfer
   * leave the same record.
   *
   * The reference is the idempotency key for money and is checked against every
   * receipt ever recorded, not against a cache with a TTL. A webhook that fires
   * twice, an operator pressing the button again, a retry after a timeout — all
   * the same payment, and the second one credits nothing.
   */
  creditFromPayment(input: {
    tenantId: string;
    amountMinor: number;
    method: PaymentMethod;
    reference: string;
    intentId?: string;
    recordedBy: string;
    note?: string;
    /**
     * Who is asserting that the money arrived.
     *
     * `PROVIDER` is a signed settlement notification: the payment processor has
     * the money and says so, and the reference is one it generated. `OPERATOR`
     * is a human typing into a form. The difference matters at exactly one
     * point — a second credit against an intent that is already settled — where
     * the provider is telling us about a second real payment and the operator is
     * most likely crediting the same payment twice under a mistyped reference.
     */
    source?: 'PROVIDER' | 'OPERATOR';
  }): { receipt: PaymentReceipt; alreadyRecorded: boolean } {
    const reference = normaliseReference(input.reference);
    assertCreditableAmount(input.amountMinor);

    // Checked before the reference is spent. A payment addressed to a tenancy
    // that does not exist has to stay creditable: registering the receipt first
    // and failing at the wallet would burn the reference, and a retry would then
    // report success while nothing was ever credited.
    this.wallet(input.tenantId);

    // Checked before anything else, and answered as success rather than as an
    // error: a webhook retried after a timeout is not a fault, and a 4xx would
    // make the provider keep retrying a payment that is already credited.
    const existing = this.#receiptsByReference.get(reference);
    if (existing) {
      if (existing.tenantId !== input.tenantId || existing.amountMinor !== input.amountMinor) {
        throw new DomainError(
          'PAYMENT_REFERENCE_CONFLICT',
          `Reference ${reference} is already recorded against a different tenancy or amount. ` +
            'A payment reference identifies one payment and cannot be reused.',
          409,
        );
      }
      return { receipt: existing, alreadyRecorded: true };
    }

    let intent = input.intentId ? this.#topUpIntents.get(input.intentId) : undefined;
    if (input.intentId && !intent) throw new NotFoundError(`No top-up request ${input.intentId}`);
    if (intent && intent.tenantId !== input.tenantId) {
      throw new NotFoundError(`No top-up request ${input.intentId}`);
    }
    if (intent && intent.status !== 'AWAITING_PAYMENT') {
      if (input.source === 'PROVIDER') {
        // A customer who opened the checkout page twice and paid on both. The
        // second payment is real — the processor is holding it — so refusing it
        // would take money and credit nothing, and a 4xx would have the provider
        // retry a rejection for days. Credit it, and leave it unattached: the
        // intent records one request and has already been answered once.
        intent = undefined;
      } else {
        throw new DomainError(
          'TOPUP_ALREADY_SETTLED',
          'That top-up request has already been settled or cancelled',
          409,
        );
      }
    }

    const receipt: PaymentReceipt = {
      id: ulid(),
      tenantId: input.tenantId,
      amountMinor: input.amountMinor,
      currency: BILLING_CURRENCY,
      method: input.method,
      reference,
      // The resolved intent, not the requested one: a second real payment
      // against an already-settled request is credited without being attached
      // to it, so the request keeps recording the one settlement it answered.
      ...(intent ? { intentId: intent.id } : {}),
      recordedBy: input.recordedBy,
      recordedAt: new Date().toISOString(),
      ...(input.note ? { note: input.note } : {}),
    };

    // The receipt is registered before the wallet moves. If the credit throws,
    // the reference is spent and the payment cannot be credited twice by a
    // retry — which is the safer failure: a customer chasing a missing credit
    // is a support conversation, a double credit is money.
    this.#receiptsByReference.set(reference, receipt);

    this.ledger.commit({
      tenantId: input.tenantId,
      projectId: `${input.tenantId}-governance`,
      actor: { refType: 'System', refId: 'billing' },
      source: 'SYSTEM',
      correlationId: ulid(),
      eventType: 'PAYMENT_RECEIVED',
      entity: { refType: 'PaymentReceipt', refId: receipt.id },
      nextState: { ...receipt },
    });

    if (intent) {
      intent.status = 'SETTLED';
      intent.receiptId = receipt.id;
      this.ledger.commit({
        tenantId: input.tenantId,
        projectId: `${input.tenantId}-governance`,
        actor: { refType: 'System', refId: 'billing' },
        source: 'SYSTEM',
        correlationId: ulid(),
        eventType: 'TOPUP_SETTLED',
        entity: { refType: 'TopUpIntent', refId: intent.id },
        nextState: { ...intent },
      });
    }

    this.#creditWallet(input.tenantId, input.amountMinor, `${input.method} ${reference}`);
    return { receipt, alreadyRecorded: false };
  }

  /** Top-up requests awaiting payment, for the operator's reconciliation view. */
  topUpIntents(tenantId?: string): TopUpIntent[] {
    return [...this.#topUpIntents.values()]
      .filter((intent) => tenantId === undefined || intent.tenantId === tenantId)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  paymentReceipts(tenantId?: string): PaymentReceipt[] {
    return [...this.#receiptsByReference.values()]
      .filter((receipt) => tenantId === undefined || receipt.tenantId === tenantId)
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }

  #creditWallet(tenantId: string, amountMinor: number, note: string): void {
    const wallet = this.wallet(tenantId);
    wallet.topUp(amountMinor, `Prepaid ACU purchase — ${note}`);

    this.ledger.commit({
      tenantId,
      projectId: `${tenantId}-governance`,
      actor: { refType: 'System', refId: 'billing' },
      source: 'SYSTEM',
      correlationId: ulid(),
      eventType: 'ACU_TOPPED_UP',
      entity: { refType: 'ACUWallet', refId: tenantId },
      nextState: {
        id: tenantId,
        tenantId,
        balanceMinor: wallet.snapshot().balanceMinor,
        lastTopUpMinor: amountMinor,
        lastTopUpAt: new Date().toISOString(),
      },
    });
  }

  /**
   * Move the AI spend ceilings, and record who moved them.
   *
   * A cap is a governance decision, not an accounting fact. The ACU ledger
   * stays the single source of truth for what was *spent* — writing spend into
   * the project ledger as well would give the platform two answers to the same
   * question — but who raised a budget ceiling, when, and why is exactly what
   * the Golden Thread is for, and it was previously changeable with no record
   * of any kind.
   */
  setAcuCaps(actor: AuthContext, caps: ACUCaps, reason: string): ReturnType<ACUWallet['snapshot']> {
    const wallet = this.wallet(actor.tenantId);
    const previous = wallet.snapshot().caps;
    wallet.setCaps(caps);
    const snapshot = wallet.snapshot();

    this.ledger.commit({
      tenantId: actor.tenantId,
      projectId: `${actor.tenantId}-governance`,
      // A person, not the system. That is the whole point of recording it.
      actor: { refType: 'User', refId: actor.actorId },
      source: 'WEB',
      correlationId: ulid(),
      eventType: 'ACU_CAPS_SET',
      entity: { refType: 'ACUWallet', refId: actor.tenantId },
      nextState: {
        id: actor.tenantId,
        tenantId: actor.tenantId,
        balanceMinor: snapshot.balanceMinor,
        caps: snapshot.caps,
        previousCaps: previous,
        reason,
        setAt: new Date().toISOString(),
      },
    });

    return snapshot;
  }

  /**
   * The billing position for a period, without issuing anything.
   *
   * Deliberately separate from `issueInvoice` rather than a flag on it. Issuing
   * credits the period's AI allowance and writes to the ledger; looking must do
   * neither, and a boolean parameter controlling whether a function spends
   * money is the kind of thing that gets passed wrong once.
   */
  previewInvoice(tenantId: string, period: string): Invoice {
    return buildInvoice(
      this.subscription(tenantId),
      this.wallet(tenantId),
      period,
      // The billing currency, not the tenancy's working one. Every published
      // price is a bare integer of minor units, and "minor unit" means a
      // different amount of money in a currency with a different exponent —
      // so reading the customer's own choice here priced the same package at a
      // quarter in KWD and half in JPY.
      BILLING_CURRENCY,
      storage.purchasedBlocks(this.ledger, tenantId),
    );
  }

  issueInvoice(tenantId: string, period: string): Invoice {
    const subscription = this.subscription(tenantId);

    // The period must be one that has actually happened.
    //
    // This route used to be tenant-callable with a client-supplied period, and
    // issuing an invoice credits that period's AI allowance. The wallet refuses
    // a second allocation for the *same* period — but nothing stopped anybody
    // asking for a different one. A loop from 2020-01 to 2030-12 minted a
    // hundred and thirty-two months of allowance, at twenty per cent of the
    // plan price each, for free.
    //
    // Two bounds close it: the period cannot be in the future, and it cannot
    // predate the subscription. Issuing is also operator-only now, which is the
    // primary control; this is the one that holds even if that is ever relaxed.
    assertBillablePeriod(period, subscription.startedAt);

    // Billing the period is what buys the period's AI allowance, so it is
    // credited here rather than on a timer. The wallet refuses a second
    // allocation for the same period, which is what makes a reissued invoice
    // safe — an invoice gets corrected and retried, and each retry handing out
    // another month of AI would be free money.
    this.wallet(tenantId).allocateFromSubscription(PACKAGES[subscription.package].monthlyPriceMinor, period);

    const invoice = buildInvoice(
      subscription,
      this.wallet(tenantId),
      period,
      // The billing currency, not the tenancy's working one. Every published
      // price is a bare integer of minor units, and "minor unit" means a
      // different amount of money in a currency with a different exponent —
      // so reading the customer's own choice here priced the same package at a
      // quarter in KWD and half in JPY.
      BILLING_CURRENCY,
      storage.purchasedBlocks(this.ledger, tenantId),
    );

    this.ledger.commit({
      tenantId,
      projectId: `${tenantId}-governance`,
      actor: { refType: 'System', refId: 'billing' },
      source: 'SYSTEM',
      correlationId: ulid(),
      eventType: 'INVOICE_ISSUED',
      entity: { refType: 'Invoice', refId: invoice.id },
      nextState: { ...invoice } as unknown as Record<string, unknown>,
      // The invoice is its own evidence: the ACU entries behind every line are
      // already in the ledger and can be reconciled against it.
      evidenceRefs: [{ refType: 'Invoice', refId: invoice.id }],
    });

    return invoice;
  }

  // --- Sessions --------------------------------------------------------------

  login(email: string): { user: PlatformUser; tokens: TokenPair } {
    const user = this.userByEmail(email);
    if (!user) throw new NotFoundError('No user with that email address');
    if (user.status !== 'ACTIVE') throw new DomainError('USER_SUSPENDED', 'This identity has been suspended', 403);

    return {
      user,
      tokens: issueTokens({
        actorId: user.id,
        tenantId: user.tenantId,
        partyId: user.partyId,
        roles: user.roles,
        mfaSatisfied: true,
      }),
    };
  }

  /** Build a per-request engine context. */
  context(auth: AuthContext, projectId: string, options: { source?: EventSource; correlationId?: string } = {}): EngineContext {
    return {
      ledger: this.ledger,
      orchestrator: this.orchestrator,
      wallet: this.wallet(auth.tenantId),
      auth,
      source: options.source ?? 'WEB',
      correlationId: options.correlationId ?? ulid(),
      tenantId: auth.tenantId,
      projectId,
      // Resolved once, here, rather than at each write. `#subscriptions.get`
      // rather than `subscription()`: an absent subscription is a state the
      // entitlement rules answer for — fail-closed, with the operator exempt so
      // there is still a way to repair it — and throwing here would make an
      // unprovisioned tenancy a 404 on every route instead of a 402 on the ones
      // that change something.
      standing: standing(this.#subscriptions.get(auth.tenantId), auth.roles),
    };
  }

  /** Operator health view. */
  health(): {
    status: 'ok';
    env: string;
    aiMode: string;
    tenants: number;
    events: number;
    controlPlane: ReturnType<AIOrchestrator['controlPlaneStatus']>;
  } {
    return {
      status: 'ok',
      env: config.env,
      aiMode: config.ai.mode,
      tenants: this.#tenants.size,
      events: this.ledger.size,
      controlPlane: this.orchestrator.controlPlaneStatus(),
    };
  }
}
