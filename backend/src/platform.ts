import { AIOrchestrator } from './ai/orchestrator.ts';
import { EvidenceStore } from './evidence/store.ts';
import { SigningAuthority } from './signing/signature.ts';
import { ExportService } from './export/exporter.ts';
import { SyncEngine } from './field/sync.ts';
import { ACUWallet, type ACUCaps, type ACUEntry } from './billing/acu.ts';
import { buildInvoice, type Invoice } from './billing/invoice.ts';
import { assignIdentity, packageForTier, revokeIdentity, TIERS, type Subscription, type SubscriptionTier } from './billing/subscription.ts';
import { standing } from './billing/entitlement.ts';
import { KODA_SETTLEMENT_CURRENCY } from './billing/koda.ts';
import {
  BILLING_CURRENCY,
  assertBillablePeriod,
  assertCreditableAmount,
  convertFromBillingMinor,
  convertToBillingMinor,
  normaliseReference,
  type PaymentMethod,
  type PaymentReceipt,
  type SettlementFx,
  type TopUpIntent,
} from './billing/payments.ts';
import { PACKAGES, UNCHARGED_ROLES, type PackageTier } from './billing/seats.ts';
import * as storage from './billing/storage.ts';
import { createHash } from 'node:crypto';
import { config } from './config.ts';
import { SIGNATURES } from './site/media.ts';
import { DomainError, ForbiddenError, NotFoundError } from './core/errors.ts';
import { hashEvidence } from './core/canonical.ts';
import { ulid } from './core/ids.ts';
import type { EngineContext } from './engines/context.ts';
import { GoldenThreadLedger } from './goldenthread/ledger.ts';
import type { EventSource } from './goldenthread/types.ts';
import { bindCredentialStores } from './identity/credentialstore.ts';
import type { AuthContext } from './identity/auth.ts';
import { issueTokens, type TokenPair } from './identity/auth.ts';
import type { Role } from './identity/roles.ts';
import { MODULES, grantRef, isModuleId, type ModuleGrant, type ModuleId } from './identity/modules.ts';
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
  /**
   * The referral code this tenancy arrived with, if any.
   *
   * Recorded at creation and never afterwards. Attribution that can be edited
   * later is attribution somebody can rewrite once they know what a tenancy
   * turned out to be worth — so it is set once, on the way in, and the growth
   * programme computes commission by matching against it.
   */
  referralCode?: string;
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
   * The account picture, in the evidence store, by its SHA-256.
   *
   * A hash rather than the bytes, for the same reason a client's mark is: the
   * store is content-addressed, so this names exactly one image and swapping it
   * is a new hash and a new event rather than a silent substitution behind a
   * name that did not change.
   */
  pictureHash?: string;
  /**
   * The banner behind the name on an account page.
   *
   * Separate from `pictureHash` and not a variant of it. A profile picture
   * identifies a person on a record they authored — a permit, an induction —
   * and is cropped square and shown small; a cover is decoration on their own
   * page and is shown wide. Storing one field and cropping it two ways gives a
   * face stretched across a banner and a landscape squeezed into an avatar.
   */
  coverHash?: string;
  /**
   * Created by the demonstration seed.
   *
   * The one thing that distinguishes an identity anybody may sign in as from a
   * real customer's. It is set only by `seedDemoProject`, it is written into
   * the `USER_CREATED` event so it survives a replay, and no route sets or
   * clears it — an account cannot become a demonstration account, and a
   * demonstration account cannot stop being one, after it is created.
   *
   * Absent on every real identity rather than `false`, so the flag has to be
   * put there on purpose for anything to treat an account as public.
   */
  demonstration?: true;
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
  /**
   * Private module grants, keyed by `grantRef` — one record per module per
   * tenancy, so a re-grant after a revocation moves the same record back to
   * ACTIVE rather than starting a second one that would have to be reconciled.
   */
  readonly #moduleGrants = new Map<string, ModuleGrant>();

  constructor(
    orchestrator = new AIOrchestrator(),
    evidence = new EvidenceStore(),
    signing = new SigningAuthority(),
  ) {
    this.orchestrator = orchestrator;
    this.evidence = evidence;
    this.signing = signing;
    this.sync = new SyncEngine(this.ledger);
    // Devices and passkeys resolve out of this ledger from here on. Bound in
    // the constructor rather than at first use because the failure mode of
    // forgetting is a *silent* one: `identity/devices.ts` falls back to an
    // in-process store, so an unbound build would appear to work and would
    // forget every revocation on restart.
    bindCredentialStores(this.ledger);

    // The platform's own tenancy exists from the start, not from the first
    // operator being created.
    //
    // Created in `createOperator` alone, it was missing on every boot that
    // rehydrated an operator from the journal rather than creating one — which
    // is every boot after the first. The wallet the platform's own AI spends
    // from would then be absent on a restarted deployment and present on a
    // fresh one, which is the worst kind of difference: it works on the machine
    // it was tested on.
    this.#ensurePlatformTenancy();
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
    /**
     * A referral code carried in from a partner's link.
     *
     * Normalised and stored verbatim, whether or not anybody in the growth
     * programme holds it. An unknown code is reported as unattributed rather
     * than discarded: somebody is sending traffic and a typo in their link is
     * worth seeing.
     */
    referralCode?: string;
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
      referralCode: input.referralCode?.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '') || undefined,
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
      // The party carrying the duty on every document this tenancy issues.
      // Distinct from `clientName`, which a project overrides with whoever the
      // document is prepared for — naming the client as the issuer of a permit
      // to work would put the wrong organisation on the one document where it
      // matters most.
      issuingEntity: input.legalName,
      primaryColour: 'rgba(255, 106, 26, 1)',
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
    this.#ensurePlatformTenancy();
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

  /**
   * The platform's own tenancy: a subscription and a metered wallet.
   *
   * The operator layer had neither. That was fine for as long as the operator
   * only ever read — but the platform now runs AI of its own, drafting articles
   * for its own marketing site, and that is real provider spend.
   *
   * Two ways to handle it and only one is honest. Letting the operator's AI run
   * uncharged would put the company's own spend outside the meter that governs
   * everybody else's, so the one figure the operator most needs to trust — what
   * this platform costs to run — would be the one figure missing its own line.
   * So the platform is a tenant of itself: same wallet, same ACU arithmetic,
   * same refusal when it runs out.
   *
   * Idempotent, because it is called on every operator creation and there is
   * exactly one platform tenancy however many operators exist.
   */
  #ensurePlatformTenancy(): void {
    if (this.#wallets.has(PLATFORM_TENANT_ID)) return;

    if (!this.#tenants.has(PLATFORM_TENANT_ID)) {
      this.#tenants.set(PLATFORM_TENANT_ID, {
        id: PLATFORM_TENANT_ID,
        legalName: 'CONSTRUX',
        jurisdiction: 'GB',
        defaultCurrency: 'GBP',
        createdAt: new Date().toISOString(),
      });
    }

    if (!this.#subscriptions.has(PLATFORM_TENANT_ID)) {
      this.#subscriptions.set(PLATFORM_TENANT_ID, {
        id: ulid(),
        tenantId: PLATFORM_TENANT_ID,
        tier: 'ENTERPRISE',
        package: packageForTier('ENTERPRISE'),
        status: 'ACTIVE',
        assignedIdentities: [],
        startedAt: new Date().toISOString(),
        renewsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      });
    }

    const wallet = new ACUWallet(PLATFORM_TENANT_ID, { volumeIncentive: true });
    if (this.#walletSink) wallet.attachSink(this.#walletSink);
    // No trial grant. The trial is an offer to a customer deciding whether to
    // buy, and the platform is not deciding. It starts empty and is credited
    // the way any other tenancy is — which means the first attempt to draft an
    // article on a deployment nobody has funded is refused for want of credit,
    // and says so.
    this.#wallets.set(PLATFORM_TENANT_ID, wallet);
  }

  /**
   * Set a person's own account picture.
   *
   * Stored in the evidence store rather than in a second image store, because
   * the platform already has one that is content-addressed, tenant-scoped and
   * size-capped — and a face is exactly the class of thing it holds. It is not
   * registered as *evidence*: nothing in the record is being evidenced by it,
   * and putting an avatar in the evidence register would make the one place
   * that answers "what does this project rest on" answer partly about
   * profile pictures.
   *
   * The type is read from the file's own magic bytes, never from what the
   * upload claimed. An SVG is refused outright: it is served from the
   * platform's own origin, and an SVG is a document that can carry script.
   */
  async setUserPicture(input: {
    actorId: string;
    userId: string;
    bytes: Buffer;
    contentType?: string;
    /**
     * Which of the two images this is. Defaults to the profile picture, so
     * every existing caller means exactly what it meant before.
     */
    kind?: 'PROFILE' | 'COVER';
  }): Promise<PlatformUser> {
    const user = this.#users.get(input.userId);
    if (!user) throw new NotFoundError(`No user ${input.userId}`);

    if (input.bytes.length === 0) throw new DomainError('EMPTY_UPLOAD', 'No bytes were received', 400);
    if (input.bytes.length > config.site.mediaMaxBytes) {
      throw new DomainError(
        'IMAGE_TOO_LARGE',
        `That picture is ${Math.round(input.bytes.length / 1024)}KB. The ceiling is ` +
          `${Math.round(config.site.mediaMaxBytes / 1024)}KB — crop it square and compress.`,
        413,
      );
    }

    const signature = SIGNATURES.find((candidate) => candidate.matches(input.bytes));
    if (!signature) {
      throw new DomainError(
        'NOT_AN_IMAGE',
        'That file is not a PNG, JPEG or WebP. It is read from the file itself rather than from what the upload ' +
          'claimed, and an SVG is refused because it is a document that can carry script.',
        415,
      );
    }

    const hash = createHash('sha256').update(input.bytes).digest('hex');
    await this.evidence.store(user.tenantId, hash, input.bytes, signature.contentType);

    const kind = input.kind ?? 'PROFILE';
    const updated: PlatformUser =
      kind === 'COVER' ? { ...user, coverHash: hash } : { ...user, pictureHash: hash };
    this.#users.set(user.id, updated);

    this.ledger.commit({
      tenantId: user.tenantId,
      projectId: `${user.tenantId}-governance`,
      actor: { refType: 'User', refId: input.actorId },
      source: 'WEB',
      correlationId: hash,
      eventType: kind === 'COVER' ? 'USER_COVER_SET' : 'USER_PICTURE_SET',
      entity: { refType: 'User', refId: user.id },
      nextState: {
        id: user.id,
        tenantId: user.tenantId,
        name: user.name,
        email: user.email,
        roles: user.roles,
        status: user.status,
        pictureHash: updated.pictureHash,
        coverHash: updated.coverHash,
      },
    });

    return updated;
  }

  /**
   * The bytes behind an account picture, for whoever may see the person.
   *
   * Scoped to one tenancy by the caller, which is what stops this becoming a
   * way to read any hash in the store by guessing: the hash has to be the one
   * recorded against a user in the caller's own tenancy.
   */
  async userPicture(
    tenantId: string,
    userId: string,
    kind: 'PROFILE' | 'COVER' = 'PROFILE',
  ): Promise<{ bytes: Buffer; contentType: string } | undefined> {
    const user = this.#users.get(userId);
    if (!user || user.tenantId !== tenantId) return undefined;
    const hash = kind === 'COVER' ? user.coverHash : user.pictureHash;
    if (!hash) return undefined;
    if (!(await this.evidence.holds(tenantId, hash))) return undefined;
    return this.evidence.fetch(tenantId, hash);
  }

  /** Every operator account on the platform. */
  operators(): PlatformUser[] {
    return [...this.#users.values()].filter((u) => u.tenantId === PLATFORM_TENANT_ID);
  }

  /**
   * Every identity the demonstration seed created.
   *
   * Asked by two callers with the same question in different words: the console
   * bootstrap, to find out whether a demonstration tenancy already exists on
   * this deployment rather than seeding a second one after a restart; and the
   * login route, to decide whether an address is a published demonstration
   * account or somebody's real one. Operators are excluded here rather than at
   * each call site — nothing should ever be able to reach a `PLATFORM_ADMIN`
   * through a demonstration affordance, and a filter each caller has to
   * remember is a filter one of them will forget.
   */
  demonstrationUsers(): PlatformUser[] {
    return [...this.#users.values()].filter(
      (u) => u.demonstration === true && u.tenantId !== PLATFORM_TENANT_ID && !u.roles.includes('PLATFORM_ADMIN'),
    );
  }

  createUser(input: {
    tenantId: string;
    name: string;
    email: string;
    roles: Role[];
    partyId?: string;
    /** Only `seedDemoProject` passes this. See `PlatformUser.demonstration`. */
    demonstration?: true;
  }): PlatformUser {
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
      ...(input.demonstration ? { demonstration: true as const } : {}),
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
        // In the event, not only in memory: `rehydrate` rebuilds every user
        // from this state, and a flag that lived only in the process would be
        // lost on the first restart — taking the demonstration sign-in with it.
        ...(input.demonstration ? { demonstration: true as const } : {}),
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
  /**
   * Move a subscription's renewal date on, once a period has been billed.
   *
   * Separate from `setSubscriptionStatus` because it is not a decision about
   * the customer: the period ends whether or not the money arrived, and a
   * renewal date that waited for payment would raise the same charge every day
   * somebody was late until the debt was the number of times the scheduler ran.
   */
  advanceRenewal(tenantId: string, renewsAt: string): Subscription | undefined {
    const subscription = this.#subscriptions.get(tenantId);
    if (!subscription) return undefined;

    const updated: Subscription = { ...subscription, renewsAt };
    this.#subscriptions.set(tenantId, updated);

    this.ledger.commit({
      tenantId,
      projectId: `${tenantId}-governance`,
      actor: { refType: 'System', refId: 'billing' },
      source: 'SYSTEM',
      correlationId: ulid(),
      eventType: 'SUBSCRIPTION_RENEWAL_ADVANCED',
      entity: { refType: 'Subscription', refId: updated.id },
      nextState: { ...updated, renewalAdvancedFrom: subscription.renewsAt },
    });

    return updated;
  }

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

  /**
   * Move a tenancy to a different package, at whatever price the operator has
   * agreed — including none.
   *
   * ## What this does and does not touch
   *
   * It changes the **package**: the seat cap, the storage allowance, whether
   * the tenancy may export, whether it has API access and an isolated tenancy,
   * and what the monthly charge will be at the next renewal.
   *
   * It does **not** touch the ACU wallet, and that is the load-bearing rule
   * rather than an omission. The package is what a company is entitled to do;
   * the wallet is money it has put in to spend on AI. An operator handing a
   * customer a better package free of charge is a commercial decision they are
   * entitled to make. An operator crediting a customer's wallet is spending
   * money against providers who invoice this platform for it, and it would
   * arrive in the burn figures as revenue nobody received.
   *
   * So a free grant makes the platform more useful and costs the operator
   * nothing per request, and the customer still tops up their own wallet
   * before an engine will run. `chargeSubscription` reads the package at
   * renewal, so `grantFree` also decides whether the next monthly charge is
   * raised at all.
   *
   * ## Why a downgrade can be refused
   *
   * Seats already assigned may exceed the smaller package's cap. Moving anyway
   * would leave a tenancy silently over its limit — every existing identity
   * still working, and the next assignment refused with a message about a cap
   * nobody knowingly crossed. Refused with the numbers in it instead, so the
   * operator revokes seats first or picks a different package.
   */
  setSubscriptionPackage(input: {
    tenantId: string;
    package: PackageTier;
    reason: string;
    /** The operator who decided. */
    decidedBy: string;
    /**
     * True where the operator is giving this package away — no monthly charge
     * is raised for it at renewal. Recorded on the event either way, because
     * "was this paid for" is the question a revenue reconciliation asks.
     */
    grantFree: boolean;
  }): Subscription {
    if (!input.reason.trim()) {
      throw new DomainError('SUBSCRIPTION_REASON_REQUIRED', 'Changing a package requires a reason');
    }

    const subscription = this.subscription(input.tenantId);
    if (subscription.package === input.package && !input.grantFree) return subscription;

    const target = PACKAGES[input.package];
    const assigned = subscription.assignedIdentities.length;
    // `null` is unlimited, which can never be exceeded.
    if (target.includedSeats !== null && assigned > target.includedSeats) {
      throw new DomainError(
        'PACKAGE_SEATS_EXCEEDED',
        `${assigned} identities are assigned and the ${target.label} package includes ${target.includedSeats}. ` +
          'Revoke seats first, or choose a package that holds them — moving anyway would leave this tenancy over ' +
          'its cap with every existing identity still working and the next assignment refused.',
      );
    }

    // Only the package moves. `tier` is a different vocabulary —
    // `SubscriptionTier` has TEAM, BUSINESS and SOVEREIGN where `PackageTier`
    // has CORE_PROJECT and PROFESSIONAL_DELIVERY — so assigning one to the
    // other would write a value that is not a member of the type, and the
    // seat and price lookups read `package` anyway.
    const updated: Subscription = { ...subscription, package: input.package };
    this.#subscriptions.set(input.tenantId, updated);

    const evidenceId = ulid();
    const projectId = `${input.tenantId}-governance`;
    const decidedAt = new Date().toISOString();

    this.ledger.commit({
      tenantId: input.tenantId,
      projectId,
      actor: { refType: 'User', refId: input.decidedBy },
      source: 'WEB',
      correlationId: ulid(),
      eventType: 'EVIDENCE_REGISTERED',
      entity: { refType: 'EvidenceItem', refId: evidenceId },
      nextState: {
        id: evidenceId,
        type: 'SUBSCRIPTION_PACKAGE_AUTHORITY',
        hash: hashEvidence(
          JSON.stringify({
            tenantId: input.tenantId,
            from: subscription.package,
            to: input.package,
            grantFree: input.grantFree,
            decidedAt,
          }),
        ),
        description:
          `Package ${subscription.package} → ${input.package}` +
          `${input.grantFree ? ', granted free of charge' : ''}: ${input.reason}`,
        linkedEntities: [],
        capturedAt: decidedAt,
        capturedBy: input.decidedBy,
      },
    });

    this.ledger.commit({
      tenantId: input.tenantId,
      projectId,
      actor: { refType: 'User', refId: input.decidedBy },
      source: 'WEB',
      correlationId: ulid(),
      eventType: 'SUBSCRIPTION_PACKAGE_CHANGED',
      entity: { refType: 'Subscription', refId: updated.id },
      nextState: {
        ...updated,
        previousPackage: subscription.package,
        packageChangedAt: decidedAt,
        packageChangedBy: input.decidedBy,
        packageReason: input.reason,
        grantedFree: input.grantFree,
        // The figure that would otherwise have to be reconstructed from the
        // price list at whatever version it was on the day.
        monthlyPriceMinor: input.grantFree ? 0 : target.monthlyPriceMinor,
        listPriceMinor: target.monthlyPriceMinor,
      },
      evidenceRefs: [{ refType: 'EvidenceItem', refId: evidenceId }],
    });

    return updated;
  }

  // --- Private modules -------------------------------------------------------

  /**
   * Give a tenancy a private module, or take it back.
   *
   * The operator's decision, and the only way a grant is ever made — including
   * the operator's own tenancy, which holds its modules by the same command and
   * appears on the same register. A tenant id in a constant would make
   * revocation a deployment and leave no record of who decided it.
   *
   * A reason is required for the same reason it is on a subscription status
   * change: this hands a named company capability that is not on the price
   * list, and a record of that with no stated basis is unreviewable.
   */
  setModuleGrant(input: {
    moduleId: ModuleId;
    tenantId: string;
    status: ModuleGrant['status'];
    reason: string;
    decidedBy: string;
  }): ModuleGrant {
    if (!isModuleId(input.moduleId)) {
      throw new DomainError('MODULE_UNKNOWN', `${input.moduleId} is not a module this platform has`, 404);
    }
    if (!input.reason.trim()) {
      throw new DomainError('MODULE_REASON_REQUIRED', 'Granting or revoking a module requires a reason');
    }
    // The tenancy has to exist. Without this a typo in a tenant id writes a
    // grant nobody can see, against a company that does not exist, which then
    // sits on the register looking exactly like a real one.
    const tenant = this.tenant(input.tenantId);

    const ref = grantRef(input.moduleId, input.tenantId);
    const existing = this.#moduleGrants.get(ref);
    if (existing && existing.status === input.status) return existing;
    if (!existing && input.status === 'REVOKED') {
      // There is nothing to take back. Refused rather than recorded, because a
      // revocation with no grant behind it would have to name a grantor who
      // never granted anything, and that fiction would then sit on the register
      // looking exactly like a real one.
      throw new DomainError(
        'MODULE_NOT_GRANTED',
        `${tenant.legalName} does not hold ${MODULES[input.moduleId].name}, so there is nothing to revoke.`,
        404,
      );
    }

    const decidedAt = new Date().toISOString();
    const granting = input.status === 'ACTIVE';

    const updated: ModuleGrant = granting
      ? {
          moduleId: input.moduleId,
          tenantId: tenant.id,
          status: 'ACTIVE',
          grantedBy: input.decidedBy,
          grantedAt: decidedAt,
          reason: input.reason,
          // A re-grant clears the revocation. Leaving it would show a live
          // grant with a revocation date on it, which reads as expired.
        }
      : {
          // The original grant survives revocation untouched. "Who had this,
          // and between which dates" is what an access review asks, and a
          // record that overwrote its own grant cannot answer it.
          ...existing!,
          status: 'REVOKED',
          revokedBy: input.decidedBy,
          revokedAt: decidedAt,
          revokedReason: input.reason,
        };

    this.#moduleGrants.set(ref, updated);

    this.ledger.commit({
      // Written on the platform's own tenancy, not the customer's: this is the
      // operator's decision about a company, not that company's record about
      // themselves, and a tenancy that could read its own grant would be
      // reading the register of who else has been given the module.
      tenantId: PLATFORM_TENANT_ID,
      projectId: `${PLATFORM_TENANT_ID}-governance`,
      actor: { refType: 'User', refId: input.decidedBy },
      source: 'WEB',
      correlationId: ulid(),
      eventType: granting ? 'MODULE_GRANTED' : 'MODULE_REVOKED',
      entity: { refType: 'ModuleGrant', refId: ref },
      nextState: { ...updated, id: ref, moduleName: MODULES[input.moduleId].name },
    });

    return updated;
  }

  /** Every grant ever made, live and revoked. The operator's register. */
  moduleGrants(): ModuleGrant[] {
    return [...this.#moduleGrants.values()];
  }

  /**
   * The modules a tenancy currently holds.
   *
   * Derived from the grants each time rather than cached on the tenancy: a
   * cached copy is a second source of truth for the same fact, and the one that
   * goes stale is always the one an access check reads.
   */
  grantedModules(tenantId: string): ModuleId[] {
    return this.moduleGrants()
      .filter((grant) => grant.tenantId === tenantId && grant.status === 'ACTIVE')
      .map((grant) => grant.moduleId);
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

    for (const record of this.ledger.entitiesOfType('ModuleGrant')) {
      const state = record.state as unknown as ModuleGrant;
      // Guarded, because a grant restored for a module this build no longer has
      // would be an access check reading a module id that is not in the
      // catalogue. Dropping it fails closed; keeping it would not.
      if (isModuleId(state.moduleId)) {
        this.#moduleGrants.set(grantRef(state.moduleId, state.tenantId), state);
      }
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
    /**
     * What was handed over, when the rail settled in another currency.
     * `amountMinor` above is still the billing currency and is still what the
     * wallet is credited; this is the audit trail for how it was arrived at.
     */
    fx?: SettlementFx;
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
      ...(input.fx ? { fx: input.fx } : {}),
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

  /**
   * Quote a recorded top-up on the mobile-money rail, and pin the rate to it.
   *
   * The rate is written onto the intent the first time it is quoted and reused
   * afterwards, so re-opening a checkout does not re-price a payment somebody
   * is already making, and so the webhook can credit at the rate the customer
   * was actually shown.
   */
  quoteMobileMoney(intentId: string, tenantId: string): { amountMinor: number; currency: string; ratePerBillingUnit: number } {
    const intent = this.#topUpIntents.get(intentId);
    if (!intent || intent.tenantId !== tenantId) throw new NotFoundError(`No top-up request ${intentId}`);

    if (intent.quotedFx) return { ...intent.quotedFx };

    const rate = config.koda.usdPerGbp;
    const amountMinor = convertFromBillingMinor(intent.amountMinor, rate);
    intent.quotedFx = { currency: KODA_SETTLEMENT_CURRENCY, amountMinor, ratePerBillingUnit: rate };
    return { ...intent.quotedFx };
  }

  /**
   * Credit a wallet from a verified mobile-money settlement.
   *
   * Converts at the rate quoted on the intent when there is one — the customer
   * gets what they were shown — and at the configured rate otherwise, which is
   * the case for a payment that reached KODA without going through our
   * checkout. Both amounts and the rate go onto the receipt, so the credit can
   * be recomputed from its own record without knowing what the configured rate
   * was that day.
   */
  creditFromMobileMoney(settlement: {
    reference: string;
    tenantId: string;
    intentId?: string;
    settledAmountMinor: number;
    settledCurrency: string;
  }): { receipt: PaymentReceipt; alreadyRecorded: boolean } {
    const intent = settlement.intentId ? this.#topUpIntents.get(settlement.intentId) : undefined;
    const rate = intent?.quotedFx?.ratePerBillingUnit ?? config.koda.usdPerGbp;
    const amountMinor = convertToBillingMinor(settlement.settledAmountMinor, rate);

    return this.creditFromPayment({
      tenantId: settlement.tenantId,
      amountMinor,
      method: 'MOBILE_MONEY',
      reference: settlement.reference,
      ...(settlement.intentId ? { intentId: settlement.intentId } : {}),
      recordedBy: 'koda',
      // KODA is holding the money and has signed for it, so a second real
      // payment against a spent request is a credit rather than a 409.
      source: 'PROVIDER',
      note: `KODA mobile money ${settlement.settledAmountMinor} ${settlement.settledCurrency}`,
      fx: {
        settledCurrency: settlement.settledCurrency,
        settledAmountMinor: settlement.settledAmountMinor,
        ratePerBillingUnit: rate,
      },
    });
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
    // The account-layer boundary, enforced here rather than left to an accident.
    //
    // It used to hold for a reason nobody chose: the operator tenancy had no
    // wallet, so `this.wallet()` below threw and an operator could not hold an
    // engine context for anything. `entitlement.test.ts` pinned that and called
    // it "stronger", correctly — a route guard can be forgotten on a new route,
    // and this cannot.
    //
    // Giving the platform its own wallet, so its marketing AI is metered like
    // everybody else's, removed that accident. The property is too important to
    // depend on one, so it is now a check: an operator may hold a context for
    // the platform's own projects and for nothing else. Without this, a caller
    // could pass a customer's project id with an operator's token and get an
    // engine context over their record, charged to the platform's wallet.
    if (auth.roles.includes('PLATFORM_ADMIN') && !projectId.startsWith(`${PLATFORM_TENANT_ID}-`)) {
      throw new ForbiddenError(
        'Platform operators are barred from customer delivery data',
        'ACCOUNT_LAYER_SEPARATION',
      );
    }

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
      // Beside standing, and not expressed in terms of it. Standing is derived
      // from whether the tenancy is paying; a module grant is an act somebody
      // took. A granted tenancy that stops paying loses the platform, not the
      // grant, so reactivating restores what they had rather than silently
      // dropping a module nobody remembered to re-add.
      grantedModules: this.grantedModules(auth.tenantId),
    };
  }

  /**
   * The readiness probe, and only what a probe needs.
   *
   * This is served unauthenticated at `/readyz`, and it used to carry the
   * tenant count, the event count and the whole AI control plane with it. On a
   * live deployment that read:
   *
   *     {"tenants":3,"events":3164,"controlPlane":{...every provider, its
   *      health, the routing matrix and every engine contract...}}
   *
   * — published to anybody who asked. Two things wrong with that, and neither
   * is hypothetical:
   *
   *   - **`tenants` is the customer count.** In an industry that buys on
   *     references, how many customers you have is the number you least want
   *     on an unauthenticated URL, and a competitor can watch it move.
   *   - **The control plane names your sub-processors.** Which AI vendors hold
   *     customer material, and which are reachable right now, is
   *     reconnaissance for somebody choosing a target and a sub-processor
   *     disclosure made by accident rather than by policy.
   *
   * `/v1/admin/readiness` is operator-only precisely because "it is a map of
   * which locks on this deployment are unlocked". The same argument applies
   * here and was not being applied.
   *
   * What stays public is what a probe is for. `status` answers the
   * orchestrator. `env` and `commit` answer "is what I am looking at the build
   * we shipped" — deliberately public, and useless if only somebody with a
   * shell on the host can read it. Everything else moved behind the gate it
   * was already available behind: `/v1/admin/readiness` and
   * `/v1/ai/control-plane`.
   */
  health(): {
    status: 'ok';
    env: string;
    /** The commit this process is running, or `unknown` if the deployer did not say. */
    commit: string;
  } {
    return {
      status: 'ok',
      env: config.env,
      commit: config.buildCommit || 'unknown',
    };
  }

  /**
   * The same picture with the operational detail in it, for the operator.
   *
   * Everything `health()` used to publish. Reached through
   * `/v1/admin/readiness`, which is already operator-only.
   */
  operationalHealth(): {
    status: 'ok';
    env: string;
    commit: string;
    aiMode: string;
    tenants: number;
    events: number;
    controlPlane: ReturnType<AIOrchestrator['controlPlaneStatus']>;
  } {
    return {
      ...this.health(),
      aiMode: config.ai.mode,
      tenants: this.#tenants.size,
      events: this.ledger.size,
      controlPlane: this.orchestrator.controlPlaneStatus(),
    };
  }
}
