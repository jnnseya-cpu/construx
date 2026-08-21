import { CONTINENT, SECTOR, SITE_OBSERVATION_CATEGORY, WEATHER_CONDITION, values } from '../../../shared/vocabulary.js';
import { ask } from '../ai/conversation.ts';
import * as signup from '../identity/signup.ts';
import * as erasure from '../identity/erasure.ts';
import * as site from '../site/index.ts';
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
import { DomainError, ForbiddenError, NotFoundError } from '../core/errors.ts';
import type { Schema } from '../core/validate.ts';
import * as business from '../domain/business.ts';
import * as cdm from '../domain/cdm.ts';
import * as portfolio from '../domain/portfolio.ts';
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
import { unsubscribePage } from '../messaging/render.ts';
import { evaluateAccess, WRITE_PHASE_GATES } from '../identity/abac.ts';
import { createMfaChallenge, refreshTokens, shapeMfaResponse, verifyMfaChallenge, type AuthContext } from '../identity/auth.ts';
import { classifyEntity } from '../identity/entityAccess.ts';
import { FIELD_FORBIDDEN_EVENTS } from '../field/sync.ts';
import { ownershipMap } from '../identity/ownership.ts';
import { PERMISSION_MATRIX, type CapabilityArea, type PermissionCode } from '../identity/roles.ts';
import { authorise, AUTHZ_OPTIONS, currentPhase } from '../engines/context.ts';
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
    handler: (platform, ctx) => {
      const { email } = body<{ email: string }>(ctx);
      const user = platform.userByEmail(email);
      if (!user) throw new NotFoundError('No user with that email address');
      const challenge = createMfaChallenge(user.id);
      return {
        ...shapeMfaResponse(challenge),
        // The challenge code is returned only outside production, so the demo
        // and local development do not need an SMS gateway.
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
          };
        }),
      };
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
    handler: (platform, ctx) => radar.setCompanyProfile(tenantContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/radar/run',
    description: 'Screen a batch of tender notices against the company profile',
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
    handler: (platform, ctx) => control.captureLesson(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/pipeline/supply-chain-evidence',
    description: 'What the register says about the trades an opportunity needs',
    handler: (platform, ctx) =>
      business.supplyChainEvidence(tenantContext(platform, ctx), body<{ trades: string[] }>(ctx).trades ?? []),
  },
  {
    method: 'POST',
    pattern: '/v1/pipeline/opportunities',
    description: 'Register an opportunity — the head of the delivery chain',
    handler: (platform, ctx) => business.registerOpportunity(tenantContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/pipeline/opportunities/:opportunityId/qualify',
    description: 'Score an opportunity against the six weighted criteria',
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
    handler: (platform, ctx) => quality.createInspectionPlan(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/quality/inspections',
    description: 'Record an inspection against an ITP stage; a failure raises an NCR',
    handler: (platform, ctx) => quality.recordInspection(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/quality/ncrs',
    description: 'Raise a non-conformance',
    handler: (platform, ctx) => quality.raiseNCR(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/quality/ncrs/:ncrId/close',
    description: 'Close a non-conformance with a disposition and a justification',
    handler: (platform, ctx) =>
      quality.closeNCR(projectContext(platform, ctx), ctx.params.ncrId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/quality/snags/:snagId/close',
    description: 'Close a snag with photographic evidence',
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
    handler: (platform, ctx) => supplychain.registerSupplier(tenantContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/supply-chain/suppliers/:supplierId/prequalify',
    description: 'Assess a supplier and classify them Strategic, Approved, Conditional or Do Not Use',
    handler: (platform, ctx) =>
      supplychain.prequalifySupplier(tenantContext(platform, ctx), ctx.params.supplierId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/supply-chain/suppliers/:supplierId/suspend',
    description: 'Suspend a supplier immediately, with a reason',
    handler: (platform, ctx) =>
      supplychain.suspendSupplier(tenantContext(platform, ctx), ctx.params.supplierId as string, body(ctx)),
  },

  // --------------------------------------------------------- framework agreements
  {
    method: 'POST',
    pattern: '/v1/frameworks/recommend',
    description: 'Size and shape a framework from turnover and what the business builds',
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
    handler: (platform, ctx) =>
      framework.admitToFramework(tenantContext(platform, ctx), ctx.params.frameworkId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/frameworks/:frameworkId/call-off',
    description: 'Apply the framework call-off rule to a package and return who to invite',
    handler: (platform, ctx) =>
      framework.callOff(tenantContext(platform, ctx), ctx.params.frameworkId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/frameworks/:frameworkId/awards',
    description: 'Record a framework award so rotation and concentration stay real',
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
    handler: (platform, ctx) => cdm.draftDocument(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cdm/documents/:documentId/approve',
    description: 'Approve a CDM document — refused while a required section is unfilled',
    handler: (platform, ctx) =>
      cdm.approveDocument(projectContext(platform, ctx), ctx.params.documentId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cdm/inductions',
    description: 'Record a site induction',
    handler: (platform, ctx) => cdm.recordInduction(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cdm/toolbox-talks',
    description: 'Record a toolbox talk and its attendance',
    handler: (platform, ctx) => cdm.recordToolboxTalk(projectContext(platform, ctx), body(ctx)),
  },

  // -------------------------------------------------------------------- HSEQ
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
    handler: (platform, ctx) => safety.recordIncident(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/safety/training',
    description: 'Record completed training against a competency, with its expiry',
    handler: (platform, ctx) => safety.recordTraining(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/risks/:riskId/mitigation',
    description: 'Add a mitigation to a risk and re-score the residual position',
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

      // Deliberately no tokens. Completing a registration produces an account,
      // not a session — the person signs in through /v1/auth/login and MFA like
      // any other client. Returning a token here would rebuild the anonymous
      // login hole through a different door.
      return {
        status: 'VERIFIED',
        enterpriseName: activation.enterpriseName,
        email: user.email,
        signInPath: '/app',
        message: 'Your account is ready. Sign in with this address to continue.',
      };
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
    handler: (platform, ctx) => structure.createScopePackage(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design-maturity',
    description: 'Assess design maturity for a package',
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
    handler: (platform, ctx) => tender.runTakeoff(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender/estimate',
    description: 'Engine A — build a bottom-up estimate across the twenty tender cost heads',
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
    handler: (platform, ctx) => tender.respondToTender(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender/itt',
    description: 'Analyse an invitation to tender: compliance matrix and commercial terms',
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
    handler: (platform, ctx) =>
      tender.modelTenderFunding(projectContext(platform, ctx), ctx.params.estimateId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender/estimate/:estimateId/freeze',
    description: 'Engine A — freeze the estimate',
    handler: (platform, ctx) =>
      tender.freezeEstimate(projectContext(platform, ctx), ctx.params.estimateId as string, body<{ reason: string }>(ctx).reason),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender/package',
    ai: { engine: 'TENDER', taskType: 'package_composition', capability: 'REASONING' },
    description: 'Engine A — compose a tender package',
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
    ai: { engine: 'TENDER', taskType: 'return_variance_analysis', capability: 'REASONING' },
    handler: (platform, ctx) => tender.analyseReturns(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender/evaluate',
    description: 'Engine A — evaluate bids deterministically',
    handler: (platform, ctx) => tender.evaluateSubmissions(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender/adjudicate',
    description: 'Engine A — adjudicate and select',
    handler: (platform, ctx) => tender.adjudicate(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender/bid-pack',
    description: 'Engine A — compile and lock the bid submission pack',
    handler: (platform, ctx) => tender.compileBidPack(projectContext(platform, ctx), body(ctx)),
  },

  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/procurement/rfq',
    description: 'Create an RFQ (design maturity gated)',
    handler: (platform, ctx) => procurement.createRFQ(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/procurement/rfq/:rfqId/issue',
    description: 'Issue an RFQ to the invited supply chain',
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
    handler: (platform, ctx) =>
      procurement.receiveSubmission(projectContext(platform, ctx), { ...body<Omit<Parameters<typeof procurement.receiveSubmission>[1], 'rfqId'>>(ctx), rfqId: ctx.params.rfqId as string }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/procurement/rfq/:rfqId/award',
    description: 'Award the RFQ against an adjudication',
    handler: (platform, ctx) =>
      procurement.awardRFQ(projectContext(platform, ctx), { ...body<Omit<Parameters<typeof procurement.awardRFQ>[1], 'rfqId'>>(ctx), rfqId: ctx.params.rfqId as string }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/procurement/subcontract',
    description: 'Assemble a subcontract from the award',
    handler: (platform, ctx) => procurement.assembleSubcontract(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/procurement/subcontract/:subcontractId/execute',
    description: 'Execute the subcontract and raise the commitment',
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
    handler: (platform, ctx) => ({
      taskIds: planning.createTasks(projectContext(platform, ctx), body<{ tasks: Parameters<typeof planning.createTasks>[1] }>(ctx).tasks),
    }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/programme/dependencies',
    description: 'Engine B — link activities',
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
    handler: (platform, ctx) => planning.approveBaseline(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/programme/wbs',
    ai: { engine: 'PLANNING', taskType: 'wbs_generation', capability: 'REASONING' },
    description: 'Engine B — generate a work breakdown structure',
    handler: (platform, ctx) => planning.generateWBS(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/programme/delay-forecast',
    ai: { engine: 'PLANNING', taskType: 'delay_risk_forecast', capability: 'REASONING' },
    description: 'Engine B — forecast delay risk with corrective measures',
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
    handler: (platform, ctx) =>
      planning.whatIf(projectContext(platform, ctx), body<{ changes: Parameters<typeof planning.whatIf>[1] }>(ctx).changes),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/progress',
    description: 'Record measured progress against an activity',
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
    handler: (platform, ctx) => planning.publishLookahead(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/lookahead/:lookaheadId/review',
    description: 'Review the week and compute Percent Plan Complete',
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
    handler: (platform, ctx) => cost.approveBudget(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cost/actuals',
    description: 'Engine C — post actual cost',
    handler: (platform, ctx) => ({ actualCostId: cost.postActualCost(projectContext(platform, ctx), body(ctx)) }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cost/evm',
    description: 'Engine C — take an earned value snapshot',
    handler: (platform, ctx) => cost.takeEVMSnapshot(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cost/cvr',
    ai: { engine: 'RESOURCE_COST', taskType: 'cvr_analysis', capability: 'REASONING' },
    description: 'Engine C — publish the live CVR',
    handler: (platform, ctx) => cost.publishCVR(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cost/cashflow',
    description: 'Engine C — forecast cashflow on an S-curve',
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
    method: 'GET',
    pattern: '/v1/projects/:projectId/cost/ledger',
    description: 'Engine C — committed vs certified vs paid, with exceptions',
    handler: (platform, ctx) => cost.ledgerPosition(projectContext(platform, ctx)),
  },

  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/risk',
    description: 'Engine D — register and score a risk',
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
    handler: (platform, ctx) => safety.draftRAMS(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/safety/rams/:ramsId/approve',
    description: 'Engine D — approve a RAMS',
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
    handler: (platform, ctx) => safety.logSafetyObservation(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/safety/forecast',
    ai: { engine: 'RISK_SAFETY', taskType: 'safety_forecast', capability: 'REASONING' },
    description: 'Engine D — predictive safety forecast',
    handler: (platform, ctx) => safety.forecastSafetyRisk(projectContext(platform, ctx), body(ctx)),
  },

  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/bim/drawings',
    ai: { engine: 'BIM_TWIN', taskType: 'title_block_extraction', capability: 'PERCEPTION' },
    description: 'Engine E — register a drawing and supersede prior revisions',
    handler: (platform, ctx) => bim.registerDrawing(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/bim/markups',
    description: 'Engine E — add a markup, optionally converting it to an RFI or instruction',
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
    pattern: '/v1/projects/:projectId/rfi/position',
    description: 'The RFI register as a delay exhibit: what is overdue and for how long',
    handler: (platform, ctx) => bim.rfiPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/bim/models',
    ai: { engine: 'BIM_TWIN', taskType: 'model_ingestion', capability: 'PERCEPTION' },
    description: 'Engine E — ingest a model',
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
    handler: (platform, ctx) => bim.updateTwinFromSite(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/bim/as-built',
    ai: { engine: 'BIM_TWIN', taskType: 'as_built_generation', capability: 'REASONING' },
    description: 'Engine E — generate the as-built record',
    handler: (platform, ctx) => bim.generateAsBuilt(projectContext(platform, ctx), body(ctx)),
  },

  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/contracts',
    description: 'Engine F — create a contract',
    handler: (platform, ctx) => claims.createContract(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/contracts/from-bid',
    description: 'Engine F — convert a locked bid pack into a contract',
    handler: (platform, ctx) => claims.convertBidToContract(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/contracts/:contractId/intelligence',
    ai: { engine: 'CONTRACTS_CLAIMS', taskType: 'clause_extraction', capability: 'REASONING' },
    description: 'Engine F — extract clauses and register obligations',
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
    handler: (platform, ctx) => claims.submitChangeRequest(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/changes/:changeRequestId/impact',
    ai: { engine: 'CONTRACTS_CLAIMS', taskType: 'impact_assessment', capability: 'REASONING' },
    description: 'Engine F — assess change impact',
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
    handler: (platform, ctx) => claims.instructVariation(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/variations/domestic',
    description: 'Engine F — flag a domestic variation from a trade application',
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
    pattern: '/v1/projects/:projectId/variations/register',
    description: 'Engine F — the variation control matrix, both sides of every change',
    handler: (platform, ctx) => claims.variationRegister(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/delay-events',
    description: 'Engine F — record an evidenced delay event',
    handler: (platform, ctx) => claims.recordDelayEvent(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/claims',
    ai: { engine: 'CONTRACTS_CLAIMS', taskType: 'claim_assessment', capability: 'REASONING' },
    description: 'Engine F — assess a delay claim with concurrency',
    handler: (platform, ctx) => claims.assessDelayClaim(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/claims/:claimId/evidence-pack',
    ai: { engine: 'CONTRACTS_CLAIMS', taskType: 'evidence_pack_narrative', capability: 'REASONING' },
    description: 'Engine F — build a verifiable evidence pack',
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
    handler: (platform, ctx) => handover.recordCommissioningTest(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/commissioning/:testId/accept',
    description: 'Engine G — accept a commissioned system',
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
    handler: (platform, ctx) => handover.compileHandoverPack(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/handover/accept',
    description: 'Engine G — accept handover',
    handler: (platform, ctx) => {
      handover.acceptHandover(projectContext(platform, ctx), body(ctx));
      return { accepted: true };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/assets',
    description: 'Engine G — register an asset',
    handler: (platform, ctx) => handover.registerAsset(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/om/manual',
    ai: { engine: 'HANDOVER_OM', taskType: 'om_manual_generation', capability: 'PERCEPTION' },
    description: 'Engine G — publish an O&M manual',
    handler: (platform, ctx) => handover.publishOMManual(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/defects',
    description: 'Engine G — raise a defect with warranty check',
    handler: (platform, ctx) => handover.raiseDefect(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/work-orders',
    description: 'Engine G — raise a work order',
    handler: (platform, ctx) => handover.raiseWorkOrder(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/om/maintenance-forecast',
    ai: { engine: 'HANDOVER_OM', taskType: 'maintenance_forecast', capability: 'REASONING' },
    description: 'Engine G — predictive maintenance forecast',
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
      const actor = authoriseTenant(ctx, 'BILLING_ACU', 'U');
      platform.topUp(actor.tenantId, body<{ amountMinor: number }>(ctx).amountMinor);
      return platform.wallet(actor.tenantId).snapshot();
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
      required: ['period'],
      properties: { period: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      platform.issueInvoice(authoriseTenant(ctx, 'BILLING_ACU', 'U').tenantId, body<{ period: string }>(ctx).period),
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
];

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
