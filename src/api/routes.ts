import { ask } from '../ai/conversation.ts';
import { TIERS } from '../billing/subscription.ts';
import { config } from '../config.ts';
import { DomainError, ForbiddenError, NotFoundError } from '../core/errors.ts';
import type { Schema } from '../core/validate.ts';
import * as procurement from '../domain/procurement.ts';
import * as structure from '../domain/structure.ts';
import * as bim from '../engines/bim.ts';
import * as claims from '../engines/claims.ts';
import * as cost from '../engines/cost.ts';
import * as handover from '../engines/handover.ts';
import * as planning from '../engines/planning.ts';
import * as safety from '../engines/safety.ts';
import * as tender from '../engines/tender.ts';
import { replayProject, replayTimeline } from '../goldenthread/replay.ts';
import { evaluateAccess } from '../identity/abac.ts';
import { createMfaChallenge, refreshTokens, shapeMfaResponse, verifyMfaChallenge } from '../identity/auth.ts';
import { classifyEntity } from '../identity/entityAccess.ts';
import { PERMISSION_MATRIX } from '../identity/roles.ts';
import { AUTHZ_OPTIONS } from '../engines/context.ts';
import { LIFECYCLE_ORDER, PHASE_GATES } from '../lifecycle/phases.ts';
import type { Platform } from '../platform.ts';
import type { ExportAudience, ExportFormat } from '../export/exporter.ts';
import { metrics, recentLogs, type RequestContext } from './middleware.ts';

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
  schema?: Schema;
  description: string;
};

function body<T>(ctx: RequestContext): T {
  return (ctx.body ?? {}) as T;
}

function auth(ctx: RequestContext) {
  if (!ctx.auth) throw new ForbiddenError('Authenticated context required');
  return ctx.auth;
}

function projectContext(platform: Platform, ctx: RequestContext) {
  const projectId = ctx.params.projectId;
  if (!projectId) throw new NotFoundError('Project id missing from path');
  // Refuse the operator layer here rather than letting it fail later on a
  // missing wallet: the answer is "you are not allowed", not "not found".
  if (auth(ctx).roles.includes('PLATFORM_ADMIN')) {
    throw new ForbiddenError('Platform operators are barred from customer delivery data', 'ACCOUNT_LAYER_SEPARATION');
  }
  return platform.context(auth(ctx), projectId, { correlationId: ctx.correlationId, source: sourceOf(ctx) });
}

function sourceOf(ctx: RequestContext): 'WEB' | 'ANDROID' | 'IOS' | 'SYSTEM' {
  const client = ctx.query.get('client');
  return client === 'android' ? 'ANDROID' : client === 'ios' ? 'IOS' : 'WEB';
}

const stringField = { type: 'string', minLength: 1 } as const;

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
        ...(config.env === 'production' ? {} : { devCode: challenge.code }),
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
      return { logs: recentLogs(200), metrics: metrics() };
    },
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
    pattern: '/v1/console/identities',
    public: true,
    description: 'List the seeded demonstration identities so any role can be signed into',
    handler: async (platform) => {
      if (config.env === 'production') {
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
    pattern: '/v1/permissions/matrix',
    description: 'The enforceable permission matrix',
    handler: () => ({ matrix: PERMISSION_MATRIX }),
  },

  // ----------------------------------------------------------------- console
  {
    method: 'POST',
    pattern: '/v1/console/session',
    public: true,
    description: 'Bootstrap a console session against the seeded demonstration project',
    handler: async (platform) => {
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
        continentCode: { type: 'string' },
        countryCode: { type: 'string' },
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
        sectorType: { type: 'string', enum: ['BUILDING', 'INFRASTRUCTURE', 'SPECIALISED'] },
        assetType: stringField,
        location: { type: 'object' },
        contractValueMinor: { type: 'integer', minimum: 0 },
        currency: stringField,
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
    description: 'Engine A — run a take-off and create BoQ items',
    handler: (platform, ctx) => tender.runTakeoff(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender/estimate',
    description: 'Engine A — build a bottom-up estimate',
    handler: (platform, ctx) => tender.buildEstimate(projectContext(platform, ctx), body(ctx)),
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
    description: 'Engine A — compose a tender package',
    handler: (platform, ctx) => tender.composeTenderPackage(projectContext(platform, ctx), body(ctx)),
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
    description: 'Engine B — generate a work breakdown structure',
    handler: (platform, ctx) => planning.generateWBS(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/programme/delay-forecast',
    description: 'Engine B — forecast delay risk with corrective measures',
    handler: (platform, ctx) => planning.forecastDelay(projectContext(platform, ctx), body(ctx)),
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
    handler: (platform, ctx) => cost.generatePaymentSchedule(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cost/application',
    description: 'Engine C — submit a payment application',
    handler: (platform, ctx) => cost.submitApplication(projectContext(platform, ctx), body(ctx)),
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
    method: 'GET',
    pattern: '/v1/projects/:projectId/risk/contingency',
    description: 'Engine D — contingency requirement (expected and P80)',
    handler: (platform, ctx) => safety.assessContingency(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/safety/rams',
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
    description: 'Engine D — log a safety observation',
    handler: (platform, ctx) => safety.logSafetyObservation(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/safety/forecast',
    description: 'Engine D — predictive safety forecast',
    handler: (platform, ctx) => safety.forecastSafetyRisk(projectContext(platform, ctx), body(ctx)),
  },

  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/bim/drawings',
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
    pattern: '/v1/projects/:projectId/bim/models',
    description: 'Engine E — ingest a model',
    handler: (platform, ctx) => bim.ingestModel(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/bim/clashes',
    description: 'Engine E — detect and triage clashes',
    handler: (platform, ctx) => bim.detectClashes(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/bim/twin',
    description: 'Engine E — update the twin from site reality',
    handler: (platform, ctx) => bim.updateTwinFromSite(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/bim/as-built',
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
    pattern: '/v1/projects/:projectId/delay-events',
    description: 'Engine F — record an evidenced delay event',
    handler: (platform, ctx) => claims.recordDelayEvent(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/claims',
    description: 'Engine F — assess a delay claim with concurrency',
    handler: (platform, ctx) => claims.assessDelayClaim(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/claims/:claimId/evidence-pack',
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
    description: 'Engine G — predictive maintenance forecast',
    handler: (platform, ctx) => handover.forecastMaintenance(projectContext(platform, ctx), body(ctx)),
  },

  // ---------------------------------------------------------------- copilot
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
    description: 'Raw Golden Thread events for the project',
    handler: (platform, ctx) => ({
      chainHead: platform.ledger.chainHead(ctx.params.projectId as string),
      events: platform.ledger.events({ tenantId: auth(ctx).tenantId, projectId: ctx.params.projectId as string }),
    }),
  },

  // ----------------------------------------------------------------- billing
  {
    method: 'GET',
    pattern: '/v1/billing/wallet',
    description: 'ACU wallet position, caps and alerts',
    handler: (platform, ctx) => platform.wallet(auth(ctx).tenantId).snapshot(),
  },
  {
    method: 'GET',
    pattern: '/v1/billing/attribution',
    description: 'AI cost attribution by engine',
    handler: (platform, ctx) => ({
      attribution: platform.wallet(auth(ctx).tenantId).attributionByModule(ctx.query.get('month') ?? undefined),
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
      platform.topUp(auth(ctx).tenantId, body<{ amountMinor: number }>(ctx).amountMinor);
      return platform.wallet(auth(ctx).tenantId).snapshot();
    },
  },
  {
    method: 'POST',
    pattern: '/v1/billing/caps',
    description: 'Set monthly, per-project and per-module AI spend caps',
    handler: (platform, ctx) => {
      platform.wallet(auth(ctx).tenantId).setCaps(body(ctx));
      return platform.wallet(auth(ctx).tenantId).snapshot();
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
    handler: (platform, ctx) => platform.issueInvoice(auth(ctx).tenantId, body<{ period: string }>(ctx).period),
  },
  {
    method: 'GET',
    pattern: '/v1/ai/control-plane',
    description: 'AI routing matrix and provider health',
    handler: (platform) => platform.orchestrator.controlPlaneStatus(),
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
