import { AIOrchestrator } from './ai/orchestrator.ts';
import { ExportService } from './export/exporter.ts';
import { SyncEngine } from './field/sync.ts';
import { ACUWallet } from './billing/acu.ts';
import { buildInvoice, type Invoice } from './billing/invoice.ts';
import { assignIdentity, revokeIdentity, TIERS, type Subscription, type SubscriptionTier } from './billing/subscription.ts';
import { config } from './config.ts';
import { DomainError, NotFoundError } from './core/errors.ts';
import { ulid } from './core/ids.ts';
import type { EngineContext } from './engines/context.ts';
import { GoldenThreadLedger } from './goldenthread/ledger.ts';
import type { EventSource } from './goldenthread/types.ts';
import type { AuthContext } from './identity/auth.ts';
import { issueTokens, type TokenPair } from './identity/auth.ts';
import type { Role } from './identity/roles.ts';

/**
 * Platform assembly — one object that owns the ledger, the wallets, the
 * subscriptions and the AI control plane, and hands out per-request engine
 * contexts. Everything else in the system depends on interfaces, not on this.
 */

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
};

export class Platform {
  readonly ledger = new GoldenThreadLedger();
  readonly orchestrator: AIOrchestrator;
  /** Offline-first field sync. Devices push batches and pull by cursor. */
  readonly sync: SyncEngine;
  /** Every document that leaves the platform is branded, hashed and recorded. */
  readonly exports: ExportService;

  readonly #wallets = new Map<string, ACUWallet>();
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #tenants = new Map<string, Tenant>();
  readonly #users = new Map<string, PlatformUser>();

  constructor(orchestrator = new AIOrchestrator()) {
    this.orchestrator = orchestrator;
    this.sync = new SyncEngine(this.ledger);
    this.exports = new ExportService(this.ledger);
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
    enterpriseName: string;
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
      status: 'ACTIVE',
      assignedIdentities: [],
      startedAt: new Date().toISOString(),
      renewsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    };
    this.#subscriptions.set(tenantId, subscription);

    const wallet = new ACUWallet(tenantId, { volumeIncentive: input.tier === 'ENTERPRISE' || input.tier === 'SOVEREIGN' });
    // Every tenant, paid or trial, starts with the trial grant so AI can be
    // tried without a payment method — and stops when it runs out.
    wallet.grantTrialCredit();
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
        includedIdentities: TIERS[subscription.tier].includedIdentities,
        monthlyPriceUsd: TIERS[subscription.tier].monthlyPriceUsd,
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
    const updated = assignIdentity(subscription, userId);
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
        includedIdentities: TIERS[updated.tier].includedIdentities,
        monthlyPriceUsd: TIERS[updated.tier].monthlyPriceUsd,
        status: updated.status,
        assignedIdentities: updated.assignedIdentities,
      },
    });

    return user;
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

  // --- Accessors -------------------------------------------------------------

  tenant(tenantId: string): Tenant {
    const tenant = this.#tenants.get(tenantId);
    if (!tenant) throw new NotFoundError(`Tenant ${tenantId} not found`);
    return tenant;
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

  topUp(tenantId: string, amountMinor: number): void {
    const wallet = this.wallet(tenantId);
    wallet.topUp(amountMinor);

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

  issueInvoice(tenantId: string, period: string): Invoice {
    const invoice = buildInvoice(this.subscription(tenantId), this.wallet(tenantId), period, this.tenant(tenantId).defaultCurrency);

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
