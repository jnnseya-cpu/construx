import { CHANGE_ORIGIN, CONTINENT, CONTRACT_FORM, DELAY_CAUSE, NOTICE_TYPE, SECTOR, SITE_OBSERVATION_CATEGORY, WEATHER_CONDITION, values } from '../../../shared/vocabulary.js';
import { ask } from '../ai/conversation.ts';
import * as storage from '../billing/storage.ts';
import * as signup from '../identity/signup.ts';
import * as erasure from '../identity/erasure.ts';
import * as site from '../site/index.ts';
// Read from the data module rather than through the site barrel: `pages.ts`
// reads this route table, so importing the posts through it would make this
// file depend on a module that depends on this file.
import { POST_PAGES } from '../site/posts.ts';
import * as notifications from '../notifications/catalogue.ts';
import { CATEGORIES, CATEGORY_TITLES, NOTIFICATION_EVENTS } from '../notifications/catalogue.ts';
import * as notifyEngine from '../notifications/notify.ts';
import * as preferences from '../notifications/preferences.ts';
import * as notificationRender from '../notifications/render.ts';
import type { Engine } from '../ai/orchestrator.ts';
import type { ProviderCapability } from '../ai/providers/types.ts';
import * as agents from '../agents/runtime.ts';
import { fleetManifest } from '../agents/runtime.ts';
import type { ACUCaps } from '../billing/acu.ts';
import { ACU_BUNDLES, PACKAGES, SEATS } from '../billing/seats.ts';
import { seatEconomics, TIERS } from '../billing/subscription.ts';
import { config, isProduction } from '../config.ts';
import * as consistency from '../domain/consistency.ts';
import { CURRENCIES, JURISDICTIONS } from '../domain/locale.ts';
import { AuthError, DomainError, ForbiddenError, NotFoundError } from '../core/errors.ts';
import type { Schema } from '../core/validate.ts';
import * as business from '../domain/business.ts';
import * as cdm from '../domain/cdm.ts';
import * as portfolio from '../domain/portfolio.ts';
import * as correspondence from '../domain/correspondence.ts';
import * as procurement from '../domain/procurement.ts';
import * as supplychain from '../domain/supplychain.ts';
import * as control from '../domain/control.ts';
import * as radar from '../domain/radar.ts';
import * as itt from '../domain/itt.ts';
import * as costintel from '../domain/costintel.ts';
import { morningBriefing } from '../agents/briefing.ts';
import { AGENT_DIVISIONS, type AgentDivision } from '../agents/types.ts';
import { AGENTS } from '../agents/registry.ts';
import * as framework from '../domain/framework.ts';
import * as lifecycleControl from '../lifecycle/control.ts';
import * as stages from '../lifecycle/stages.ts';
import * as costModel from '../engines/maths/costModel.ts';
import * as structure from '../domain/structure.ts';
import * as bim from '../engines/bim.ts';
import * as claims from '../engines/claims.ts';
import * as cost from '../engines/cost.ts';
import * as handover from '../engines/handover.ts';
import * as planning from '../engines/planning.ts';
import * as quality from '../engines/quality.ts';
import * as safety from '../engines/safety.ts';
import * as tender from '../engines/tender.ts';
import { lineage } from '../goldenthread/lineage.ts';
import { replayProject, replayTimeline } from '../goldenthread/replay.ts';
import { readConsent, resolveAudience, resolveUnsubscribe, setConsent } from '../messaging/audience.ts';
import {
  deliveriesFor,
  isoWeek,
  issueNewsletter,
  listCampaigns,
  previewFor,
} from '../messaging/newsletter.ts';
import { unsubscribePage, verificationPage } from '../messaging/render.ts';
import { evaluateAccess, WRITE_PHASE_GATES } from '../identity/abac.ts';
import { createMfaChallenge, decoyMfaResponse, refreshTokens, shapeMfaResponse, verifyMfaChallenge, type AuthContext } from '../identity/auth.ts';
import { classifyEntity } from '../identity/entityAccess.ts';
import { FIELD_FORBIDDEN_EVENTS } from '../field/sync.ts';
import { estateBurn } from '../billing/burn.ts';
import * as evidence from '../evidence/registry.ts';
import * as perception from '../engines/perception.ts';
import * as signing from '../signing/signature.ts';
import { ownershipMap } from '../identity/ownership.ts';
import { PERMISSION_MATRIX, type CapabilityArea, type PermissionCode } from '../identity/roles.ts';
import { authorise, AUTHZ_OPTIONS, currentPhase, write } from '../engines/context.ts';
import { ulid } from '../core/ids.ts';
import { LIFECYCLE_ORDER, PHASE_GATES } from '../lifecycle/phases.ts';
import type { Platform } from '../platform.ts';
import type { ExportAudience, ExportFormat } from '../export/exporter.ts';
import { metrics, recentLogs, type HtmlPolicy, type RequestContext } from './middleware.ts';
import { gatewayMetrics, securityEvents, securitySummary, type SecurityEventKind } from './telemetry.ts';

/**
 * The gateway routing table. Routes are explicit and versioned — no backend
 * discovery, no implicit fallthrough. Each entry declares whether it is public
 * and what schema its body must satisfy.
 */

export type RouteHandler = (platform: Platform, ctx: RequestContext) => unknown | Promise<unknown>;

export type Route = {
  method: string;
  /** Path pattern with :params, e.g. /v1/projects/:projectId/programme. */
  pattern: string;
  handler: RouteHandler;
  public?: boolean;
  /** Handler returns a complete HTML page rather than a JSON payload. */
  html?: boolean;
  /** Which content-security policy an html route is served under. */
  htmlPolicy?: HtmlPolicy;
  /**
   * Handler returns bytes and the headers to send them under, rather than a
   * JSON payload. A PDF cannot be base64 in a JSON envelope and still be a file
   * somebody's browser saves with the right name.
   */
  binary?: boolean;
  /**
   * The request body is a file, delivered as bytes on `ctx.rawBody` rather than
   * parsed as JSON. Base64 inside an envelope would inflate a 50MB photograph
   * to 67MB of text and then ask the JSON parser to hold all of it.
   */
  upload?: boolean;
  /**
   * A POST that creates nothing and changes nothing — answered 200, not 201.
   *
   * The method is POST because the question does not fit in a path, not because
   * a resource appears. 201 Created would name a resource there is nothing to
   * point at, the same reasoning the HTML routes already carry.
   */
  readOnly?: boolean;
  schema?: Schema;
  description: string;
  /**
   * Declared where the handler reaches an AI provider, so the cost of the
   * action can be quoted before anybody commits to it.
   *
   * It lives on the route rather than in a separate catalogue because the route
   * is the only place that already knows which engine command runs — and it
   * sits next to that call, where a change to one is visible against the other.
   * The browser then needs no vocabulary of its own: it asks what the request
   * it is about to send would cost.
   */
  ai?: { engine: Engine; taskType: string; capability: ProviderCapability };
};

function body<T>(ctx: RequestContext): T {
  return (ctx.body ?? {}) as T;
}

function auth(ctx: RequestContext) {
  if (!ctx.auth) throw new ForbiddenError('Authenticated context required');
  return ctx.auth;
}

/** The operator layer, stated as a refusal rather than a 404. */
function operatorOnly(ctx: RequestContext, action: string): void {
  if (!auth(ctx).roles.includes('PLATFORM_ADMIN')) {
    throw new ForbiddenError(`Only the platform operator may ${action}`, 'PLATFORM_ADMIN_REQUIRED');
  }
}

/**
 * A context for work that happens before a project exists — the pipeline.
 * Bound to the tenant's governance chain rather than to a project id.
 */
/**
 * A control item as it can be published. The evidence predicate is a function
 * and does not survive JSON, so what leaves is what the item requires and where
 * it is looked for — not how the check is implemented.
 */
function publishableControlItem(item: lifecycleControl.ControlItem) {
  return {
    id: item.id,
    stage: item.stage,
    label: item.label,
    purpose: item.purpose,
    dueFrom: item.dueFrom,
    gateEnforced: Boolean(item.gateEnforced),
    tracked: item.evidence !== undefined,
    evidence: item.evidence ? { refType: item.evidence.refType, minimum: item.evidence.minimum, counts: item.evidence.counts } : undefined,
    notTrackedReason: item.notTrackedReason,
  };
}

/**
 * Authorise a tenant-level action that is not about a project.
 *
 * Billing is the case this exists for. Those routes enforced nothing at all:
 * any authenticated identity in a tenant could top the wallet up, move the AI
 * spend caps or issue an invoice, and the console was the only thing stopping
 * them — which is to say nothing was. The permission matrix already had the
 * answer (`BILLING_ACU`, update reserved to the enterprise administrator and
 * the asset owner); it simply was not being asked.
 */
function authoriseTenant(ctx: RequestContext, area: CapabilityArea, code: PermissionCode): AuthContext {
  const actor = auth(ctx);
  const decision = evaluateAccess(actor, area, code, { tenantId: actor.tenantId }, AUTHZ_OPTIONS);
  if (decision.decision !== 'ALLOW') {
    throw new ForbiddenError(decision.reason ?? 'Not permitted', 'ACCESS_DENIED');
  }
  return actor;
}

function tenantContext(platform: Platform, ctx: RequestContext) {
  const actor = auth(ctx);
  if (actor.roles.includes('PLATFORM_ADMIN')) {
    throw new ForbiddenError('Platform operators are barred from customer delivery data', 'ACCOUNT_LAYER_SEPARATION');
  }
  return platform.context(actor, `${actor.tenantId}-governance`, {
    correlationId: ctx.correlationId,
    source: sourceOf(ctx),
  });
}

function projectContext(platform: Platform, ctx: RequestContext, overrideProjectId?: string) {
  const projectId = overrideProjectId ?? ctx.params.projectId;
  if (!projectId) throw new NotFoundError('Project id missing from path');
  // Refuse the operator layer here rather than letting it fail later on a
  // missing wallet: the answer is "you are not allowed", not "not found".
  if (auth(ctx).roles.includes('PLATFORM_ADMIN')) {
    throw new ForbiddenError('Platform operators are barred from customer delivery data', 'ACCOUNT_LAYER_SEPARATION');
  }
  return platform.context(auth(ctx), projectId, { correlationId: ctx.correlationId, source: sourceOf(ctx) });
}

function sourceOf(ctx: RequestContext): 'WEB' | 'PWA' | 'ANDROID' | 'IOS' | 'SYSTEM' {
  // The installed application declares itself, because only it knows: a PWA in
  // standalone display mode is the same user agent as the same browser with a
  // tab open, and nothing in the request distinguishes them. The client asserts
  // it, the ledger records what was asserted, and the value is a provenance
  // note rather than a permission — nothing is granted or refused on it.
  const client = ctx.query.get('client');
  if (client === 'android') return 'ANDROID';
  if (client === 'ios') return 'IOS';
  if (client === 'pwa') return 'PWA';
  return 'WEB';
}

/**
 * Every capability area, read from the permission matrix rather than restated.
 *
 * A signature request names the area its document belongs to, and that choice
 * decides who may ask for it and who may sign. Listing the areas here by hand
 * would be a second vocabulary that drifts from the one being enforced.
 */
const CAPABILITY_AREAS: string[] = [
  ...new Set(Object.values(PERMISSION_MATRIX).flatMap((matrix) => Object.keys(matrix))),
].sort();

/**
 * The parties a letter can be addressed to.
 *
 * Derived from the matrix rather than typed out beside it: the schema's enum and
 * the rule that enforces it have to be the same list, or a party the console
 * offers is a party the platform refuses.
 */
const CORRESPONDENCE_PARTIES: string[] = [
  ...new Set(Object.values(correspondence.CORRESPONDENCE_TYPES).flatMap((d) => [...d.senders, ...d.recipients])),
].sort();

/** The URL segment each perception task lives at. Kebab-case, as the API is. */
const PERCEPTION_PATHS: Record<perception.PerceptionTask, string> = {
  TITLE_BLOCK: 'title-block',
  DRAWING_TAKEOFF: 'take-off',
  VOICE_NOTE: 'voice-note',
};

/**
 * A tenancy's storage position: what the package allows plus what was bought,
 * against what the volume actually holds.
 *
 * Assembled here rather than inside the billing module because it needs three
 * things that live in three places — the subscription, the ledger and the
 * object store — and the billing module should not have to know how to reach
 * any of them.
 */
function storagePositionFor(platform: Platform, tenantId: string): storage.StoragePosition {
  return storage.storagePosition({
    tier: platform.subscription(tenantId).package,
    usedBytes: platform.evidence.usage(tenantId),
    purchasedBlocks: storage.purchasedBlocks(platform.ledger, tenantId),
  });
}

const stringField = { type: 'string', minLength: 1 } as const;

/**
 * Commands an approved proposal may run.
 *
 * An explicit allow-list, not a lookup by name into the engines: an agent can
 * only ever cause one of these to happen, and adding to this map is a
 * deliberate act rather than a side effect of naming a function.
 */
/**
 * Branding for platform-to-stranger mail.
 *
 * A registration has no tenancy yet, so there is no customer branding to use.
 * This is CONSTRUX writing as itself, which is what the message actually is.
 */
const PLATFORM_BRANDING = {
  clientName: 'CONSTRUX.AI',
  primaryColour: '#ff6600',
  documentReferencePrefix: 'CXA',
  legalFooter: 'CONSTRUX.AI — construction operating system',
} as const;

const AGENT_COMMANDS: Record<string, (ctx: ReturnType<typeof projectContext>, input: Record<string, unknown>) => Promise<unknown>> = {
  'planning:forecastDelay': (ctx, input) => planning.forecastDelay(ctx, input as never),
  'cost:publishCVR': (ctx, input) => cost.publishCVR(ctx, input as never),
  'safety:assessContingency': (ctx) => Promise.resolve(safety.assessContingency(ctx)),
  'claims:assessDelayClaim': (ctx, input) => claims.assessDelayClaim(ctx, input as never),
  'handover:forecastMaintenance': (ctx, input) => handover.forecastMaintenance(ctx, input as never),
};

/**
 * The console's demonstration session. Seeding is expensive and must happen
 * once per process, so concurrent bootstraps share a single promise.
 */
let consoleSession: Promise<{ projectId: string; email: string; enterpriseName: string; portfolioName: string }> | undefined;

function getOrCreateConsoleSession(platform: Platform): Promise<{
  projectId: string;
  email: string;
  enterpriseName: string;
  portfolioName: string;
}> {
  consoleSession ??= import('../seed.ts').then(async ({ seedDemoProject }) => {
    const seed = await seedDemoProject(platform);
    return {
      projectId: seed.projectId,
      email: 'pm@meridian.example',
      enterpriseName: seed.enterpriseName,
      portfolioName: seed.portfolioName,
    };
  });
  return consoleSession;
}

/**
 * Prove an address and provision the tenancy behind it.
 *
 * Shared by the two doors onto the same act: `POST /v1/signup/verify` for a
 * client that speaks JSON, and `POST /verify` for a person who pressed the
 * button on the page the confirmation email points at. One implementation,
 * because two would drift and only one of them would keep sending the welcome.
 */
async function activateRegistration(
  platform: Platform,
  ctx: RequestContext,
  registrationId: string,
  token: string,
): Promise<{ activation: signup.Activation; email: string }> {
  const activation = signup.verify(platform, { registrationId, token, correlationId: ctx.correlationId });
  const user = platform.user(activation.userId);

  await notifyEngine.notify(platform, {
    code: 'account.verification.successful',
    recipients: [{ id: user.id, name: user.name, email: user.email, tenantId: user.tenantId }],
    payload: {
      enterprise: activation.enterpriseName,
      actionUrl: '/app',
      actionLabel: 'Sign in',
      detail: `${activation.enterpriseName} is set up and you are its administrator.`,
    },
    branding: platform.exports.branding(activation.tenantId),
    actorId: 'signup',
    correlationId: ctx.correlationId,
  });

  return { activation, email: user.email };
}

export const ROUTES: Route[] = [
  // ------------------------------------------------------------------ health
  {
    method: 'GET',
    pattern: '/healthz',
    public: true,
    description: 'Liveness probe',
    handler: () => ({ status: 'ok' }),
  },
  {
    method: 'GET',
    pattern: '/readyz',
    public: true,
    description: 'Readiness probe including AI control plane status',
    handler: (platform) => platform.health(),
  },

  // -------------------------------------------------------------------- auth
  {
    method: 'POST',
    pattern: '/v1/auth/login',
    public: true,
    description: 'Authenticate and receive an MFA challenge',
    schema: { type: 'object', required: ['email'], properties: { email: stringField }, additionalProperties: false },
    handler: async (platform, ctx) => {
      const { email } = body<{ email: string }>(ctx);
      const user = platform.userByEmail(email);

      // An unknown address gets the same answer a known one does.
      //
      // This route used to reply `404 No user with that email address`, which
      // made it an account-enumeration oracle: feed it a leaked address list and
      // it sorts the list into customers and strangers, for free, without
      // authenticating. Registration was written from the opposite premise —
      // `identity/signup.ts` returns an identical receipt whether or not the
      // address is in use, precisely so that nobody can ask — and login handed
      // the answer to anyone who asked it.
      //
      // The decoy is a challenge that was never stored, so `verifyMfaChallenge`
      // cannot match it and the attempt fails with MFA_FAILED — the same error a
      // real account gives for a wrong code. Nothing is sent, because there is
      // nobody to send it to.
      if (!user) return decoyMfaResponse();

      const challenge = createMfaChallenge(user.id);

      // In production the code has to reach the person, and until now it did
      // not: it was generated, held in memory, returned to nobody, and the
      // response deliberately withheld it. The effect was a deployment where
      // every credential was correct and no human being could complete a
      // sign-in — the demonstration identity picker was hiding it, because the
      // demo path reads `devCode` straight out of this response.
      //
      // `mfa.otp_code` was already in the notification catalogue waiting for a
      // caller. Sent through the same pipeline as every other notice, so it is
      // recorded, rendered and branded like one rather than being a second
      // private mail path.
      if (isProduction()) {
        await notifyEngine.notify(platform, {
          code: 'mfa.otp_code',
          recipients: [{ id: user.id, name: user.name, email: user.email, tenantId: user.tenantId }],
          payload: {
            detail: `Your verification code is ${challenge.code}. It expires in five minutes.`,
          },
          // Email only. The catalogue also lists SMS, and there is no SMS
          // carrier in this build — routing to one would record a delivery
          // that never happened.
          channels: ['EMAIL'],
          branding: platform.exports.branding(user.tenantId),
          actorId: user.id,
          correlationId: ctx.correlationId,
        });
      }

      return {
        ...shapeMfaResponse(challenge),
        // Returned only outside production, so local development and the
        // demonstration do not need a mail server to sign in.
        ...(isProduction() ? {} : { devCode: challenge.code }),
        actorId: user.id,
      };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/auth/mfa/verify',
    public: true,
    description: 'Verify an MFA challenge and issue tokens',
    schema: {
      type: 'object',
      required: ['actorId', 'challengeId', 'code'],
      properties: { actorId: stringField, challengeId: stringField, code: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const { actorId, challengeId, code } = body<{ actorId: string; challengeId: string; code: string }>(ctx);
      if (!verifyMfaChallenge(actorId, challengeId, code)) {
        throw new DomainError('MFA_FAILED', 'Verification failed', 401);
      }
      const user = platform.user(actorId);
      return { user: { id: user.id, name: user.name, roles: user.roles }, ...platform.login(user.email).tokens };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/auth/refresh',
    public: true,
    description: 'Rotate a refresh token',
    schema: {
      type: 'object',
      required: ['refreshToken'],
      properties: { refreshToken: stringField },
      additionalProperties: false,
    },
    handler: (_platform, ctx) => refreshTokens(body<{ refreshToken: string }>(ctx).refreshToken),
  },

  // ------------------------------------------------------------------- admin
  {
    method: 'POST',
    pattern: '/v1/admin/tenants',
    description: 'Onboard a tenant (platform operator only)',
    schema: {
      type: 'object',
      required: ['legalName', 'jurisdiction', 'defaultCurrency', 'tier', 'enterpriseName'],
      properties: {
        legalName: stringField,
        jurisdiction: stringField,
        defaultCurrency: stringField,
        enterpriseName: stringField,
        tier: { type: 'string', enum: ['SOLO', 'TEAM', 'BUSINESS', 'ENTERPRISE', 'SOVEREIGN', 'FREE_TRIAL'] },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      if (!auth(ctx).roles.includes('PLATFORM_ADMIN')) {
        throw new ForbiddenError('Only the platform operator may onboard tenants', 'PLATFORM_ADMIN_REQUIRED');
      }
      const result = platform.createTenant(body(ctx));
      return { tenant: result.tenant, subscription: result.subscription, wallet: result.wallet.snapshot() };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/admin/tenants/:tenantId/subscription-status',
    description: 'Suspend, cancel or reactivate a tenancy (platform operator only)',
    schema: {
      type: 'object',
      required: ['status', 'reason'],
      properties: {
        status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'CANCELLED'] },
        // Required, and recorded as evidence. This is the switch that turns off
        // a paying customer's platform; a record of it with no stated reason is
        // useless the day somebody asks why it happened.
        reason: { type: 'string', minLength: 3 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      // Operator-only, and it stays that way when a payment provider is wired:
      // the provider's webhook comes through here rather than reaching into
      // platform state, so a dunning failure and an operator's decision leave
      // the same record.
      const actor = auth(ctx);
      if (!actor.roles.includes('PLATFORM_ADMIN')) {
        throw new ForbiddenError('Only the platform operator may change a subscription status', 'PLATFORM_ADMIN_REQUIRED');
      }
      const input = body<{ status: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED'; reason: string }>(ctx);
      const updated = platform.setSubscriptionStatus({
        tenantId: ctx.params.tenantId!,
        status: input.status,
        reason: input.reason,
        decidedBy: actor.actorId,
      });
      return {
        tenantId: updated.tenantId,
        status: updated.status,
        // Stated back rather than left implied: an operator suspending a
        // tenancy should see exactly what they have just switched off.
        effect:
          updated.status === 'ACTIVE'
            ? 'Writes, AI execution, top-ups and export are permitted.'
            : 'The record is read-only. No writes, no AI execution, no top-ups and no export until reactivated.',
      };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/admin/tenants',
    description: 'Tenancy, seats and prepaid balance across the estate (platform operator only)',
    handler: (platform, ctx) => {
      if (!auth(ctx).roles.includes('PLATFORM_ADMIN')) {
        throw new ForbiddenError('Only the platform operator may see the tenant estate', 'PLATFORM_ADMIN_REQUIRED');
      }
      // Tenancy, commercial terms and credit — and nothing about what any of
      // these tenants is building. That is the whole point of the layer.
      return {
        tenants: platform.tenants().map((tenant) => {
          const subscription = platform.subscription(tenant.id);
          const definition = TIERS[subscription.tier];
          return {
            id: tenant.id,
            legalName: tenant.legalName,
            jurisdiction: tenant.jurisdiction,
            currency: tenant.defaultCurrency,
            createdAt: tenant.createdAt,
            tier: subscription.tier,
            status: subscription.status,
            renewsAt: subscription.renewsAt,
            seatsUsed: subscription.assignedIdentities.length,
            seatsIncluded: definition.includedIdentities,
            monthlyPriceUsd: definition.monthlyPriceUsd,
            isolatedTenancy: definition.isolatedTenancy,
            wallet: platform.wallet(tenant.id).snapshot(),
            // How much of the volume this tenancy is using, and how close it is
            // to the point where its next upload is refused. Bytes held, not
            // what they contain — the operator layer sees the meter, never the
            // evidence.
            storage: storagePositionFor(platform, tenant.id),
          };
        }),
        // The estate total, because the decision it informs is not about any
        // one tenant. This deployment holds evidence on a local volume, which
        // is right for a pilot and cannot hold a Professional Delivery tenancy
        // at 500 GB, let alone an Enterprise one at 4 TB. Somebody has to be
        // able to see the line coming.
        estate: (() => {
          const positions = platform.tenants().map((tenant) => storagePositionFor(platform, tenant.id));
          const heldBytes = positions.reduce((sum, position) => sum + position.usedBytes, 0);
          const committedBytes = positions.reduce((sum, position) => sum + position.limitBytes, 0);
          return {
            tenancies: positions.length,
            heldBytes,
            /**
             * What the estate has *promised*, against what it is using.
             *
             * The number that matters for the volume, and the one that arrives
             * without warning: a single Enterprise tenancy commits 4 TB the day
             * it signs, whatever it has uploaded so far.
             */
            committedBytes,
            atWarning: positions.filter((position) => position.state === 'WARNING').length,
            atLimit: positions.filter((position) => position.state === 'FULL').length,
          };
        })(),
      };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/admin/burn',
    description: 'AI spend, realised margin and runway across every tenancy (platform operator only)',
    readOnly: true,
    handler: (platform, ctx) => {
      if (!auth(ctx).roles.includes('PLATFORM_ADMIN')) {
        throw new ForbiddenError('Only the platform operator may see estate spend', 'PLATFORM_ADMIN_REQUIRED');
      }
      // Spend and margin, and nothing about what any tenant is building — the
      // same boundary the tenant estate view keeps. An ACU entry names a module
      // and a feature, both of which are billing facts; it never carries the
      // content of the work that produced the charge.
      const windowDays = ctx.query.get('windowDays') ? Number(ctx.query.get('windowDays')) : undefined;
      return estateBurn(
        platform.tenants().map((tenant) => {
          const wallet = platform.wallet(tenant.id);
          return {
            tenantId: tenant.id,
            legalName: tenant.legalName,
            availableMinor: wallet.availableMinor(),
            entries: wallet.entries(),
          };
        }),
        windowDays,
      );
    },
  },
  {
    method: 'GET',
    pattern: '/v1/admin/logs',
    description: 'Recent gateway request logs',
    handler: (_platform, ctx) => {
      if (!auth(ctx).roles.includes('PLATFORM_ADMIN')) throw new ForbiddenError('Operator access required');
      return { logs: recentLogs(200), metrics: metrics(), gateway: gatewayMetrics() };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/admin/security',
    description: 'The gateway security audit stream: auth failures, denials, rate limits, admin access',
    handler: (_platform, ctx) => {
      // The audit stream names who tried what. It is operator-only for the same
      // reason the logs are: it is a map of where the locks are.
      if (!auth(ctx).roles.includes('PLATFORM_ADMIN')) throw new ForbiddenError('Operator access required');
      return {
        summary: securitySummary(),
        events: securityEvents({
          limit: Number(ctx.query.get('limit') ?? 100),
          ...(ctx.query.get('kind') ? { kind: ctx.query.get('kind') as SecurityEventKind } : {}),
        }),
      };
    },
  },

  // -------------------------------------------------------------- newsletter
  {
    method: 'GET',
    pattern: '/unsubscribe',
    public: true,
    html: true,
    description: 'Unsubscribe confirmation page reached from a signed link in an email',
    handler: (platform, ctx) => {
      const u = ctx.query.get('u') ?? '';
      const t = ctx.query.get('t') ?? '';
      const user = resolveUnsubscribe(platform, u, t);
      const consent = readConsent(platform, user.id);
      return unsubscribePage({ state: consent?.subscribed === false ? 'ALREADY_OUT' : 'CONFIRM', user, u, t });
    },
  },
  {
    method: 'POST',
    pattern: '/unsubscribe',
    public: true,
    html: true,
    description: 'Act on an unsubscribe link — the form button and RFC 8058 one-click both arrive here',
    handler: (platform, ctx) => {
      const u = ctx.query.get('u') ?? '';
      const t = ctx.query.get('t') ?? '';
      const user = resolveUnsubscribe(platform, u, t);
      // The body is ignored on purpose. A mail provider posting one-click sends
      // `List-Unsubscribe=One-Click`; the browser form sends nothing. The proof
      // of intent is the signed token in the URL, which both of them carry.
      setConsent(platform, { user, subscribed: false, source: 'UNSUBSCRIBE_LINK', actorId: user.id });
      return unsubscribePage({ state: 'DONE', user, u, t });
    },
  },
  {
    method: 'GET',
    pattern: '/v1/me/newsletter',
    description: 'My own email preference and what the next issue would say',
    handler: (platform, ctx) => {
      const user = platform.user(auth(ctx).actorId);
      const consent = readConsent(platform, user.id);
      return {
        subscribed: consent ? consent.subscribed : config.newsletter.defaultSubscribed,
        decidedAt: consent?.decidedAt ?? null,
        source: consent?.source ?? 'DEFAULT',
        // Stated rather than implied: a role can be excluded while consent says yes.
        excludedByRole: user.roles.some((role) => config.newsletter.excludedRoles.includes(role)),
        preview: previewFor({
          userId: user.id,
          tenantId: user.tenantId,
          name: user.name,
          email: user.email,
          roles: user.roles,
        }),
      };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/me/newsletter',
    description: 'Set my own email preference',
    schema: {
      type: 'object',
      required: ['subscribed'],
      properties: { subscribed: { type: 'boolean' }, note: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const { subscribed, note } = body<{ subscribed: boolean; note?: string }>(ctx);
      const user = platform.user(auth(ctx).actorId);
      return setConsent(platform, {
        user,
        subscribed,
        source: 'PREFERENCE_PAGE',
        actorId: user.id,
        ...(note ? { note } : {}),
      });
    },
  },
  {
    method: 'GET',
    pattern: '/v1/newsletter/audience',
    description: 'Who the next issue would reach, and who it would not (platform operator only)',
    handler: (platform, ctx) => {
      operatorOnly(ctx, 'see the newsletter audience');
      const { recipients, excluded } = resolveAudience(platform);
      return {
        week: isoWeek(new Date()),
        enabled: config.newsletter.enabled,
        channel: config.smtp.host ? 'SMTP' : 'RECORD_ONLY',
        sendDayUtc: config.newsletter.sendDayUtc,
        sendHourUtc: config.newsletter.sendHourUtc,
        defaultSubscribed: config.newsletter.defaultSubscribed,
        excludedRoles: config.newsletter.excludedRoles,
        // Addresses are withheld from the summary; the delivery log is where a
        // named list belongs, behind its own read.
        recipientCount: recipients.length,
        byRole: recipients.reduce<Record<string, number>>((counts, recipient) => {
          for (const role of recipient.roles) counts[role] = (counts[role] ?? 0) + 1;
          return counts;
        }, {}),
        excluded,
      };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/newsletter/campaigns',
    description: 'Issues sent so far, newest first (platform operator only)',
    handler: (platform, ctx) => {
      operatorOnly(ctx, 'see newsletter campaigns');
      return {
        campaigns: listCampaigns(platform).map((campaign) => {
          const deliveries = deliveriesFor(platform, campaign.id);
          return {
            ...campaign,
            sent: deliveries.filter((d) => d.status === 'SENT').length,
            recorded: deliveries.filter((d) => d.status === 'RECORDED').length,
            failed: deliveries.filter((d) => d.status === 'FAILED').length,
          };
        }),
      };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/newsletter/campaigns',
    description: 'Issue this week now rather than waiting for the schedule (platform operator only)',
    schema: {
      type: 'object',
      properties: { week: { type: 'string' }, force: { type: 'boolean' } },
      additionalProperties: false,
    },
    handler: async (platform, ctx) => {
      operatorOnly(ctx, 'issue the newsletter');
      const { week, force } = body<{ week?: string; force?: boolean }>(ctx);
      const report = await issueNewsletter(platform, {
        issuedBy: auth(ctx).actorId,
        ...(week ? { week } : {}),
        ...(force ? { force } : {}),
      });
      // The deliveries carry every recipient's address; the summary does not
      // need them and the campaign screen reads them through their own route.
      const { deliveries: _deliveries, ...summary } = report;
      return summary;
    },
  },
  {
    method: 'GET',
    pattern: '/v1/newsletter/campaigns/:campaignId/deliveries',
    description: 'Per-recipient outcome for one issue (platform operator only)',
    handler: (platform, ctx) => {
      operatorOnly(ctx, 'see newsletter deliveries');
      const campaignId = ctx.params.campaignId;
      if (!campaignId) throw new NotFoundError('Campaign id missing from path');
      return { deliveries: deliveriesFor(platform, campaignId) };
    },
  },

  // ------------------------------------------------ business development
  {
    method: 'GET',
    pattern: '/v1/pipeline',
    description: 'The opportunity pipeline: what the business is chasing and what it is worth',
    handler: (platform, ctx) => business.pipeline(tenantContext(platform, ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/pipeline/criteria',
    description: 'The ten weighted factors and the bid/no-bid thresholds',
    handler: () => ({ criteria: business.QUALIFICATION_CRITERIA, thresholds: business.BID_THRESHOLDS }),
  },
  {
    method: 'GET',
    pattern: '/v1/company/profile',
    description: "The company's own verified facts — everything the radar is allowed to assert",
    handler: (platform, ctx) => radar.companyProfile(tenantContext(platform, ctx)),
  },
  {
    method: 'PUT',
    pattern: '/v1/company/profile',
    description: 'Record the company profile the radar screens against',
    schema: {
      type: 'object',
      required: ['legalName', 'turnoverMinorByYear', 'regions', 'sectors', 'valueBandMinor', 'insurances', 'accreditations', 'selfDeliveredTrades', 'capacity'],
      properties: {
        legalName: stringField,
        // At least one year, because the radar sizes what the business can carry
        // from turnover and will not invent it.
        turnoverMinorByYear: { type: 'array', minItems: 1, items: { type: 'object' } },
        netAssetsMinor: { type: 'integer' },
        workingCapitalMinor: { type: 'integer' },
        regions: { type: 'array', items: { type: 'string' } },
        sectors: { type: 'array', items: { type: 'string' } },
        cpvCodes: { type: 'array', items: { type: 'string' } },
        valueBandMinor: {
          type: 'object',
          required: ['min', 'max'],
          properties: { min: { type: 'integer', minimum: 0 }, max: { type: 'integer', minimum: 0 } },
          additionalProperties: false,
        },
        insurances: { type: 'array', items: { type: 'object' } },
        accreditations: { type: 'array', items: { type: 'string' } },
        references: { type: 'array', items: { type: 'object' } },
        selfDeliveredTrades: { type: 'array', items: { type: 'string' } },
        targetMarginPercent: { type: 'number' },
        capacity: { type: 'object' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => radar.setCompanyProfile(tenantContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/radar/run',
    description: 'Screen a batch of tender notices against the company profile',
    schema: {
      type: 'object',
      required: ['notices'],
      properties: {
        notices: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['reference', 'title', 'clientName', 'region', 'sector', 'estimatedValueMinor', 'deadline', 'scope', 'source'],
          },
        },
        today: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => radar.runRadar(tenantContext(platform, ctx), body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/briefing',
    description: 'The morning briefing — what needs a decision today, across the whole business',
    handler: (platform, ctx) =>
      morningBriefing(tenantContext(platform, ctx), {
        ...(ctx.query.get('name') ? { name: ctx.query.get('name') as string } : {}),
        ...(ctx.query.get('today') ? { today: ctx.query.get('today') as string } : {}),
      }),
  },
  {
    method: 'GET',
    pattern: '/v1/agents/fleet',
    description: 'The agent fleet by division, with each mandate',
    handler: () => ({
      divisions: AGENT_DIVISIONS.map((d) => ({
        ...d,
        agents: AGENTS.filter((a) => a.division === (d.division as AgentDivision)).map((a) => ({
          name: a.name,
          purpose: a.purpose,
          mandate: a.mandate,
        })),
      })),
    }),
  },
  {
    method: 'GET',
    pattern: '/v1/radar/latest',
    description: 'The most recent radar run, with why each opportunity was filtered out',
    handler: (platform, ctx) => ({ run: radar.latestRadarRun(tenantContext(platform, ctx)) ?? null }),
  },
  {
    method: 'GET',
    pattern: '/v1/pipeline/discipline',
    description: 'Whether the business is refusing bad work, and whether the bands predict',
    handler: (platform, ctx) => business.bidDiscipline(tenantContext(platform, ctx)),
  },

  // ------------------------------------------------- corporate project control
  {
    method: 'GET',
    pattern: '/v1/control/standard',
    description: 'The corporate control standard: four stages and every item in them',
    handler: () => ({ stages: lifecycleControl.CONTROL_STAGES, items: lifecycleControl.CONTROL_ITEMS.map(publishableControlItem) }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/control',
    description: 'This project against the standard: what is due, what is present, what is missing',
    handler: (platform, ctx) => control.projectControl(projectContext(platform, ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/control/estate',
    description: 'Every project against the same standard, and what the business is systematically missing',
    handler: (platform, ctx) => control.estateControl(tenantContext(platform, ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/lessons',
    description: 'The lessons library, across every project in the business',
    handler: (platform, ctx) =>
      control.lessonsLibrary(tenantContext(platform, ctx), {
        ...(ctx.query.get('category') ? { category: ctx.query.get('category') as control.LessonCategory } : {}),
        ...(ctx.query.get('kind') ? { kind: ctx.query.get('kind') as control.LessonKind } : {}),
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/lessons',
    description: 'Capture a lesson against the project that produced it',
    schema: {
      type: 'object',
      required: ['title', 'whatHappened', 'recommendation'],
      properties: {
        title: stringField,
        // The two minimums the engine already enforces, stated at the edge so the
        // form can say what it wants before the command is sent.
        whatHappened: { type: 'string', minLength: 20 },
        recommendation: { type: 'string', minLength: 20 },
        category: { type: 'string' },
        costImpactMinor: { type: 'integer' },
        daysImpact: { type: 'integer' },
        relatedControlItemId: { type: 'string' },
        stage: { type: 'string' },
      },
    },
    handler: (platform, ctx) => control.captureLesson(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/pipeline/supply-chain-evidence',
    description: 'What the register says about the trades an opportunity needs',
    schema: {
      type: 'object',
      required: ['trades'],
      properties: { trades: { type: 'array', minItems: 1, items: { type: 'string' } } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      business.supplyChainEvidence(tenantContext(platform, ctx), body<{ trades: string[] }>(ctx).trades ?? []),
  },
  {
    method: 'POST',
    pattern: '/v1/pipeline/opportunities',
    description: 'Register an opportunity — the head of the delivery chain',
    schema: {
      type: 'object',
      required: ['title', 'clientName', 'sectorType', 'estimatedValueMinor', 'source'],
      properties: {
        title: stringField,
        clientName: stringField,
        sectorType: { type: 'string', enum: values(SECTOR) },
        estimatedValueMinor: { type: 'integer', minimum: 0 },
        source: stringField,
        submissionDueAt: stringField,
        countryCode: stringField,
        city: stringField,
        notes: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => business.registerOpportunity(tenantContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/pipeline/opportunities/:opportunityId/qualify',
    description: 'Score an opportunity against the six weighted criteria',
    schema: {
      type: 'object',
      // The ten factors are named by the qualification criteria, and a score
      // outside 0–10 would silently skew the weighted total. The keys are checked
      // by the engine against its own criteria list rather than restated here.
      additionalProperties: { type: 'number', minimum: 0, maximum: 10 },
    },
    handler: (platform, ctx) =>
      business.qualifyOpportunity(tenantContext(platform, ctx), ctx.params.opportunityId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/pipeline/opportunities/:opportunityId/decide',
    description: 'Record the bid / no-bid decision, with its rationale',
    schema: {
      type: 'object',
      required: ['bid', 'rationale'],
      properties: { bid: { type: 'boolean' }, rationale: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      business.decideBidNoBid(tenantContext(platform, ctx), ctx.params.opportunityId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/pipeline/opportunities/:opportunityId/convert',
    description: 'Turn a won opportunity into a project, carrying the thread forward',
    schema: {
      type: 'object',
      required: ['projectName', 'portfolioId', 'assetType', 'location', 'currency', 'plannedStart', 'plannedCompletion'],
      properties: {
        projectName: stringField,
        portfolioId: stringField,
        programmeId: stringField,
        assetType: stringField,
        location: {
          type: 'object',
          required: ['continentCode', 'countryCode', 'city'],
          properties: {
            continentCode: { type: 'string', enum: values(CONTINENT) },
            countryCode: stringField,
            city: stringField,
          },
          additionalProperties: false,
        },
        // The same closed list project creation uses. An unconstrained currency is
        // a permanently broken record, because the ledger is append-only.
        currency: { type: 'string', enum: Object.keys(CURRENCIES) },
        contractValueMinor: { type: 'integer', minimum: 0 },
        plannedStart: stringField,
        plannedCompletion: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      business.convertToProject(tenantContext(platform, ctx), ctx.params.opportunityId as string, body(ctx)),
  },

  // ----------------------------------------------------------------- quality
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/quality',
    description: 'Quality position: conformance, open hold points, NCRs and snags',
    handler: (platform, ctx) => quality.qualityPosition(projectContext(platform, ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/quality/hold-points',
    description: 'Hold points that have not been released',
    handler: (platform, ctx) => ({ holdPoints: quality.openHoldPoints(projectContext(platform, ctx)) }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/quality/plans',
    description: 'Create an inspection and test plan for a work package',
    schema: {
      type: 'object',
      required: ['workPackageId', 'title', 'discipline', 'stages'],
      properties: {
        workPackageId: stringField,
        title: stringField,
        discipline: stringField,
        specificationRef: stringField,
        // Stage shape is defined by the quality engine and validated there; what
        // this pins is that the plan cannot arrive without stages at all, which is
        // an inspection plan that inspects nothing.
        stages: { type: 'array', minItems: 1, items: { type: 'object' } },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => quality.createInspectionPlan(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/quality/inspections',
    description: 'Record an inspection against an ITP stage; a failure raises an NCR',
    schema: {
      type: 'object',
      required: ['planId', 'stageReference', 'outcome', 'inspectedBy', 'comments', 'evidenceHash'],
      properties: {
        planId: stringField,
        stageReference: stringField,
        outcome: { type: 'string', enum: ['PASS', 'PASS_WITH_COMMENT', 'FAIL'] },
        inspectedBy: stringField,
        comments: { type: 'string' },
        evidenceHash: stringField,
        nonConformance: {
          type: 'object',
          required: ['description', 'severity', 'proposedAction'],
          properties: {
            description: { type: 'string', minLength: 10 },
            severity: { type: 'string', enum: ['MINOR', 'MAJOR', 'CRITICAL'] },
            proposedAction: { type: 'string', minLength: 10 },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => quality.recordInspection(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/quality/ncrs',
    description: 'Raise a non-conformance',
    schema: {
      type: 'object',
      required: ['description', 'severity', 'proposedAction', 'evidenceHash'],
      properties: {
        description: { type: 'string', minLength: 10 },
        severity: { type: 'string', enum: ['MINOR', 'MAJOR', 'CRITICAL'] },
        proposedAction: { type: 'string', minLength: 10 },
        inspectionId: stringField,
        workPackageId: stringField,
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => quality.raiseNCR(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/quality/ncrs/:ncrId/close',
    description: 'Close a non-conformance with a disposition and a justification',
    schema: {
      type: 'object',
      required: ['disposition', 'justification', 'evidenceHash'],
      properties: {
        // USE_AS_IS and REPAIR are concessions against the specification, which is
        // why the justification is not optional on any of them.
        disposition: { type: 'string', enum: ['REWORK', 'REPAIR', 'USE_AS_IS', 'REJECT'] },
        justification: { type: 'string', minLength: 10 },
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      quality.closeNCR(projectContext(platform, ctx), ctx.params.ncrId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/quality/snags/:snagId/close',
    description: 'Close a snag with photographic evidence',
    schema: {
      type: 'object',
      required: ['evidenceHash', 'note'],
      properties: { evidenceHash: stringField, note: { type: 'string', minLength: 4 } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      quality.closeSnag(projectContext(platform, ctx), ctx.params.snagId as string, body(ctx)),
  },

  // -------------------------------------------------------- supply chain
  {
    method: 'GET',
    pattern: '/v1/supply-chain/trades',
    description: 'The trade catalogue, and which trades require third-party accreditation',
    handler: () => ({ trades: supplychain.TRADES, scrutiny: supplychain.SCRUTINY_THRESHOLDS }),
  },
  {
    method: 'GET',
    pattern: '/v1/supply-chain',
    description: 'Registered suppliers, with why any of them cannot be invited',
    handler: (platform, ctx) =>
      ({ suppliers: supplychain.findSuppliers(tenantContext(platform, ctx), {
        ...(ctx.query.get('trade') ? { trade: ctx.query.get('trade') as string } : {}),
        includeIneligible: ctx.query.get('all') === 'true',
      }) }),
  },
  {
    method: 'GET',
    pattern: '/v1/supply-chain/coverage',
    description: 'Coverage across the trade catalogue, and where it is too thin to compete',
    handler: (platform, ctx) => supplychain.supplyChainCoverage(tenantContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/supply-chain/suppliers',
    description: 'Register a supplier against one or more trades',
    schema: {
      type: 'object',
      required: ['partyId', 'legalName', 'trades', 'contactName', 'contactEmail'],
      properties: {
        // The join between the register and everything downstream. Required in
        // the schema as well as in the command, so a console form that omits it
        // is refused at the door rather than at the write.
        partyId: stringField,
        legalName: stringField,
        tradingName: stringField,
        companyNumber: stringField,
        trades: { type: 'array', minItems: 1, items: { type: 'string' } },
        contactName: stringField,
        contactEmail: stringField,
        countryCode: stringField,
        regionsCovered: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => supplychain.registerSupplier(tenantContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/supply-chain/suppliers/:supplierId/prequalify',
    description: 'Assess a supplier and classify them Strategic, Approved, Conditional or Do Not Use',
    schema: {
      type: 'object',
      required: ['insurances', 'safetyAccreditations', 'qualityAccreditations', 'riddorLastThreeYears', 'capacity', 'complianceConfirmed', 'evidenceHash'],
      properties: {
        identity: { type: 'object' },
        financial: { type: 'object' },
        insurances: { type: 'array', items: { type: 'object' } },
        safetyAccreditations: { type: 'array', items: { type: 'string' } },
        qualityAccreditations: { type: 'array', items: { type: 'string' } },
        accidentFrequencyRate: { type: 'number', minimum: 0 },
        riddorLastThreeYears: { type: 'integer', minimum: 0 },
        enforcementNotices: { type: 'integer', minimum: 0 },
        ramsCapability: { type: 'object' },
        competenceCards: { type: 'array', items: { type: 'object' } },
        training: { type: 'object' },
        references: { type: 'array', items: { type: 'object' } },
        capacity: { type: 'object' },
        dayRates: { type: 'array', items: { type: 'object' } },
        coverage: { type: 'object' },
        complianceConfirmed: { type: 'boolean' },
        performance: { type: 'object' },
        evidenceHash: stringField,
        packageValueMinor: { type: 'integer', minimum: 0 },
      },
    },
    handler: (platform, ctx) =>
      supplychain.prequalifySupplier(tenantContext(platform, ctx), ctx.params.supplierId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/supply-chain/suppliers/:supplierId/suspend',
    description: 'Suspend a supplier immediately, with a reason',
    schema: {
      type: 'object',
      required: ['reason'],
      properties: { reason: { type: 'string', minLength: 4 } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      supplychain.suspendSupplier(tenantContext(platform, ctx), ctx.params.supplierId as string, body(ctx)),
  },

  // --------------------------------------------------------- framework agreements
  {
    method: 'POST',
    pattern: '/v1/frameworks/recommend',
    description: 'Size and shape a framework from turnover and what the business builds',
    schema: {
      type: 'object',
      required: ['annualTurnoverMinor', 'projectTypes'],
      properties: {
        annualTurnoverMinor: { type: 'integer', minimum: 0 },
        projectTypes: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'string',
            enum: [
              'HRB_RESIDENTIAL', 'RESIDENTIAL', 'COMMERCIAL_NEW_BUILD', 'FIT_OUT', 'REFURBISHMENT',
              'CIVILS_INFRASTRUCTURE', 'INDUSTRIAL', 'REMEDIATION', 'MAINTENANCE',
            ],
          },
        },
        additionalTrades: { type: 'array', items: { type: 'string' } },
        excludedTrades: { type: 'array', items: { type: 'string' } },
        concurrentProjects: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    handler: (_platform, ctx) => framework.recommendFramework(body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/frameworks',
    description: 'Framework agreements held by this tenant',
    handler: (platform, ctx) => ({ frameworks: framework.listFrameworks(tenantContext(platform, ctx)) }),
  },
  {
    method: 'POST',
    pattern: '/v1/frameworks',
    description: 'Create a framework agreement with lots and a call-off rule',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (platform, ctx) => framework.createFramework(tenantContext(platform, ctx), body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/frameworks/:frameworkId',
    description: 'Framework position: membership balance, thin lots, concentration and expiry',
    handler: (platform, ctx) =>
      framework.frameworkPosition(tenantContext(platform, ctx), ctx.params.frameworkId as string),
  },
  {
    method: 'POST',
    pattern: '/v1/frameworks/:frameworkId/members',
    description: 'Admit a prequalified supplier to a lot',
    schema: {
      type: 'object',
      required: ['supplierId', 'lot', 'tier'],
      properties: {
        supplierId: stringField,
        lot: stringField,
        // The tier decides how a framework is sized and balanced, so it is a
        // closed list rather than a label somebody types.
        tier: { type: 'string', enum: ['LOCAL_SME', 'SPECIALIST', 'LARGE'] },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      framework.admitToFramework(tenantContext(platform, ctx), ctx.params.frameworkId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/frameworks/:frameworkId/call-off',
    description: 'Apply the framework call-off rule to a package and return who to invite',
    schema: {
      type: 'object',
      required: ['lot', 'packageValueMinor'],
      properties: {
        lot: stringField,
        packageValueMinor: { type: 'integer', minimum: 1 },
        today: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      framework.callOff(tenantContext(platform, ctx), ctx.params.frameworkId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/frameworks/:frameworkId/awards',
    description: 'Record a framework award so rotation and concentration stay real',
    schema: {
      type: 'object',
      required: ['supplierId', 'lot', 'valueMinor', 'packageReference', 'evidenceHash'],
      properties: {
        supplierId: stringField,
        lot: stringField,
        valueMinor: { type: 'integer', minimum: 1 },
        packageReference: stringField,
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      framework.recordFrameworkAward(tenantContext(platform, ctx), ctx.params.frameworkId as string, body(ctx)),
  },

  // --------------------------------------------------------------------- CDM
  {
    method: 'GET',
    pattern: '/v1/cdm/documents',
    description: 'The CDM document catalogue and the sections each one requires',
    handler: () => ({ documents: cdm.CDM_DOCUMENTS }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/cdm',
    description: 'Principal Contractor position: the plan, inductions, talks and any visible breaches',
    handler: (platform, ctx) => cdm.principalContractorPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cdm/documents',
    description: 'Draft a project-specific CDM document, naming any section it could not fill',
    schema: {
      type: 'object',
      required: ['type', 'title'],
      properties: {
        type: {
          type: 'string',
          enum: [
            'CONSTRUCTION_PHASE_PLAN', 'RAMS', 'COSHH_ASSESSMENT', 'TEMPORARY_WORKS_DESIGN_BRIEF',
            'LIFTING_PLAN', 'WORKING_AT_HEIGHT_PLAN', 'FIRE_SAFETY_PLAN', 'EMERGENCY_ARRANGEMENTS',
            'ENVIRONMENTAL_CONTROL_PLAN', 'WORK_EQUIPMENT_REGISTER', 'SITE_INDUCTION', 'TOOLBOX_TALK',
          ],
        },
        title: stringField,
        sections: {
          type: 'array',
          items: {
            type: 'object',
            required: ['heading', 'body'],
            properties: { heading: stringField, body: { type: 'string' } },
            additionalProperties: false,
          },
        },
        workPackageId: stringField,
        // Named where an agent produced the draft, so authorship is never ambiguous.
        draftedByAgent: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => cdm.draftDocument(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cdm/documents/:documentId/approve',
    description: 'Approve a CDM document — refused while a required section is unfilled',
    schema: {
      type: 'object',
      required: ['comments'],
      properties: { comments: { type: 'string', minLength: 4 } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      cdm.approveDocument(projectContext(platform, ctx), ctx.params.documentId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cdm/inductions',
    description: 'Record a site induction',
    schema: {
      type: 'object',
      required: ['personId', 'personName', 'employer', 'inductedBy', 'competenciesChecked'],
      properties: {
        personId: stringField,
        personName: stringField,
        employer: stringField,
        inductedBy: stringField,
        competenciesChecked: { type: 'array', items: { type: 'string' } },
        documentId: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => cdm.recordInduction(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cdm/toolbox-talks',
    description: 'Record a toolbox talk and its attendance',
    schema: {
      type: 'object',
      required: ['subject', 'deliveredBy', 'keyPoints', 'attendees'],
      properties: {
        subject: stringField,
        deliveredBy: stringField,
        keyPoints: { type: 'array', minItems: 1, items: { type: 'string' } },
        attendees: { type: 'array', items: { type: 'string' } },
        documentId: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => cdm.recordToolboxTalk(projectContext(platform, ctx), body(ctx)),
  },

  // -------------------------------------------------------------------- HSEQ
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/safety/permits',
    description: 'Issue a permit to work, refused where an operative is not competent for the whole permit',
    schema: {
      type: 'object',
      required: ['activity', 'location', 'operativeIds', 'validFrom', 'validTo', 'ramsId', 'precautions', 'evidenceHash'],
      properties: {
        activity: {
          type: 'string',
          enum: ['HOT_WORK', 'CONFINED_SPACE', 'WORK_AT_HEIGHT', 'LIVE_ELECTRICAL', 'EXCAVATION', 'LIFTING_OPERATIONS'],
        },
        location: stringField,
        operativeIds: { type: 'array', minItems: 1, items: stringField },
        validFrom: stringField,
        validTo: stringField,
        ramsId: stringField,
        precautions: { type: 'string', minLength: 10 },
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => safety.issuePermit(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/safety/permit-requirements',
    description: 'Which competency each permitted activity requires',
    readOnly: true,
    handler: () => ({ requirements: safety.permitRequirements() }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/safety/position',
    description: 'Safety position: incidents, escalations, lost time and training currency',
    handler: (platform, ctx) => safety.safetyPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/safety/incidents',
    description: 'Record an incident, including whether it is RIDDOR reportable',
    schema: {
      type: 'object',
      required: ['occurredAt', 'location', 'category', 'description', 'immediateAction', 'personsInvolved', 'riddorReportable', 'evidenceHash'],
      properties: {
        occurredAt: stringField,
        location: stringField,
        category: {
          type: 'string',
          enum: ['NEAR_MISS', 'FIRST_AID', 'MINOR_INJURY', 'LOST_TIME', 'RIDDOR_REPORTABLE', 'ENVIRONMENTAL', 'DANGEROUS_OCCURRENCE'],
        },
        description: { type: 'string', minLength: 10 },
        immediateAction: { type: 'string', minLength: 4 },
        // Identities, never names. The record references a person; it does not
        // describe one.
        personsInvolved: { type: 'array', items: { type: 'string' } },
        riddorReportable: { type: 'boolean' },
        lostTimeDays: { type: 'integer', minimum: 0 },
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => safety.recordIncident(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/safety/training',
    description: 'Record completed training against a competency, with its expiry',
    schema: {
      type: 'object',
      required: ['personId', 'competency', 'provider', 'completedOn', 'certificateHash'],
      properties: {
        personId: stringField,
        competency: stringField,
        provider: stringField,
        completedOn: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        expiresOn: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        certificateHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => safety.recordTraining(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/risks/:riskId/mitigation',
    description: 'Add a mitigation to a risk and re-score the residual position',
    schema: {
      type: 'object',
      required: ['description', 'owner', 'dueBy', 'costMinor', 'probabilityReduction', 'impactReduction', 'projectValueMinor', 'projectDurationDays'],
      properties: {
        description: { type: 'string', minLength: 10 },
        owner: stringField,
        dueBy: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        costMinor: { type: 'integer', minimum: 0 },
        // Proportions, not percentages. A control removing 1.4 of a risk is a
        // typing mistake that would otherwise reach the arithmetic.
        probabilityReduction: { type: 'number', minimum: 0, maximum: 1 },
        impactReduction: { type: 'number', minimum: 0, maximum: 1 },
        projectValueMinor: { type: 'integer', minimum: 0 },
        projectDurationDays: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      safety.setRiskMitigation(projectContext(platform, ctx), ctx.params.riskId as string, body(ctx)),
  },

  // ------------------------------------------------------------------ people
  {
    method: 'POST',
    pattern: '/v1/users',
    description: 'Create a user and assign an identity seat',
    schema: {
      type: 'object',
      required: ['name', 'email', 'roles'],
      properties: {
        name: stringField,
        email: stringField,
        partyId: { type: 'string' },
        roles: { type: 'array', minItems: 1, items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      if (!actor.roles.includes('ENTERPRISE_ADMIN') && !actor.roles.includes('OWNER')) {
        throw new ForbiddenError('Only an enterprise admin may create users', 'ENTERPRISE_ADMIN_REQUIRED');
      }
      return platform.createUser({ ...body<{ name: string; email: string; roles: Parameters<typeof platform.createUser>[0]['roles']; partyId?: string }>(ctx), tenantId: actor.tenantId });
    },
  },
  {
    method: 'POST',
    pattern: '/v1/users/:userId/roles',
    description: 'Change what an identity is allowed to do, recorded against whoever changed it',
    schema: {
      type: 'object',
      required: ['roles', 'reason'],
      properties: {
        roles: { type: 'array', minItems: 1, items: { type: 'string' } },
        reason: { type: 'string', minLength: 10 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      if (!actor.roles.includes('ENTERPRISE_ADMIN') && !actor.roles.includes('OWNER')) {
        throw new ForbiddenError('Only an enterprise admin may change roles', 'ENTERPRISE_ADMIN_REQUIRED');
      }
      return platform.assignRoles(actor, {
        ...body<{ roles: Parameters<typeof platform.assignRoles>[1]['roles']; reason: string }>(ctx),
        userId: ctx.params.userId as string,
      });
    },
  },
  {
    method: 'GET',
    pattern: '/v1/ownership',
    description: 'Who owns the decision — named holders of create and approve in every capability area',
    readOnly: true,
    // The permission matrix resolves a capability; this resolves it to people.
    // An item that names no owner is an item nobody picks up, and "awaiting
    // approval" is not an owner. One call per screen rather than one per row:
    // the answer is the same for every item in an area.
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      return { areas: ownershipMap(platform.users(actor.tenantId)) };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/me/erasure',
    description: 'Whether an erasure is outstanding for the signed-in identity, and what it would and would not remove',
    readOnly: true,
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      const user = platform.user(actor.actorId);
      const basis = erasure.retentionBasis();
      return {
        // Which account this is about. A confirmation screen for an
        // irreversible act has to name the thing being destroyed, and the
        // session payload does not carry the address.
        identity: { id: user.id, name: user.name, email: user.email, roles: user.roles },
        requestedAt: user.erasureRequestedAt,
        dueAt: user.erasureDueAt,
        erasedAt: user.erasedAt,
        graceDays: erasure.graceDays(),
        // Published rather than described in help text: what a person is told
        // before they press the button has to be the same thing the platform
        // will actually do, and the only way to guarantee that is to read it
        // from the code that does it.
        removed: basis.removed,
        retained: basis.retained,
        lawfulBasis: basis.lawfulBasis,
      };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/me/erasure',
    description: 'Ask for this identity to be erased. Starts the grace period; does not erase anything yet',
    schema: {
      type: 'object',
      required: ['reason'],
      properties: { reason: { type: 'string', minLength: 3 } },
      additionalProperties: false,
    },
    handler: async (platform, ctx) => {
      const actor = auth(ctx);
      const { reason } = body<{ reason: string }>(ctx);
      // Read the identity before requesting: after this the account is
      // suspended, and the notice still has to reach the real mailbox.
      const before = platform.user(actor.actorId);
      const recipient = { id: before.id, name: before.name, email: before.email, tenantId: before.tenantId };

      const requested = platform.requestErasure(actor, { userId: actor.actorId, reason });

      // Mandatory. This is the notice that lets the true owner stop an erasure
      // somebody else asked for with a stolen session, so it is not subject to
      // a preference and the catalogue enforces that.
      await notifyEngine.notify(platform, {
        code: 'privacy.account_deletion_requested',
        recipients: [recipient],
        payload: {
          actionUrl: '/app',
          actionLabel: 'Cancel this request',
          detail:
            `Your account will be erased on ${requested.dueAt.slice(0, 10)}. ` +
            `If you did not ask for this, sign in and cancel it before then. ` +
            `Your project record is kept: ${erasure.retentionBasis().lawfulBasis}`,
        },
        branding: platform.exports.branding(actor.tenantId),
        actorId: actor.actorId,
        correlationId: ctx.correlationId,
      });

      return requested;
    },
  },
  {
    method: 'DELETE',
    pattern: '/v1/me/erasure',
    description: 'Call off an outstanding erasure request and restore the identity',
    // It takes no body, and this says so rather than saying nothing. A route
    // with no schema is not validated at all, which is the debt the register in
    // vocabulary.test.ts counts; an empty closed object refuses a stray body
    // instead of ignoring it.
    schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      return platform.cancelErasure(actor, {
        userId: actor.actorId,
        reason: 'Cancelled by the account holder',
      });
    },
  },
  {
    method: 'POST',
    pattern: '/v1/users/:userId/erasure',
    description: 'Request erasure of another identity in this tenancy, on a written request from its holder',
    schema: {
      type: 'object',
      required: ['reason'],
      properties: { reason: { type: 'string', minLength: 10 } },
      additionalProperties: false,
    },
    handler: async (platform, ctx) => {
      const actor = auth(ctx);
      if (!actor.roles.includes('ENTERPRISE_ADMIN') && !actor.roles.includes('OWNER')) {
        throw new ForbiddenError('Only an enterprise admin may request erasure of another identity', 'ENTERPRISE_ADMIN_REQUIRED');
      }
      const userId = ctx.params.userId as string;
      const before = platform.user(userId);
      const recipient = { id: before.id, name: before.name, email: before.email, tenantId: before.tenantId };

      const requested = platform.requestErasure(actor, { userId, reason: body<{ reason: string }>(ctx).reason });

      await notifyEngine.notify(platform, {
        code: 'privacy.account_deletion_requested',
        recipients: [recipient],
        payload: {
          actionUrl: '/app',
          actionLabel: 'Cancel this request',
          detail:
            `An administrator has asked for your account to be erased on ${requested.dueAt.slice(0, 10)}. ` +
            'If this is wrong, sign in and cancel it before then.',
        },
        branding: platform.exports.branding(actor.tenantId),
        actorId: actor.actorId,
        correlationId: ctx.correlationId,
      });

      return requested;
    },
  },
  {
    method: 'POST',
    pattern: '/v1/console/identities',
    public: true,
    description: 'List the seeded demonstration identities so any role can be signed into',
    handler: async (platform) => {
      if (isProduction()) {
        throw new ForbiddenError('Demonstration identities are not available in production', 'DEMO_DISABLED');
      }
      const session = await getOrCreateConsoleSession(platform);
      const users = platform.users(platform.ledger.require({ refType: 'Project', refId: session.projectId }).tenantId);
      // Operators are listed alongside the delivery team but marked as a
      // different account layer, because signing in as one shows a deliberately
      // different — and much narrower — product.
      const shape = (u: { id: string; name: string; email: string; roles: readonly string[] }, layer: string) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        roles: u.roles,
        layer,
      });
      return {
        projectId: session.projectId,
        enterprise: session.enterpriseName,
        portfolio: session.portfolioName,
        identities: [
          ...users.map((u) => shape(u, u.roles.includes('ENTERPRISE_ADMIN') ? 'ENTERPRISE_ADMIN' : 'TENANT_USER')),
          ...platform.operators().map((u) => shape(u, 'PLATFORM_ADMIN')),
        ],
      };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/localisation',
    description: 'Currencies, the locale resolved from this request, and the tax rules held per jurisdiction',
    handler: (_platform, ctx) => ({
      locale: ctx.locale,
      currencies: Object.values(CURRENCIES),
      jurisdictions: Object.values(JURISDICTIONS),
      note:
        'A project\u2019s money stays in the project\u2019s currency. Only the platform\u2019s own charges are converted, ' +
        'and only where a rate has been supplied — no rate is invented.',
    }),
  },
  {
    method: 'GET',
    pattern: '/v1/billing/catalogue',
    description: 'Seat prices, packages and ACU bundles',
    handler: () => ({
      seats: Object.values(SEATS),
      packages: Object.values(PACKAGES),
      bundles: Object.values(ACU_BUNDLES),
      currency: 'GBP',
      note: 'A package is charged, not the sum of its seats. No package includes AI — ACUs are bought separately.',
    }),
  },
  {
    method: 'GET',
    pattern: '/v1/billing/seats',
    description: 'Seats held by this tenant against what the package charges',
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      const subscription = platform.subscription(actor.tenantId);
      const rolesByUser = new Map(platform.users(actor.tenantId).map((u) => [u.id, u.roles]));
      return {
        package: PACKAGES[subscription.package],
        seatsUsed: subscription.assignedIdentities.length,
        ...seatEconomics(subscription, rolesByUser),
      };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/permissions/matrix',
    description: 'The enforceable permission matrix and the phases each area may be written in',
    handler: () => ({
      matrix: PERMISSION_MATRIX,
      // Published so a client can show a command as unavailable for the reason
      // it will actually be refused, rather than duplicating the rule and
      // drifting from it.
      writePhaseGates: WRITE_PHASE_GATES,
      // Same argument, one layer further out: the installed application refuses
      // a governance action at the point of the press rather than queuing an
      // operation the sync engine will certainly reject, and showing the
      // operative an approval as "pending sync" until it does.
      neverOffline: [...FIELD_FORBIDDEN_EVENTS],
    }),
  },

  // ------------------------------------------------------------- public site
  //
  // Server-rendered rather than client-rendered, unlike the console. These
  // pages are read by people deciding whether to trust the product, by search
  // crawlers and by link previews — all of which see markup, not the script
  // that would have produced it.
  ...site.SITE_PAGES.map((definition) => ({
    method: 'GET' as const,
    pattern: definition.path,
    public: true,
    html: true,
    htmlPolicy: 'PUBLIC_SITE' as const,
    description: `Public site — ${definition.label}`,
    handler: (platform: Platform, ctx: RequestContext) => site.render(definition.path, platform, ctx),
  })),

  // Blog posts, each at its own address. Registered separately from
  // `SITE_PAGES` because that list also drives the navigation and the footer,
  // and engineering notes belong in neither — they are reached from the blog
  // index and from links people share. Their own URLs are also the only way
  // anything can count them: every measurement tool counts pages, not cards.
  ...POST_PAGES.map((post) => ({
    method: 'GET' as const,
    pattern: post.path,
    public: true,
    html: true,
    htmlPolicy: 'PUBLIC_SITE' as const,
    description: `Blog — ${post.title}`,
    handler: (platform: Platform, ctx: RequestContext) => site.render(post.path, platform, ctx),
  })),

  // ------------------------------------------------------------------ signup
  {
    method: 'GET',
    pattern: '/v1/signup/account-types',
    public: true,
    description: 'Every account type, what it includes, and whether it is self-serve',
    handler: () => ({
      accountTypes: signup.accountTypes(),
      currencies: Object.values(CURRENCIES),
      jurisdictions: Object.values(JURISDICTIONS),
      note:
        'Enterprise is provisioned with an agreement rather than a form. Selecting it registers an enquiry.',
    }),
  },
  {
    method: 'POST',
    pattern: '/v1/signup',
    public: true,
    description: 'Begin a registration. Answers identically whether or not the address is already in use',
    schema: {
      type: 'object',
      required: ['email', 'contactName', 'organisationName', 'jurisdiction', 'currency', 'package'],
      properties: {
        email: { type: 'string', minLength: 3, maxLength: 254 },
        contactName: { type: 'string', minLength: 2, maxLength: 120 },
        organisationName: { type: 'string', minLength: 2, maxLength: 200 },
        jurisdiction: { type: 'string', enum: Object.keys(JURISDICTIONS) },
        currency: { type: 'string', enum: Object.keys(CURRENCIES) },
        package: { type: 'string', enum: signup.SELF_SERVE_PACKAGES },
      },
      additionalProperties: false,
    },
    handler: async (platform, ctx) => {
      const input = body<Parameters<typeof signup.register>[1]>(ctx);
      const started = signup.register(platform, input);

      // Both branches send mail. The branch that found an existing account
      // tells its owner that one exists rather than creating a second — which
      // is the only way to warn the real owner without telling the caller
      // whether the address is registered.
      const recipient = {
        id: `registration:${started.registration?.id ?? 'existing'}`,
        name: input.contactName,
        email: input.email,
        tenantId: 'platform',
      };

      if (started.outcome === 'NEW' && started.registration && started.token) {
        await notifyEngine.notify(platform, {
          code: 'account.registration.requested',
          recipients: [recipient],
          payload: {
            enterprise: input.organisationName,
            actionUrl: signup.verificationUrl(started.registration.id, started.token),
            actionLabel: 'Confirm your account',
            detail:
              `Confirm this address to finish setting up ${input.organisationName}. ` +
              `The link is good for ${signup.VERIFICATION_TTL_MINUTES / 60} hours.`,
          },
          branding: PLATFORM_BRANDING,
          actorId: 'signup',
          correlationId: ctx.correlationId,
        });
      } else {
        await notifyEngine.notify(platform, {
          code: 'account.registration.received',
          recipients: [recipient],
          payload: {
            actionUrl: '/app',
            actionLabel: 'Sign in',
            detail:
              'An account already exists for this address, so no new one was created. ' +
              'If this was you, sign in. If it was not, you can ignore this message — nothing has changed.',
          },
          branding: PLATFORM_BRANDING,
          actorId: 'signup',
          correlationId: ctx.correlationId,
        });
      }

      return started.receipt;
    },
  },
  {
    method: 'POST',
    pattern: '/v1/signup/verify',
    public: true,
    description: 'Prove the address and provision the tenancy. Returns an account, never a session',
    schema: {
      type: 'object',
      required: ['registrationId', 'token'],
      properties: { registrationId: stringField, token: stringField },
      additionalProperties: false,
    },
    handler: async (platform, ctx) => {
      const { registrationId, token } = body<{ registrationId: string; token: string }>(ctx);
      const { activation, email } = await activateRegistration(platform, ctx, registrationId, token);

      // Deliberately no tokens. Completing a registration produces an account,
      // not a session — the person signs in through /v1/auth/login and MFA like
      // any other client. Returning a token here would rebuild the anonymous
      // login hole through a different door.
      return {
        status: 'VERIFIED',
        enterpriseName: activation.enterpriseName,
        email,
        signInPath: '/app',
        message: 'Your account is ready. Sign in with this address to continue.',
      };
    },
  },
  {
    method: 'GET',
    pattern: '/verify',
    public: true,
    html: true,
    description: 'The landing page for the confirmation link in a signup email. Renders a button; provisions nothing',
    handler: (_platform, ctx) =>
      // No validation of r and t here, and no lookup. Telling a caller at this
      // point that an id is unknown would turn the page into the enumeration
      // oracle that `identity/signup.ts` exists to avoid; a wrong link simply
      // fails on the press, like a right link with a spent token.
      verificationPage({ state: 'CONFIRM', r: ctx.query.get('r') ?? '', t: ctx.query.get('t') ?? '' }),
  },
  {
    method: 'POST',
    pattern: '/verify',
    public: true,
    html: true,
    description: 'Act on a confirmation link — provisions the tenancy and renders the outcome as a page',
    handler: async (platform, ctx) => {
      const r = ctx.query.get('r') ?? '';
      const t = ctx.query.get('t') ?? '';
      try {
        const { activation, email } = await activateRegistration(platform, ctx, r, t);
        return verificationPage({ state: 'DONE', r, t, organisation: activation.enterpriseName, email });
      } catch (error) {
        // Rendered as a page rather than rethrown. The error handler answers
        // problem+json, which is right for an API client and useless to someone
        // who clicked a link in Outlook and would be shown raw JSON. The
        // message is the domain error's own — expired, superseded, already
        // verified — because each has a different next step.
        if (error instanceof DomainError || error instanceof NotFoundError) {
          return verificationPage({ state: 'FAILED', r, t, reason: error.message });
        }
        throw error;
      }
    },
  },

  // ----------------------------------------------------------- notifications
  {
    method: 'GET',
    pattern: '/v1/notifications/catalogue',
    description: 'The communication event catalogue — 177 events, 15 categories, channel coverage',
    handler: (_platform, ctx) => {
      // Readable by any authenticated identity: a person is entitled to know
      // what the platform may send them before being asked to set preferences
      // about it. It carries no tenant data — only the catalogue itself.
      auth(ctx);
      return {
        events: NOTIFICATION_EVENTS,
        categories: CATEGORIES.map((code) => ({
          code,
          title: CATEGORY_TITLES[code],
          events: notifications.eventsInCategory(code).length,
        })),
        channels: notifyEngine.channelStatus(),
        coverage: notifications.channelCoverage(),
        mandatory: notifications.mandatoryEvents().length,
        totals: { events: NOTIFICATION_EVENTS.length, categories: CATEGORIES.length },
      };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/notifications/deliveries',
    description: 'Every event × channel × recipient with its delivery status',
    handler: (platform, ctx) => {
      // ENTERPRISE_STRUCTURE, not PLATFORM_ADMINISTRATION: these are the
      // tenant's own outbound messages to its own people. The platform
      // operator's area would have made this an operator screen and locked the
      // administrator who actually needs it out of their own delivery log.
      const actor = authoriseTenant(ctx, 'ENTERPRISE_STRUCTURE', 'R');
      return {
        deliveries: notifyEngine.deliveries(platform, actor.tenantId, 100),
        totals: notifyEngine.deliveryTotals(platform, actor.tenantId),
        tenantId: actor.tenantId,
      };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/notifications/inbox',
    description: 'The caller’s own in-app notifications',
    readOnly: true,
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      return { messages: notifyEngine.inbox(platform, actor.tenantId, actor.actorId, 60) };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/notifications/preferences',
    description: 'The caller’s notification preferences, and which of them are switchable',
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      return {
        matrix: preferences.preferenceMatrix(platform, actor.actorId),
        categories: CATEGORY_TITLES,
        // Stated so the screen does not have to infer it, and cannot render a
        // live control for a notice that ignores it.
        note:
          'Mandatory notices — security, payment, compliance and data-protection facts — are sent regardless of these settings.',
      };
    },
  },
  {
    method: 'PUT',
    pattern: '/v1/notifications/preferences',
    description: 'Set the caller’s notification preferences',
    schema: {
      type: 'object',
      required: ['muted'],
      properties: { muted: { type: 'object' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      // A person sets their own preferences and nobody else's. There is no
      // route that takes a userId, so an administrator cannot mute somebody
      // else's alerts.
      const actor = auth(ctx);
      const { muted } = body<{ muted: Record<string, Record<string, boolean>> }>(ctx);
      return preferences.setPreferences(platform, {
        userId: actor.actorId,
        tenantId: actor.tenantId,
        muted: muted as never,
        updatedBy: actor.actorId,
        correlationId: ctx.correlationId,
      });
    },
  },
  {
    method: 'POST',
    pattern: '/v1/notifications/preview',
    description: 'Render the branded email a recipient would receive for one event',
    readOnly: true,
    schema: {
      type: 'object',
      required: ['code'],
      properties: { code: stringField, payload: { type: 'object' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const actor = authoriseTenant(ctx, 'ENTERPRISE_STRUCTURE', 'R');
      const { code, payload } = body<{ code: string; payload?: Record<string, unknown> }>(ctx);
      const user = platform.user(actor.actorId);
      return notificationRender.previewNotification({
        event: notifications.requireEvent(code),
        recipient: { id: user.id, name: user.name, email: user.email },
        payload: payload ?? {},
        branding: platform.exports.branding(actor.tenantId),
      });
    },
  },
  {
    method: 'POST',
    pattern: '/v1/notifications/test',
    description: 'Fire one event to the caller across its channels',
    schema: {
      type: 'object',
      required: ['code'],
      properties: { code: stringField, payload: { type: 'object' } },
      additionalProperties: false,
    },
    handler: async (platform, ctx) => {
      // Deliberately only ever to the caller. A route that took a recipient
      // would be a way to make the platform send arbitrary branded mail to an
      // arbitrary address, which is a spam relay with an audit trail.
      const actor = authoriseTenant(ctx, 'ENTERPRISE_STRUCTURE', 'R');
      const { code, payload } = body<{ code: string; payload?: Record<string, unknown> }>(ctx);
      const user = platform.user(actor.actorId);

      return notifyEngine.notify(platform, {
        code,
        recipients: [{ id: user.id, name: user.name, email: user.email, tenantId: user.tenantId }],
        payload: payload ?? {},
        branding: platform.exports.branding(actor.tenantId),
        actorId: actor.actorId,
        correlationId: ctx.correlationId,
      });
    },
  },

  // ----------------------------------------------------------------- console
  {
    method: 'POST',
    pattern: '/v1/console/session',
    public: true,
    description: 'Bootstrap a console session against the seeded demonstration project',
    handler: async (platform) => {
      // This route returns a usable access token to an anonymous caller. That
      // is correct for a demonstration and is an authentication bypass in
      // production — anyone who could reach the origin held a PM identity for
      // the asking, with no credential and no MFA. Its sibling
      // /v1/console/identities already carried this gate; this one did not.
      if (isProduction()) {
        throw new ForbiddenError('Demonstration sessions are not available in production', 'DEMO_DISABLED');
      }

      // The console is a demonstration surface: on first call it seeds a full
      // lifecycle so there is something real to look at, then reuses it.
      const session = await getOrCreateConsoleSession(platform);
      const project = platform.ledger.require({ refType: 'Project', refId: session.projectId });
      const tokens = platform.login(session.email).tokens;
      return {
        accessToken: tokens.accessToken,
        expiresIn: tokens.expiresIn,
        projectId: session.projectId,
        project: project.state,
        enterprise: session.enterpriseName,
        portfolio: session.portfolioName,
        actor: session.email,
      };
    },
  },

  {
    method: 'GET',
    pattern: '/v1/enterprise/command',
    description: 'The portfolio position across every project in the tenancy, computed from the ledger',
    readOnly: true,
    handler: (platform, ctx) =>
      portfolio.enterpriseCommand(
        // Enterprise scope, on the tenant governance pseudo-project. Not any
        // one project's context: a view across the estate is a governance
        // capability, not the sum of project-level access.
        platform.context(auth(ctx), `${auth(ctx).tenantId}-governance`, { correlationId: ctx.correlationId }),
      ),
  },
  {
    method: 'GET',
    pattern: '/v1/enterprise/forecast',
    description: 'Completion confidence across the estate — how many projects miss their date at P80',
    readOnly: true,
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      // The simulation is injected rather than imported by the domain module,
      // so portfolio.ts stays free of the planning engine and of the platform
      // needed to build a per-project context. Each project is simulated under
      // its own context, so a project the caller cannot read the programme of
      // is refused there and reported as not simulated — not silently included.
      return portfolio.portfolioForecast(
        platform.context(actor, `${actor.tenantId}-governance`, { correlationId: ctx.correlationId }),
        (projectId, iterations, contractualDurationDays) =>
          planning.simulateProgramme(
            platform.context(actor, projectId, { correlationId: ctx.correlationId }),
            { iterations, contractualDurationDays },
          ),
        ctx.query.get('iterations') ? Number(ctx.query.get('iterations')) : undefined,
      );
    },
  },
  {
    method: 'GET',
    pattern: '/v1/enterprise/changes',
    description: 'What changed across the tenancy in a window, grouped and counted',
    readOnly: true,
    // Seven days by default because that is the period a portfolio review
    // covers. Counted rather than listed: every event in a tenancy for a week
    // is thousands of rows and answers nothing.
    handler: (platform, ctx) => {
      const to = ctx.query.get('to') ?? new Date().toISOString();
      const from =
        ctx.query.get('from') ?? new Date(Date.parse(to) - 7 * 86_400_000).toISOString();
      return portfolio.changeWindow(
        platform.context(auth(ctx), `${auth(ctx).tenantId}-governance`, { correlationId: ctx.correlationId }),
        from,
        to,
      );
    },
  },

  // --------------------------------------------------------------- structure
  {
    method: 'POST',
    pattern: '/v1/portfolios',
    description: 'Create a portfolio',
    schema: {
      type: 'object',
      required: ['name', 'enterpriseId', 'governanceModel'],
      properties: {
        name: stringField,
        enterpriseId: stringField,
        governanceModel: stringField,
        continentCode: { type: 'string', enum: values(CONTINENT) },
        countryCode: { type: 'string', minLength: 2, maxLength: 2 },
        city: { type: 'string' },
        targets: { type: 'object' },
        riskAppetite: { type: 'object' },
        reportingCadence: { type: 'string', enum: ['WEEKLY', 'FORTNIGHTLY', 'MONTHLY'] },
        standardCalendar: { type: 'object' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      structure.createPortfolio(
        platform.context(auth(ctx), `${auth(ctx).tenantId}-governance`, { correlationId: ctx.correlationId }),
        body(ctx),
      ),
  },
  {
    method: 'GET',
    pattern: '/v1/enterprises',
    description: 'List enterprises for the tenant',
    // `POST /v1/portfolios` requires an `enterpriseId` and nothing published
    // one, so the console could read the estate and not add to it: the only
    // place the id appeared was inside a portfolio that already existed. The
    // same `listByTenant` scoping as every other read on this page.
    handler: (platform, ctx) => ({
      enterprises: platform.ledger.listByTenant(auth(ctx).tenantId, 'Enterprise').map((r) => r.state),
    }),
  },
  {
    method: 'GET',
    pattern: '/v1/portfolios',
    description: 'List portfolios for the tenant',
    handler: (platform, ctx) => ({
      portfolios: platform.ledger.listByTenant(auth(ctx).tenantId, 'Portfolio').map((r) => r.state),
    }),
  },
  {
    method: 'POST',
    pattern: '/v1/programmes',
    description: 'Create a programme within a portfolio',
    schema: {
      type: 'object',
      required: ['portfolioId', 'name', 'objective'],
      properties: { portfolioId: stringField, name: stringField, objective: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      structure.createProgramme(
        platform.context(auth(ctx), `${auth(ctx).tenantId}-governance`, { correlationId: ctx.correlationId }),
        body(ctx),
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects',
    description: 'Create a project',
    schema: {
      type: 'object',
      required: ['portfolioId', 'name', 'sectorType', 'assetType', 'location', 'contractValueMinor', 'currency', 'plannedStart', 'plannedCompletion'],
      properties: {
        portfolioId: stringField,
        programmeId: { type: 'string' },
        name: stringField,
        // From the shared vocabulary, so the picker the browser renders and the
        // enum this validates against are the same bytes rather than two lists
        // that happen to agree.
        sectorType: { type: 'string', enum: values(SECTOR) },
        assetType: stringField,
        // Same argument as `currency` below, one field earlier. This was an
        // unvalidated object, so `continentCode` accepted `EU`, `Europe`,
        // `europe` and `eu` in one tenancy and no estate view could group on
        // it. The ledger is append-only, so each of those is permanent.
        location: {
          type: 'object',
          required: ['continentCode', 'countryCode', 'city'],
          properties: {
            continentCode: { type: 'string', enum: values(CONTINENT) },
            countryCode: { type: 'string', minLength: 2, maxLength: 2 },
            city: stringField,
            coordinates: {
              type: 'object',
              required: ['lat', 'lng'],
              properties: {
                lat: { type: 'number', minimum: -90, maximum: 90 },
                lng: { type: 'number', minimum: -180, maximum: 180 },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        contractValueMinor: { type: 'integer', minimum: 0 },
        // Constrained to the currencies the platform actually counts in. It was
        // an unconstrained string, and a project created with a currency code
        // that does not exist is not a bad field — it is a permanently broken
        // record. The ledger is append-only, so the value cannot be corrected,
        // and every read that formats money against it raises CurrencyError.
        // Verified against a running server before this was changed:
        // currency "not-a-currency" was accepted and the project created.
        currency: { type: 'string', enum: Object.keys(CURRENCIES) },
        plannedStart: stringField,
        plannedCompletion: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      // A project is created against its own id, so the very first event of the
      // project's chain is the project's creation.
      const projectId = undefined;
      return structure.createProject(
        platform.context(actor, `${actor.tenantId}-governance`, { correlationId: ctx.correlationId }),
        { ...body<Parameters<typeof structure.createProject>[1]>(ctx), projectId },
      );
    },
  },
  {
    method: 'GET',
    pattern: '/v1/projects',
    description: 'List projects for the tenant',
    handler: (platform, ctx) => ({
      projects: platform.ledger.listByTenant(auth(ctx).tenantId, 'Project').map((r) => r.state),
    }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId',
    description: 'Project detail with lifecycle gate status',
    handler: (platform, ctx) => {
      const context = projectContext(platform, ctx);
      const project = platform.ledger.require({ refType: 'Project', refId: ctx.params.projectId as string });
      return { project: project.state, gate: structure.evaluateCurrentGate(context) };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/phase',
    description: 'Transition the project to another lifecycle phase',
    schema: {
      type: 'object',
      required: ['to', 'justification'],
      properties: { to: { type: 'string', enum: LIFECYCLE_ORDER }, justification: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) => structure.transitionPhase(projectContext(platform, ctx), body(ctx)),
  },
  // ------------------------------------------- stage instances and gate reviews
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/stages',
    description: 'Every stage this project has occupied, what was frozen at each, and what is open now',
    handler: (platform, ctx) => {
      const engineCtx = projectContext(platform, ctx);
      const current = stages.currentStage(engineCtx);
      return {
        current: current ?? null,
        // Named separately from `current.openActions` because this is the
        // question people actually ask at a gate — what have we been carrying,
        // and since when — and burying it inside the stage makes it a lookup.
        openActions: ((current?.openActions as unknown[]) ?? []).filter(
          (a) => (a as { status: string }).status === 'OPEN',
        ),
        history: stages.stageInstances(engineCtx),
        gateReviews: stages.gateReviews(engineCtx),
      };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/stages/gate',
    description: 'Submit the current stage for gate review. Answers NOT_READY with the blockers rather than refusing',
    schema: {
      type: 'object',
      required: ['comments'],
      properties: { comments: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) => stages.submitForGate(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/stages/gate/:gateReviewId/decision',
    description: 'Decide a submitted gate. Approving freezes the outgoing baseline and transitions the project',
    schema: {
      type: 'object',
      required: ['result', 'authorityBasis', 'comments'],
      properties: {
        result: { type: 'string', enum: ['APPROVED', 'APPROVED_WITH_ACTIONS', 'REJECTED'] },
        // Not free text for its own sake: this is the delegation or role the
        // approver is acting under, and a decision that cannot name one is a
        // decision nobody can defend three years later.
        authorityBasis: stringField,
        comments: stringField,
        to: { type: 'string', enum: LIFECYCLE_ORDER },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['description', 'ownerId', 'dueDate'],
            properties: { description: stringField, ownerId: stringField, dueDate: stringField },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      stages.decideGate(projectContext(platform, ctx), {
        gateReviewId: ctx.params.gateReviewId!,
        ...body<Omit<Parameters<typeof stages.decideGate>[1], 'gateReviewId'>>(ctx),
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/stages/reopen',
    description: 'Re-enter a stage already left. Supersedes the live instance; the approved one is never rewritten',
    schema: {
      type: 'object',
      required: ['phase', 'reason', 'scope'],
      properties: {
        phase: { type: 'string', enum: LIFECYCLE_ORDER },
        reason: stringField,
        scope: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => stages.reopenStage(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/stages/actions/:actionId/close',
    description: 'Close a condition a gate attached to its approval',
    schema: {
      type: 'object',
      required: ['evidenceNote'],
      properties: { evidenceNote: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      stages.closeAction(projectContext(platform, ctx), {
        actionId: ctx.params.actionId!,
        ...body<{ evidenceNote: string }>(ctx),
      }),
  },
  {
    method: 'GET',
    pattern: '/v1/lifecycle/gates',
    description: 'The lifecycle phases and their exit criteria',
    handler: () => ({
      phases: LIFECYCLE_ORDER,
      gates: PHASE_GATES.map((g) => ({
        phase: g.phase,
        purpose: g.purpose,
        exitCriteria: g.exitCriteria.map((c) => ({ id: c.id, description: c.description, entity: c.requires.refType })),
      })),
    }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/packages',
    description: 'Define a scope package',
    schema: {
      type: 'object',
      required: ['name', 'discipline', 'scopeOfWorks', 'inclusions', 'exclusions', 'acceptanceCriteria', 'estimatedValueMinor', 'designResponsibility'],
      properties: {
        name: stringField,
        discipline: stringField,
        scopeOfWorks: { type: 'string', minLength: 10 },
        // Inclusions and exclusions are required and may be empty. An empty list is
        // a statement that nothing is excluded; an absent one is a package whose
        // boundary nobody has thought about, and the two are argued over later.
        inclusions: { type: 'array', items: { type: 'string' } },
        exclusions: { type: 'array', items: { type: 'string' } },
        acceptanceCriteria: { type: 'array', items: { type: 'string' } },
        estimatedValueMinor: { type: 'integer', minimum: 0 },
        designResponsibility: { type: 'string', enum: ['CLIENT', 'CONTRACTOR', 'SHARED'] },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => structure.createScopePackage(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design-maturity',
    description: 'Assess design maturity for a package',
    schema: {
      type: 'object',
      required: ['packageId', 'disciplineScores', 'informationGaps', 'assessorNotes'],
      properties: {
        packageId: stringField,
        disciplineScores: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['discipline', 'ribaStage', 'completenessPercent', 'frozen'],
            properties: {
              discipline: stringField,
              ribaStage: { type: 'integer', minimum: 0, maximum: 7 },
              completenessPercent: { type: 'number', minimum: 0, maximum: 100 },
              frozen: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
        informationGaps: { type: 'array', items: { type: 'string' } },
        assessorNotes: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => structure.assessDesignMaturity(projectContext(platform, ctx), body(ctx)),
  },

  // ------------------------------------------------------------- entity read
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/entities/:refType',
    description: 'List materialised entities of a type within a project',
    handler: (platform, ctx) => {
      // This endpoint can return any record in the system, so it has to apply
      // the same capability and sensitivity rules the typed endpoints do —
      // otherwise it is a way around every one of them.
      const actor = auth(ctx);
      const projectId = ctx.params.projectId as string;
      const refType = ctx.params.refType as string;

      const classification = classifyEntity(refType);
      if (!classification) {
        throw new NotFoundError(`No entity type named ${refType}`);
      }

      const decision = evaluateAccess(
        actor,
        classification.area,
        'R',
        { tenantId: actor.tenantId, projectId, dataSensitivity: classification.sensitivity },
        AUTHZ_OPTIONS,
      );

      // A REDACT verdict is a refusal here: there is no partial view of a list
      // of commercial records worth returning, and returning the shells would
      // still leak how many exist.
      if (decision.decision !== 'ALLOW') {
        throw new ForbiddenError(decision.reason ?? 'Not permitted', 'ACCESS_DENIED');
      }

      return {
        entities: platform.ledger
          .list(projectId, refType)
          .filter((r) => r.tenantId === actor.tenantId)
          .map((r) => ({ refId: r.refId, version: r.version, stateHash: r.stateHash, state: r.state })),
      };
    },
  },

  // ----------------------------------------------------------------- engines
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender/takeoff',
    ai: { engine: 'TENDER', taskType: 'quantity_extraction', capability: 'PERCEPTION' },
    description: 'Engine A — run a take-off and create BoQ items',
    schema: {
      type: 'object',
      required: ['packageId', 'sources', 'items', 'costCodePrefix'],
      properties: {
        packageId: stringField,
        sources: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['discipline'],
            properties: {
              discipline: stringField,
              sheetId: stringField,
              drawingRef: { type: 'object' },
              modelRef: { type: 'object' },
            },
          },
        },
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['description', 'unit', 'quantity'],
            properties: {
              description: stringField,
              unit: stringField,
              quantity: { type: 'number' },
              // Where the quantity came from. Traceability back to the sheet is
              // what separates a measured item from an assertion.
              sourceSheet: stringField,
              measurementRule: stringField,
            },
            additionalProperties: false,
          },
        },
        costCodePrefix: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => tender.runTakeoff(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender/estimate',
    description: 'Engine A — build a bottom-up estimate across the twenty tender cost heads',
    schema: {
      type: 'object',
      required: ['packageId', 'durationWeeks', 'lines', 'margin'],
      properties: {
        packageId: stringField,
        durationWeeks: { type: 'integer', minimum: 1 },
        // The twenty cost heads are a large nested shape owned by the cost model,
        // which validates each head as it prices it and refuses a head that is
        // neither priced nor excluded. Declared open here rather than restated:
        // a copy of that shape in two places is the drift this schema exists to
        // prevent.
        lines: { type: 'array', minItems: 1, items: { type: 'object' } },
        timeRelated: { type: 'array', items: { type: 'object' } },
        quantified: { type: 'array', items: { type: 'object' } },
        fees: { type: 'array', items: { type: 'object' } },
        insurance: { type: 'object' },
        risks: { type: 'array', items: { type: 'object' } },
        contingencyBasis: { type: 'string', enum: ['EXPECTED', 'P80'] },
        inflation: { type: 'object' },
        margin: { type: 'object' },
        exclusions: { type: 'array', items: { type: 'object' } },
      },
    },
    handler: (platform, ctx) => tender.buildEstimate(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/tender/cost-heads',
    description: 'The twenty tender cost heads and the basis each one is priced on',
    handler: () => ({ heads: costModel.COST_HEADS }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender/estimate/:estimateId/reprice',
    description: 'Engine A — what the estimate becomes on a different programme',
    schema: {
      type: 'object',
      required: ['durationWeeks'],
      properties: { durationWeeks: { type: 'integer', minimum: 1 } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      tender.repriceEstimate(
        projectContext(platform, ctx),
        ctx.params.estimateId as string,
        body<{ durationWeeks: number }>(ctx).durationWeeks,
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender/response',
    ai: { engine: 'TENDER', taskType: 'tender_response', capability: 'REASONING' },
    description: 'Engine A — price a client enquiry and draft the tender response',
    schema: {
      type: 'object',
      required: ['enquiry', 'estimate'],
      properties: {
        enquiry: {
          type: 'object',
          required: ['clientReference', 'clientName', 'projectTitle', 'contractForm', 'returnBy', 'scopeNarrative', 'documents'],
        },
        estimate: { type: 'object', required: ['packageId', 'durationWeeks', 'lines', 'margin'] },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => tender.respondToTender(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender/itt',
    description: 'Analyse an invitation to tender: compliance matrix and commercial terms',
    schema: {
      type: 'object',
      required: ['reference', 'clientName', 'returnBy', 'estimatedValueMinor', 'durationWeeks', 'requirements', 'terms'],
      properties: {
        reference: stringField,
        clientName: stringField,
        returnBy: stringField,
        estimatedValueMinor: { type: 'integer', minimum: 0 },
        durationWeeks: { type: 'integer', minimum: 1 },
        requirements: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['reference', 'category', 'requirement', 'mandatory', 'evidenceRequired'],
            properties: {
              reference: stringField,
              category: stringField,
              requirement: { type: 'string' },
              mandatory: { type: 'boolean' },
              weightingPercent: { type: 'number', minimum: 0, maximum: 100 },
              evidenceRequired: { type: 'string' },
              dueBy: stringField,
            },
            additionalProperties: false,
          },
        },
        // The commercial terms carry optional fields whose absence is meaningful —
        // no stated bond is different from a bond of zero — so the shape is open
        // and the analyser reports what was not stated.
        terms: { type: 'object' },
        targetMarginPercent: { type: 'number' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => itt.analyseITT(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/cost-intelligence',
    description: "Unit rates and package outturns from the business's own committed records",
    handler: (platform, ctx) =>
      costintel.costIntelligence(tenantContext(platform, ctx), {
        ...(ctx.query.get('unit') ? { unit: ctx.query.get('unit') as string } : {}),
        ...(ctx.query.get('search') ? { search: ctx.query.get('search') as string } : {}),
      }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/tender/estimate/:estimateId/benchmark',
    description: "Compare an estimate against the business's own price history",
    handler: (platform, ctx) =>
      costintel.benchmarkEstimate(projectContext(platform, ctx), ctx.params.estimateId as string),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender/estimate/:estimateId/funding',
    description: 'Peak funding requirement for this tender, against available working capital',
    schema: {
      type: 'object',
      required: ['payment', 'supply', 'vat'],
      properties: {
        payment: {
          type: 'object',
          required: ['applicationDayOfMonth', 'paymentNoticeDays', 'payLessNoticeDaysBeforeFinal', 'finalDateDays'],
        },
        supply: {
          type: 'object',
          required: ['subcontractorPaymentDays', 'materialSupplierPaymentDays', 'materialsDepositPercent', 'materialsDepositLeadWeeks', 'plantPaymentDays'],
        },
        vat: { type: 'object', required: ['ratePercent', 'reverseCharge', 'returnIntervalWeeks', 'settlementLagWeeks'] },
        // Spent before anybody is productive: hoarding, cabins, bonds, deposits.
        mobilisationMinor: { type: 'integer', minimum: 0 },
        availableWorkingCapitalMinor: { type: 'integer', minimum: 0 },
        durationWeeks: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      tender.modelTenderFunding(projectContext(platform, ctx), ctx.params.estimateId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender/estimate/:estimateId/freeze',
    description: 'Engine A — freeze the estimate',
    schema: {
      type: 'object',
      required: ['reason'],
      properties: { reason: { type: 'string', minLength: 4 } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      tender.freezeEstimate(projectContext(platform, ctx), ctx.params.estimateId as string, body<{ reason: string }>(ctx).reason),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender/package',
    ai: { engine: 'TENDER', taskType: 'package_composition', capability: 'REASONING' },
    description: 'Engine A — compose a tender package',
    schema: {
      type: 'object',
      required: ['rfqId', 'packageId', 'scopeNarrative', 'designResponsibilityMatrix', 'attendances', 'paymentTerms', 'documents'],
      properties: {
        rfqId: stringField,
        packageId: stringField,
        scopeNarrative: { type: 'string', minLength: 10 },
        designResponsibilityMatrix: {
          type: 'array',
          items: {
            type: 'object',
            required: ['element', 'responsibleParty'],
            properties: { element: stringField, responsibleParty: stringField },
            additionalProperties: false,
          },
        },
        attendances: { type: 'array', items: { type: 'string' } },
        paymentTerms: stringField,
        programmeRef: { type: 'object' },
        documents: { type: 'array', items: { type: 'object' } },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => tender.composeTenderPackage(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender/master-pricing',
    description: 'Engine A — consolidate every pricing route into the number that goes out',
    schema: {
      type: 'object',
      properties: { estimateId: stringField, note: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) => tender.consolidateMasterPricing(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender/returns',
    description: 'Engine A — normalise supplier returns, rank variance and raise clarifications',
    schema: {
      type: 'object',
      required: ['rfqId', 'baseline', 'returns'],
      properties: {
        rfqId: stringField,
        // Both sides are priced schedules on the same references. That is what
        // makes a variance a variance rather than two unrelated lists.
        baseline: { type: 'array', minItems: 1, items: { type: 'object' } },
        returns: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['submissionId', 'supplierName', 'lines'],
            properties: {
              submissionId: stringField,
              supplierName: stringField,
              lines: { type: 'array', items: { type: 'object' } },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    ai: { engine: 'TENDER', taskType: 'return_variance_analysis', capability: 'REASONING' },
    handler: (platform, ctx) => tender.analyseReturns(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender/evaluate',
    description: 'Engine A — evaluate bids deterministically',
    schema: {
      type: 'object',
      required: ['rfqId', 'submissions'],
      properties: {
        rfqId: stringField,
        submissions: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['submissionId', 'supplierPartyId', 'supplierName', 'priceMinor', 'durationDays', 'exclusions', 'contractExceptions', 'provisionalSumsMinor', 'insurancesHeld'],
            properties: {
              submissionId: stringField,
              supplierPartyId: stringField,
              supplierName: stringField,
              priceMinor: { type: 'integer', minimum: 0 },
              durationDays: { type: 'integer', minimum: 0 },
              exclusions: { type: 'array', items: { type: 'string' } },
              contractExceptions: { type: 'array', items: { type: 'string' } },
              provisionalSumsMinor: { type: 'integer', minimum: 0 },
              insurancesHeld: { type: 'array', items: { type: 'string' } },
              peakLabour: { type: 'integer', minimum: 0 },
              riskItems: { type: 'array', items: { type: 'object' } },
            },
          },
        },
        // The penalty profile decides how an exclusion is priced back in. Its
        // shape belongs to the bid-scoring maths, which validates it there.
        profile: { type: 'object' },
        designMaturityScore: { type: 'number', minimum: 0, maximum: 100 },
        packageLabourDemand: { type: 'number', minimum: 0 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => tender.evaluateSubmissions(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender/adjudicate',
    description: 'Engine A — adjudicate and select',
    schema: {
      type: 'object',
      required: ['evaluationId', 'selectedSubmissionId', 'buyoutTargetMinor', 'rationale'],
      properties: {
        evaluationId: stringField,
        selectedSubmissionId: stringField,
        buyoutTargetMinor: { type: 'integer', minimum: 0 },
        rationale: { type: 'string', minLength: 10 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => tender.adjudicate(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender/bid-pack',
    description: 'Engine A — compile and lock the bid submission pack',
    schema: {
      type: 'object',
      required: ['rfqId', 'estimateId', 'submissionLetter', 'qualifications', 'exclusions', 'prelimsNarrative', 'attachments'],
      properties: {
        rfqId: stringField,
        estimateId: stringField,
        submissionLetter: { type: 'string', minLength: 10 },
        // Both required and both allowed to be empty. "We qualified nothing" is a
        // commercial statement; a missing list is nobody having considered it.
        qualifications: { type: 'array', items: { type: 'string' } },
        exclusions: { type: 'array', items: { type: 'string' } },
        prelimsNarrative: { type: 'string' },
        attachments: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'ref'],
            properties: {
              name: stringField,
              ref: {
                type: 'object',
                required: ['refType', 'refId'],
                properties: { refType: stringField, refId: stringField },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => tender.compileBidPack(projectContext(platform, ctx), body(ctx)),
  },

  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/procurement/rfq',
    description: 'Create an RFQ (design maturity gated)',
    schema: {
      type: 'object',
      required: ['packageId', 'title', 'pricingBasis', 'returnDeadline', 'invitedSupplierIds', 'requiredInsurances', 'contractSuite'],
      properties: {
        packageId: stringField,
        title: stringField,
        pricingBasis: { type: 'string', enum: ['LUMP_SUM', 'REMEASURABLE', 'TARGET_COST', 'COST_REIMBURSABLE'] },
        returnDeadline: stringField,
        invitedSupplierIds: { type: 'array', minItems: 1, items: { type: 'string' } },
        requiredInsurances: { type: 'array', items: { type: 'string' } },
        contractSuite: stringField,
        trade: stringField,
        packageValueMinor: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => procurement.createRFQ(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/procurement/rfq/:rfqId/issue',
    description: 'Issue an RFQ to the invited supply chain',
    schema: {
      type: 'object',
      required: ['tenderPackageId'],
      properties: { tenderPackageId: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      procurement.issueRFQ(projectContext(platform, ctx), {
        rfqId: ctx.params.rfqId as string,
        tenderPackageId: body<{ tenderPackageId: string }>(ctx).tenderPackageId,
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/procurement/rfq/:rfqId/submissions',
    description: 'Receive a supplier submission',
    schema: {
      type: 'object',
      required: ['supplierPartyId', 'supplierName', 'priceMinor', 'durationDays', 'exclusions', 'contractExceptions', 'provisionalSumsMinor', 'insurancesHeld', 'submissionHash'],
      properties: {
        supplierPartyId: stringField,
        supplierName: stringField,
        priceMinor: { type: 'integer', minimum: 0 },
        durationDays: { type: 'integer', minimum: 0 },
        // Exclusions and exceptions are what make two prices incomparable, so both
        // are required — an empty list is a claim, an absent one is a gap.
        exclusions: { type: 'array', items: { type: 'string' } },
        contractExceptions: { type: 'array', items: { type: 'string' } },
        provisionalSumsMinor: { type: 'integer', minimum: 0 },
        insurancesHeld: { type: 'array', items: { type: 'string' } },
        peakLabour: { type: 'integer', minimum: 0 },
        submissionHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      procurement.receiveSubmission(projectContext(platform, ctx), { ...body<Omit<Parameters<typeof procurement.receiveSubmission>[1], 'rfqId'>>(ctx), rfqId: ctx.params.rfqId as string }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/procurement/rfq/:rfqId/reconciliation',
    readOnly: true,
    description: 'Who was invited, who answered, who returned, and who has said nothing',
    handler: (platform, ctx) =>
      procurement.reconcileTenderResponses(projectContext(platform, ctx), ctx.params.rfqId as string),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/procurement/rfq/:rfqId/award',
    description: 'Award the RFQ against an adjudication',
    schema: {
      type: 'object',
      required: ['adjudicationId', 'governanceApprovalRef', 'conditions'],
      properties: {
        // An award is made against an adjudication and a governance approval, never
        // against a price. Both are required for exactly that reason.
        adjudicationId: stringField,
        governanceApprovalRef: stringField,
        conditions: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      procurement.awardRFQ(projectContext(platform, ctx), { ...body<Omit<Parameters<typeof procurement.awardRFQ>[1], 'rfqId'>>(ctx), rfqId: ctx.params.rfqId as string }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/procurement/subcontract',
    description: 'Assemble a subcontract from the award',
    schema: {
      type: 'object',
      required: ['rfqId', 'contractSuite', 'form', 'startDate', 'completionDate', 'retentionPercent', 'paymentTermsDays'],
      properties: {
        rfqId: stringField,
        contractSuite: stringField,
        form: stringField,
        // What was actually agreed, against what was adjudicated. The delta is the
        // negotiation, and it is carried rather than lost.
        negotiatedValueMinor: { type: 'integer', minimum: 0 },
        negotiationNotes: { type: 'string' },
        startDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        completionDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        retentionPercent: { type: 'number', minimum: 0, maximum: 100 },
        paymentTermsDays: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => procurement.assembleSubcontract(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/procurement/subcontract/:subcontractId/execute',
    description: 'Execute the subcontract and raise the commitment',
    schema: {
      type: 'object',
      required: ['signedDocumentHash', 'signatureMethod', 'budgetCheckPassed'],
      properties: {
        signedDocumentHash: stringField,
        signatureMethod: stringField,
        budgetCheckPassed: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      procurement.executeSubcontract(projectContext(platform, ctx), {
        subcontractId: ctx.params.subcontractId as string,
        ...body<{ signedDocumentHash: string; signatureMethod: string; budgetCheckPassed: boolean }>(ctx),
      }),
  },

  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/programme/tasks',
    description: 'Engine B — create activities',
    schema: {
      type: 'object',
      required: ['tasks'],
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['name', 'durationDays'],
            properties: {
              id: stringField,
              activityCode: stringField,
              name: stringField,
              durationDays: { type: 'number', minimum: 0 },
              workPackageId: stringField,
              costCode: stringField,
              optimisticDays: { type: 'number', minimum: 0 },
              pessimisticDays: { type: 'number', minimum: 0 },
            },
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => ({
      taskIds: planning.createTasks(projectContext(platform, ctx), body<{ tasks: Parameters<typeof planning.createTasks>[1] }>(ctx).tasks),
    }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/programme/dependencies',
    description: 'Engine B — link activities',
    schema: {
      type: 'object',
      required: ['dependencies'],
      properties: {
        dependencies: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['predecessorId', 'successorId', 'type'],
            properties: {
              predecessorId: stringField,
              successorId: stringField,
              // Finish-to-start and its three siblings. A network built with a
              // type outside these is not a network the CPM can traverse.
              type: { type: 'string', enum: ['FS', 'SS', 'FF', 'SF'] },
              lagDays: { type: 'number' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => ({
      dependencyIds: planning.linkTasks(
        projectContext(platform, ctx),
        body<{ dependencies: Parameters<typeof planning.linkTasks>[1] }>(ctx).dependencies,
      ),
    }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/programme',
    description: 'Engine B — recalculate the programme from the network',
    handler: (platform, ctx) =>
      planning.recalculateProgramme(projectContext(platform, ctx), {
        contractualDurationDays: ctx.query.get('contractualDurationDays')
          ? Number(ctx.query.get('contractualDurationDays'))
          : undefined,
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/programme/baseline',
    description: 'Engine B — approve a baseline',
    schema: {
      type: 'object',
      required: ['version', 'reason', 'contractualCompletionDate'],
      properties: {
        version: stringField,
        reason: { type: 'string', minLength: 4 },
        contractualCompletionDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => planning.approveBaseline(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/programme/wbs',
    ai: { engine: 'PLANNING', taskType: 'wbs_generation', capability: 'REASONING' },
    description: 'Engine B — generate a work breakdown structure',
    schema: {
      type: 'object',
      required: ['projectType', 'sectorType', 'scopeNarrative', 'targetDurationDays'],
      properties: {
        projectType: stringField,
        sectorType: { type: 'string', enum: values(SECTOR) },
        scopeNarrative: { type: 'string', minLength: 10 },
        targetDurationDays: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => planning.generateWBS(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/programme/delay-forecast',
    ai: { engine: 'PLANNING', taskType: 'delay_risk_forecast', capability: 'REASONING' },
    description: 'Engine B — forecast delay risk with corrective measures',
    schema: {
      type: 'object',
      required: ['dailyPreliminariesMinor', 'contractualDurationDays'],
      properties: {
        dailyPreliminariesMinor: { type: 'integer', minimum: 0 },
        contractualDurationDays: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => planning.forecastDelay(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/programme/simulate',
    description: 'Engine B — Monte Carlo completion across the whole network, with the criticality index',
    handler: (platform, ctx) =>
      planning.simulateProgramme(projectContext(platform, ctx), {
        iterations: ctx.query.get('iterations') ? Number(ctx.query.get('iterations')) : undefined,
        contractualDurationDays: ctx.query.get('contractualDurationDays')
          ? Number(ctx.query.get('contractualDurationDays'))
          : undefined,
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/programme/what-if',
    description: 'Engine B — what-if analysis (no state change)',
    schema: {
      type: 'object',
      required: ['changes'],
      properties: {
        changes: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['taskId', 'newDurationDays'],
            properties: { taskId: stringField, newDurationDays: { type: 'number', minimum: 0 } },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      planning.whatIf(projectContext(platform, ctx), body<{ changes: Parameters<typeof planning.whatIf>[1] }>(ctx).changes),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/progress',
    description: 'Record measured progress against an activity',
    schema: {
      type: 'object',
      required: ['taskId', 'percentComplete', 'elapsedDays', 'evidenceDescription', 'evidenceHash'],
      properties: {
        taskId: stringField,
        percentComplete: { type: 'number', minimum: 0, maximum: 100 },
        elapsedDays: { type: 'number', minimum: 0 },
        quantityComplete: { type: 'number', minimum: 0 },
        evidenceDescription: stringField,
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      planning.recordProgress(projectContext(platform, ctx), body(ctx));
      return { recorded: true };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/constraints',
    description: 'Raise a constraint against an activity, with an owner and a need-by date',
    schema: {
      type: 'object',
      required: ['taskId', 'category', 'description', 'owner', 'needByDate'],
      properties: {
        taskId: stringField,
        category: { type: 'string', enum: ['DESIGN', 'MATERIALS', 'LABOUR', 'PLANT', 'ACCESS', 'PERMIT', 'PREDECESSOR', 'INFORMATION', 'APPROVAL'] },
        description: stringField,
        owner: stringField,
        needByDate: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => planning.raiseConstraint(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/constraints/:constraintId/close',
    description: 'Clear a constraint, with what cleared it',
    schema: {
      type: 'object',
      required: ['resolution'],
      properties: { resolution: { type: 'string', minLength: 10 } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      planning.closeConstraint(projectContext(platform, ctx), {
        ...body<Omit<Parameters<typeof planning.closeConstraint>[1], 'constraintId'>>(ctx),
        constraintId: ctx.params.constraintId as string,
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/lookahead',
    description: 'Publish the lookahead. Work that is still constrained cannot be committed to.',
    schema: {
      type: 'object',
      required: ['weekStarting', 'plannedTaskIds', 'commitments'],
      properties: {
        weekStarting: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        // Six is the usual window: long enough to clear a constraint, short enough
        // to mean something.
        weeks: { type: 'integer', minimum: 1, maximum: 12 },
        plannedTaskIds: { type: 'array', items: { type: 'string' } },
        commitments: { type: 'array', items: { type: 'object' } },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => planning.publishLookahead(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/lookahead/:lookaheadId/review',
    description: 'Review the week and compute Percent Plan Complete',
    schema: {
      type: 'object',
      required: ['outcomes'],
      properties: {
        outcomes: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['taskId', 'completed'],
            properties: {
              taskId: stringField,
              completed: { type: 'boolean' },
              // The reason a promise broke is what makes PPC worth measuring; the
              // engine holds the closed list and refuses one outside it.
              reason: { type: 'string' },
              note: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      planning.reviewLookahead(projectContext(platform, ctx), {
        ...body<Omit<Parameters<typeof planning.reviewLookahead>[1], 'lookaheadId'>>(ctx),
        lookaheadId: ctx.params.lookaheadId as string,
      }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/lookahead/ppc',
    description: 'The PPC trend, the recurring reason promises break, and the open constraints log',
    handler: (platform, ctx) => planning.ppcTrend(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/site-diary',
    description: 'Record the daily site diary — the contemporaneous record a delay claim stands on',
    schema: {
      type: 'object',
      required: ['diaryDate', 'weather', 'labour', 'plant', 'progressNarrative', 'evidenceHash'],
      properties: {
        diaryDate: stringField,
        weather: {
          type: 'object',
          required: ['conditions', 'workingStopped'],
          properties: {
            conditions: { type: 'string', enum: values(WEATHER_CONDITION) },
            temperatureC: { type: 'number' },
            workingStopped: { type: 'boolean' },
            hoursLost: { type: 'number', minimum: 0 },
          },
          additionalProperties: false,
        },
        labour: { type: 'array' },
        plant: { type: 'array' },
        progressNarrative: stringField,
        workedTaskIds: { type: 'array' },
        deliveries: { type: 'array' },
        blockers: { type: 'array' },
        visitors: { type: 'array' },
        safetyEvents: { type: 'array' },
        evidenceHash: stringField,
        supersedes: { type: 'string' },
        supersessionReason: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => planning.recordSiteDiary(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/site-diary/position',
    description: 'The diary as evidence: gaps, late entries, weather days lost and blocked days',
    handler: (platform, ctx) =>
      planning.diaryPosition(projectContext(platform, ctx), {
        from: ctx.query.get('from') ?? new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10),
        to: ctx.query.get('to') ?? new Date().toISOString().slice(0, 10),
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/observations',
    description: 'Capture an observation from a site walk — quality, progress, access, materials',
    schema: {
      type: 'object',
      required: ['category', 'description', 'location', 'observedBy', 'requiresAction', 'evidenceHash'],
      properties: {
        // The same list the site-walk dropdown offers, not a second copy of it.
        category: { type: 'string', enum: values(SITE_OBSERVATION_CATEGORY) },
        description: { type: 'string', minLength: 10 },
        location: stringField,
        taskId: stringField,
        observedBy: stringField,
        requiresAction: { type: 'boolean' },
        actionOwner: stringField,
        actionByDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => planning.captureSiteObservation(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/observations/:observationId/close',
    description: 'Close a site observation, saying what was done about it',
    schema: {
      type: 'object',
      required: ['actionTaken', 'closedBy'],
      properties: {
        actionTaken: { type: 'string', minLength: 10 },
        closedBy: stringField,
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      planning.closeSiteObservation(projectContext(platform, ctx), {
        ...body<Omit<Parameters<typeof planning.closeSiteObservation>[1], 'observationId'>>(ctx),
        observationId: ctx.params.observationId as string,
      }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/observations/position',
    description: 'The walk register ordered by what is overdue rather than by what is recent',
    handler: (platform, ctx) => planning.siteWalkPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/work-packages',
    description: 'Create a work package by hand, without generating a WBS',
    schema: {
      type: 'object',
      required: ['wbsCode', 'title', 'indicativeDurationDays'],
      properties: {
        wbsCode: stringField,
        title: stringField,
        parentWorkPackageId: stringField,
        indicativeDurationDays: { type: 'number', minimum: 1 },
        scopeNarrative: stringField,
        responsibleParty: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => planning.createWorkPackage(projectContext(platform, ctx), body(ctx)),
  },

  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cost/budget',
    description: 'Engine C — approve the cost baseline',
    schema: {
      type: 'object',
      required: ['version', 'byCostCode', 'contingencyMinor', 'managementReserveMinor', 'tenderMarginPercent'],
      properties: {
        version: stringField,
        byCostCode: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['costCode', 'description', 'budgetMinor'],
            properties: { costCode: stringField, description: stringField, budgetMinor: { type: 'integer' } },
            additionalProperties: false,
          },
        },
        contingencyMinor: { type: 'integer', minimum: 0 },
        managementReserveMinor: { type: 'integer', minimum: 0 },
        tenderMarginPercent: { type: 'number' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => cost.approveBudget(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cost/actuals',
    description: 'Engine C — post actual cost',
    schema: {
      type: 'object',
      required: ['costCode', 'amountMinor', 'date', 'sourceSystem', 'description'],
      properties: {
        costCode: stringField,
        amountMinor: { type: 'integer' },
        date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        sourceSystem: stringField,
        description: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => ({ actualCostId: cost.postActualCost(projectContext(platform, ctx), body(ctx)) }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cost/evm',
    description: 'Engine C — take an earned value snapshot',
    schema: {
      type: 'object',
      required: ['period', 'plannedValueMinor'],
      properties: { period: stringField, plannedValueMinor: { type: 'integer', minimum: 0 } },
      additionalProperties: false,
    },
    handler: (platform, ctx) => cost.takeEVMSnapshot(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cost/cvr',
    ai: { engine: 'RESOURCE_COST', taskType: 'cvr_analysis', capability: 'REASONING' },
    description: 'Engine C — publish the live CVR',
    schema: {
      type: 'object',
      required: ['period', 'costToCompleteMinor', 'accrualsMinor'],
      properties: {
        period: stringField,
        costToCompleteMinor: { type: 'integer', minimum: 0 },
        accrualsMinor: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => cost.publishCVR(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cost/cashflow',
    description: 'Engine C — forecast cashflow on an S-curve',
    schema: {
      type: 'object',
      required: ['totalValueMinor', 'periods', 'paymentLagDays', 'retentionPercent'],
      properties: {
        totalValueMinor: { type: 'integer', minimum: 0 },
        periods: { type: 'integer', minimum: 1 },
        paymentLagDays: { type: 'integer', minimum: 0 },
        retentionPercent: { type: 'number', minimum: 0, maximum: 100 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => cost.forecastCashflow(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cost/payment-cycle',
    description: 'Engine C — generate the statutory payment cycle',
    // This one decides statutory dates, so it is validated even though the
    // surrounding routes are not yet. `cycles` drives a loop in a single-
    // threaded process and was unbounded; `startDate` reached `new Date()`
    // unchecked, and an unparseable one writes Invalid Date into an append-only
    // record that cannot afterwards be corrected.
    schema: {
      type: 'object',
      required: ['contractId', 'startDate', 'cycles', 'terms', 'direction'],
      properties: {
        contractId: stringField,
        startDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}' },
        cycles: { type: 'integer', minimum: 1, maximum: 120 },
        direction: { type: 'string', enum: ['UPSTREAM', 'DOWNSTREAM'] },
        terms: {
          type: 'object',
          required: ['applicationDayOfMonth', 'paymentNoticeDays', 'payLessNoticeDaysBeforeFinal', 'finalDateDays'],
          properties: {
            applicationDayOfMonth: { type: 'integer', minimum: 1, maximum: 28 },
            paymentNoticeDays: { type: 'integer', minimum: 0, maximum: 90 },
            payLessNoticeDaysBeforeFinal: { type: 'integer', minimum: 0, maximum: 90 },
            finalDateDays: { type: 'integer', minimum: 0, maximum: 365 },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => cost.generatePaymentSchedule(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cost/application',
    description: 'Engine C — submit a payment application',
    schema: {
      type: 'object',
      required: ['cycleId', 'cycleNumber', 'grossValuationMinor', 'variationsIncludedMinor', 'previouslyCertifiedMinor', 'retentionMinor', 'supportingEvidenceHash'],
      properties: {
        cycleId: stringField,
        cycleNumber: { type: 'integer', minimum: 1 },
        grossValuationMinor: { type: 'integer', minimum: 0 },
        variationsIncludedMinor: { type: 'integer', minimum: 0 },
        previouslyCertifiedMinor: { type: 'integer', minimum: 0 },
        retentionMinor: { type: 'integer', minimum: 0 },
        supportingEvidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => cost.submitApplication(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cost/application/:applicationId/certify',
    description: 'Engine C — certify an application and issue the payment notice',
    schema: {
      type: 'object',
      required: ['certifiedMinor', 'retentionMinor', 'issuedDate', 'certificateHash'],
      properties: {
        certifiedMinor: { type: 'number', minimum: 0 },
        retentionMinor: { type: 'number', minimum: 0 },
        issuedDate: stringField,
        certificateHash: stringField,
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      cost.certifyApplication(projectContext(platform, ctx), {
        ...body<Omit<Parameters<typeof cost.certifyApplication>[1], 'applicationId'>>(ctx),
        applicationId: ctx.params.applicationId as string,
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cost/certificate/:certificateId/payment',
    description: 'Engine C — post a payment against a certificate',
    schema: {
      type: 'object',
      required: ['amountMinor', 'paidDate', 'reference'],
      properties: {
        amountMinor: { type: 'number', minimum: 1 },
        paidDate: stringField,
        reference: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      cost.postPayment(projectContext(platform, ctx), {
        ...body<Omit<Parameters<typeof cost.postPayment>[1], 'certificateId'>>(ctx),
        certificateId: ctx.params.certificateId as string,
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cost/application/:applicationId/pay-less',
    description: 'Engine C — issue a pay less notice under s.111',
    schema: {
      type: 'object',
      required: ['sumConsideredDueMinor', 'basis', 'issuedDate', 'noticeHash'],
      properties: {
        sumConsideredDueMinor: { type: 'number', minimum: 0 },
        basis: { type: 'string', minLength: 20 },
        issuedDate: stringField,
        noticeHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      cost.issuePayLessNotice(projectContext(platform, ctx), {
        ...body<Omit<Parameters<typeof cost.issuePayLessNotice>[1], 'applicationId'>>(ctx),
        applicationId: ctx.params.applicationId as string,
      }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/cost/notices/:cycleId',
    description: 'Engine C — notice compliance position',
    handler: (platform, ctx) => ({
      position: cost.noticePosition(projectContext(platform, ctx), ctx.params.cycleId as string),
    }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/cost/statutory/:cycleId',
    description: 'Engine C — the statutory payment position under the Construction Act',
    handler: (platform, ctx) =>
      cost.statutoryPosition(
        projectContext(platform, ctx),
        ctx.params.cycleId as string,
        ctx.query.get('today') ?? undefined,
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cost/contra',
    description: 'Raise a contra charge against a subcontract, with its enforceability computed',
    schema: {
      type: 'object',
      required: ['subcontractId', 'reason', 'amountMinor', 'narrative', 'incurredOn', 'evidenceHash'],
      properties: {
        subcontractId: stringField,
        reason: {
          type: 'string',
          enum: [
            'REMEDIAL_WORK',
            'ATTENDANCE',
            'PLANT_AND_EQUIPMENT',
            'CLEANING_AND_WASTE',
            'DELAY_TO_FOLLOWING_TRADES',
            'MATERIALS_SUPPLIED',
            'STATUTORY_OR_SAFETY',
          ],
        },
        amountMinor: { type: 'integer', minimum: 1 },
        narrative: { type: 'string', minLength: 10 },
        incurredOn: stringField,
        evidenceHash: stringField,
        payLessNoticeId: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => cost.raiseContraCharge(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/cost/contra',
    description: 'Contra charges raised, and how much of it will stand as a deduction',
    readOnly: true,
    handler: (platform, ctx) => cost.contraPosition(projectContext(platform, ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/cost/ledger',
    description: 'Engine C — committed vs certified vs paid, with exceptions',
    handler: (platform, ctx) => cost.ledgerPosition(projectContext(platform, ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/cost/forward-cashflow',
    readOnly: true,
    description: 'Cash in and out over the payment periods that remain, measured from what has been certified',
    handler: (platform, ctx) => cost.forwardCashflow(projectContext(platform, ctx)),
  },

  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/risk',
    description: 'Engine D — register and score a risk',
    schema: {
      type: 'object',
      required: ['id', 'title', 'category', 'probability', 'costImpact', 'scheduleImpactDays', 'projectValueMinor', 'projectDurationDays'],
      properties: {
        id: stringField,
        title: stringField,
        category: stringField,
        // A proportion, not a percentage. A risk with a probability of 40 would
        // otherwise be scored as forty times certain.
        probability: { type: 'number', minimum: 0, maximum: 1 },
        costImpact: {
          type: 'object',
          required: ['optimistic', 'mostLikely', 'pessimistic'],
          properties: {
            optimistic: { type: 'integer' },
            mostLikely: { type: 'integer' },
            pessimistic: { type: 'integer' },
          },
          additionalProperties: false,
        },
        scheduleImpactDays: {
          type: 'object',
          required: ['optimistic', 'mostLikely', 'pessimistic'],
          properties: {
            optimistic: { type: 'number' },
            mostLikely: { type: 'number' },
            pessimistic: { type: 'number' },
          },
          additionalProperties: false,
        },
        ownerPartyId: stringField,
        mitigations: { type: 'array', items: { type: 'object' } },
        projectValueMinor: { type: 'integer', minimum: 0 },
        projectDurationDays: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => safety.registerRisk(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/risk/:riskId/rescore',
    description: 'Engine D — rescore a risk, with the reason the exposure moved',
    schema: {
      type: 'object',
      required: ['probability', 'costImpact', 'scheduleImpactDays', 'reason', 'projectValueMinor', 'projectDurationDays'],
      properties: {
        probability: { type: 'number', minimum: 0, maximum: 1 },
        costImpact: { type: 'object' },
        scheduleImpactDays: { type: 'object' },
        reason: { type: 'string', minLength: 15 },
        projectValueMinor: { type: 'number', minimum: 0 },
        projectDurationDays: { type: 'number', minimum: 0 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      safety.rescoreRisk(projectContext(platform, ctx), {
        ...body<Omit<Parameters<typeof safety.rescoreRisk>[1], 'riskId'>>(ctx),
        riskId: ctx.params.riskId as string,
      }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/risk/contingency',
    description: 'Engine D — contingency requirement (expected and P80)',
    handler: (platform, ctx) => safety.assessContingency(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/safety/rams',
    ai: { engine: 'RISK_SAFETY', taskType: 'rams_drafting', capability: 'REASONING' },
    description: 'Engine D — draft a RAMS from the hazard library',
    schema: {
      type: 'object',
      required: ['workPackageId', 'activityDescription', 'location', 'steps'],
      properties: {
        workPackageId: stringField,
        activityDescription: { type: 'string', minLength: 10 },
        location: stringField,
        steps: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['description', 'activityType'],
            properties: { description: stringField, activityType: stringField },
            additionalProperties: false,
          },
        },
        // A company's own hazard library takes precedence over the platform's, so
        // it arrives with the request rather than being assumed.
        companyHazardLibrary: {
          type: 'array',
          items: {
            type: 'object',
            required: ['activityType', 'hazards', 'controls'],
            properties: {
              activityType: stringField,
              hazards: { type: 'array', items: { type: 'string' } },
              controls: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => safety.draftRAMS(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/safety/rams/:ramsId/approve',
    description: 'Engine D — approve a RAMS',
    schema: {
      type: 'object',
      required: ['reviewComments'],
      properties: { reviewComments: { type: 'string', minLength: 4 } },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      safety.approveRAMS(projectContext(platform, ctx), ctx.params.ramsId as string, body<{ reviewComments: string }>(ctx).reviewComments);
      return { approved: true };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/safety/observations',
    ai: { engine: 'RISK_SAFETY', taskType: 'hazard_classification', capability: 'PERCEPTION' },
    description: 'Engine D — log a safety observation',
    schema: {
      type: 'object',
      required: ['description', 'location', 'mediaHash', 'observationType', 'reportedBy'],
      properties: {
        description: { type: 'string', minLength: 10 },
        location: stringField,
        mediaHash: stringField,
        mediaUri: { type: 'string' },
        observationType: { type: 'string', enum: ['UNSAFE_ACT', 'UNSAFE_CONDITION', 'NEAR_MISS', 'GOOD_PRACTICE'] },
        reportedBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => safety.logSafetyObservation(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/safety/forecast',
    ai: { engine: 'RISK_SAFETY', taskType: 'safety_forecast', capability: 'REASONING' },
    description: 'Engine D — predictive safety forecast',
    schema: {
      type: 'object',
      required: ['headcount', 'highRiskActivitiesPlanned', 'adverseWeatherDays'],
      properties: {
        headcount: { type: 'integer', minimum: 0 },
        highRiskActivitiesPlanned: { type: 'integer', minimum: 0 },
        adverseWeatherDays: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => safety.forecastSafetyRisk(projectContext(platform, ctx), body(ctx)),
  },

  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/bim/drawings',
    ai: { engine: 'BIM_TWIN', taskType: 'title_block_extraction', capability: 'PERCEPTION' },
    description: 'Engine E — register a drawing and supersede prior revisions',
    schema: {
      type: 'object',
      required: ['fileHash'],
      properties: {
        fileHash: stringField,
        fileUri: { type: 'string' },
        // Either a parsed title block or the text to read one from. The engine
        // refuses when neither arrives, and refuses again when the reading produces
        // no drawing number.
        titleBlock: {
          type: 'object',
          required: ['drawingNumber', 'title', 'revision', 'discipline'],
          properties: {
            drawingNumber: stringField,
            title: stringField,
            revision: stringField,
            discipline: stringField,
            scale: stringField,
            drawnBy: stringField,
            checkedBy: stringField,
            issueDate: stringField,
            status: stringField,
          },
          additionalProperties: false,
        },
        rawTitleBlockText: { type: 'string' },
        packageIds: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => bim.registerDrawing(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/bim/markups',
    description: 'Engine E — add a markup, optionally converting it to an RFI or instruction',
    schema: {
      type: 'object',
      required: ['drawingId', 'author', 'note'],
      properties: {
        drawingId: stringField,
        author: stringField,
        note: { type: 'string', minLength: 4 },
        region: {
          type: 'object',
          required: ['x', 'y', 'width', 'height'],
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
          additionalProperties: false,
        },
        convertTo: { type: 'string', enum: ['RFI', 'INSTRUCTION', 'NONE'] },
        // The activity the answer holds up. What turns the design-delay
        // exposure from "if this is on the critical path" into a figure read
        // off the network.
        taskId: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => bim.addMarkup(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/rfi/:rfiId/answer',
    description: 'Answer an RFI, recording the revision it was answered against',
    schema: {
      type: 'object',
      required: ['answer', 'answeredBy', 'evidenceHash'],
      properties: {
        answer: { type: 'string', minLength: 10 },
        answeredBy: stringField,
        changesDesign: { type: 'boolean' },
        supersedingDrawingId: { type: 'string' },
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      bim.answerRFI(projectContext(platform, ctx), {
        ...body<Omit<Parameters<typeof bim.answerRFI>[1], 'rfiId'>>(ctx),
        rfiId: ctx.params.rfiId as string,
      }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/om/position',
    readOnly: true,
    description: 'The operating position — assets, warranties, work orders, defects and what it costs to run',
    handler: (platform, ctx) => handover.operatingPosition(projectContext(platform, ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/om/queue',
    readOnly: true,
    description: 'What needs doing against the asset register, statutory first and then by lateness',
    handler: (platform, ctx) => handover.maintenanceQueue(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/om/operating-cost',
    description: 'Record what the asset cost to run in a period — energy, water, maintenance, statutory',
    schema: {
      type: 'object',
      required: ['period', 'category', 'amountMinor', 'narrative', 'evidenceHash'],
      properties: {
        period: stringField,
        category: {
          type: 'string',
          enum: [
            'ENERGY', 'WATER', 'REACTIVE_MAINTENANCE', 'PLANNED_MAINTENANCE',
            'CONSUMABLES', 'STATUTORY_INSPECTION', 'CLEANING', 'SECURITY',
          ],
        },
        amountMinor: { type: 'integer', minimum: 0 },
        // Attributed to one asset where it can be. "The building used £40,000
        // of electricity" is a bill; "chiller 2 used £9,000 of it" is a
        // decision about whether to replace it.
        assetId: stringField,
        quantity: { type: 'number', minimum: 0 },
        unit: stringField,
        narrative: { type: 'string', minLength: 4 },
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => handover.recordOperatingCost(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/design/readiness',
    readOnly: true,
    description: 'Whether the work in the published lookahead has the design information it needs',
    handler: (platform, ctx) => bim.designReadiness(projectContext(platform, ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/productivity',
    readOnly: true,
    description: 'Earned days against elapsed days, per activity and weighted for the project',
    handler: (platform, ctx) => planning.productivityPosition(projectContext(platform, ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/rfi/exposure',
    description: 'What late design information is costing, priced at the contract damages rate',
    readOnly: true,
    handler: (platform, ctx) =>
      bim.designDelayExposure(projectContext(platform, ctx), ctx.query.get('today') ?? undefined),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/rfi/position',
    description: 'The RFI register as a delay exhibit: what is overdue and for how long',
    handler: (platform, ctx) => bim.rfiPosition(projectContext(platform, ctx)),
  },
  // Contractual correspondence. The matrix is published rather than restated in
  // the browser, for the same reason the permission matrix is: who a letter must
  // be served on is a rule, and settled decision 6 says the interface holds no
  // rule the API does not publish.
  {
    method: 'GET',
    pattern: '/v1/correspondence/matrix',
    readOnly: true,
    description: 'Which letters may be written, who may send them, who they must be served on, and the reply period each form allows',
    handler: (_platform, ctx) => {
      auth(ctx);
      return {
        types: Object.entries(correspondence.CORRESPONDENCE_TYPES).map(([type, definition]) => ({
          type,
          ...definition,
        })),
      };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/correspondence',
    description: 'Compose and issue a contractual letter, to the party the contract requires',
    schema: {
      type: 'object',
      required: ['type', 'from', 'to', 'subject', 'body', 'author'],
      properties: {
        type: { type: 'string', enum: Object.keys(correspondence.CORRESPONDENCE_TYPES) },
        from: { type: 'string', enum: CORRESPONDENCE_PARTIES },
        to: { type: 'string', enum: CORRESPONDENCE_PARTIES },
        subject: { type: 'string', minLength: 4 },
        body: { type: 'string', minLength: 10 },
        author: stringField,
        linkedEntity: {
          type: 'object',
          required: ['refType', 'refId'],
          properties: { refType: stringField, refId: stringField },
          additionalProperties: false,
        },
        evidenceHash: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      correspondence.issueCorrespondence(
        projectContext(platform, ctx),
        body<Parameters<typeof correspondence.issueCorrespondence>[1]>(ctx),
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/correspondence/:correspondenceId/reply',
    description: 'Answer a letter, and record whether the answer came within the period the contract allows',
    schema: {
      type: 'object',
      required: ['body', 'author'],
      properties: {
        body: { type: 'string', minLength: 10 },
        author: stringField,
        evidenceHash: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      correspondence.respondToCorrespondence(projectContext(platform, ctx), {
        ...body<Omit<Parameters<typeof correspondence.respondToCorrespondence>[1], 'correspondenceId'>>(ctx),
        correspondenceId: ctx.params.correspondenceId as string,
      }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/correspondence/position',
    readOnly: true,
    description: 'What is awaiting a reply, what is past the contractual period, and what silence has already decided',
    handler: (platform, ctx) => correspondence.correspondencePosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/bim/models',
    ai: { engine: 'BIM_TWIN', taskType: 'model_ingestion', capability: 'PERCEPTION' },
    description: 'Engine E — ingest a model',
    schema: {
      type: 'object',
      required: ['fileHash', 'format', 'discipline', 'lod', 'elementCount'],
      properties: {
        fileHash: stringField,
        fileUri: { type: 'string' },
        format: { type: 'string', enum: ['IFC', 'RVT', 'NWD', 'DWG'] },
        discipline: stringField,
        // Level of detail, on the 100–500 scale. A model claiming LOD 6 is a typo
        // that would otherwise be recorded as fact.
        lod: { type: 'integer', minimum: 100, maximum: 500 },
        elementCount: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => bim.ingestModel(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/specifications',
    ai: { engine: 'BIM_TWIN', taskType: 'specification_reading', capability: 'REASONING' },
    description: 'Engine E — read a specification section for what it requires, from supplied text',
    schema: {
      type: 'object',
      required: ['sectionRef', 'title', 'revision', 'specificationText', 'documentHash'],
      properties: {
        sectionRef: stringField,
        title: stringField,
        revision: stringField,
        specificationText: { type: 'string', minLength: 100 },
        documentHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => bim.ingestSpecification(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/specifications/coverage',
    description: 'Which specified tests, submittals and hold points have an inspection stage against them',
    handler: (platform, ctx) => bim.specificationCoverage(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/bim/clashes',
    ai: { engine: 'BIM_TWIN', taskType: 'clash_triage', capability: 'REASONING' },
    description: 'Engine E — detect and triage clashes',
    schema: {
      type: 'object',
      required: ['modelAId', 'modelBId', 'clashes'],
      properties: {
        modelAId: stringField,
        modelBId: stringField,
        clashes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['elementA', 'elementB', 'disciplineA', 'disciplineB', 'overlapVolume', 'location'],
            properties: {
              elementA: stringField,
              elementB: stringField,
              disciplineA: stringField,
              disciplineB: stringField,
              // Cubic metres. The objective severity driver, so it is a number and
              // not a grade somebody assigns.
              overlapVolume: { type: 'number', minimum: 0 },
              location: stringField,
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => bim.detectClashes(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/bim/clashes/:clashId/resolve',
    description: 'Engine E — close a clash out, naming how and which discipline moved',
    schema: {
      type: 'object',
      required: ['method', 'justification', 'resolvedBy', 'evidenceHash'],
      properties: {
        method: { type: 'string', enum: ['MODEL_REVISED', 'WITHIN_TOLERANCE', 'NOT_A_CLASH', 'RESOLVED_ON_SITE'] },
        movedDiscipline: stringField,
        resolvedInModelId: stringField,
        justification: { type: 'string', minLength: 15 },
        resolvedBy: stringField,
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      bim.resolveClash(projectContext(platform, ctx), {
        ...body<Omit<Parameters<typeof bim.resolveClash>[1], 'clashId'>>(ctx),
        clashId: ctx.params.clashId as string,
      }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/bim/clashes/position',
    description: 'The clash register as a coordination position: what is still critical and where the model was left behind',
    handler: (platform, ctx) => bim.clashPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/bim/twin',
    ai: { engine: 'BIM_TWIN', taskType: 'site_reality_comparison', capability: 'PERCEPTION' },
    description: 'Engine E — update the twin from site reality',
    schema: {
      type: 'object',
      required: ['observationHash', 'source', 'zone', 'linkedTaskIds', 'observedElements'],
      properties: {
        observationHash: stringField,
        observationUri: { type: 'string' },
        source: { type: 'string', enum: ['DRONE', 'CCTV', 'MOBILE', 'IOT', 'LASER_SCAN'] },
        zone: stringField,
        linkedTaskIds: { type: 'array', items: { type: 'string' } },
        observedElements: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['elementId', 'expectedStatus', 'observedStatus'],
            properties: { elementId: stringField, expectedStatus: stringField, observedStatus: stringField },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => bim.updateTwinFromSite(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/bim/as-built',
    ai: { engine: 'BIM_TWIN', taskType: 'as_built_generation', capability: 'REASONING' },
    description: 'Engine E — generate the as-built record',
    schema: {
      type: 'object',
      required: ['baseModelId'],
      properties: { baseModelId: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) => bim.generateAsBuilt(projectContext(platform, ctx), body(ctx)),
  },

  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/contracts',
    description: 'Engine F — create a contract',
    schema: {
      type: 'object',
      required: ['suite', 'form', 'parties', 'contractSumMinor', 'commencementDate', 'completionDate', 'liquidatedDamagesPerDayMinor', 'ldCapPercent', 'retentionPercent', 'defectsLiabilityMonths'],
      properties: {
        // The same closed list the clause register knows how to cite against.
        suite: { type: 'string', enum: values(CONTRACT_FORM) },
        form: stringField,
        parties: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['role', 'partyId', 'name'],
            properties: { role: stringField, partyId: stringField, name: stringField },
            additionalProperties: false,
          },
        },
        contractSumMinor: { type: 'integer', minimum: 0 },
        commencementDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        completionDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        liquidatedDamagesPerDayMinor: { type: 'integer', minimum: 0 },
        ldCapPercent: { type: 'number', minimum: 0, maximum: 100 },
        retentionPercent: { type: 'number', minimum: 0, maximum: 100 },
        defectsLiabilityMonths: { type: 'integer', minimum: 0 },
        sourceBidPackId: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => claims.createContract(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/contracts/from-bid',
    description: 'Engine F — convert a locked bid pack into a contract',
    schema: {
      type: 'object',
      required: ['bidPackId', 'suite', 'form', 'parties', 'commencementDate', 'completionDate', 'liquidatedDamagesPerDayMinor', 'ldCapPercent', 'retentionPercent', 'defectsLiabilityMonths'],
      properties: {
        // No contract sum: it comes from the bid pack, which is the point of
        // converting rather than re-keying.
        bidPackId: stringField,
        suite: { type: 'string', enum: values(CONTRACT_FORM) },
        form: stringField,
        parties: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['role', 'partyId', 'name'],
            properties: { role: stringField, partyId: stringField, name: stringField },
            additionalProperties: false,
          },
        },
        commencementDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        completionDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        liquidatedDamagesPerDayMinor: { type: 'integer', minimum: 0 },
        ldCapPercent: { type: 'number', minimum: 0, maximum: 100 },
        retentionPercent: { type: 'number', minimum: 0, maximum: 100 },
        defectsLiabilityMonths: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => claims.convertBidToContract(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/contracts/:contractId/intelligence',
    ai: { engine: 'CONTRACTS_CLAIMS', taskType: 'clause_extraction', capability: 'REASONING' },
    description: 'Engine F — extract clauses and register obligations',
    schema: {
      type: 'object',
      required: ['contractText'],
      properties: { contractText: { type: 'string', minLength: 20 } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      claims.extractContractIntelligence(projectContext(platform, ctx), {
        contractId: ctx.params.contractId as string,
        ...body<{ contractText: string; documentHash: string }>(ctx),
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/changes',
    description: 'Engine F — submit a change request',
    schema: {
      type: 'object',
      required: ['description', 'origin', 'noticeType', 'reason', 'impactedPackageIds', 'affectedSubcontractIds', 'supportingEvidenceHash'],
      properties: {
        description: { type: 'string', minLength: 10 },
        origin: { type: 'string', enum: values(CHANGE_ORIGIN) },
        // The claims engine's own list, which the console already offers.
    noticeType: { type: 'string', enum: ['CCI', 'RFC', 'VE', 'SI', 'NCR_LINKED', 'DRAWING_REVISION'] },
        reason: { type: 'string', minLength: 4 },
        impactedPackageIds: { type: 'array', items: { type: 'string' } },
        // Required and allowed to be empty. An empty list says the change touches
        // no subcontract; an absent one says nobody looked, and the variation
        // control matrix cannot tell those apart afterwards.
        affectedSubcontractIds: { type: 'array', items: { type: 'string' } },
        supportingEvidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => claims.submitChangeRequest(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/changes/:changeRequestId/impact',
    ai: { engine: 'CONTRACTS_CLAIMS', taskType: 'impact_assessment', capability: 'REASONING' },
    description: 'Engine F — assess change impact',
    schema: {
      type: 'object',
      required: ['costImpactMinor', 'timeImpactDays', 'assessedBy'],
      properties: {
        costImpactMinor: { type: 'integer' },
        timeImpactDays: { type: 'integer' },
        assessedBy: stringField,
        // Both sides of the impact, where the change reaches a package that is
        // already bought. The variation control matrix is why these are
        // recorded together rather than as two unrelated assessments.
        affectedSubcontractIds: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
      },
    },
    handler: (platform, ctx) =>
      claims.assessImpact(projectContext(platform, ctx), {
        changeRequestId: ctx.params.changeRequestId as string,
        ...body<Omit<Parameters<typeof claims.assessImpact>[1], 'changeRequestId'>>(ctx),
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/variations',
    description: 'Engine F — instruct a variation',
    schema: {
      type: 'object',
      required: ['changeRequestId', 'contractId', 'valuationMethod', 'valuedAmountMinor', 'timeImpactDays'],
      properties: {
        changeRequestId: stringField,
        contractId: stringField,
        valuationMethod: { type: 'string', enum: ['BOQ_RATES', 'STAR_RATE', 'DAYWORK', 'LUMP_SUM', 'FAIR_VALUATION'] },
        valuedAmountMinor: { type: 'integer' },
        timeImpactDays: { type: 'integer' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => claims.instructVariation(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/variations/domestic',
    description: 'Engine F — flag a domestic variation from a trade application',
    schema: {
      type: 'object',
      required: ['applicationId', 'subcontractId', 'description', 'claimedAmountMinor', 'claimedTimeDays', 'supportingEvidenceHash'],
      properties: {
        applicationId: stringField,
        subcontractId: stringField,
        description: { type: 'string', minLength: 10 },
        claimedAmountMinor: { type: 'integer' },
        claimedTimeDays: { type: 'integer' },
        supportingEvidenceHash: stringField,
        // The upstream change this cost belongs to. Naming it makes both sides of
        // one change a single record rather than two that never meet.
        changeRequestId: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => claims.flagDomesticVariation(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/variations/:variationId/value',
    description: 'Engine F — agree the value of a variation with the client',
    schema: {
      type: 'object',
      required: ['valuationMethod', 'agreedAmountMinor', 'agreedTimeDays', 'basis', 'agreedWith'],
      properties: {
        valuationMethod: { type: 'string', enum: ['BOQ_RATES', 'STAR_RATE', 'DAYWORK', 'LUMP_SUM', 'FAIR_VALUATION'] },
        agreedAmountMinor: { type: 'number' },
        agreedTimeDays: { type: 'number' },
        basis: { type: 'string', minLength: 15 },
        agreedWith: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      claims.valueVariation(projectContext(platform, ctx), {
        ...body<Omit<Parameters<typeof claims.valueVariation>[1], 'variationId'>>(ctx),
        variationId: ctx.params.variationId as string,
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/changes/:changeRequestId/reject',
    description: 'Engine F — refuse a change, with the grounds',
    schema: {
      type: 'object',
      required: ['reason'],
      properties: { reason: { type: 'string', minLength: 15 }, rejectedBy: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      claims.rejectChangeRequest(projectContext(platform, ctx), {
        ...body<Omit<Parameters<typeof claims.rejectChangeRequest>[1], 'changeRequestId'>>(ctx),
        changeRequestId: ctx.params.changeRequestId as string,
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/obligations',
    description: 'Register a dated contractual obligation',
    schema: {
      type: 'object',
      required: ['contractId', 'category', 'description', 'dueDate', 'owner'],
      properties: {
        contractId: stringField,
        category: stringField,
        description: stringField,
        dueDate: stringField,
        owner: stringField,
        recurrenceMonths: { type: 'number', minimum: 1 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => claims.registerObligation(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/consistency',
    description: 'What the records say against each other, with the money or the days behind each disagreement',
    handler: (platform, ctx) =>
      consistency.consistencyReport(projectContext(platform, ctx), ctx.query.get('today') ?? undefined),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/obligations/calendar',
    description: 'The obligations calendar: what falls due, and which time bars are running',
    handler: (platform, ctx) =>
      claims.obligationCalendar(
        projectContext(platform, ctx),
        ctx.query.get('today') ?? undefined,
        ctx.query.get('horizonDays') ? Number(ctx.query.get('horizonDays')) : undefined,
      ),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/contracts/:contractId/terms',
    description: 'The executed contract as a register of commercial terms, each citing its clause',
    readOnly: true,
    handler: (platform, ctx) =>
      claims.contractTerms(projectContext(platform, ctx), ctx.params.contractId as string),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/variations/register',
    description: 'Engine F — the variation control matrix, both sides of every change',
    handler: (platform, ctx) => claims.variationRegister(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/delay-events',
    description: 'Engine F — record an evidenced delay event',
    schema: {
      type: 'object',
      required: ['cause', 'description', 'start', 'end', 'criticalDelayDays', 'affectedTaskIds', 'noticeServed', 'evidenceHashes'],
      properties: {
        cause: { type: 'string', enum: values(DELAY_CAUSE) },
        description: { type: 'string', minLength: 10 },
        start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        end: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        criticalDelayDays: { type: 'integer', minimum: 0 },
        affectedTaskIds: { type: 'array', items: { type: 'string' } },
        noticeServed: { type: 'boolean' },
        noticeDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        evidenceHashes: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => claims.recordDelayEvent(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/claims',
    ai: { engine: 'CONTRACTS_CLAIMS', taskType: 'claim_assessment', capability: 'REASONING' },
    description: 'Engine F — assess a delay claim with concurrency',
    schema: {
      type: 'object',
      required: ['contractId', 'claimType', 'claimedDays', 'claimedAmountMinor', 'dailyProlongationMinor'],
      properties: {
        contractId: stringField,
        claimType: { type: 'string', enum: ['EOT', 'COST', 'LOSS_AND_EXPENSE'] },
        claimedDays: { type: 'integer', minimum: 0 },
        claimedAmountMinor: { type: 'integer', minimum: 0 },
        dailyProlongationMinor: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => claims.assessDelayClaim(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/claims/:claimId/evidence-pack',
    ai: { engine: 'CONTRACTS_CLAIMS', taskType: 'evidence_pack_narrative', capability: 'REASONING' },
    description: 'Engine F — build a verifiable evidence pack',
    schema: {
      type: 'object',
      required: ['from', 'to'],
      properties: { from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      claims.buildEvidencePack(projectContext(platform, ctx), {
        claimId: ctx.params.claimId as string,
        ...body<{ from: string; to: string; audience: 'INTERNAL' | 'CLIENT' | 'ADJUDICATOR' | 'COURT' }>(ctx),
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/notices',
    description: 'Engine F — serve a contractual notice with time-bar check',
    schema: {
      type: 'object',
      required: ['contractId', 'type', 'servedTo', 'content', 'triggerEventDate'],
      properties: {
        contractId: stringField,
        type: { type: 'string', enum: values(NOTICE_TYPE) },
        servedTo: stringField,
        content: { type: 'string', minLength: 10 },
        // The date the clock starts from. A notice served against a trigger date
        // in the future is a time bar computed backwards.
        triggerEventDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        relatedEntityRef: {
          type: 'object',
          required: ['refType', 'refId'],
          properties: { refType: stringField, refId: stringField },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => claims.issueNotice(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/disputes',
    description: 'Give notice of adjudication under HGCRA s.108 and start the statutory timetable',
    schema: {
      type: 'object',
      required: ['contractId', 'natureOfDispute', 'redressSought', 'referringParty', 'respondingParty', 'noticeDate', 'evidenceHash'],
      properties: {
        contractId: stringField,
        natureOfDispute: { type: 'string', minLength: 20 },
        redressSought: { type: 'string', minLength: 10 },
        disputedAmountMinor: { type: 'number', minimum: 0 },
        referringParty: stringField,
        respondingParty: stringField,
        noticeDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        relatedApplicationId: stringField,
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => claims.openDispute(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/disputes/:disputeId/refer',
    description: 'Record the appointment and the referral, against the seven-day period',
    schema: {
      type: 'object',
      required: ['adjudicatorName', 'referralDate', 'evidenceHash'],
      properties: {
        adjudicatorName: stringField,
        nominatingBody: stringField,
        referralDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      claims.referDispute(projectContext(platform, ctx), {
        ...body<Omit<Parameters<typeof claims.referDispute>[1], 'disputeId'>>(ctx),
        disputeId: ctx.params.disputeId as string,
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/disputes/:disputeId/decision',
    description: 'Record the adjudicator’s decision and whether it was reached in time',
    schema: {
      type: 'object',
      required: ['decisionDate', 'inFavourOf', 'evidenceHash'],
      properties: {
        decisionDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        inFavourOf: stringField,
        awardedAmountMinor: { type: 'number', minimum: 0 },
        awardedDays: { type: 'number', minimum: 0 },
        extensionDays: { type: 'number', minimum: 0 },
        extensionAgreedBy: { type: 'string', enum: ['REFERRING_PARTY', 'BOTH_PARTIES'] },
        extensionAgreedDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        adjudicatorFeesMinor: { type: 'number', minimum: 0 },
        feesBorneBy: stringField,
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      claims.recordAdjudicatorDecision(projectContext(platform, ctx), {
        ...body<Omit<Parameters<typeof claims.recordAdjudicatorDecision>[1], 'disputeId'>>(ctx),
        disputeId: ctx.params.disputeId as string,
      }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/disputes/position',
    description: 'Every adjudication, ordered by the deadline that expires soonest',
    handler: (platform, ctx) =>
      claims.disputePosition(projectContext(platform, ctx), ctx.query.get('today') ?? undefined),
  },

  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/commissioning',
    description: 'Engine G — record a commissioning test',
    schema: {
      type: 'object',
      required: ['systemId', 'systemName', 'testType', 'testStandard', 'result', 'readings', 'witnessedBy', 'certificateHash'],
      properties: {
        systemId: stringField,
        systemName: stringField,
        testType: stringField,
        testStandard: stringField,
        result: { type: 'string', enum: ['PASS', 'FAIL', 'PASS_WITH_OBSERVATIONS'] },
        readings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['parameter', 'expected', 'actual', 'withinTolerance'],
            properties: {
              parameter: stringField,
              expected: stringField,
              actual: stringField,
              withinTolerance: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
        witnessedBy: stringField,
        certificateHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => handover.recordCommissioningTest(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/commissioning/:testId/accept',
    description: 'Engine G — accept a commissioned system',
    schema: {
      type: 'object',
      required: ['acceptedBy', 'acceptanceHash'],
      properties: { acceptedBy: stringField, acceptanceHash: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const { acceptedBy, acceptanceHash } = body<{ acceptedBy: string; acceptanceHash: string }>(ctx);
      handover.acceptSystem(projectContext(platform, ctx), ctx.params.testId as string, acceptedBy, acceptanceHash);
      return { accepted: true };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/handover/pack',
    ai: { engine: 'HANDOVER_OM', taskType: 'handover_readiness', capability: 'REASONING' },
    description: 'Engine G — compile the handover pack',
    schema: {
      type: 'object',
      required: ['receivingPartyId', 'receivingPartyName'],
      properties: { receivingPartyId: stringField, receivingPartyName: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) => handover.compileHandoverPack(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/handover/accept',
    description: 'Engine G — accept handover',
    schema: {
      type: 'object',
      required: ['packId', 'acceptedBy', 'qualifications', 'acceptanceHash'],
      properties: {
        packId: stringField,
        acceptedBy: stringField,
        // Required and allowed to be empty: accepting with no qualifications is a
        // statement, and it is a different one from nobody having been asked.
        qualifications: { type: 'array', items: { type: 'string' } },
        acceptanceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      handover.acceptHandover(projectContext(platform, ctx), body(ctx));
      return { accepted: true };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/assets',
    description: 'Engine G — register an asset',
    schema: {
      type: 'object',
      required: ['assetTag', 'description', 'assetClass', 'manufacturer', 'modelNumber', 'installedAt', 'location', 'expectedLifeYears', 'replacementCostMinor'],
      properties: {
        assetTag: stringField,
        description: stringField,
        assetClass: stringField,
        manufacturer: stringField,
        modelNumber: stringField,
        serialNumber: stringField,
        installedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        location: stringField,
        expectedLifeYears: { type: 'integer', minimum: 1 },
        replacementCostMinor: { type: 'integer', minimum: 0 },
        parentAssetId: stringField,
        linkedModelElementId: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => handover.registerAsset(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/om/manual',
    ai: { engine: 'HANDOVER_OM', taskType: 'om_manual_generation', capability: 'PERCEPTION' },
    description: 'Engine G — publish an O&M manual',
    schema: {
      type: 'object',
      required: ['assetIds', 'sourceDocumentHashes', 'systemName'],
      properties: {
        assetIds: { type: 'array', minItems: 1, items: { type: 'string' } },
        sourceDocumentHashes: { type: 'array', items: { type: 'string' } },
        systemName: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => handover.publishOMManual(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/defects',
    description: 'Engine G — raise a defect with warranty check',
    schema: {
      type: 'object',
      required: ['location', 'description', 'severity', 'reportedBy', 'evidenceHash'],
      properties: {
        assetId: stringField,
        location: stringField,
        description: { type: 'string', minLength: 10 },
        severity: { type: 'string', enum: ['MINOR', 'MAJOR', 'CRITICAL'] },
        reportedBy: stringField,
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => handover.raiseDefect(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/work-orders',
    description: 'Engine G — raise a work order',
    schema: {
      type: 'object',
      required: ['assetId', 'type', 'description', 'priority', 'dueDate'],
      properties: {
        assetId: stringField,
        type: { type: 'string', enum: ['PLANNED', 'REACTIVE', 'CORRECTIVE', 'STATUTORY'] },
        description: { type: 'string', minLength: 4 },
        priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'EMERGENCY'] },
        dueDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        linkedDefectId: stringField,
        estimatedCostMinor: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => handover.raiseWorkOrder(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/om/maintenance-forecast',
    ai: { engine: 'HANDOVER_OM', taskType: 'maintenance_forecast', capability: 'REASONING' },
    description: 'Engine G — predictive maintenance forecast',
    schema: {
      type: 'object',
      required: ['horizonMonths', 'annualBudgetMinor'],
      properties: {
        horizonMonths: { type: 'integer', minimum: 1 },
        annualBudgetMinor: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => handover.forecastMaintenance(projectContext(platform, ctx), body(ctx)),
  },

  // ---------------------------------------------------------------- copilot
  // ------------------------------------------------------------------ agents
  {
    method: 'GET',
    pattern: '/v1/agents',
    description: 'The agent fleet, each with the mandate it can never exceed',
    handler: () => ({ agents: fleetManifest() }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/agents/run',
    description: 'Run the agent fleet over current project state and raise proposals',
    schema: {
      type: 'object',
      properties: { only: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    },
    handler: (platform, ctx) => agents.runAgents(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/proposals',
    description: 'Proposals awaiting a human decision, most urgent first',
    handler: (platform, ctx) => ({ proposals: agents.pendingProposals(projectContext(platform, ctx)) }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/proposals/:proposalId/approve',
    description: 'Approve a proposal and run its command as the approver',
    schema: { type: 'object', properties: { note: { type: 'string' } }, additionalProperties: false },
    handler: async (platform, ctx) => {
      const context = projectContext(platform, ctx);
      const { note } = body<{ note?: string }>(ctx);

      // Approval is recorded before the command runs, so a failed execution
      // still leaves a record of who authorised the attempt.
      const { proposal, execute } = agents.approveProposal(context, ctx.params.proposalId as string, note);
      if (!execute) return { proposal, executed: false };

      const command = AGENT_COMMANDS[execute.command];
      if (!command) {
        throw new DomainError('UNKNOWN_COMMAND', `No dispatcher for ${execute.command}`, 500);
      }

      // Runs as the approver, through the same engine path any human command
      // takes — there is no second, weaker route into the engines.
      const result = await command(context, execute.input);
      agents.markExecuted(context, proposal.id, result as Record<string, unknown>);
      return { proposal, executed: true, result };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/proposals/:proposalId/reject',
    description: 'Reject a proposal, with the reason that becomes part of the record',
    schema: {
      type: 'object',
      required: ['reason'],
      properties: { reason: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      agents.rejectProposal(projectContext(platform, ctx), ctx.params.proposalId as string, body<{ reason: string }>(ctx).reason),
  },

  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/ask',
    description: 'Conversational copilot — grounded answer plus suggested actions',
    schema: {
      type: 'object',
      required: ['question'],
      properties: { question: { type: 'string', minLength: 2, maxLength: 2000 } },
      additionalProperties: false,
    },
    handler: (platform, ctx) => ask(projectContext(platform, ctx), body<{ question: string }>(ctx).question),
  },

  // ------------------------------------------------- offline field execution
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/sync/push',
    description: 'Push a batch of offline field operations',
    schema: {
      type: 'object',
      required: ['operations'],
      properties: { operations: { type: 'array', minItems: 1, items: { type: 'object' } } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      platform.sync.push(
        auth(ctx),
        ctx.params.projectId as string,
        body<{ operations: Parameters<Platform['sync']['push']>[2] }>(ctx).operations,
        ctx.correlationId,
      ),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/sync/pull',
    description: 'Pull events since a cursor',
    handler: (platform, ctx) =>
      platform.sync.pull(
        auth(ctx),
        ctx.params.projectId as string,
        ctx.query.get('deviceId') ?? 'unknown',
        ctx.query.get('since') ?? undefined,
        ctx.query.get('limit') ? Number(ctx.query.get('limit')) : undefined,
      ),
  },

  // ---------------------------------------------------------------- exports
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/exports/report',
    description: 'Branded project status report, hashed and recorded',
    schema: {
      type: 'object',
      properties: {
        audience: { type: 'string', enum: ['INTERNAL', 'CLIENT', 'SUPPLIER', 'REGULATOR', 'INSURER', 'ADJUDICATOR', 'COURT'] },
        format: { type: 'string', enum: ['PDF', 'JSON_BUNDLE', 'CSV', 'HTML'] },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const { audience, format } = body<{ audience?: ExportAudience; format?: ExportFormat }>(ctx);
      const actor = auth(ctx);
      const document = platform.exports.projectReport(actor, ctx.params.projectId as string, {
        // A regulator always receives the regulator copy, whatever is requested.
        audience: actor.roles.includes('REGULATOR') ? 'REGULATOR' : (audience ?? 'CLIENT'),
        format,
        correlationId: ctx.correlationId,
      });
      return format === 'HTML' ? { ...document, html: platform.exports.toHtml(document) } : document;
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/exports/report.pdf',
    binary: true,
    description: 'The same report as a PDF file, rendered from the document that was hashed',
    schema: {
      type: 'object',
      properties: {
        audience: { type: 'string', enum: ['INTERNAL', 'CLIENT', 'SUPPLIER', 'REGULATOR', 'INSURER', 'ADJUDICATOR', 'COURT'] },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const { audience } = body<{ audience?: ExportAudience }>(ctx);
      const actor = auth(ctx);
      const document = platform.exports.projectReport(actor, ctx.params.projectId as string, {
        audience: actor.roles.includes('REGULATOR') ? 'REGULATOR' : (audience ?? 'CLIENT'),
        format: 'PDF',
        correlationId: ctx.correlationId,
      });

      return {
        contentType: 'application/pdf',
        filename: `${document.reference}.pdf`,
        bytes: platform.exports.toPdf(document),
      };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/exports/audit',
    description: 'Verifiable Golden Thread audit export with attestation',
    schema: {
      type: 'object',
      properties: {
        audience: { type: 'string' },
        from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        format: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const { audience, from, to, format } = body<{ audience?: ExportAudience; from?: string; to?: string; format?: ExportFormat }>(ctx);
      const actor = auth(ctx);
      return platform.exports.auditExport(actor, ctx.params.projectId as string, {
        audience: actor.roles.includes('REGULATOR') ? 'REGULATOR' : (audience ?? 'INTERNAL'),
        from: from ?? '1970-01-01T00:00:00.000Z',
        to: to ?? new Date().toISOString(),
        format,
        correlationId: ctx.correlationId,
      });
    },
  },
  {
    method: 'PUT',
    pattern: '/v1/branding',
    description: 'Configure the client identity applied to every export',
    schema: {
      type: 'object',
      required: ['clientName', 'primaryColour', 'legalFooter', 'documentReferencePrefix'],
      properties: {
        clientName: stringField,
        logoRef: { type: 'string' },
        primaryColour: stringField,
        legalFooter: stringField,
        documentReferencePrefix: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      platform.exports.setBranding(auth(ctx).tenantId, body(ctx));
      return platform.exports.branding(auth(ctx).tenantId);
    },
  },

  // ------------------------------------------------------------------- audit
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/audit/replay',
    description: 'Replay and verify project state at a point in time',
    schema: {
      type: 'object',
      properties: {
        timestamp: { type: 'string' },
        audience: { type: 'string', enum: ['INTERNAL', 'REGULATOR', 'INSURER', 'COURT'] },
        scope: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      const { timestamp, audience, scope } = body<{ timestamp?: string; audience?: 'INTERNAL' | 'REGULATOR' | 'INSURER' | 'COURT'; scope?: string[] }>(ctx);
      return replayProject(
        platform.ledger,
        actor.tenantId,
        ctx.params.projectId as string,
        timestamp ?? new Date().toISOString(),
        // A regulator always gets the regulator view regardless of what is asked for.
        { audience: actor.roles.includes('REGULATOR') ? 'REGULATOR' : audience, scope },
      );
    },
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/lineage/:refType/:refId',
    description: 'What caused a record and what was built on it, walked over the ledger',
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      if (actor.roles.includes('PLATFORM_ADMIN')) {
        throw new ForbiddenError('Platform operators are barred from customer delivery data', 'ACCOUNT_LAYER_SEPARATION');
      }

      const projectId = ctx.params.projectId as string;
      const project = platform.ledger.get({ refType: 'Project', refId: projectId });
      if (!project || project.tenantId !== actor.tenantId) throw new NotFoundError(`No project ${projectId}`);

      // The starting record is authorised the same way every node in the walk
      // is, by the walk itself. What is checked here is only that the caller is
      // asking about a project that is theirs.
      return lineage(
        platform.ledger,
        actor,
        projectId,
        { refType: ctx.params.refType as string, refId: ctx.params.refId as string },
        { maxDepth: ctx.query.get('depth') ? Number(ctx.query.get('depth')) : undefined, authzOptions: AUTHZ_OPTIONS },
      );
    },
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/audit/timeline',
    description: 'Narrative event timeline for a period',
    handler: (platform, ctx) =>
      ({
        timeline: replayTimeline(
          platform.ledger,
          auth(ctx).tenantId,
          ctx.params.projectId as string,
          ctx.query.get('from') ?? '1970-01-01T00:00:00.000Z',
          ctx.query.get('to') ?? new Date().toISOString(),
        ),
      }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/audit/events',
    description: 'Golden Thread events for the project, with content the caller may not read withheld',
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      const projectId = ctx.params.projectId as string;

      // An audit trail has two jobs, and they need separating. Proving the
      // record is complete and untampered needs the envelope — who, when, what
      // type, and the hashes that chain it. Reading what actually changed needs
      // the patch, and that is entity content: withholding it here is the same
      // decision the entity read makes, or the audit feed becomes the way round
      // every capability boundary in the system.
      const events = platform.ledger.events({ tenantId: actor.tenantId, projectId }).map((event) => {
        const classification = classifyEntity(event.entity.refType);
        const decision = classification
          ? evaluateAccess(
              actor,
              classification.area,
              'R',
              { tenantId: actor.tenantId, projectId, dataSensitivity: classification.sensitivity },
              AUTHZ_OPTIONS,
            ).decision
          : 'DENY';

        if (decision === 'ALLOW') return event;
        return { ...event, diff: undefined, contentWithheld: true };
      });

      return {
        chainHead: platform.ledger.chainHead(projectId),
        events,
        withheldCount: events.filter((e) => 'contentWithheld' in e).length,
      };
    },
  },

  // ----------------------------------------------------------------- billing
  {
    method: 'GET',
    pattern: '/v1/billing/wallet',
    description: 'ACU wallet position, caps and alerts',
    handler: (platform, ctx) => platform.wallet(authoriseTenant(ctx, 'BILLING_ACU', 'R').tenantId).snapshot(),
  },
  {
    method: 'GET',
    pattern: '/v1/billing/attribution',
    description: 'AI cost attribution by engine',
    handler: (platform, ctx) => ({
      attribution: platform
        .wallet(authoriseTenant(ctx, 'BILLING_ACU', 'R').tenantId)
        .attributionByModule(ctx.query.get('month') ?? undefined),
    }),
  },
  {
    method: 'POST',
    pattern: '/v1/billing/top-up',
    description: 'Purchase prepaid ACUs',
    schema: {
      type: 'object',
      required: ['amountMinor'],
      properties: { amountMinor: { type: 'integer', minimum: 1 } },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      // This used to credit the wallet with the amount in the request body.
      // There is no payment provider, so that made the route a mint: any tenant
      // user holding `U` on BILLING_ACU could grant themselves unlimited AI
      // credit, and every ACU spent from it bought real provider compute.
      //
      // It now records an intent and moves nothing. Credit appears when a
      // receipt says money arrived, which only the operator can record.
      const actor = authoriseTenant(ctx, 'BILLING_ACU', 'U');
      const intent = platform.requestTopUp({
        tenantId: actor.tenantId,
        amountMinor: body<{ amountMinor: number }>(ctx).amountMinor,
        requestedBy: actor.actorId,
      });
      return {
        ...intent,
        // Said plainly, because the balance will not have moved and a screen
        // that showed the old snapshot would look like the request had failed.
        message:
          'Recorded. Credit is added once payment has been received and matched to this request; ' +
          'the balance is unchanged until then.',
        wallet: platform.wallet(actor.tenantId).snapshot(),
      };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/admin/tenants/:tenantId/credit',
    description: 'Credit a wallet against a received payment (platform operator only)',
    schema: {
      type: 'object',
      required: ['amountMinor', 'method', 'reference'],
      properties: {
        amountMinor: { type: 'integer', minimum: 1 },
        method: {
          type: 'string',
          enum: ['CARD', 'BANK_TRANSFER', 'INVOICE_SETTLEMENT', 'CREDIT_NOTE', 'MANUAL_ADJUSTMENT'],
        },
        // The provider's or bank's own identifier. Unique for ever — it is the
        // idempotency key for money, and it is what makes a webhook that fires
        // twice credit once.
        reference: { type: 'string', minLength: 4, maxLength: 200 },
        intentId: stringField,
        note: { type: 'string', maxLength: 500 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      // Operator-only, and it stays that way when a payment provider is wired:
      // the webhook calls this rather than reaching into wallet state, so a
      // card settlement and a bank transfer leave the same record.
      const actor = auth(ctx);
      if (!actor.roles.includes('PLATFORM_ADMIN')) {
        throw new ForbiddenError('Only the platform operator may credit a wallet', 'PLATFORM_ADMIN_REQUIRED');
      }
      const input = body<{
        amountMinor: number;
        method: 'CARD' | 'BANK_TRANSFER' | 'INVOICE_SETTLEMENT' | 'CREDIT_NOTE' | 'MANUAL_ADJUSTMENT';
        reference: string;
        intentId?: string;
        note?: string;
      }>(ctx);

      const { receipt, alreadyRecorded } = platform.creditFromPayment({
        tenantId: ctx.params.tenantId!,
        ...input,
        recordedBy: actor.actorId,
      });

      return {
        receipt,
        // Success rather than an error, and said out loud. A provider retrying
        // after a timeout must not be told the payment failed, or it will keep
        // retrying something that is already credited.
        alreadyRecorded,
        wallet: platform.wallet(ctx.params.tenantId!).snapshot(),
      };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/admin/payments',
    description: 'Top-up requests awaiting payment and every receipt recorded (platform operator only)',
    handler: (platform, ctx) => {
      if (!auth(ctx).roles.includes('PLATFORM_ADMIN')) {
        throw new ForbiddenError('Only the platform operator may see the payment record', 'PLATFORM_ADMIN_REQUIRED');
      }
      const tenantId = ctx.query.get('tenantId') ?? undefined;
      return {
        awaitingPayment: platform.topUpIntents(tenantId).filter((i) => i.status === 'AWAITING_PAYMENT'),
        receipts: platform.paymentReceipts(tenantId),
      };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/billing/caps',
    description: 'Set monthly, per-project and per-module AI spend caps, recorded against whoever moved them',
    schema: {
      type: 'object',
      required: ['reason'],
      properties: {
        monthlyMinor: { type: 'integer', minimum: 0 },
        perProjectMinor: { type: 'object' },
        perModuleMinor: { type: 'object' },
        reason: { type: 'string', minLength: 10 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const actor = authoriseTenant(ctx, 'BILLING_ACU', 'U');
      const { reason, ...caps } = body<{ reason: string } & ACUCaps>(ctx);
      return platform.setAcuCaps(actor, caps, reason);
    },
  },
  {
    method: 'POST',
    pattern: '/v1/billing/invoice',
    description: 'Issue an invoice for a period',
    schema: {
      type: 'object',
      required: ['tenantId', 'period'],
      properties: {
        tenantId: stringField,
        period: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      // Operator-only. Issuing an invoice credits that period's AI allowance,
      // which makes it an act of billing rather than something a customer does
      // to themselves — and while it was tenant-callable with a client-supplied
      // period, a loop over periods minted allowance for free.
      //
      // A customer who wants to see their position reads it: `GET` below
      // returns the same figures and allocates nothing.
      const actor = auth(ctx);
      if (!actor.roles.includes('PLATFORM_ADMIN')) {
        throw new ForbiddenError(
          'Only the platform operator issues invoices. Use GET /v1/billing/invoice to see the current position.',
          'PLATFORM_ADMIN_REQUIRED',
        );
      }
      const { tenantId, period } = body<{ tenantId: string; period: string }>(ctx);
      return platform.issueInvoice(tenantId, period);
    },
  },
  {
    method: 'GET',
    pattern: '/v1/billing/invoice',
    description: 'The current billing position for a period. Reads only — issues nothing and credits nothing',
    readOnly: true,
    handler: (platform, ctx) => {
      const actor = authoriseTenant(ctx, 'BILLING_ACU', 'R');
      const period = ctx.query.get('period') ?? new Date().toISOString().slice(0, 7);
      // `preview` rather than `issueInvoice`: the same figures, no allocation,
      // no ledger event. What a customer is looking at when they ask "what do I
      // owe" is a statement, and a statement that quietly credits a month of AI
      // every time somebody opens the page is not one.
      return platform.previewInvoice(actor.tenantId, period);
    },
  },
  {
    method: 'GET',
    pattern: '/v1/ai/control-plane',
    description: 'AI routing matrix and provider health',
    handler: (platform) => platform.orchestrator.controlPlaneStatus(),
  },
  {
    method: 'POST',
    pattern: '/v1/ai/quote',
    description: 'What an AI action would cost, before anybody commits to it. Runs nothing.',
    readOnly: true,
    schema: {
      type: 'object',
      required: ['method', 'path'],
      properties: {
        method: { type: 'string', enum: ['POST'] },
        path: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const input = body<{ method: string; path: string }>(ctx);
      const [pathname] = input.path.split('?');
      const matched = matchRoute(input.method, pathname ?? '');

      if (!matched) throw new NotFoundError(`No route matches ${input.method} ${pathname}`);
      if (!matched.route.ai) {
        // Not a refusal to quote — a statement that there is nothing to quote.
        // A caller told "£0.00" would reasonably conclude the AI is free.
        throw new DomainError(
          'NOT_AN_AI_ACTION',
          `${input.method} ${matched.route.pattern} does not call an AI provider, so it has no ACU cost`,
          400,
        );
      }

      // Quoted under the AI permission every one of these actions shares, and
      // under the same phase gate: showing someone the price of something they
      // would then be refused is worse than the refusal. It is not the whole
      // check — each command also authorises its own capability area when it
      // runs, and a quote does not stand in for that.
      const projectId = matched.params.projectId;
      if (!projectId) throw new DomainError('QUOTE_SCOPE', 'AI actions are quoted against a project', 400);

      const engineCtx = projectContext(platform, ctx, projectId);

      // The project has to exist and be this tenant's. Nothing else in this
      // handler reads the project, so without an explicit check a quote would
      // answer for any id at all — the one route in the platform where a
      // caller supplies a project id that no read then validates.
      const project = platform.ledger.get({ refType: 'Project', refId: projectId });
      if (!project || project.tenantId !== engineCtx.tenantId) {
        // Not "exists but not yours": that answer is itself information.
        throw new NotFoundError(`No project ${projectId}`);
      }

      authorise(engineCtx, 'AI_EXECUTION', 'X', { lifecyclePhase: currentPhase(engineCtx) });

      return platform.orchestrator.quote({
        capability: matched.route.ai.capability,
        engine: matched.route.ai.engine,
        taskType: matched.route.ai.taskType,
        wallet: engineCtx.wallet,
        projectId,
      });
    },
  },

  // --- Evidence objects ------------------------------------------------------
  //
  // The platform recorded that a document with a given hash was the evidence
  // and did not hold the document. That is a real chain only while somebody
  // outside the platform still has the file, and three years after practical
  // completion the person who took the photograph has left and the phone has
  // been wiped. These three routes close it.
  //
  // The order is the rule: a ledger record names a hash first, and only then
  // may bytes be stored against it. Reversing that would make this an open blob
  // store with an authentication check on it.
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/evidence',
    readOnly: true,
    description: 'Evidence register for a project, and which files the platform actually holds',
    handler: (platform, ctx) => {
      const engineCtx = projectContext(platform, ctx);
      authorise(engineCtx, 'EVIDENCE_AUDIT', 'R');

      const entries = evidence.projectRegister(
        platform.ledger,
        platform.evidence,
        engineCtx.tenantId,
        engineCtx.projectId,
      );
      return {
        // Said out loud rather than inferred from an empty register: with no
        // store configured every entry is unheld, and a screen showing that
        // without the reason reads as lost evidence rather than as a
        // deployment that never switched the store on.
        storeConfigured: platform.evidence.configured,
        coverage: evidence.coverage(entries),
        entries,
      };
    },
  },
  // Retention, which here is mostly a policy about not deleting. Tenant-scoped
  // rather than project-scoped because the store is: the same file legitimately
  // evidences things in more than one project of the same tenancy.
  {
    method: 'GET',
    pattern: '/v1/evidence/retention',
    readOnly: true,
    description: 'What the object store holds, what no record names, and the policy on removing any of it',
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      if (actor.roles.includes('PLATFORM_ADMIN')) {
        throw new ForbiddenError('Platform operators are barred from customer delivery data', 'ACCOUNT_LAYER_SEPARATION');
      }
      // `I` rather than `R`: this reads across every project in the tenancy at
      // once, which is the export-shaped permission rather than the read one.
      authorise(
        platform.context(actor, `${actor.tenantId}-governance`, { correlationId: ctx.correlationId }),
        'EVIDENCE_AUDIT',
        'I',
      );
      return evidence.retentionPosition(platform.ledger, platform.evidence, actor.tenantId);
    },
  },
  {
    method: 'GET',
    pattern: '/v1/storage',
    readOnly: true,
    description: 'What this tenancy holds against what its plan allows, and what the next upload will do',
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      if (actor.roles.includes('PLATFORM_ADMIN')) {
        throw new ForbiddenError('Platform operators are barred from customer delivery data', 'ACCOUNT_LAYER_SEPARATION');
      }
      // Readable by anyone in the tenancy who can see the billing area. Somebody
      // whose upload is about to be refused should be able to find out why
      // without asking an administrator.
      authorise(
        platform.context(actor, `${actor.tenantId}-governance`, { correlationId: ctx.correlationId }),
        'BILLING_ACU',
        'R',
      );
      return storagePositionFor(platform, actor.tenantId);
    },
  },
  {
    method: 'POST',
    pattern: '/v1/storage/capacity',
    description: 'Buy storage capacity in 100 GB blocks, charged monthly for as long as it is held',
    schema: {
      type: 'object',
      required: ['blocks'],
      properties: {
        // A ceiling on one purchase, not on the total. Buying a hundred blocks
        // in one click is more likely to be a stuck finger than an intention,
        // and the second purchase is one more click.
        blocks: { type: 'integer', minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      if (actor.roles.includes('PLATFORM_ADMIN')) {
        throw new ForbiddenError('Platform operators are barred from customer delivery data', 'ACCOUNT_LAYER_SEPARATION');
      }
      // Committing the tenancy to a recurring charge is an approval, not a read.
      const engineCtx = platform.context(actor, `${actor.tenantId}-governance`, {
        correlationId: ctx.correlationId,
        source: sourceOf(ctx),
      });
      authorise(engineCtx, 'BILLING_ACU', 'U');

      const { blocks } = body<{ blocks: number }>(ctx);
      const entitlementId = ulid();
      const monthlyPriceMinor = blocks * config.billing.storageBlockPriceMinor;
      write(engineCtx, {
        eventType: 'STORAGE_CAPACITY_PURCHASED',
        entity: { refType: 'StorageEntitlement', refId: entitlementId },
        nextState: {
          id: entitlementId,
          tenantId: actor.tenantId,
          blocks,
          gb: blocks * storage.STORAGE_BLOCK_GB,
          monthlyPriceMinor,
          // Recorded on the entitlement so a later reading of the record does
          // not have to guess which price was in force when it was bought.
          blockPriceMinorAtPurchase: config.billing.storageBlockPriceMinor,
          purchasedAt: new Date().toISOString(),
          purchasedBy: actor.actorId,
        },
      });

      return { entitlementId, blocks, monthlyPriceMinor, position: storagePositionFor(platform, actor.tenantId) };
    },
  },
  {
    method: 'DELETE',
    pattern: '/v1/evidence/:hash',
    description: 'Remove bytes no evidence record names. Anything the ledger names is refused.',
    // No body, and said rather than left unstated: an empty closed object
    // refuses a stray body instead of ignoring it.
    schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      if (actor.roles.includes('PLATFORM_ADMIN')) {
        throw new ForbiddenError('Platform operators are barred from customer delivery data', 'ACCOUNT_LAYER_SEPARATION');
      }
      authorise(
        platform.context(actor, `${actor.tenantId}-governance`, { correlationId: ctx.correlationId }),
        'EVIDENCE_AUDIT',
        'I',
      );
      // The guard is in the registry, not here, and it refuses whoever asks.
      return evidence.discardOrphan(platform.ledger, platform.evidence, actor.tenantId, ctx.params.hash as string);
    },
  },
  {
    method: 'POST',
    pattern: '/v1/evidence/:hash',
    upload: true,
    description: 'Store the file behind an evidence hash the ledger already records',
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      if (actor.roles.includes('PLATFORM_ADMIN')) {
        throw new ForbiddenError('Platform operators are barred from customer delivery data', 'ACCOUNT_LAYER_SEPARATION');
      }

      const hash = ctx.params.hash as string;
      const record = evidence.findByHash(platform.ledger, actor.tenantId, hash);
      if (!record) {
        // Not "unknown hash": within this tenancy nothing has claimed that hash
        // as evidence, so there is nothing for these bytes to be evidence of.
        throw new NotFoundError('No evidence record in this tenancy references that hash');
      }

      // Through the project the evidence belongs to, so the same authorisation
      // that governs reading the record governs supplying its file. The project
      // id comes from a record already scoped to the caller's tenancy, so it
      // cannot be used to reach across one.
      const engineCtx = platform.context(actor, record.projectId, {
        correlationId: ctx.correlationId,
        source: sourceOf(ctx),
      });
      // Evidence is never created through this route; the record already
      // exists, and this supplies the file it always referred to. The matrix
      // has no `C` on EVIDENCE_AUDIT for exactly that reason.
      //
      // Two ways to be allowed, and the second is not a loosening. A site
      // supervisor holds EVIDENCE_AUDIT read only, and is precisely the person
      // whose phone took the photograph: on `I` alone the field app could
      // register a hash and then be refused the file behind it, which is the
      // whole feature failing for the role it exists for. Supplying bytes that
      // match a hash you yourself committed is finishing your own act, not
      // reaching into somebody else's — so the captor may complete their own
      // record, and `I` is what it takes to complete anybody's.
      authorise(engineCtx, 'EVIDENCE_AUDIT', 'R');
      const capturedBy = (record.state as { capturedBy?: string }).capturedBy;
      if (capturedBy !== actor.actorId) authorise(engineCtx, 'EVIDENCE_AUDIT', 'I');

      // Capacity, checked before the write rather than after it. The plan's
      // allowance was published on the pricing page from the first day and
      // enforced nowhere, which made it a promise the billing engine was never
      // going to keep.
      const incoming = ctx.rawBody ?? Buffer.alloc(0);
      storage.assertCapacity(storagePositionFor(platform, actor.tenantId), incoming.length);

      const stored = platform.evidence.put(actor.tenantId, hash, incoming, mediaType(ctx.contentType));

      // No ledger event is written, and that is deliberate rather than an
      // omission. The hash was committed by the domain command that registered
      // the evidence; bytes that hash to it add no assertion, and bytes that do
      // not are refused above. There is no new fact to record, and inventing an
      // event type to record a non-fact would widen a closed catalogue.
      return { ...stored, evidenceId: record.refId, projectId: record.projectId };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/evidence/:hash',
    binary: true,
    // Public so a signed link works without a session — which is the only thing
    // a signed link is for. The handler refuses anyone who has neither a valid
    // signature nor an authorised identity.
    public: true,
    description: 'Fetch a stored evidence file, by session or by signed link',
    handler: (platform, ctx) => {
      const hash = ctx.params.hash as string;
      const tenantId = signedTenant(platform, ctx) ?? sessionTenant(platform, ctx, hash);

      const file = platform.evidence.get(tenantId, hash);
      return {
        contentType: file.contentType,
        // Named by its hash. The original filename is not in the record — the
        // chain is over content, not over what a device happened to call it —
        // and inventing one would put a name on a file that nothing attests to.
        filename: `${hash.replace(':', '-')}${extensionFor(file.contentType)}`,
        bytes: file.bytes,
        // Inline only for the few types a browser renders without executing
        // anything. Everything else downloads: served inline, an uploaded HTML
        // file would be stored cross-site scripting on the platform's origin.
        disposition: INLINE_TYPES.has(file.contentType) ? ('inline' as const) : ('attachment' as const),
      };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/evidence/:hash/link',
    readOnly: true,
    description: 'Mint an expiring link to a stored evidence file',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      const hash = ctx.params.hash as string;
      const record = evidence.findByHash(platform.ledger, actor.tenantId, hash);
      if (!record) throw new NotFoundError('No evidence record in this tenancy references that hash');

      const engineCtx = platform.context(actor, record.projectId, {
        correlationId: ctx.correlationId,
        source: sourceOf(ctx),
      });
      authorise(engineCtx, 'EVIDENCE_AUDIT', 'R');

      if (!platform.evidence.has(actor.tenantId, hash)) {
        throw new NotFoundError('The platform holds no bytes for this evidence');
      }
      return platform.evidence.signedUrl(actor.tenantId, hash);
    },
  },

  // --- Perception ingestion --------------------------------------------------
  //
  // Reading a file the platform holds: a drawing title block, quantities off a
  // sheet, a site voice note. One pipeline, three tasks. An extraction is
  // always a draft — confirming it runs the ordinary domain command, so
  // machine-read data reaches the register through the same door as typed data.
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/perception',
    readOnly: true,
    description: 'What this deployment can read from a file, and the drafts awaiting confirmation',
    handler: (platform, ctx) => {
      const engineCtx = projectContext(platform, ctx);
      authorise(engineCtx, 'EVIDENCE_AUDIT', 'R');
      return {
        capability: perception.perceptionCapability(engineCtx),
        drafts: perception.drafts(engineCtx),
      };
    },
  },
  // One route per task rather than one route with a task parameter. The cost of
  // an AI action is quoted from the route it is on, and a single route carrying
  // three different engines and three different cost profiles cannot be quoted
  // at all — which would make this the one AI action in the platform that
  // spends money without showing a price first.
  ...(Object.entries(perception.PERCEPTION_TASKS) as Array<[perception.PerceptionTask, (typeof perception.PERCEPTION_TASKS)[perception.PerceptionTask]]>)
    .map(([task, definition]): Route => ({
      method: 'POST',
      pattern: `/v1/projects/:projectId/perception/${PERCEPTION_PATHS[task]}`,
      description: `${definition.label} — reads a stored evidence file and produces a draft for confirmation`,
      schema: {
        type: 'object',
        required: ['hash'],
        properties: { hash: stringField },
        additionalProperties: false,
      },
      ai: { engine: definition.engine, taskType: definition.taskType, capability: 'PERCEPTION' },
      handler: (platform, ctx) =>
        perception.extract(projectContext(platform, ctx), platform.evidence, {
          ...body<{ hash: string }>(ctx),
          task,
        }),
    })),
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/perception/:draftId/confirm',
    description: 'Confirm an extraction, with corrections, and run the domain command it feeds',
    schema: {
      type: 'object',
      properties: {
        // The shape of a correction is the shape of the extraction, which
        // differs per task — a title block, an array of measured items, a
        // transcript — so this is checked by the engine against the draft's own
        // task rather than pinned here. What the schema does enforce is that
        // nothing else arrives: the three fields below name where a confirmed
        // extraction is filed, and a stray property in this body would be a
        // caller trying to redirect it.
        corrections: { type: 'object' },
        packageId: stringField,
        costCodePrefix: stringField,
        observedBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      perception.confirm(projectContext(platform, ctx), {
        draftId: ctx.params.draftId as string,
        ...body<{ corrections?: Record<string, unknown> }>(ctx),
      }),
  },
  // --- The command catalogue -------------------------------------------------
  //
  // Every write route, with the schema that governs its body.
  //
  // This exists because 78 of 156 write routes had no console entry point: the
  // capability was there and the door to it was not, which is the likeliest
  // reason a reviewer concludes there is nowhere to put information in. The
  // alternative was 78 hand-written forms, each restating a schema the platform
  // already owns — settled decision 6 says the interface holds no rule the API
  // does not publish, and a field list is a rule.
  //
  // So the console renders a door from the schema. Curated panels stay where
  // they exist, because a good label and a real dropdown beat a generated one;
  // everything else gets a generated door rather than no door.
  //
  // Authenticated, unlike `/v1/routes`. The route list is a catalogue of what
  // exists; this is the shape of every request body the platform accepts, which
  // is a different thing to hand to an anonymous caller.
  {
    method: 'GET',
    pattern: '/v1/commands',
    readOnly: true,
    description: 'Every write command with the schema that governs it, so the console can render a door for each',
    handler: (_platform, ctx) => {
      auth(ctx);
      const commands = ROUTES.filter((route) => route.method !== 'GET' && route.public !== true).map((route) => ({
        id: `${route.method} ${route.pattern}`,
        method: route.method,
        path: route.pattern,
        description: route.description,
        // The path parameters a caller has to supply. `projectId` is the
        // session's; the rest name a record and the form has to ask.
        params: route.pattern
          .split('/')
          .filter((segment) => segment.startsWith(':'))
          .map((segment) => segment.slice(1)),
        schema: route.schema,
        // A generated form must not be able to spend money silently: where a
        // route reaches a provider the console quotes it first, exactly as a
        // curated panel does.
        ai: route.ai,
        upload: route.upload === true,
      }));

      return {
        commands,
        // Said out loud rather than left to be counted. A route with no schema
        // takes an unvalidated body, and a generated form for it can only offer
        // free text — the console says so instead of implying a checked form.
        withoutSchema: commands.filter((command) => !command.schema).length,
      };
    },
  },

  // --- Signing ---------------------------------------------------------------
  //
  // A witnessed signature, and the record says so: the platform attests that an
  // identity it authenticated, with multi-factor satisfied, affirmed a named
  // document hash at a recorded time. The signing key is the platform's, not the
  // signatory's, so this is a simple electronic signature with an evidenced
  // trail — not an advanced or qualified one, and it never claims to be.
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/signatures',
    readOnly: true,
    description: 'Signature requests and signatures, each re-verified as it is read',
    handler: (platform, ctx) => {
      const engineCtx = projectContext(platform, ctx);
      authorise(engineCtx, 'EVIDENCE_AUDIT', 'R');
      return signing.signatureRegister(engineCtx, platform.signing);
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/signatures',
    description: 'Ask named people to sign a document the platform holds',
    schema: {
      type: 'object',
      required: ['documentHash', 'purpose', 'area', 'requiredSignatories'],
      properties: {
        documentHash: stringField,
        purpose: { type: 'string', minLength: 4 },
        // The capability area the document belongs to. It decides who may ask
        // and who may sign, so it is chosen from the platform's own list rather
        // than free text.
        area: { type: 'string', enum: CAPABILITY_AREAS },
        dueBy: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        requiredSignatories: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['actorId', 'name', 'capacity'],
            properties: { actorId: stringField, name: stringField, capacity: stringField },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      signing.requestSignature(projectContext(platform, ctx), platform.signing, platform.evidence, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/signatures/:requestId/sign',
    description: 'Sign a document, witnessed by the platform',
    schema: {
      type: 'object',
      required: ['signatoryName', 'affirmation'],
      properties: {
        signatoryName: stringField,
        capacity: stringField,
        // What the person is agreeing to, in their words. A signature with no
        // affirmation records a click.
        affirmation: { type: 'string', minLength: 4 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      signing.signDocument(projectContext(platform, ctx), platform.signing, {
        requestId: ctx.params.requestId as string,
        ...body<{ signatoryName: string; affirmation: string }>(ctx),
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/signatures/:requestId/decline',
    description: 'Refuse to sign, saying why. The refusal is the record',
    schema: {
      type: 'object',
      required: ['reason'],
      properties: { reason: { type: 'string', minLength: 4 } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      signing.declineSignature(projectContext(platform, ctx), {
        requestId: ctx.params.requestId as string,
        ...body<{ reason: string }>(ctx),
      }),
  },

  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/perception/:draftId/discard',
    description: 'Reject an extraction, saying why. What the model read stays in the record',
    schema: {
      type: 'object',
      required: ['reason'],
      properties: { reason: { type: 'string', minLength: 4 } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      perception.discard(projectContext(platform, ctx), {
        draftId: ctx.params.draftId as string,
        ...body<{ reason: string }>(ctx),
      }),
  },
];

/**
 * The tenancy a signed link names, if the signature over it is good.
 *
 * Returns undefined when there is no link to check, so the caller falls through
 * to session authorisation. A link that is present but bad is a refusal, never
 * a fallthrough — otherwise a forged signature would quietly become an
 * unauthenticated request and get the ordinary 401.
 */
function signedTenant(platform: Platform, ctx: RequestContext): string | undefined {
  const signature = ctx.query.get('signature');
  const tenant = ctx.query.get('tenant');
  const expires = ctx.query.get('expires');
  if (!signature && !tenant && !expires) return undefined;

  if (!signature || !tenant || !expires) throw new ForbiddenError('Incomplete signed link', 'EVIDENCE_LINK_INVALID');
  if (!platform.evidence.verifySignedUrl(tenant, ctx.params.hash as string, Number(expires), signature)) {
    throw new ForbiddenError('This link is not valid, or has expired', 'EVIDENCE_LINK_INVALID');
  }
  return tenant;
}

/** The tenancy an authenticated caller may read this evidence in. */
function sessionTenant(platform: Platform, ctx: RequestContext, hash: string): string {
  // The route is public so a signed link works; an anonymous caller who brought
  // no link and no credential is unauthenticated rather than forbidden, and
  // saying so is the difference between "sign in" and "you may not have this".
  // On every other route the gateway raises this before a handler is reached.
  if (!ctx.auth) throw new AuthError('Evidence requires a session or a signed link');
  const actor = auth(ctx);
  if (actor.roles.includes('PLATFORM_ADMIN')) {
    throw new ForbiddenError('Platform operators are barred from customer delivery data', 'ACCOUNT_LAYER_SEPARATION');
  }

  const record = evidence.findByHash(platform.ledger, actor.tenantId, hash);
  if (!record) throw new NotFoundError('No evidence record in this tenancy references that hash');

  const engineCtx = platform.context(actor, record.projectId, { correlationId: ctx.correlationId });
  authorise(engineCtx, 'EVIDENCE_AUDIT', 'R');
  return actor.tenantId;
}

/**
 * Types a browser renders without running anything in them.
 *
 * Deliberately short. SVG is absent and stays absent: it is a document format
 * that carries script, so an inline SVG is the exact attack the nosniff and
 * sandbox headers exist to contain, and there is no reason to rely on them
 * when the file can simply download instead.
 */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);

const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/csv': '.csv',
};

function extensionFor(contentType: string): string {
  return EXTENSIONS[contentType] ?? '';
}

/**
 * The media type from a `Content-Type` header, with the parameters dropped.
 *
 * Whitelisted rather than sanitised: this string is written to disk beside the
 * object and later sent back as a response header, and a header value the
 * caller controls without constraint is a response-splitting question nobody
 * should have to think about twice.
 */
function mediaType(header: string | undefined): string {
  const declared = (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(declared)
    ? declared
    : 'application/octet-stream';
}

/** Match a path against the routing table, extracting params. */
export function matchRoute(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
  const segments = path.split('/').filter(Boolean);

  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const patternSegments = route.pattern.split('/').filter(Boolean);
    if (patternSegments.length !== segments.length) continue;

    const params: Record<string, string> = {};
    let matched = true;

    for (let i = 0; i < patternSegments.length; i++) {
      const pattern = patternSegments[i] as string;
      const segment = segments[i] as string;
      if (pattern.startsWith(':')) {
        params[pattern.slice(1)] = decodeURIComponent(segment);
      } else if (pattern !== segment) {
        matched = false;
        break;
      }
    }

    if (matched) return { route, params };
  }

  return undefined;
}
