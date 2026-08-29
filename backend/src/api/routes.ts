import { CHANGE_ORIGIN, CONTINENT, CONTRACT_FORM, COUNTRY, DELAY_CAUSE, NOTICE_TYPE, SECTOR, SITE_OBSERVATION_CATEGORY, WEATHER_CONDITION, values } from '../../../shared/vocabulary.js';
import { ask } from '../ai/conversation.ts';
import * as storage from '../billing/storage.ts';
import * as stripe from '../billing/stripe.ts';
import * as koda from '../billing/koda.ts';
import * as signup from '../identity/signup.ts';
import * as erasure from '../identity/erasure.ts';
import * as site from '../site/index.ts';
// Read from the data module rather than through the site barrel: `pages.ts`
// reads this route table, so importing the posts through it would make this
// file depend on a module that depends on this file.
import { POST_PAGES } from '../site/posts.ts';
import * as views from '../site/views.ts';
import * as booking from '../site/booking.ts';
import { SIGNATURES } from '../site/media.ts';
import { createHash } from 'node:crypto';
import * as notifications from '../notifications/catalogue.ts';
import { CATEGORIES, CATEGORY_TITLES, NOTIFICATION_EVENTS } from '../notifications/catalogue.ts';
import * as notifyEngine from '../notifications/notify.ts';
import * as preferences from '../notifications/preferences.ts';
import * as notificationRender from '../notifications/render.ts';
import type { Engine } from '../ai/orchestrator.ts';
import type { ProviderCapability } from '../ai/providers/types.ts';
import * as agents from '../agents/runtime.ts';
import { fleetManifest } from '../agents/runtime.ts';
import { AUTOMATABLE_COMMANDS, LADDER, envelopeRegister, grantEnvelope, revokeEnvelope } from '../agents/mandate.ts';
import { egressPosition, flush as flushEgress } from '../ops/otlp.ts';
import { assurancePosition, sweep } from '../ops/assurance.ts';
import { blueprintPosition } from '../ops/blueprint.ts';
import { eventStorePosition, platformEventStream } from '../ops/eventstore.ts';
import * as reports from '../ops/reports.ts';
import { forecastPosition } from '../ops/forecast.ts';
import * as growth from '../growth/partners.ts';
import * as support from '../support/queue.ts';
import { latencySummaries, performancePosition } from '../ops/performance.ts';
import { repair, repairPosition } from '../ops/repair.ts';
import { centreCatalogue, commandCentre, type CentreFunctionId } from '../commandcentre/centre.ts';
import { grantableScopes, issueKey, keyRegister, revokeKey } from '../developer/keys.ts';
import { subscribe, subscriptionRegister, unsubscribe, webhookPosition } from '../developer/webhooks.ts';
import type { ACUCaps } from '../billing/acu.ts';
import { ACU_BUNDLES, PACKAGES, SEATS } from '../billing/seats.ts';
import { seatEconomics, TIERS, type SubscriptionTier } from '../billing/subscription.ts';
import { config, demonstrationEnabled, isProduction } from '../config.ts';
import * as consistency from '../domain/consistency.ts';
import { CURRENCIES, JURISDICTIONS } from '../domain/locale.ts';
import { AuthError, DomainError, ForbiddenError, NotFoundError, ValidationError } from '../core/errors.ts';
import type { Schema } from '../core/validate.ts';
import * as business from '../domain/business.ts';
import * as cdm from '../domain/cdm.ts';
import { CDM_DOCUMENTS } from '../domain/cdm.ts';
import * as portfolio from '../domain/portfolio.ts';
import * as commitments from '../domain/commitments.ts';
import * as invitation from '../domain/invitation.ts';
import * as cde from '../domain/cde.ts';
import * as watch from '../ops/watch.ts';
import * as correspondence from '../domain/correspondence.ts';
import * as procurement from '../domain/procurement.ts';
import * as programmecontrol from '../domain/programmecontrol.ts';
import * as qualitycontrol from '../domain/qualitycontrol.ts';
import * as progressverification from '../domain/progressverification.ts';
import * as supplychain from '../domain/supplychain.ts';
import * as control from '../domain/control.ts';
import * as radar from '../domain/radar.ts';
import * as regulatorycompletion from '../domain/regulatorycompletion.ts';
import * as reliability from '../domain/reliability.ts';
import * as informationcontrol from '../domain/informationcontrol.ts';
import * as handoverrequirements from '../domain/handoverrequirements.ts';
import * as itt from '../domain/itt.ts';
import * as tenderintake from '../domain/tenderintake.ts';
import * as costintel from '../domain/costintel.ts';
import { morningBriefing } from '../agents/briefing.ts';
import { AGENT_DIVISIONS, type AgentDivision } from '../agents/types.ts';
import { AGENTS } from '../agents/registry.ts';
import * as framework from '../domain/framework.ts';
import * as functionaltest from '../domain/functionaltest.ts';
import * as lifecycleControl from '../lifecycle/control.ts';
import * as stages from '../lifecycle/stages.ts';
import * as costModel from '../engines/maths/costModel.ts';
import * as structure from '../domain/structure.ts';
import * as bim from '../engines/bim.ts';
import * as claims from '../engines/claims.ts';
import * as cost from '../engines/cost.ts';
import * as handover from '../engines/handover.ts';
import * as planning from '../engines/planning.ts';
import * as sitevisit from '../engines/sitevisit.ts';
import * as asbuilt from '../domain/asbuilt.ts';
import * as assetregister from '../domain/assetregister.ts';
import * as award from '../domain/award.ts';
import * as enquiry from '../domain/enquiry.ts';
import * as constructability from '../domain/constructability.ts';
import * as commissioningclose from '../domain/commissioningclose.ts';
import * as commissioningexception from '../domain/commissioningexception.ts';
import * as completion from '../domain/completion.ts';
import * as coordination from '../domain/coordination.ts';
import * as designbaseline from '../domain/designbaseline.ts';
import * as dailylog from '../domain/dailylog.ts';
import * as delivery from '../domain/delivery.ts';
import * as designchange from '../domain/designchange.ts';
import * as designplan from '../domain/designplan.ts';
import * as decisioncontrol from '../domain/decisioncontrol.ts';
import * as measurement from '../domain/measurement.ts';
import * as meetings from '../domain/meetings.ts';
import * as mobilisation from '../domain/mobilisation.ts';
import * as submittals from '../domain/submittals.ts';
import * as systemisation from '../domain/systemisation.ts';
import * as testpack from '../domain/testpack.ts';
import * as vendortest from '../domain/vendortest.ts';
import * as prefunctional from '../domain/prefunctional.ts';
import * as ommanual from '../domain/ommanual.ts';
import * as operatorreadiness from '../domain/operatorreadiness.ts';
import * as transfer from '../domain/transfer.ts';
import * as practicalcompletion from '../domain/practicalcompletion.ts';
import * as handoveracceptance from '../domain/handoveracceptance.ts';
import * as aftercare from '../domain/aftercare.ts';
import * as aidisposition from '../domain/aidisposition.ts';
import * as conceptbrief from '../domain/conceptbrief.ts';
import * as conceptcompliance from '../domain/conceptcompliance.ts';
import * as conceptcontrols from '../domain/conceptcontrols.ts';
import * as conceptduediligence from '../domain/conceptduediligence.ts';
import * as conceptinitiation from '../domain/conceptinitiation.ts';
import * as conceptoptions from '../domain/conceptoptions.ts';
import * as conceptstrategy from '../domain/conceptstrategy.ts';
import * as pricingroute from '../domain/pricingroute.ts';
import * as settlement from '../domain/settlement.ts';
import * as documents from '../documents/generate.ts';
import * as stagegate from '../domain/stagegate.ts';
import * as tenderintel from '../domain/tenderintel.ts';
import * as tenderreview from '../domain/tenderreview.ts';
import * as valuechain from '../domain/valuechain.ts';
import * as quality from '../engines/quality.ts';
import * as safetycontrol from '../domain/safetycontrol.ts';
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
import { createMfaChallenge, decoyMfaResponse, identityLock, refreshTokens, shapeMfaResponse, verifyMfaChallenge, type AuthContext } from '../identity/auth.ts';
import { lockedSubjects } from '../identity/lockout.ts';
import { classifyEntity } from '../identity/entityAccess.ts';
import { FIELD_FORBIDDEN_EVENTS } from '../field/sync.ts';
import { estateBurn } from '../billing/burn.ts';
import { estateOverview } from '../billing/overview.ts';
import { isPlatformGovernanceEvent } from '../goldenthread/eventTypes.ts';
import * as evidence from '../evidence/registry.ts';
import * as ingestion from '../evidence/pipeline.ts';
import * as siteMedia from '../site/media.ts';
import * as blog from '../site/blog.ts';
import * as conflicts from '../field/conflicts.ts';
import * as outbox from '../notifications/outbox.ts';
import * as aievaluation from '../ai/evaluation.ts';
import * as designreview from '../engines/designreview.ts';
import * as perception from '../engines/perception.ts';
import * as signing from '../signing/signature.ts';
import { ownersByRole, ownersFor, ownershipMap } from '../identity/ownership.ts';
import { PERMISSION_MATRIX, type CapabilityArea, type PermissionCode,
  assertTenantGrantable,
  TENANT_GRANTABLE_ROLES,
} from '../identity/roles.ts';
import { authorise, AUTHZ_OPTIONS, currentPhase, registerEvidence, write } from '../engines/context.ts';
import { ulid } from '../core/ids.ts';
import { LIFECYCLE_ORDER, PHASE_GATES } from '../lifecycle/phases.ts';
import type { Platform } from '../platform.ts';
import type { ExportAudience, ExportFormat } from '../export/exporter.ts';
import { metrics, recentLogs, type HtmlPolicy, type RequestContext } from './middleware.ts';
import { gatewayMetrics, recordSecurityEvent, securityEvents, securitySummary, type SecurityEventKind } from './telemetry.ts';
import { readiness } from './readiness.ts';

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
   * A smaller ceiling than the evidence limit, for an upload route that is not
   * receiving a file.
   *
   * The evidence limit is sized for a scanned drawing set. A webhook envelope
   * is a few kilobytes, and it arrives on a public route — anybody may post to
   * it, so anybody may make the server buffer whatever the ceiling allows.
   * Sizing the limit to the payload is the difference between a rejected
   * request and 50MB of memory held per connection.
   */
  maxBytes?: number;
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
  PROGRESS_FROM_IMAGES: 'progress',
  PPE_COMPLIANCE: 'ppe',
  EQUIPMENT_RECOGNITION: 'equipment',
  DEFECT_DETECTION: 'defects',
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
 * Store an image that is part of a tenancy's identity rather than a project's
 * evidence.
 *
 * The same shape as an account picture and a landing-page slot, and separate
 * from the evidence upload route on purpose: that route requires an
 * `EvidenceItem` record already naming the hash, because it exists to supply
 * the file behind a record somebody committed. A cover image is configuration —
 * nothing committed it as evidence of anything — so it takes this path, and the
 * branding record is what names the hash.
 *
 * Type is decided by the bytes. The same magic-byte table the account pictures
 * and the landing page use, so an SVG is refused everywhere for the same
 * reason: it is a document that can carry script.
 */
async function storeBrandImage(
  platform: Platform,
  tenantId: string,
  bytes: Buffer,
): Promise<{ hash: string; bytes: number; contentType: string }> {
  if (bytes.length === 0) throw new DomainError('EMPTY_UPLOAD', 'No bytes were received', 400);
  if (bytes.length > config.site.mediaMaxBytes) {
    throw new DomainError(
      'IMAGE_TOO_LARGE',
      `That image is ${Math.round(bytes.length / 1024)}KB. The ceiling is ` +
        `${Math.round(config.site.mediaMaxBytes / 1024)}KB — export it at the size it will be printed and compress.`,
      413,
    );
  }

  const signature = SIGNATURES.find((candidate) => candidate.matches(bytes));
  if (!signature) {
    throw new DomainError(
      'NOT_AN_IMAGE',
      'That file is not a PNG, JPEG or WebP. It is read from the file itself rather than from what the upload ' +
        'claimed, and an SVG is refused because it is a document that can carry script.',
      415,
    );
  }

  const hash = createHash('sha256').update(bytes).digest('hex');
  await platform.evidence.store(tenantId, hash, bytes, signature.contentType);
  return { hash, bytes: bytes.length, contentType: signature.contentType };
}

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
  clientName: 'CONSTRUX',
  primaryColour: '#ff6600',
  documentReferencePrefix: 'CXA',
  legalFooter: 'CONSTRUX — construction operating system',
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

export function getOrCreateConsoleSession(platform: Platform): Promise<{
  projectId: string;
  email: string;
  enterpriseName: string;
  portfolioName: string;
}> {
  consoleSession ??= import('../seed.ts').then(async ({ DEMO_TENANCY, seedDemoProject, ensureDemonstrationExtras }) => {
    // Adopt before seeding.
    //
    // The memo lives in this process, but the ledger lives on disk. A restart
    // clears the memo and leaves the tenancy — so seeding unconditionally would
    // build a second Meridian on every restart, each with its own project, its
    // own wallet and its own thirteen identities, until the sign-in page listed
    // dozens of Project Managers and nobody could tell which one held the work.
    // Harmless where the journal is thrown away between runs, which is why it
    // was never seen; a slow disaster on a deployment that keeps it.
    const existing = platform.demonstrationUsers();
    if (existing.length > 0) {
      const tenantId = existing[0]?.tenantId as string;
      const project = platform.ledger
        .entitiesOfType('Project')
        .find((record) => record.tenantId === tenantId && record.state.name === DEMO_TENANCY.projectName);
      if (project) {
        // Adopted, and then topped up.
        //
        // Returning here without this was the reason nothing added to the
        // demonstration after the first seed ever appeared on a deployment that
        // keeps its journal — which is the only kind of deployment that
        // matters. A laptop throwing its journal away saw every addition on the
        // next run; the live site never did, and both looked like they had
        // worked. `ensureDemonstrationExtras` asks what is missing and adds only
        // that, so this is safe to run on every bootstrap.
        await ensureDemonstrationExtras(platform);
        return {
          projectId: project.refId,
          email: DEMO_TENANCY.primaryEmail,
          enterpriseName: DEMO_TENANCY.enterpriseName,
          portfolioName: DEMO_TENANCY.portfolioName,
        };
      }
      // Identities but no project: a seed that was interrupted part-way. Fall
      // through and seed rather than serving a console with nothing in it.
    }

    const seed = await seedDemoProject(platform);
    return {
      projectId: seed.projectId,
      email: DEMO_TENANCY.primaryEmail,
      enterpriseName: seed.enterpriseName,
      portfolioName: seed.portfolioName,
    };
  });
  return consoleSession;
}

/**
 * Whether the demonstration tenancy may be offered on this deployment.
 *
 * Outside production it always may — that is what a development environment is
 * for. In production it may only when an operator has switched it on, and the
 * switch is what makes an anonymous visitor's sign-in a considered decision
 * rather than a default nobody chose.
 *
 * This gates the identity list and the code-in-response path.
 * `POST /v1/console/session`, which mints a token with no challenge at all, is
 * not covered by it and stays refused in production unconditionally: that one
 * is an authentication bypass rather than a published account, and there is no
 * setting that should turn it back on.
 */
function demonstrationOffered(): boolean {
  return !isProduction() || demonstrationEnabled();
}

/**
 * Both demonstration tenancies exist before the page offering them renders.
 *
 * The seeded programme is built lazily, on the first call to
 * `POST /v1/console/identities`. That was fine while the sign-in screen was the
 * only thing that listed identities — it asked for the list and got a seeded
 * one. `/demo` is a *page*, rendered synchronously, and it reads the identities
 * rather than asking for them: the first visitor to a fresh process would have
 * been told the demonstration was switched off, on the one page whose entire
 * job is to offer it, and the second visitor would have seen it work.
 *
 * Awaited on the demonstration routes only, and memoised by
 * `getOrCreateConsoleSession` — it seeds once per process, not once per request.
 * The empty workspace is created inside the render, which is cheap: it is three
 * identities and a credit, with no lifecycle behind it.
 */
async function ensureDemonstrationSeeded(platform: Platform): Promise<void> {
  if (!demonstrationOffered()) return;
  try {
    await getOrCreateConsoleSession(platform);
  } catch {
    // A seed that fails must not take the page down with it. `demoInput` reads
    // what is actually there, so the page then says the demonstration is not
    // available rather than showing cards that sign nobody in.
  }
}

/**
 * Take a booking, and tell the person who made it.
 *
 * One helper behind two doors: the JSON route an integration would call, and
 * the form post from the public page. They were separate, and only the JSON one
 * sent the confirmation — so the route almost nobody uses notified, and the one
 * everybody uses recorded a booking in silence and left somebody expecting a
 * call that nobody knew to make.
 *
 * Queued through the outbox, so a mail server that is down delays the
 * confirmation rather than losing it.
 */
async function takeBooking(
  platform: Platform,
  input: Parameters<typeof booking.book>[1],
  correlationId: string,
): Promise<ReturnType<typeof booking.book>> {
  const made = booking.book(platform, input);

  await notifyEngine.notify(platform, {
    code: 'account.demo_booking_confirmed',
    recipients: [{ id: `booking:${made.id}`, name: made.name, email: made.email, tenantId: 'platform' }],
    payload: {
      detail:
        `Your walkthrough is booked for ${made.startsAt.slice(0, 16).replace('T', ' ')} UTC — ` +
        `${made.minutes} minutes, in ${made.language === 'FR' ? 'French' : 'English'}. ` +
        'Joining details follow separately from the person taking it: this platform integrates with no calendar ' +
        'and generates no meeting link, and one that went nowhere would be worse than none.',
      reference: made.reference,
      actionUrl: '/demo',
      actionLabel: 'Explore in the meantime',
    },
    // A stranger has no tenancy and therefore no branding of their own. The
    // platform's own mark is the honest one to send under — it is the platform
    // they are meeting.
    branding: PLATFORM_BRANDING,
    actorId: 'booking',
    correlationId,
  });

  return made;
}

/**
 * Whether this identity's one-time code may be returned rather than emailed.
 *
 * Four conditions, each of which alone would be enough to refuse:
 * the demonstration must be offered on this deployment; the account must carry
 * the seed's `demonstration` mark; it must not be a platform operator; and it
 * must be the account the platform itself agrees is a demonstration identity —
 * `demonstrationUsers()` applies the tenancy and operator filters in one place
 * so no caller can forget them.
 *
 * A real customer's account fails the second condition and always will: nothing
 * in the platform can set that mark except the seed.
 */
function isDemonstrationIdentity(platform: Platform, userId: string): boolean {
  if (!demonstrationOffered()) return false;
  return platform.demonstrationUsers().some((u) => u.id === userId);
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
    // Same reasoning as the login code: this arrives seconds after the tenancy
    // exists, so there has been no opportunity to configure anything.
    branding: platform.exports.brandingIfConfigured(activation.tenantId) ?? PLATFORM_BRANDING,
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

      // A published demonstration account, or somebody's real one?
      //
      // The distinction decides two things below: whether the code is emailed,
      // and whether it is returned. For a demonstration identity the address is
      // `@meridian.example` and belongs to nobody — mailing it would bounce and
      // would put a live deployment's sending reputation behind a domain it
      // does not own — so the code comes back in the response instead. That is
      // the whole of the demonstration affordance: the challenge, its
      // five-minute expiry, its single use and the verification step are all
      // the real ones, and nothing here shortens the path.
      const demonstration = isDemonstrationIdentity(platform, user.id);

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
      if (isProduction() && !demonstration) {
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
          // The tenancy's own branding when it has any, the platform's
          // otherwise. Demanding client branding here made the platform
          // unsignable-into: the operator tenancy can never have any, and a
          // tenancy created ten seconds ago has none either — so the first
          // person through the door of every new customer was refused their
          // own login code, and the screen said documents could not be
          // exported.
          branding: platform.exports.brandingIfConfigured(user.tenantId) ?? PLATFORM_BRANDING,
          actorId: user.id,
          correlationId: ctx.correlationId,
        });

        // The last-resort fallback, and the blocker it removes.
        //
        // With no SMTP host the notification engine records the message and
        // transmits nothing — correctly; there is nowhere to send it. The
        // effect was that a production deployment with mail not yet configured
        // could not be signed into by anybody, including the operator whose
        // job is to configure it. Every credential correct, and a locked door.
        //
        // So when, and only when, no SMTP host is configured, the code goes to
        // **stderr**. Not to the response, not to the ledger, not to any
        // route: reading it requires a shell on the server, which is a
        // strictly higher bar than an email inbox and is already the level of
        // access needed to change the secret that signs the tokens.
        //
        // It is loud on purpose. A deployment sending one-time codes to its
        // own logs should be uncomfortable to look at until SMTP is set.
        if (config.smtp.host === '') {
          process.stderr.write(
            `[auth] NO SMTP HOST CONFIGURED — the one-time code for ${user.email} could not be sent and is ` +
              `printed here instead: ${challenge.code} (expires in five minutes). ` +
              'Set SMTP_HOST to stop writing sign-in codes to the log.\n',
          );
        }
      }

      return {
        ...shapeMfaResponse(challenge),
        // Returned only outside production, so local development does not need
        // a mail server to sign in. Every account on the deployment, because
        // outside production every account is a development fixture.
        ...(isProduction() ? {} : { devCode: challenge.code }),
        // The production counterpart, and deliberately a different key: one is
        // "this is not a real deployment", the other is "this is a real
        // deployment and this one account is published". Conflating them would
        // make the narrower rule invisible in every reader that handles the
        // wider one.
        ...(isProduction() && demonstration ? { demoCode: challenge.code } : {}),
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
    handler: async (platform, ctx) => {
      const { actorId, challengeId, code } = body<{ actorId: string; challengeId: string; code: string }>(ctx);

      // Read before and after, which is how the route learns that *this*
      // attempt was the one that crossed the threshold. The alternative — a
      // richer return from `verifyMfaChallenge` — would put "should somebody be
      // emailed" inside a function whose job is to say whether a code is right.
      const wasLocked = identityLock(actorId).locked;
      const verified = verifyMfaChallenge(actorId, challengeId, code);

      if (!verified) {
        const lock = identityLock(actorId);

        // One notice, on the transition. An attacker who keeps going after the
        // lock must not be able to use it to post a thousand emails at the
        // person whose account they are attacking — the lock would then be a
        // way of harassing exactly the people it protects.
        if (lock.locked && !wasLocked) {
          // A decoy actorId belongs to nobody, and `platform.user` throws for
          // one. It cannot reach here — a decoy gets a fresh random id on every
          // login, so no run accumulates against it — but a lookup that threw
          // inside a refusal path would turn "wrong code" into a 500, which is
          // itself the enumeration answer.
          let user: ReturnType<typeof platform.user> | undefined;
          try {
            user = platform.user(actorId);
          } catch {
            user = undefined;
          }

          recordSecurityEvent({
            kind: 'AUTH_FAILURE',
            reason: 'IDENTITY_LOCKED',
            method: ctx.method,
            path: ctx.routeId ?? ctx.path,
            traceId: ctx.traceId,
            correlationId: ctx.correlationId,
            tenantId: user?.tenantId,
            actorId,
            remote: ctx.remote,
            status: 401,
          });

          // The one channel that reaches the account holder and nobody else,
          // which is why the refusal itself can stay silent. `account.locked`
          // has been in the catalogue since the notification engine was built,
          // with nothing raising it.
          if (user) {
            await notifyEngine
              .notify(platform, {
                code: 'account.locked',
                recipients: [{ id: user.id, name: user.name, email: user.email, tenantId: user.tenantId }],
                payload: {
                  detail:
                    `Repeated failed sign-in attempts on your CONSTRUX account have locked it for ` +
                    `${Math.ceil(lock.retryAfterSeconds / 60)} minutes. It will unlock by itself. ` +
                    'If this was not you, somebody is trying your address — nothing has been accessed.',
                },
                channels: ['EMAIL'],
                branding: platform.exports.brandingIfConfigured(user.tenantId) ?? PLATFORM_BRANDING,
                actorId: user.id,
                correlationId: ctx.correlationId,
              })
              // A mail that will not send must not turn a refusal into a 500,
              // which would tell an attacker they had found a real account.
              .catch(() => undefined);
          }
        }

        // The same refusal either way — wrong code, dead challenge, locked
        // identity. Distinguishing them would rebuild the account-enumeration
        // oracle the login route above goes to such lengths to close, because
        // only a real account can be locked.
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
    description: 'Onboard a tenant and its first administrator (platform operator only)',
    schema: {
      type: 'object',
      required: ['legalName', 'jurisdiction', 'defaultCurrency', 'tier', 'enterpriseName', 'adminName', 'adminEmail'],
      properties: {
        legalName: stringField,
        jurisdiction: stringField,
        defaultCurrency: stringField,
        enterpriseName: stringField,
        tier: { type: 'string', enum: ['SOLO', 'TEAM', 'BUSINESS', 'ENTERPRISE', 'SOVEREIGN', 'FREE_TRIAL'] },
        /**
         * The first person through the door, and required for the same reason
         * `PLATFORM_OPERATOR_EMAIL` is required at boot.
         *
         * This route used to create the tenancy alone. Creating a user demands
         * `ENTERPRISE_ADMIN` of that tenancy, and a tenancy seconds old has
         * none — so an operator could provision a customer that nobody, ever,
         * could sign in to, and nothing said so. Public signup never had the
         * defect: it creates the tenancy and its administrator together, which
         * is the shape mirrored here.
         *
         * Optional would preserve the defect for anybody who omitted it, so it
         * is required. There is no correct tenancy with no way in.
         */
        adminName: stringField,
        adminEmail: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      if (!auth(ctx).roles.includes('PLATFORM_ADMIN')) {
        throw new ForbiddenError('Only the platform operator may onboard tenants', 'PLATFORM_ADMIN_REQUIRED');
      }
      const input = body<{
        legalName: string;
        jurisdiction: string;
        defaultCurrency: string;
        enterpriseName: string;
        tier: SubscriptionTier;
        adminName: string;
        adminEmail: string;
      }>(ctx);

      // Refused before the tenancy exists rather than after. Creating it and
      // then failing on the administrator leaves exactly the unreachable
      // tenancy this change exists to prevent, and leaves it in the ledger.
      const existing = platform.userByEmail(input.adminEmail);
      if (existing) {
        throw new ValidationError('That address already holds an identity on this platform', [
          { field: 'adminEmail', message: 'Already in use — one human, one identity' },
        ]);
      }

      const { adminName, adminEmail, ...tenancy } = input;
      const result = platform.createTenant(tenancy);
      // ENTERPRISE_ADMIN and nothing more. Somebody has to be able to invite
      // the rest of the organisation, and that is the whole of the mandate —
      // the same role and the same reasoning as public signup.
      const administrator = platform.createUser({
        tenantId: result.tenant.id,
        name: adminName,
        email: adminEmail,
        roles: ['ENTERPRISE_ADMIN'],
      });

      return {
        tenant: result.tenant,
        subscription: result.subscription,
        wallet: result.wallet.snapshot(),
        administrator,
      };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/operators',
    description: 'Create another platform operator (platform operator only)',
    schema: {
      type: 'object',
      required: ['name', 'email'],
      properties: { name: stringField, email: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      // The *second* operator onwards. The first is created at boot from
      // PLATFORM_OPERATOR_EMAIL, because there is nobody to authorise this call
      // on a deployment that has none — and a public route that mints a
      // PLATFORM_ADMIN is the worst thing that could be put on the internet.
      if (!auth(ctx).roles.includes('PLATFORM_ADMIN')) {
        throw new ForbiddenError('Only the platform operator may create another', 'PLATFORM_ADMIN_REQUIRED');
      }
      const input = body<{ name: string; email: string }>(ctx);
      return platform.createOperator(input);
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
            // What this tenancy has actually paid, and how many people it has.
            // Both were reachable only by fetching two other endpoints and
            // joining them in the browser, so the estate table — the one screen
            // an operator judges a customer from — showed neither.
            lifetimeRevenueMinor: platform
              .paymentReceipts(tenant.id)
              .reduce((sum, receipt) => sum + receipt.amountMinor, 0),
            identities: platform.users(tenant.id).length,
            administrators: platform
              .users(tenant.id)
              .filter((user) => user.roles.includes('ENTERPRISE_ADMIN')).length,
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
    pattern: '/v1/admin/overview',
    description: 'Tenancy, identity and revenue position across the estate (platform operator only)',
    readOnly: true,
    handler: (platform, ctx) => {
      if (!auth(ctx).roles.includes('PLATFORM_ADMIN')) {
        throw new ForbiddenError('Only the platform operator may see the estate position', 'PLATFORM_ADMIN_REQUIRED');
      }
      // Commercial position only, on the same boundary the rest of the operator
      // layer keeps: how many tenancies, how many identities, how much money.
      // Nothing here names a project, a package or a document.
      return estateOverview({
        tenancies: platform.tenants().map((tenant) => {
          const subscription = platform.subscription(tenant.id);
          return {
            tenantId: tenant.id,
            createdAt: tenant.createdAt,
            tier: subscription.tier,
            status: subscription.status,
            seatsUsed: subscription.assignedIdentities.length,
            seatsIncluded: TIERS[subscription.tier].includedIdentities,
            identities: platform.users(tenant.id).map((user) => ({
              status: user.status,
              administrator: user.roles.includes('ENTERPRISE_ADMIN'),
            })),
          };
        }),
        receipts: platform.paymentReceipts(),
        awaitingPayment: platform.topUpIntents().filter((intent) => intent.status === 'AWAITING_PAYMENT'),
        operators: platform.operators().length,
      });
    },
  },
  {
    method: 'GET',
    pattern: '/v1/admin/audit',
    description: 'Every governance act on the estate, hash-chained and verified (platform operator only)',
    readOnly: true,
    handler: (platform, ctx) => {
      if (!auth(ctx).roles.includes('PLATFORM_ADMIN')) {
        throw new ForbiddenError('Only the platform operator may see the governance record', 'PLATFORM_ADMIN_REQUIRED');
      }

      /**
       * The account boundary, stated one event code at a time.
       *
       * The first attempt selected every event on a `<tenantId>-governance`
       * project, on the reasoning that governance acts are written there and
       * delivery work is not. That is false: the governance project is where
       * *everything tenant-scoped* goes, so it handed the operator a customer's
       * portfolios, programmes, suppliers and bid pipeline. It looked correct on
       * an estate with no delivery data — which is what every fresh fixture is,
       * and why the tests agreed with it.
       *
       * `PLATFORM_GOVERNANCE_EVENTS` names the acts instead. Anything not on
       * that list is out of reach by default, which is the right direction for
       * the failure to fall: a missing code is a gap in an audit screen, and a
       * wrongly added one is a customer's work handed to somebody with no
       * business seeing it.
       *
       * The project check stays as well. It costs nothing and means a delivery
       * event that ever reused one of these codes still could not arrive here.
       */
      const governance = platform.ledger
        .events({})
        .filter((event) => event.projectId.endsWith('-governance') && isPlatformGovernanceEvent(event.eventType));

      const names = new Map(platform.tenants().map((tenant) => [tenant.id, tenant.legalName]));
      const byType: Record<string, number> = {};
      for (const event of governance) byType[event.eventType] = (byType[event.eventType] ?? 0) + 1;

      // Verified rather than asserted. "Hash-chained" on a screen means nothing
      // unless something has actually walked the chain, and the replay engine
      // that does it already exists — so the answer here is computed, not
      // claimed. Each governance project is its own chain and is verified as
      // one.
      const projects = [...new Set(governance.map((event) => event.projectId))];
      const verification = projects.map((projectId) => {
        const tenantId = projectId === 'platform-governance' ? 'platform' : projectId.replace(/-governance$/, '');
        const report = replayProject(platform.ledger, tenantId, projectId, new Date().toISOString());
        return {
          projectId,
          tenant: names.get(tenantId) ?? (tenantId === 'platform' ? 'Platform' : tenantId),
          verified: report.summary.VERIFIED,
          failures: report.failures.length,
          chainHead: platform.ledger.chainHead(projectId),
        };
      });

      return {
        at: new Date().toISOString(),
        total: governance.length,
        byType,
        // A single broken chain anywhere on the estate is the only number on
        // this screen that matters, so it is computed across all of them rather
        // than left for a reader to spot in a list.
        intact: verification.every((entry) => entry.failures === 0),
        chains: verification,
        events: governance
          .slice(-Number(ctx.query.get('limit') ?? 200))
          .reverse()
          .map((event) => ({
            eventId: event.eventId,
            timestamp: event.timestamp,
            eventType: event.eventType,
            tenant: names.get(event.tenantId) ?? (event.tenantId === 'platform' ? 'Platform' : event.tenantId),
            entity: event.entity,
            actor: event.actor,
            source: event.source,
            action: event.action,
            // The per-entity hash and the whole-chain hash. The first proves the
            // record was not edited; the second proves none was deleted or
            // reordered around it, which a per-entity hash alone cannot.
            afterHash: event.afterHash,
            chainHash: event.chainHash,
          })),
      };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/admin/readiness',
    description: 'What this deployment has configured, by capability (platform operator only)',
    readOnly: true,
    handler: (_platform, ctx) => {
      // Operator-only, and it would be operator-only even though it carries no
      // secret: it is a map of which locks on this deployment are unlocked, and
      // that is exactly the reconnaissance an attacker wants. Whether a value is
      // set crosses this boundary; what it is never does.
      if (!auth(ctx).roles.includes('PLATFORM_ADMIN')) {
        throw new ForbiddenError('Only the platform operator may see deployment readiness', 'PLATFORM_ADMIN_REQUIRED');
      }
      return readiness();
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
    pattern: '/v1/admin/ai/evaluation',
    readOnly: true,
    description: 'What the AI harness checks, when it last ran, and what has moved since',
    handler: (platform, ctx) => {
      operatorOnly(ctx, 'read the AI evaluation');
      return aievaluation.evaluationPosition(platform);
    },
  },
  {
    method: 'POST',
    pattern: '/v1/admin/ai/evaluation',
    description: 'Run the AI evaluation harness and record the result',
    schema: {
      type: 'object',
      properties: { against: { type: 'string', enum: ['local', 'configured'] } },
      additionalProperties: false,
    },
    handler: async (platform, ctx) => {
      operatorOnly(ctx, 'run the AI evaluation');
      // `local` by default and deliberately: the harness builds a whole
      // demonstration project and runs eight cases through it, and doing that
      // against live providers on every press is a bill nobody asked for.
      return aievaluation.runEvaluation(platform, {
        actorId: auth(ctx).actorId,
        against: body<{ against?: 'local' | 'configured' }>(ctx).against ?? 'local',
      });
    },
  },
  {
    method: 'GET',
    pattern: '/v1/admin/outbox',
    readOnly: true,
    description: 'What the platform still owes in notifications, and what it gave up on',
    handler: (platform, ctx) => {
      operatorOnly(ctx, 'read the notification outbox');
      // Across every tenancy: "is anything failing to go out" is an operator's
      // question, and the outbox is a platform chain rather than a project one.
      return outbox.outboxPosition(platform);
    },
  },
  {
    method: 'GET',
    pattern: '/v1/admin/watch',
    readOnly: true,
    description: 'What the platform is saying about itself: which of its own rules are firing, and whether anybody is told',
    handler: (platform, ctx) => {
      operatorOnly(ctx, 'read the platform watch');
      return watch.watchPosition(platform);
    },
  },
  {
    method: 'GET',
    pattern: '/v1/admin/repair',
    readOnly: true,
    description: 'What the platform has repaired about itself, how often, and what it refuses to touch',
    handler: (_platform, ctx) => {
      operatorOnly(ctx, 'read the auto-repair position');
      return repairPosition();
    },
  },
  {
    method: 'POST',
    pattern: '/v1/admin/repair',
    description: 'Run a repair pass now: restart a stopped drain, move a queue that is owed',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (platform, ctx) => {
      operatorOnly(ctx, 'run a repair pass');
      return { taken: await repair(platform) };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/admin/assurance',
    readOnly: true,
    description: 'When each project’s chain was last proved, and anything that no longer verifies',
    handler: (platform, ctx) => {
      operatorOnly(ctx, 'read the chain assurance position');
      return assurancePosition(platform);
    },
  },
  {
    method: 'POST',
    pattern: '/v1/admin/assurance/sweep',
    description: 'Verify the next slice of projects now rather than waiting for the interval',
    schema: { type: 'object', properties: { projects: { type: 'number' } }, additionalProperties: false },
    handler: (platform, ctx) => {
      operatorOnly(ctx, 'run a chain verification sweep');
      const { projects } = body<{ projects?: number }>(ctx);
      return sweep(platform, projects);
    },
  },
  // ---------------------------------------------------------------- support
  //
  // Reachable by everybody with a session, not only the operator. A support
  // queue only an operator can see is an inbox; the point of putting a request
  // in the ledger is that the customer can read back what they were told.
  {
    method: 'GET',
    pattern: '/v1/support',
    readOnly: true,
    description: 'Support requests — the estate for an operator, their own tenancy for anybody else',
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      return { ...support.supportPosition(platform, actor), canRaise: support.canRaise(actor), categories: support.CATEGORY_LABELS };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/support/:ticketId',
    readOnly: true,
    description: 'One support request with its full thread',
    handler: (platform, ctx) => support.ticket(platform, auth(ctx), ctx.params.ticketId ?? ''),
  },
  {
    method: 'POST',
    pattern: '/v1/support',
    description: 'Raise a support request',
    schema: {
      type: 'object',
      required: ['subject', 'body', 'category'],
      properties: {
        subject: stringField,
        body: stringField,
        category: { type: 'string', enum: ['ACCESS', 'BILLING', 'DATA', 'DEFECT', 'HOW_TO', 'FEATURE_REQUEST', 'OTHER'] },
        priority: { type: 'string', enum: ['URGENT', 'NORMAL', 'LOW'] },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const input = body<{ subject: string; body: string; category: support.TicketCategory; priority?: support.TicketPriority }>(ctx);
      return support.raise(platform, auth(ctx), input);
    },
  },
  {
    method: 'POST',
    pattern: '/v1/support/:ticketId/reply',
    description: 'Reply on a support request — the side is taken from the actor, never from the request',
    schema: { type: 'object', required: ['body'], properties: { body: stringField }, additionalProperties: false },
    handler: (platform, ctx) => support.reply(platform, auth(ctx), ctx.params.ticketId ?? '', body<{ body: string }>(ctx).body),
  },
  {
    method: 'POST',
    pattern: '/v1/support/:ticketId/assign',
    description: 'Take ownership of a support request (platform operator only)',
    schema: { type: 'object', required: ['operatorId'], properties: { operatorId: stringField }, additionalProperties: false },
    handler: (platform, ctx) =>
      support.assign(platform, auth(ctx), ctx.params.ticketId ?? '', body<{ operatorId: string }>(ctx).operatorId),
  },
  {
    method: 'POST',
    pattern: '/v1/support/:ticketId/resolve',
    description: 'Resolve a support request, stating what was done (platform operator only)',
    schema: { type: 'object', required: ['resolution'], properties: { resolution: stringField }, additionalProperties: false },
    handler: (platform, ctx) =>
      support.resolve(platform, auth(ctx), ctx.params.ticketId ?? '', body<{ resolution: string }>(ctx).resolution),
  },
  {
    method: 'GET',
    pattern: '/v1/admin/performance',
    readOnly: true,
    description: 'Request performance per route: how often, how slow, how often it fails',
    handler: (_platform, ctx) => {
      operatorOnly(ctx, 'read platform performance');
      return { ...performancePosition(), latency: latencySummaries() };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/admin/events',
    readOnly: true,
    description: 'The event store by type, group and tenancy — counts only, never content',
    handler: (platform, ctx) => {
      operatorOnly(ctx, 'read the event store position');
      const windowDays = ctx.query.get('windowDays') ? Number(ctx.query.get('windowDays')) : undefined;
      return {
        ...eventStorePosition(platform, windowDays),
        // The platform's own chain, in full. Every other chain is counted and
        // never read — the split is the account boundary, not a preference.
        stream: platformEventStream(platform, 100),
      };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/admin/reports',
    readOnly: true,
    description: 'The estate reports an operator can compose, and what each answers',
    handler: (_platform, ctx) => ({ reports: reports.catalogue(auth(ctx)) }),
  },
  {
    method: 'GET',
    pattern: '/v1/admin/reports/:reportId',
    readOnly: true,
    description: 'Compose one estate report from the live positions',
    handler: (platform, ctx) => reports.generate(platform, auth(ctx), ctx.params.reportId ?? ''),
  },
  {
    method: 'GET',
    pattern: '/v1/admin/blueprint',
    readOnly: true,
    description: 'The product blueprint’s roadmap and claims, against what this build measurably contains',
    handler: (platform, ctx) => {
      operatorOnly(ctx, 'read the blueprint');
      return blueprintPosition(platform, ROUTES.length);
    },
  },
  {
    method: 'POST',
    pattern: '/demo',
    public: true,
    html: true,
    htmlPolicy: 'PUBLIC_SITE' as const,
    description: 'Book a walkthrough from the public page, and render it back with the confirmation',
    // Shape and size only, and deliberately no `required` or `minLength`.
    //
    // Every write route publishes a schema and this one is no exception — an
    // unchecked body reaching a handler that writes to an append-only ledger is
    // a permanent record of whatever arrived. What it checks is the envelope: no
    // field the form does not have, nothing that is not a string, nothing
    // unbounded.
    //
    // Missing and empty fields are left to the domain on purpose. A schema
    // failure is answered with problem+json, and the person on the other end of
    // this particular route is looking at a page in a browser with no
    // JavaScript to catch it — so a blank name has to come back as a sentence on
    // the form rather than as a JSON document filling the window. `book`
    // refuses each field with a message written to be read.
    schema: {
      type: 'object',
      properties: {
        startsAt: { type: 'string', maxLength: 40 },
        name: { type: 'string', maxLength: 120 },
        email: { type: 'string', maxLength: 254 },
        organisation: { type: 'string', maxLength: 200 },
        language: { type: 'string', enum: ['EN', 'FR'] },
        about: { type: 'string', maxLength: 2000 },
      },
      additionalProperties: false,
    },
    handler: async (platform: Platform, ctx: RequestContext) => {
      // Same page, so the same seed: the confirmation renders above the two
      // demonstration tracks and both have to be there to be offered.
      await ensureDemonstrationSeeded(platform);
      const form = (ctx.body ?? {}) as Record<string, string>;
      try {
        const made = await takeBooking(
          platform,
          {
            startsAt: String(form.startsAt ?? ''),
            name: String(form.name ?? ''),
            email: String(form.email ?? ''),
            organisation: String(form.organisation ?? ''),
            language: form.language === 'FR' ? 'FR' : 'EN',
            about: form.about ? String(form.about) : undefined,
          },
          ctx.correlationId,
        );
        // Rendered rather than redirected, so a browser with no JavaScript sees
        // the confirmation on the page it submitted from — and the reference is
        // on screen rather than only in an email that may not arrive.
        return site.renderDemo(platform, { booked: made });
      } catch (error) {
        // The refusal goes back onto the form with the slots recomputed, so a
        // slot taken while the page was open is simply gone from the list the
        // person is now looking at.
        return site.renderDemo(platform, {
          bookingError: error instanceof Error ? error.message : 'That booking could not be made.',
        });
      }
    },
  },

  // ------------------------------------------------------------- book a demo
  //
  // Public, because the whole point is that somebody who has never signed in
  // can take twenty minutes. Rate limiting is the gateway's, the same as every
  // other public route.
  {
    method: 'GET',
    pattern: '/v1/booking/availability',
    public: true,
    readOnly: true,
    description: 'Slots that can still be booked for a guided walkthrough',
    handler: (platform) => booking.availability(platform),
  },
  {
    method: 'POST',
    pattern: '/v1/booking',
    public: true,
    description: 'Book a guided walkthrough at one of the offered times',
    schema: {
      type: 'object',
      required: ['startsAt', 'name', 'email', 'organisation'],
      properties: {
        startsAt: stringField,
        name: { type: 'string', minLength: 2, maxLength: 120 },
        email: { type: 'string', minLength: 3, maxLength: 254 },
        organisation: { type: 'string', minLength: 2, maxLength: 200 },
        language: { type: 'string', enum: ['EN', 'FR'] },
        about: { type: 'string', maxLength: 2000 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      takeBooking(platform, body<Parameters<typeof booking.book>[1]>(ctx), ctx.correlationId),
  },
  {
    method: 'GET',
    pattern: '/v1/admin/bookings',
    readOnly: true,
    description: 'The walkthrough diary — who booked what, and what is still to come',
    handler: (platform, ctx) => booking.bookingPosition(platform, auth(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/admin/bookings/:bookingId/cancel',
    description: 'Cancel a booked walkthrough, stating why',
    schema: { type: 'object', required: ['reason'], properties: { reason: stringField }, additionalProperties: false },
    handler: (platform, ctx) =>
      booking.cancel(platform, auth(ctx), ctx.params.bookingId ?? '', body<{ reason: string }>(ctx).reason),
  },

  // ------------------------------------------------------- growth programme
  {
    method: 'GET',
    pattern: '/v1/admin/growth',
    readOnly: true,
    description: 'Resellers and influencers, what they have brought and what they are owed',
    handler: (platform, ctx) => growth.programmePosition(platform, auth(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/admin/growth',
    description: 'Enrol a reseller or an influencer on the growth programme',
    schema: {
      type: 'object',
      required: ['kind', 'name', 'email', 'code'],
      properties: {
        kind: { type: 'string', enum: ['PARTNER', 'INFLUENCER'] },
        name: stringField,
        email: stringField,
        code: { type: 'string', minLength: 3, maxLength: 32 },
        commissionBps: { type: 'number' },
        bountyMinor: { type: 'number' },
        audience: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => growth.enrol(platform, auth(ctx), body<Parameters<typeof growth.enrol>[2]>(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/admin/growth/:partnerId/status',
    description: 'Pause or end a growth agreement, stating why',
    schema: {
      type: 'object',
      required: ['status', 'reason'],
      properties: { status: { type: 'string', enum: ['ACTIVE', 'PAUSED', 'ENDED'] }, reason: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const input = body<{ status: growth.PartnerStatus; reason: string }>(ctx);
      return growth.setStatus(platform, auth(ctx), ctx.params.partnerId ?? '', input.status, input.reason);
    },
  },
  {
    method: 'POST',
    pattern: '/v1/admin/growth/:partnerId/payout',
    description: 'Record a payout already sent to a partner. Records money; it does not move any',
    schema: {
      type: 'object',
      required: ['amountMinor', 'reference'],
      properties: { amountMinor: { type: 'number' }, reference: stringField, note: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      growth.recordPayout(platform, auth(ctx), ctx.params.partnerId ?? '', body<{ amountMinor: number; reference: string; note?: string }>(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/admin/forecast',
    readOnly: true,
    description: 'What lands next on the estate, each with the arithmetic it came from',
    handler: (platform, ctx) => {
      operatorOnly(ctx, 'read the estate forecast');
      return forecastPosition(platform);
    },
  },
  {
    method: 'GET',
    pattern: '/v1/admin/telemetry/egress',
    readOnly: true,
    description: 'Whether telemetry is reaching a collector, what is queued, and what has been dropped',
    handler: (_platform, ctx) => {
      operatorOnly(ctx, 'read the telemetry egress position');
      // Reports the endpoint and never the collector's token. A screen that
      // showed the header would put a credential on an operator's display and
      // in whatever captured it.
      return egressPosition();
    },
  },
  {
    method: 'POST',
    pattern: '/v1/admin/telemetry/flush',
    description: 'Ship the queued telemetry now rather than waiting for the interval',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_platform, ctx) => {
      operatorOnly(ctx, 'flush telemetry');
      return flushEgress();
    },
  },
  {
    method: 'POST',
    pattern: '/v1/admin/watch/evaluate',
    description: 'Evaluate every rule now rather than waiting for the interval',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (platform, ctx) => {
      operatorOnly(ctx, 'evaluate the platform watch');
      // The same evaluation the timer runs, brought forward. It cannot make a
      // rule fire that would not have fired on its own — and the first one
      // after a restart still judges no rate, because there is nothing to
      // difference against yet.
      return watch.evaluate(platform);
    },
  },
  {
    method: 'POST',
    pattern: '/v1/admin/outbox/drain',
    description: 'Deliver what is owed now, rather than waiting for the timer',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (platform, ctx) => {
      operatorOnly(ctx, 'drain the notification outbox');
      // Nothing here forces a send that the queue would not have made on its
      // own — it is the same drain the timer runs, brought forward. An entry
      // that is out of attempts stays out of attempts.
      return outbox.drain(platform);
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
        // Who is shut out *now*, rather than who was shut out at some point in
        // a scrolling stream. It is the question an operator is actually asked
        // — somebody rings up unable to sign in — and answering it from the
        // event history means reading backwards and hoping nothing has
        // expired since.
        lockedIdentities: lockedSubjects().map((entry) => ({
          actorId: entry.subject,
          failures: entry.failures,
          unlocksInSeconds: entry.retryAfterSeconds,
        })),
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
    description: 'Record the bid / no-bid decision, with its rationale, conditions and authority',
    schema: {
      type: 'object',
      required: ['bid', 'rationale'],
      properties: {
        bid: { type: 'boolean' },
        rationale: stringField,
        conditions: { type: 'array', items: { type: 'string' } },
        dissent: {
          type: 'array',
          items: {
            type: 'object',
            required: ['by', 'position'],
            properties: { by: stringField, position: { type: 'string' } },
            additionalProperties: false,
          },
        },
        // Required by the engine, not by the schema: it is only mandatory where
        // the decision goes against the recommendation, and that is a fact
        // about the opportunity rather than about the request body.
        authority: {
          type: 'object',
          required: ['delegatedTo'],
          properties: {
            delegatedTo: stringField,
            reference: { type: 'string' },
            limitMinor: { type: 'integer', minimum: 0 },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      business.decideBidNoBid(tenantContext(platform, ctx), ctx.params.opportunityId as string, body(ctx)),
  },

  // -------------------------------------------------------- tender intake (T-WF-01)
  {
    method: 'GET',
    pattern: '/v1/pipeline/tenders',
    description: 'Every recorded invitation, soonest deadline first',
    handler: (platform, ctx) => tenderintake.tenderBoard(tenantContext(platform, ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/pipeline/tenders/:invitationId',
    description: 'One invitation: deadline in force, blockers, clarifications and addenda',
    handler: (platform, ctx) => tenderintake.tenderPosition(tenantContext(platform, ctx), ctx.params.invitationId as string),
  },
  {
    method: 'POST',
    pattern: '/v1/pipeline/opportunities/:opportunityId/tenders',
    description: 'Record an invitation to tender and its deadline, in the zone the deadline is read in',
    schema: {
      type: 'object',
      required: ['reference', 'issuedAt', 'returnLocal', 'timeZone', 'timeZoneStated', 'channel'],
      properties: {
        reference: stringField,
        issuedAt: stringField,
        returnLocal: stringField,
        timeZone: stringField,
        // Not defaulted. Whether the invitation stated a zone is the fact the
        // Critical clarification hangs on, and a default would decide it.
        timeZoneStated: { type: 'boolean' },
        channel: { type: 'string', enum: [...tenderintake.SUBMISSION_CHANNEL] },
        clarificationLocal: stringField,
        siteVisitLocal: stringField,
        documents: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      tenderintake.recordInvitation(tenantContext(platform, ctx), ctx.params.opportunityId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/pipeline/tenders/:invitationId/requirements',
    description: 'Extract the return deliverables and build the compliance matrix, with a source on every line',
    schema: {
      type: 'object',
      required: ['deliverables', 'analysis'],
      properties: {
        deliverables: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['reference', 'title', 'mandatory'],
            properties: {
              reference: stringField,
              title: stringField,
              mandatory: { type: 'boolean' },
              format: { type: 'string' },
              pageLimit: { type: 'integer', minimum: 1 },
              fileSizeLimitMb: { type: 'number', minimum: 0 },
              signatureRequired: { type: 'boolean' },
              bondRequired: { type: 'boolean' },
              channel: { type: 'string', enum: [...tenderintake.SUBMISSION_CHANNEL] },
              owner: { type: 'string', enum: TENANT_GRANTABLE_ROLES },
              internalDueBy: stringField,
              source: {
                type: 'object',
                required: ['document'],
                properties: { document: stringField, clause: { type: 'string' }, page: { type: 'integer', minimum: 1 } },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
        // The analyser's own input, passed through unchanged. It has its own
        // schema on /v1/projects/:id/itt and its own tests; restating the shape
        // here would give the platform two opinions about a requirement.
        analysis: { type: 'object' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const engineCtx = tenantContext(platform, ctx);
      const input = body(ctx) as { deliverables: tenderintake.TenderDeliverable[]; analysis: Parameters<typeof itt.analyseITT>[1] };
      const analysis = itt.analyseITT(engineCtx, input.analysis);
      const bound = tenderintake.extractRequirements(engineCtx, ctx.params.invitationId as string, {
        deliverables: input.deliverables,
        analysisId: analysis.analysisId,
      });
      return { ...bound, analysis };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/pipeline/tenders/:invitationId/deliverables',
    description: 'Add one return deliverable, the way somebody actually reads an invitation',
    schema: {
      type: 'object',
      required: ['reference', 'title', 'mandatory'],
      properties: {
        reference: stringField,
        title: stringField,
        mandatory: { type: 'boolean' },
        format: { type: 'string' },
        pageLimit: { type: 'integer', minimum: 1 },
        fileSizeLimitMb: { type: 'number', minimum: 0 },
        signatureRequired: { type: 'boolean' },
        bondRequired: { type: 'boolean' },
        channel: { type: 'string', enum: [...tenderintake.SUBMISSION_CHANNEL] },
        owner: { type: 'string', enum: TENANT_GRANTABLE_ROLES },
        internalDueBy: stringField,
        source: {
          type: 'object',
          required: ['document'],
          properties: { document: stringField, clause: { type: 'string' }, page: { type: 'integer', minimum: 1 } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      tenderintake.addDeliverable(tenantContext(platform, ctx), ctx.params.invitationId as string, body(ctx) as tenderintake.TenderDeliverable),
  },
  {
    method: 'POST',
    pattern: '/v1/pipeline/tenders/:invitationId/addenda',
    description: 'Record an addendum. It appends to the invitation and never rewrites it',
    schema: {
      type: 'object',
      required: ['reference', 'issuedAt', 'summary'],
      properties: {
        reference: stringField,
        issuedAt: stringField,
        summary: { type: 'string' },
        returnLocal: stringField,
        timeZone: stringField,
        addedDeliverables: { type: 'array', items: { type: 'object' } },
        source: {
          type: 'object',
          required: ['document'],
          properties: { document: stringField, clause: { type: 'string' }, page: { type: 'integer', minimum: 1 } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      tenderintake.issueAddendum(tenantContext(platform, ctx), ctx.params.invitationId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/pipeline/tenders/:invitationId/programme',
    description: 'Back-plan the tender programme and the bid work packages from the return deadline',
    schema: {
      type: 'object',
      properties: { from: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      tenderintake.generateBidProgramme(tenantContext(platform, ctx), ctx.params.invitationId as string, body(ctx)),
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
    pattern: '/v1/projects/:projectId/quality/plans/:planId/approve',
    description: 'Approve an inspection and test plan — the other side agreeing the criteria, which its author cannot do',
    schema: {
      type: 'object',
      required: ['approvedBy', 'approvingRole', 'evidenceHash'],
      properties: {
        approvedBy: stringField,
        approvingRole: stringField,
        note: { type: 'string' },
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      quality.approveInspectionPlan(projectContext(platform, ctx), {
        ...body<Omit<Parameters<typeof quality.approveInspectionPlan>[1], 'planId'>>(ctx),
        planId: ctx.params.planId as string,
      }),
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
        // Derived from the catalogue, not restated.
        //
        // This was a hand-written copy of the twelve types `CDM_DOCUMENTS` held,
        // and the two agreed only because nobody had added a document since.
        // Adding the traffic management plan proved it: the domain knew the type
        // and the gateway refused it, so a document the platform could produce
        // was unreachable through the only door that reaches it. A picker
        // offering a value the command rejects is worse than a free-text box.
        type: { type: 'string', enum: CDM_DOCUMENTS.map((document) => document.type) },
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
    method: 'POST',
    pattern: '/v1/projects/:projectId/safety/competencies',
    description: 'Record an operative’s qualification and its expiry — what a permit is checked against',
    // The register a permit is refused against had no door. `recordCompetency`
    // was reachable from the engine and from a test, and from nowhere a person
    // could get to: a site manager whose permit was refused for a missing
    // ticket had no way to record the ticket.
    schema: {
      type: 'object',
      required: ['operativeId', 'qualification', 'issuedAt', 'expiresAt', 'certificateHash'],
      properties: {
        operativeId: stringField,
        qualification: stringField,
        issuedAt: stringField,
        expiresAt: stringField,
        certificateHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => ({
      competencyId: safety.recordCompetency(projectContext(platform, ctx), body(ctx)),
    }),
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

  // --- Account pictures -------------------------------------------------------
  //
  // A picture on an account is not decoration here. A permit to work names the
  // person who issued it and an induction names who was inducted, and a face
  // beside a name is how somebody on site tells one J. Murphy from the other.
  //
  // Your own, and nobody else's. An administrator cannot set a colleague's
  // picture: there is no operational reason to, and the one thing it would
  // enable is putting somebody's face on a record they did not make.
  {
    method: 'POST',
    pattern: '/v1/me/picture',
    upload: true,
    // A face, not a drawing set. The evidence ceiling is sized for the latter
    // and leaving it here would let anybody make this process buffer 50MB.
    maxBytes: config.site.mediaMaxBytes,
    description: 'Set your own account picture. PNG, JPEG or WebP, read from the file rather than what it claims',
    handler: async (platform, ctx) => {
      const actor = auth(ctx);
      const user = await platform.setUserPicture({
        actorId: actor.actorId,
        userId: actor.actorId,
        bytes: ctx.rawBody ?? Buffer.alloc(0),
      });
      return { pictureHash: user.pictureHash };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/me/cover',
    upload: true,
    maxBytes: config.site.mediaMaxBytes,
    description: 'Set your own account cover image. PNG, JPEG or WebP, read from the file rather than what it claims',
    // Your own, and nobody else's, for the same reason as the picture above.
    // A cover is on your page and it is yours to choose; an administrator
    // putting one there is decorating somebody else's identity.
    handler: async (platform, ctx) => {
      const actor = auth(ctx);
      const user = await platform.setUserPicture({
        actorId: actor.actorId,
        userId: actor.actorId,
        bytes: ctx.rawBody ?? Buffer.alloc(0),
        kind: 'COVER',
      });
      return { coverHash: user.coverHash };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/users/:userId/cover',
    readOnly: true,
    binary: true,
    description: 'An account cover image, for anybody in the same tenancy as the person',
    handler: async (platform, ctx) => {
      // Same tenancy scoping as the picture: the hash is never supplied by the
      // caller, only looked up against a user already inside their tenancy.
      const actor = auth(ctx);
      const held = await platform.userPicture(actor.tenantId, ctx.params.userId as string, 'COVER');
      if (!held) throw new NotFoundError('That account has no cover image');
      return {
        bytes: held.bytes,
        contentType: held.contentType,
        filename: `${ctx.params.userId}-cover.img`,
        disposition: 'inline' as const,
      };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/users/:userId/picture',
    readOnly: true,
    binary: true,
    description: "An account picture, for anybody in the same tenancy as the person",
    handler: async (platform, ctx) => {
      // Scoped to the caller's own tenancy, which is what stops this being a
      // way to read arbitrary bytes out of the store: the hash is never
      // supplied by the caller, it is the one recorded against a user who is
      // already in their tenancy.
      const actor = auth(ctx);
      const held = await platform.userPicture(actor.tenantId, ctx.params.userId as string);
      if (!held) throw new NotFoundError('That account has no picture');
      // Inline, because this is rendered in an <img> rather than downloaded.
      // The gateway sends `nosniff` and a policy denying the document every
      // capability with it, which is what makes serving somebody's upload from
      // this origin safe.
      return {
        bytes: held.bytes,
        contentType: held.contentType,
        filename: `${ctx.params.userId}.img`,
        disposition: 'inline' as const,
      };
    },
  },

  // ------------------------------------------------------------------ people
  {
    method: 'GET',
    pattern: '/v1/users',
    readOnly: true,
    description: 'Everyone in this tenancy, with what each of them may do',
    handler: (platform, ctx) => {
      // The gap this closes: a tenancy could create people and never list them.
      // An administrator onboarded fifteen minutes earlier had no way to see who
      // was in their own organisation, which makes "change what somebody may do"
      // unusable — you cannot change the roles of a person you cannot find.
      //
      // Scoped to the caller's own tenancy from the token, never from a
      // parameter: a tenant id in the path would be an invitation to pass
      // somebody else's.
      const actor = auth(ctx);
      return {
        users: platform.users(actor.tenantId).map((user) => ({
          id: user.id,
          name: user.name,
          email: user.email,
          roles: user.roles,
          status: user.status,
        })),
      };
    },
  },
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
        roles: { type: 'array', minItems: 1, items: { type: 'string', enum: TENANT_GRANTABLE_ROLES } },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      if (!actor.roles.includes('ENTERPRISE_ADMIN') && !actor.roles.includes('OWNER')) {
        throw new ForbiddenError('Only an enterprise admin may create users', 'ENTERPRISE_ADMIN_REQUIRED');
      }
      const input = body<{ name: string; email: string; roles: string[]; partyId?: string }>(ctx);
      // The roles were passed straight through, from an array of unconstrained
      // strings. An enterprise admin could mint a PLATFORM_ADMIN and hold the
      // whole operator surface — including crediting their own wallet with
      // unlimited money, which defeats every control on the money model.
      return platform.createUser({
        ...input,
        roles: assertTenantGrantable(input.roles),
        tenantId: actor.tenantId,
      });
    },
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/invitations',
    readOnly: true,
    description: 'Who has been invited onto this project, and whether they have taken it up',
    handler: (platform, ctx) => {
      const context = projectContext(platform, ctx);
      const subscription = platform.subscription(context.tenantId);
      const limit = subscription ? PACKAGES[subscription.package].includedSeats : null;
      const pending = invitation.pendingInvitations(context);
      return {
        invitations: context.ledger
          .listByTenant(context.tenantId, 'ProjectInvitation')
          .map((record) => record.state),
        // The seat position, because an invitation is a seat and somebody about
        // to send one needs to know whether there is one to give.
        seats: {
          includedSeats: limit,
          assigned: subscription?.assignedIdentities.length ?? 0,
          heldByInvitations: pending.length,
          remaining: limit === null ? null : limit - (subscription?.assignedIdentities.length ?? 0) - pending.length,
        },
      };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/invitations',
    description: 'Invite somebody onto this project — internal or external, counted as a full identity',
    schema: {
      type: 'object',
      required: ['name', 'email', 'roles', 'external', 'because'],
      properties: {
        name: stringField,
        email: stringField,
        roles: { type: 'array', minItems: 1, items: { type: 'string', enum: TENANT_GRANTABLE_ROLES } },
        external: { type: 'boolean' },
        organisation: { type: 'string' },
        because: { type: 'string', minLength: 10 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const input = body<Parameters<typeof invitation.inviteToProject>[2]>(ctx);
      return invitation.inviteToProject(platform, projectContext(platform, ctx), {
        ...input,
        // The same guard the user route has: an array of unconstrained strings
        // reaching the role model is how somebody mints a platform operator.
        roles: assertTenantGrantable(input.roles),
      });
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/invitations/:invitationId/withdraw',
    description: 'Take back an invitation, returning the seat it was holding',
    schema: {
      type: 'object',
      required: ['reason'],
      properties: { reason: { type: 'string', minLength: 5 } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      invitation.withdrawInvitation(projectContext(platform, ctx), {
        invitationId: ctx.params.invitationId as string,
        reason: body<{ reason: string }>(ctx).reason,
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/invitations/:invitationId/accept',
    description: 'Accept an invitation, which is where the identity is created and the seat taken',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (platform, ctx) =>
      invitation.acceptInvitation(platform, projectContext(platform, ctx), {
        invitationId: ctx.params.invitationId as string,
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/users/:userId/roles',
    description: 'Change what an identity is allowed to do, recorded against whoever changed it',
    schema: {
      type: 'object',
      required: ['roles', 'reason'],
      properties: {
        roles: { type: 'array', minItems: 1, items: { type: 'string', enum: TENANT_GRANTABLE_ROLES } },
        reason: { type: 'string', minLength: 10 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      if (!actor.roles.includes('ENTERPRISE_ADMIN') && !actor.roles.includes('OWNER')) {
        throw new ForbiddenError('Only an enterprise admin may change roles', 'ENTERPRISE_ADMIN_REQUIRED');
      }
      const input = body<{ roles: string[]; reason: string }>(ctx);
      // The same hole by the other door: creating a user was not the only way
      // to acquire a role, and promoting an existing one was unconstrained too.
      return platform.assignRoles(actor, {
        ...input,
        roles: assertTenantGrantable(input.roles),
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
      if (!demonstrationOffered()) {
        throw new ForbiddenError('Demonstration identities are not available on this deployment', 'DEMO_DISABLED');
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
      // In production only the seeded demonstration identities are listed, and
      // no operator is. Outside production the list is the deployment's whole
      // population, because that is the fixture and there is nobody else on it.
      //
      // The operator omission is not cosmetic. In production a live deployment's
      // real `PLATFORM_ADMIN` is on the platform, listing it would put a
      // cross-tenant administrator on the front door as a button, and the button
      // would not even work — an operator is never a demonstration identity, so
      // login returns it no code. A control that cannot succeed should not be
      // drawn.
      const demonstrationOnly = isProduction();
      const listed = demonstrationOnly ? users.filter((u) => u.demonstration === true) : users;
      const operators = demonstrationOnly ? [] : platform.operators();
      return {
        projectId: session.projectId,
        enterprise: session.enterpriseName,
        portfolio: session.portfolioName,
        identities: [
          ...listed.map((u) => shape(u, u.roles.includes('ENTERPRISE_ADMIN') ? 'ENTERPRISE_ADMIN' : 'TENANT_USER')),
          ...operators.map((u) => shape(u, 'PLATFORM_ADMIN')),
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
      // The roles a tenant administrator may actually grant. Published for the
      // same reason as everything else here: a console that wants to know
      // whether a capability is reachable *by anybody in this customer's world*
      // would otherwise have to hard-code which roles are operator-only, and
      // that rule would then drift from this one.
      tenantGrantableRoles: [...TENANT_GRANTABLE_ROLES],
    }),
  },

  // ------------------------------------------------------------- public site
  //
  // Server-rendered rather than client-rendered, unlike the console. These
  // pages are read by people deciding whether to trust the product, by search
  // crawlers and by link previews — all of which see markup, not the script
  // that would have produced it.
  // `/demo` is registered separately below, because it is the one page that has
  // to seed before it renders rather than only read.
  ...site.SITE_PAGES.filter((definition) => definition.path !== '/demo').map((definition) => ({
    method: 'GET' as const,
    pattern: definition.path,
    public: true,
    html: true,
    htmlPolicy: 'PUBLIC_SITE' as const,
    description: `Public site — ${definition.label}`,
    handler: (platform: Platform, ctx: RequestContext) => site.render(definition.path, platform, ctx),
  })),
  {
    method: 'GET',
    pattern: '/demo',
    public: true,
    html: true,
    htmlPolicy: 'PUBLIC_SITE' as const,
    description: 'Public site — Try it',
    handler: async (platform: Platform, ctx: RequestContext) => {
      await ensureDemonstrationSeeded(platform);
      return site.render('/demo', platform, ctx);
    },
  },

  // Blog posts, each at its own address. Registered separately from
  // `SITE_PAGES` because that list also drives the navigation and the footer,
  // and engineering notes belong in neither — they are reached from the blog
  // index and from links people share. Their own URLs are also the only way
  // anything can count them: every measurement tool counts pages, not cards.
  // A post published through the console. One pattern rather than one route per
  // post, because these are created after this table is built — the compiled
  // six keep their own concrete routes below, and this answers for the rest.
  // `site.render` refuses any slug that is not PUBLISHED, so a draft is not
  // reachable by guessing its address.
  {
    method: 'GET' as const,
    pattern: '/blog/:slug',
    public: true,
    html: true,
    htmlPolicy: 'PUBLIC_SITE' as const,
    description: 'A blog post published from the console',
    handler: (platform: Platform, ctx: RequestContext) => {
      const slug = ctx.params.slug as string;
      const page = site.render(`/blog/${slug}`, platform, ctx);
      // Counted after the page has been produced, so a slug that does not
      // resolve records nothing — otherwise a crawler probing for pages would
      // manufacture traffic for articles that were never written.
      views.recordView(slug);
      return page;
    },
  },

  ...POST_PAGES.map((post) => ({
    method: 'GET' as const,
    pattern: post.path,
    public: true,
    html: true,
    htmlPolicy: 'PUBLIC_SITE' as const,
    description: `Blog — ${post.title}`,
    handler: (platform: Platform, ctx: RequestContext) => {
      const page = site.render(post.path, platform, ctx);
      views.recordView(post.slug);
      return page;
    },
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
        // A referral code from a partner's link. Optional, bounded, and stored
        // whether or not anybody in the programme holds it — an unknown code is
        // reported as unattributed rather than dropped, because a typo in
        // somebody's link is a fact worth seeing.
        referralCode: { type: 'string', minLength: 3, maxLength: 32 },
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
      //
      // Note what this gate is *not* keyed on. `DEMO_TENANCY_ENABLED` opens the
      // identity list and lets a seeded account's one-time code come back in
      // the login response; it does not open this. A published account that
      // still has to answer a challenge and a route that skips the challenge
      // entirely are different things, and only the first of them belongs on
      // the internet under any setting.
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
      // The region is required. This is a multi-country platform and a portfolio
      // attached to nowhere cannot be rolled up, compared, or held to one
      // jurisdiction's contract law — and `createProject` now holds every
      // project to the region of the portfolio it is filed under, which needs a
      // region to hold it to. The country stays optional: a portfolio scoped to
      // one is a single-jurisdiction portfolio, and one without is regional.
      required: ['name', 'enterpriseId', 'governanceModel', 'continentCode'],
      properties: {
        name: stringField,
        enterpriseId: stringField,
        governanceModel: stringField,
        continentCode: { type: 'string', enum: values(CONTINENT) },
        countryCode: { type: 'string', enum: values(COUNTRY) },
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
            countryCode: { type: 'string', enum: values(COUNTRY) },
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
        changeRequestRef: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => planning.approveBaseline(projectContext(platform, ctx), body(ctx)),
  },

  // ---------------------------- CN-WF-02 programme logic, forecast and weekly control
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/programme/logic',
    description: 'Open ends, dangling logic, negative float and out-of-sequence work, each named rather than counted',
    handler: (platform, ctx) => programmecontrol.validateProgrammeLogic(projectContext(platform, ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/programme/control',
    description: 'Baseline against forecast, what is blocked and why, and whether the programme has moved since the forecast',
    handler: (platform, ctx) => programmecontrol.programmeControlPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/programme/forecasts',
    description: 'Approve a current forecast. A separate record from the baseline, because the baseline is what delay is measured against',
    schema: {
      type: 'object',
      required: ['version', 'reason', 'forecastCompletionDate'],
      properties: {
        version: stringField,
        reason: { type: 'string', minLength: 4 },
        forecastCompletionDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => programmecontrol.approveForecast(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/lookaheads/:lookaheadId/freeze',
    description: 'Freeze the weekly work plan. A week that can be reopened is one whose promises get edited to match the outcome',
    schema: {
      type: 'object',
      required: ['weekEnding', 'note'],
      properties: { weekEnding: stringField, note: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      programmecontrol.freezeWeeklyPlan(projectContext(platform, ctx), ctx.params.lookaheadId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tasks/:taskId/status',
    description: 'Daily status. Blocked needs a reason, an owner, an impact and a next action; complete needs its evidence',
    schema: {
      type: 'object',
      required: ['status'],
      properties: {
        status: { type: 'string', enum: [...programmecontrol.TASK_STATUS] },
        note: { type: 'string' },
        blocked: {
          type: 'object',
          required: ['reason', 'owner', 'impact', 'nextAction'],
          properties: {
            reason: { type: 'string' },
            owner: stringField,
            impact: { type: 'string' },
            nextAction: { type: 'string' },
          },
          additionalProperties: false,
        },
        verification: {
          type: 'object',
          required: ['description', 'hash'],
          properties: { description: { type: 'string' }, hash: stringField },
          additionalProperties: false,
        },
        sequence: {
          type: 'object',
          required: ['decision', 'rationale'],
          properties: {
            decision: { type: 'string', enum: [...programmecontrol.SEQUENCE_DECISION] },
            rationale: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      programmecontrol.updateTaskStatus(projectContext(platform, ctx), {
        ...body(ctx),
        taskId: ctx.params.taskId as string,
      }),
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

  // ------------------------------------------ CN-WF-09 and CN-WF-10 five values, and a deadline somebody checked
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/commercial-control',
    description: 'Submitted against assessed, certified against paid, and the time bars nobody has checked',
    handler: (platform, ctx) => valuechain.commercialControlPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/values',
    description: 'Record one of the five values. None of them replaces another, and nothing is paid above what was certified',
    schema: {
      type: 'object',
      required: ['subjectType', 'subjectRef', 'title', 'stage', 'amountMinor', 'basis', 'by'],
      properties: {
        subjectType: stringField,
        subjectRef: stringField,
        title: stringField,
        stage: { type: 'string', enum: [...valuechain.VALUE_STAGE] },
        amountMinor: { type: 'number' },
        timeDays: { type: 'number' },
        basis: { type: 'string' },
        by: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => valuechain.recordValue(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/notice-deadlines',
    description: 'Derive a deadline with the rule that imposes it and the arithmetic it was computed from. Unvalidated until checked',
    schema: {
      type: 'object',
      required: ['reference', 'category', 'description', 'ruleSource', 'inputs', 'dueDate', 'timeBarred'],
      properties: {
        reference: stringField,
        category: stringField,
        description: { type: 'string' },
        ruleSource: stringField,
        inputs: {
          type: 'object',
          required: ['triggerEvent', 'triggerDate', 'periodDays', 'calendar'],
          properties: {
            triggerEvent: stringField,
            triggerDate: stringField,
            periodDays: { type: 'number', exclusiveMinimum: 0 },
            calendar: { type: 'string', enum: ['CALENDAR_DAYS', 'BUSINESS_DAYS'] },
          },
          additionalProperties: false,
        },
        dueDate: stringField,
        timeBarred: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => valuechain.deriveDeadline(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/notice-deadlines/:deadlineId/validate',
    description: 'A person agreeing the date, or correcting it. The derivation is kept either way',
    schema: {
      type: 'object',
      required: ['agrees', 'note', 'validatedBy'],
      properties: {
        agrees: { type: 'boolean' },
        correctedDueDate: stringField,
        note: { type: 'string' },
        validatedBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      valuechain.validateDeadline(projectContext(platform, ctx), ctx.params.deadlineId as string, body(ctx)),
  },

  // ------------------------------------------ CN-WF-08 who was sent what, and what was only ever said
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/information-control',
    description: 'Who is still holding superseded information, what was only ever said verbally, and which RFIs have no float',
    handler: (platform, ctx) => informationcontrol.informationPosition(projectContext(platform, ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/current-information',
    description: 'What is current, what it replaced, and who has not acknowledged the replacement',
    handler: (platform, ctx) =>
      informationcontrol.currentInformationFor(
        projectContext(platform, ctx),
        ctx.query?.get('package') ?? undefined,
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/transmittals',
    description: 'Issue named documents at named revisions to named recipients, for a stated purpose',
    schema: {
      type: 'object',
      required: ['documents', 'recipients', 'note'],
      properties: {
        documents: {
          type: 'array',
          items: {
            type: 'object',
            required: ['reference', 'title', 'revision', 'purpose'],
            properties: {
              reference: stringField,
              title: stringField,
              revision: stringField,
              purpose: stringField,
              supersedes: stringField,
            },
            additionalProperties: false,
          },
        },
        recipients: { type: 'array', items: stringField },
        packageReference: stringField,
        note: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => informationcontrol.issueTransmittal(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/transmittals/:transmittalId/acknowledge',
    description: 'A recipient confirming they hold it. Until they do, they are holding the old one',
    schema: {
      type: 'object',
      required: ['party', 'acknowledgedBy'],
      properties: { party: stringField, acknowledgedBy: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      informationcontrol.acknowledgeTransmittal(projectContext(platform, ctx), ctx.params.transmittalId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/instructions',
    description: 'Issue a numbered instruction under a named clause, to named recipients, with the document that was issued',
    schema: {
      type: 'object',
      required: ['subject', 'instruction', 'contractClause', 'recipients', 'evidenceHash'],
      properties: {
        subject: stringField,
        instruction: { type: 'string' },
        contractClause: stringField,
        recipients: { type: 'array', items: stringField },
        confirmsDirectionId: stringField,
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => informationcontrol.issueInstruction(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/instructions/:instructionId/implemented',
    description: 'What was actually done on site and who checked it',
    schema: {
      type: 'object',
      required: ['what', 'verifiedBy', 'evidenceHash'],
      properties: { what: { type: 'string' }, verifiedBy: stringField, evidenceHash: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      informationcontrol.recordInstructionImplementation(
        projectContext(platform, ctx),
        ctx.params.instructionId as string,
        body(ctx),
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/unconfirmed-directions',
    description: 'Record what was said, by whom, to whom, and what the site did about it. Visible exposure, not an instruction',
    schema: {
      type: 'object',
      required: ['givenBy', 'givenTo', 'givenAt', 'whatWasSaid', 'actionTaken'],
      properties: {
        givenBy: stringField,
        givenTo: stringField,
        givenAt: stringField,
        whatWasSaid: { type: 'string' },
        actionTaken: { type: 'string' },
        estimatedCostMinor: { type: 'number', minimum: 0 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => informationcontrol.recordUnconfirmedDirection(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/unconfirmed-directions/:directionId/withdraw',
    description: 'Withdrawn, superseded, or never actually said — with what happened to the work done on the strength of it',
    schema: {
      type: 'object',
      required: ['reason'],
      properties: { reason: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      informationcontrol.withdrawDirection(projectContext(platform, ctx), ctx.params.directionId as string, body(ctx)),
  },

  // ------------------------------------------ CN-WF-07 the second half of RAMS, permits and incidents
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/safety-control',
    description: 'Revised methods nobody has been rebriefed on, permits past their expiry, and incidents never investigated',
    handler: (platform, ctx) => safetycontrol.safetyControlPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/rams/:ramsId/revise',
    description: 'Revise a method statement. The new one starts unapproved and unbriefed, and names who is owed the difference',
    schema: {
      type: 'object',
      required: ['reason', 'whatChanged'],
      properties: { reason: { type: 'string' }, whatChanged: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      safetycontrol.reviseRAMS(projectContext(platform, ctx), ctx.params.ramsId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/permits/:permitId/extend',
    description: 'Extend a permit. Refused where a ticket would lapse inside the extension',
    schema: {
      type: 'object',
      required: ['validTo', 'reason'],
      properties: { validTo: stringField, reason: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      safetycontrol.extendPermit(projectContext(platform, ctx), ctx.params.permitId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/permits/:permitId/hand-back',
    description: 'Hand the area back, with the state it was left in and who checked it',
    schema: {
      type: 'object',
      required: ['areaCondition', 'checkedBy'],
      properties: {
        areaCondition: { type: 'string' },
        checkedBy: stringField,
        outstandingHazards: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      safetycontrol.handBackPermit(projectContext(platform, ctx), ctx.params.permitId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/safety-observations/:observationId/close',
    description: 'Close an observation with an owner, what was done and the evidence that verifies it',
    schema: {
      type: 'object',
      required: ['owner', 'actionTaken', 'verificationEvidence', 'evidenceHash'],
      properties: {
        owner: stringField,
        actionTaken: { type: 'string' },
        verificationEvidence: { type: 'string' },
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      safetycontrol.closeSafetyAction(projectContext(platform, ctx), ctx.params.observationId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/incidents/:incidentId/investigate',
    description: 'Immediate, underlying and root cause, with the actions out of them. An investigation stopping at the first blames somebody',
    schema: {
      type: 'object',
      required: ['immediateCause', 'underlyingCause', 'rootCause', 'actions', 'investigatedBy', 'evidenceHash'],
      properties: {
        immediateCause: { type: 'string' },
        underlyingCause: { type: 'string' },
        rootCause: { type: 'string' },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['what', 'owner', 'by'],
            properties: { what: { type: 'string' }, owner: stringField, by: stringField },
            additionalProperties: false,
          },
        },
        investigatedBy: stringField,
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      safetycontrol.investigateIncident(projectContext(platform, ctx), ctx.params.incidentId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/incidents/:incidentId/close',
    description: 'Close an incident. Refused before it has been investigated',
    schema: {
      type: 'object',
      required: ['note'],
      properties: { note: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      safetycontrol.closeIncident(projectContext(platform, ctx), ctx.params.incidentId as string, body(ctx)),
  },

  // ------------------------------------------ CN-WF-06 the hold point, the instrument and the concession
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/quality-control',
    description: 'Hold points passed and not released, instruments out of calibration, reopened NCRs and concessions in force',
    handler: (platform, ctx) => qualitycontrol.qualityControlPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/inspection-requests',
    description: 'Call an inspection against an exact information revision, with the prerequisites confirmed and who to tell',
    schema: {
      type: 'object',
      required: ['planId', 'stageReference', 'informationRevision', 'notifyParties', 'requiredBy', 'prerequisitesConfirmed'],
      properties: {
        planId: stringField,
        stageReference: stringField,
        informationRevision: stringField,
        notifyParties: { type: 'array', items: stringField },
        requiredBy: stringField,
        prerequisitesConfirmed: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => qualitycontrol.requestInspection(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/hold-point-releases',
    description: 'Release a passed hold point. The authority to build over it, which is not the same act as the inspection',
    schema: {
      type: 'object',
      required: ['planId', 'stageReference', 'basis', 'evidenceHash'],
      properties: {
        planId: stringField,
        stageReference: stringField,
        basis: { type: 'string' },
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => qualitycontrol.releaseHoldPoint(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/instruments',
    description: 'The calibration register. A reading from an instrument past its certificate is unknown, not merely wrong',
    schema: {
      type: 'object',
      required: ['instrumentId', 'description', 'calibratedAt', 'calibrationExpiresAt', 'certificate'],
      properties: {
        instrumentId: stringField,
        description: { type: 'string' },
        calibratedAt: stringField,
        calibrationExpiresAt: stringField,
        certificate: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => qualitycontrol.registerInstrument(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/ncrs/:ncrId/corrective-action',
    description: 'Containment, root cause, corrective and preventive action, with the evidence it was carried out',
    schema: {
      type: 'object',
      required: ['containment', 'rootCause', 'corrective', 'preventive', 'owner', 'by', 'evidenceHash'],
      properties: {
        containment: { type: 'string' },
        rootCause: { type: 'string' },
        corrective: { type: 'string' },
        preventive: { type: 'string' },
        owner: stringField,
        by: stringField,
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      qualitycontrol.recordCorrectiveAction(projectContext(platform, ctx), ctx.params.ncrId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/ncrs/:ncrId/concession',
    description: 'Design authority accepting that the as-built differs from the design, with what the concession does not cover',
    schema: {
      type: 'object',
      required: ['rationale', 'limitations', 'evidenceHash'],
      properties: { rationale: { type: 'string' }, limitations: { type: 'string' }, evidenceHash: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      qualitycontrol.approveConcession(projectContext(platform, ctx), ctx.params.ncrId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/ncrs/:ncrId/reopen',
    description: 'Reopen a defect closed on evidence that was withdrawn or superseded. The original closure is kept in full',
    schema: {
      type: 'object',
      required: ['reason', 'withdrawnEvidence'],
      properties: { reason: { type: 'string' }, withdrawnEvidence: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      qualitycontrol.reopenNCR(projectContext(platform, ctx), ctx.params.ncrId as string, body(ctx)),
  },

  // ------------------------------------------ CN-WF-05 what was bought, what turned up, and where it went
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/procurement-items',
    description: 'Long leads against their order-by dates, quarantined material, open discrepancies and installed serials',
    handler: (platform, ctx) => delivery.procurementPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/procurement-items',
    description: 'Register a purchased item with the date the programme needs it and the lead time it takes',
    schema: {
      type: 'object',
      required: ['reference', 'description', 'quantity', 'unit', 'requiredOnSiteBy', 'leadTimeDays', 'safetyCritical'],
      properties: {
        reference: stringField,
        description: { type: 'string' },
        quantity: { type: 'number', exclusiveMinimum: 0 },
        unit: stringField,
        requiredOnSiteBy: stringField,
        leadTimeDays: { type: 'number', minimum: 0 },
        safetyCritical: { type: 'boolean' },
        unitRateMinor: { type: 'number', minimum: 0 },
        substitutionSubmittalRef: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => delivery.registerProcurementItem(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/procurement-items/:itemId/milestones',
    description: 'Move an item along its ladder. Every step names the evidence it rests on; delivery is received, not declared',
    schema: {
      type: 'object',
      required: ['step', 'evidence'],
      properties: {
        step: { type: 'string', enum: [...delivery.PROCUREMENT_STEP] },
        evidence: { type: 'string' },
        note: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      delivery.advanceProcurement(projectContext(platform, ctx), ctx.params.itemId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/procurement-items/:itemId/deliveries',
    description: 'Book a delivery into a slot. Two lifts in one slot is refused rather than discovered on the day',
    schema: {
      type: 'object',
      required: ['bookedFor', 'slot', 'craneRequired'],
      properties: { bookedFor: stringField, slot: stringField, craneRequired: { type: 'boolean' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      delivery.bookDelivery(projectContext(platform, ctx), ctx.params.itemId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/deliveries/:deliveryId/receive',
    description: 'Record what turned up. Safety-critical material with no certificate is quarantined on arrival',
    schema: {
      type: 'object',
      required: ['deliveryNote', 'dispatchedQuantity', 'receivedQuantity', 'condition', 'evidenceHash'],
      properties: {
        deliveryNote: stringField,
        dispatchedQuantity: { type: 'number', minimum: 0 },
        receivedQuantity: { type: 'number', minimum: 0 },
        condition: { type: 'string' },
        damaged: { type: 'boolean' },
        units: {
          type: 'array',
          items: {
            type: 'object',
            required: ['identifier'],
            properties: { identifier: stringField, certificate: { type: 'string' } },
            additionalProperties: false,
          },
        },
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      delivery.receiveDelivery(projectContext(platform, ctx), ctx.params.deliveryId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/deliveries/:deliveryId/quarantine',
    description: 'Hold material nobody may use, with what is wrong with it',
    schema: {
      type: 'object',
      required: ['why'],
      properties: { why: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      delivery.quarantineDelivery(projectContext(platform, ctx), ctx.params.deliveryId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/deliveries/:deliveryId/release',
    description: 'Release from quarantine, on quality authority, naming what resolved it',
    schema: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: { type: 'string' },
        units: {
          type: 'array',
          items: {
            type: 'object',
            required: ['identifier'],
            properties: { identifier: stringField, certificate: { type: 'string' } },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      delivery.releaseFromQuarantine(projectContext(platform, ctx), ctx.params.deliveryId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/deliveries/:deliveryId/accept',
    description: 'Take it into stock. Once, and never over an unreconciled difference or a quarantine',
    schema: {
      type: 'object',
      required: ['note'],
      properties: {
        note: { type: 'string' },
        reconciliation: {
          type: 'object',
          required: ['kind', 'what', 'chasedBy'],
          properties: {
            kind: { type: 'string', enum: ['SHORT', 'OVER', 'DAMAGED'] },
            what: { type: 'string' },
            chasedBy: stringField,
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      delivery.acceptDelivery(projectContext(platform, ctx), ctx.params.deliveryId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/deliveries/:deliveryId/install',
    description: 'Record a serial into the works, with where it went and the test that proves it works there',
    schema: {
      type: 'object',
      required: ['identifier', 'location', 'testEvidence'],
      properties: { identifier: stringField, location: stringField, testEvidence: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      delivery.installUnit(projectContext(platform, ctx), ctx.params.deliveryId as string, body(ctx)),
  },

  // ------------------------------------------ CN-WF-04 progress claimed, then certified by somebody else
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/progress-verification',
    description: 'What was claimed against what was accepted, what is awaiting a verifier, and the rework that earns nothing',
    handler: (platform, ctx) => progressverification.progressVerificationPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tasks/:taskId/measurement-basis',
    description: 'What the activity is measured in, how, and against what control total — with the drawing it came from',
    schema: {
      type: 'object',
      required: ['unit', 'controlTotal', 'measurementRule', 'source'],
      properties: {
        unit: stringField,
        controlTotal: { type: 'number', exclusiveMinimum: 0 },
        measurementRule: { type: 'string' },
        source: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      progressverification.setMeasurementBasis(projectContext(platform, ctx), {
        ...body(ctx),
        taskId: ctx.params.taskId as string,
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tasks/:taskId/progress-claims',
    description: 'Claim installed quantity against an activity, a location and a period. The same three twice is refused',
    schema: {
      type: 'object',
      required: ['quantity', 'unit', 'location', 'periodFrom', 'periodTo', 'evidenceDescription', 'evidenceHash'],
      properties: {
        quantity: { type: 'number', exclusiveMinimum: 0 },
        unit: stringField,
        location: stringField,
        periodFrom: stringField,
        periodTo: stringField,
        costCode: stringField,
        rework: { type: 'boolean' },
        evidenceDescription: { type: 'string' },
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      progressverification.submitProgress(projectContext(platform, ctx), {
        ...body(ctx),
        taskId: ctx.params.taskId as string,
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/progress-claims/:submissionId/verify',
    description: 'Accept, adjust or reject a claim. The submitted quantity is never overwritten, and an adjustment needs evidence',
    schema: {
      type: 'object',
      required: ['decision', 'rationale'],
      properties: {
        decision: { type: 'string', enum: [...progressverification.VERIFICATION] },
        acceptedQuantity: { type: 'number', minimum: 0 },
        rationale: { type: 'string' },
        evidenceDescription: { type: 'string' },
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      progressverification.verifyProgress(projectContext(platform, ctx), ctx.params.submissionId as string, body(ctx)),
  },

  // ------------------------------------------ CN-WF-03 offline daily log, captured over a shift
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/daily-logs',
    description: 'Drafts still on a device, days recorded, amendments with their before and after, and any device clock drift',
    handler: (platform, ctx) => dailylog.dailyLogPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/daily-logs',
    description: 'Open a daily log from a device. Idempotent on the id the device minted, so a retried sync writes it once',
    schema: {
      type: 'object',
      required: ['clientUuid', 'deviceId', 'capturedAt', 'diaryDate', 'shift', 'weather', 'labour', 'plant', 'progressNarrative', 'workedTaskIds', 'location'],
      properties: {
        clientUuid: stringField,
        deviceId: stringField,
        capturedAt: stringField,
        diaryDate: stringField,
        shift: { type: 'string', enum: [...dailylog.SHIFT] },
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
        workedTaskIds: { type: 'array', items: stringField },
        location: stringField,
        deliveries: { type: 'array' },
        blockers: { type: 'array' },
        visitors: { type: 'array' },
        safetyEvents: { type: 'array' },
        voiceSegments: { type: 'array' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => dailylog.draftDailyLog(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/daily-logs/:logId/submit',
    description: 'Submit the shift once. Anomalous totals are confirmed rather than refused, and never submitted unseen',
    schema: {
      type: 'object',
      required: ['evidenceHash'],
      properties: {
        evidenceHash: stringField,
        confirmedAnomalies: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      dailylog.submitDailyLog(projectContext(platform, ctx), ctx.params.logId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/daily-logs/:logId/amend',
    description: 'Amend a submitted log. A new record naming what it supersedes, with the before and after of every change',
    schema: {
      type: 'object',
      required: ['content', 'reason', 'evidenceHash'],
      properties: {
        content: { type: 'object' },
        reason: { type: 'string' },
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      dailylog.amendDailyLog(projectContext(platform, ctx), ctx.params.logId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/sync-sessions',
    description: 'Record that a device came back into signal and what it brought, with the variance on its clock',
    schema: {
      type: 'object',
      required: ['deviceId', 'syncSessionId', 'accepted', 'duplicates', 'conflicts', 'deviceTimestamp'],
      properties: {
        deviceId: stringField,
        syncSessionId: stringField,
        accepted: { type: 'integer', minimum: 0 },
        duplicates: { type: 'integer', minimum: 0 },
        conflicts: { type: 'integer', minimum: 0 },
        deviceTimestamp: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => dailylog.recordSyncCompleted(projectContext(platform, ctx), body(ctx)),
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
  // --- design review cycle --------------------------------------------------
  //
  // The specification's paths are `/v1/design-deliverables/{id}:submit` and so
  // on. These are project-scoped, as every other delivery route here is: the
  // project is what authorises the read, and a bare deliverable id would mean
  // resolving the tenancy from the record before the request could be refused.
  // The verbs and the shape are the specification's.
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design/reviews',
    description: 'Submit a design deliverable for review, with the author’s own check declared',
    schema: {
      type: 'object',
      required: ['deliverable', 'selfCheck', 'checkerId', 'dueBy'],
      properties: {
        deliverable: {
          type: 'object',
          required: ['refType', 'refId'],
          properties: { refType: stringField, refId: stringField },
          additionalProperties: false,
        },
        selfCheck: { type: 'string', minLength: 20 },
        checkerId: stringField,
        dueBy: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        purpose: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => designreview.submitForReview(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design/reviews/:cycleId/comments',
    description: 'Raise a comment against a deliverable in review, at a named location and severity',
    schema: {
      type: 'object',
      required: ['severity', 'location', 'comment'],
      properties: {
        severity: { type: 'string', enum: [...designreview.COMMENT_SEVERITY] },
        location: { type: 'string', minLength: 1 },
        comment: { type: 'string', minLength: 5 },
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      designreview.raiseComment(projectContext(platform, ctx), {
        ...body<{ severity: designreview.CommentSeverity; location: string; comment: string; evidenceHash?: string }>(ctx),
        cycleId: ctx.params.cycleId as string,
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design/comments/:commentId/disposition',
    description: 'The author’s answer to a comment — accepted, rejected, or an alternative proposed',
    schema: {
      type: 'object',
      required: ['disposition', 'response'],
      properties: {
        disposition: { type: 'string', enum: [...designreview.COMMENT_DISPOSITION] },
        response: { type: 'string', minLength: 10 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      designreview.dispositionComment(projectContext(platform, ctx), {
        ...body<{ disposition: designreview.CommentDisposition; response: string }>(ctx),
        commentId: ctx.params.commentId as string,
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design/comments/:commentId/close',
    description: 'The checker agrees the response settles the comment. Only then does it stop blocking',
    schema: { type: 'object', properties: { note: stringField }, additionalProperties: false },
    handler: (platform, ctx) =>
      designreview.closeComment(projectContext(platform, ctx), {
        ...body<{ note?: string }>(ctx),
        commentId: ctx.params.commentId as string,
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design/reviews/:cycleId/decide',
    description: 'Accept, accept with comments, send back for revision, or reject. Refused while a blocking comment is open',
    schema: {
      type: 'object',
      required: ['decision', 'reason'],
      properties: {
        decision: { type: 'string', enum: [...designreview.REVIEW_DECISION] },
        reason: { type: 'string', minLength: 10 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      designreview.decideReview(projectContext(platform, ctx), {
        ...body<{ decision: designreview.ReviewDecision; reason: string }>(ctx),
        cycleId: ctx.params.cycleId as string,
      }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/design/reviews',
    readOnly: true,
    description: 'Where every review stands: duration, what is overdue, and whose it is now',
    handler: (platform, ctx) =>
      designreview.reviewPosition(projectContext(platform, ctx), ctx.query.get('today') ?? undefined),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/design/reviews/:cycleId/comments',
    readOnly: true,
    description: 'The comment and disposition register for one cycle, blocking first',
    handler: (platform, ctx) => {
      const engineCtx = projectContext(platform, ctx);
      authorise(engineCtx, 'DESIGN_INFORMATION', 'R');
      return {
        cycle: platform.ledger.require({ refType: 'DesignReviewCycle', refId: ctx.params.cycleId as string }).state,
        comments: designreview.commentsFor(engineCtx, ctx.params.cycleId as string),
        // Published so the console reads what blocks rather than holding a
        // second copy of the rule.
        blockingSeverities: designreview.BLOCKING_SEVERITIES,
      };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/field/recordings',
    description: 'File a site recording as evidence before anything has been said about it',
    schema: {
      type: 'object',
      required: ['hash', 'description'],
      properties: {
        hash: stringField,
        description: { type: 'string', minLength: 3, maxLength: 200 },
        // The activity the recording is about, where the person knew it at the
        // time. Optional, because on a walk they often do not.
        taskId: stringField,
      },
      additionalProperties: false,
    },
    /**
     * Capture first, structure afterwards.
     *
     * Every other evidence file on the platform arrives *attached* to a command
     * — a photograph with a progress record, a survey with a measurement — and
     * that is right, because those are cases where the person already knows what
     * they are recording.
     *
     * A dictated site note is the opposite. Nobody knows what category it is,
     * where it happened or who owns it until it has been listened to, and the
     * whole point of walking and recording is that the structuring happens
     * later. So the recording has to be filable on its own.
     *
     * That is not a placeholder record. An audio file of a site walk is evidence
     * in its own right whatever is subsequently made of it, and it is the piece
     * a delay claim is argued from three years later. It is registered as what
     * it is, and the transcription that follows is a separate act with its own
     * cost and its own confirmation.
     */
    handler: (platform, ctx) => {
      const engineCtx = projectContext(platform, ctx);
      authorise(engineCtx, 'FIELD_EXECUTION', 'C', { lifecyclePhase: currentPhase(engineCtx) });

      const input = body<{ hash: string; description: string; taskId?: string }>(ctx);
      const ref = registerEvidence(engineCtx, {
        type: 'SITE_RECORDING',
        hash: input.hash,
        description: input.description,
        linkedEntities: input.taskId ? [{ refType: 'Task', refId: input.taskId }] : [],
      });

      return { evidenceId: ref.refId, hash: input.hash };
    },
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

  // ------------------------------------------------------- the site visit (walk to handover)
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/site-visits',
    description: 'The site visit position: findings, permissions, logistics warnings and what is still owed at handover',
    handler: (platform, ctx) => sitevisit.sitePosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/site-visits',
    description: 'Record a site visit — who walked it, when, and why',
    schema: {
      type: 'object',
      required: ['purpose', 'visitedOn', 'attendees'],
      properties: {
        purpose: { type: 'string', enum: [...sitevisit.VISIT_PURPOSE] },
        visitedOn: stringField,
        attendees: { type: 'array', minItems: 1, items: { type: 'string' } },
        weather: { type: 'string' },
        notes: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => sitevisit.recordVisit(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/site-visits/:visitId/findings',
    description: 'Raise a finding: what was found, what it obliges, who carries it and when it is discharged',
    schema: {
      type: 'object',
      required: ['category', 'description', 'location', 'basis', 'consequences', 'closesBy', 'owner'],
      properties: {
        category: { type: 'string', enum: [...sitevisit.FINDING_CATEGORY] },
        description: { type: 'string' },
        location: stringField,
        basis: { type: 'string', enum: [...sitevisit.FINDING_BASIS] },
        source: { type: 'string' },
        // No `minItems` on purpose. An empty list is a real domain rule with a
        // sentence worth reading — "a finding that obliges nothing is a note" —
        // and a schema rejection would replace it with VALIDATION_FAILED.
        consequences: { type: 'array', items: { type: 'string', enum: [...sitevisit.FINDING_CONSEQUENCE] } },
        closesBy: { type: 'string', enum: [...sitevisit.CLOSES_BY] },
        owner: stringField,
        // Required by the engine for an OBSERVED finding rather than by the
        // schema, because whether a photograph is needed is a fact about how the
        // finding is known, not about the shape of the request.
        evidenceHash: stringField,
        taskId: stringField,
        pricedNote: { type: 'string' },
        permit: {
          type: 'object',
          required: ['name', 'authority', 'leadTimeDays', 'requiredBy'],
          properties: {
            name: stringField,
            authority: stringField,
            leadTimeDays: { type: 'integer', minimum: 1 },
            requiredBy: stringField,
            appliedOn: stringField,
            grantedOn: stringField,
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      sitevisit.raiseFinding(projectContext(platform, ctx), ctx.params.visitId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/site-findings/:findingId/discharge',
    description: 'Discharge a finding, with what actually discharged it',
    schema: {
      type: 'object',
      required: ['discharge'],
      properties: { discharge: { type: 'string' }, evidenceHash: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      sitevisit.closeFinding(projectContext(platform, ctx), ctx.params.findingId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/logistics-plan',
    description: 'Set the site logistics plan and run the checks arithmetic can settle',
    schema: {
      type: 'object',
      required: ['elements'],
      properties: {
        elements: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['type', 'reference', 'description'],
            properties: {
              type: { type: 'string', enum: [...sitevisit.LOGISTICS_ELEMENT] },
              reference: stringField,
              description: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        cranes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['reference', 'type', 'radiusMetres', 'distanceToBoundaryMetres', 'tipHeightMetres'],
            properties: {
              reference: stringField,
              type: { type: 'string', enum: ['TOWER', 'MOBILE', 'CRAWLER'] },
              radiusMetres: { type: 'number', minimum: 0 },
              distanceToBoundaryMetres: { type: 'number', minimum: 0 },
              tipHeightMetres: { type: 'number', minimum: 0 },
              overhead: {
                type: 'object',
                required: ['distanceMetres', 'exclusionMetres'],
                properties: {
                  distanceMetres: { type: 'number', minimum: 0 },
                  exclusionMetres: { type: 'number', minimum: 0 },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
        routes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['reference', 'description'],
            properties: {
              reference: stringField,
              description: { type: 'string' },
              maxVehicleLengthMetres: { type: 'number', minimum: 0 },
              maxHeightMetres: { type: 'number', minimum: 0 },
              maxWeightTonnes: { type: 'number', minimum: 0 },
              deliveryWindow: {
                type: 'object',
                required: ['from', 'to'],
                properties: { from: stringField, to: stringField },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
        largestDelivery: {
          type: 'object',
          required: ['description', 'lengthMetres', 'heightMetres', 'weightTonnes'],
          properties: {
            description: stringField,
            lengthMetres: { type: 'number', minimum: 0 },
            heightMetres: { type: 'number', minimum: 0 },
            weightTonnes: { type: 'number', minimum: 0 },
          },
          additionalProperties: false,
        },
        notes: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => sitevisit.setLogisticsPlan(projectContext(platform, ctx), body(ctx)),
  },

  // ------------------------------------------------------- site meetings and minutes
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/meetings',
    description: 'Meetings held, and every open action across all of them ordered by how far past its date it is',
    handler: (platform, ctx) => meetings.meetingPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/meetings',
    description: 'Open a meeting record — what it was, where, who chaired it and who was in the room',
    schema: {
      type: 'object',
      required: ['type', 'title', 'heldAt', 'location', 'chair', 'attendees'],
      properties: {
        type: { type: 'string', enum: [...meetings.MEETING_TYPE] },
        title: stringField,
        heldAt: stringField,
        location: stringField,
        chair: stringField,
        // No `minItems`. "A meeting with nobody at it produces no minutes" is a
        // sentence worth reading; VALIDATION_FAILED is not.
        attendees: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'organisation', 'role', 'attended'],
            properties: {
              name: stringField,
              organisation: stringField,
              role: stringField,
              attended: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => meetings.openMeeting(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/meetings/:meetingId/agenda',
    description: 'Minute an item: what was raised and what was actually said about it',
    schema: {
      type: 'object',
      required: ['subject', 'discussion'],
      properties: { subject: stringField, discussion: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      meetings.recordAgendaItem(projectContext(platform, ctx), ctx.params.meetingId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/meetings/:meetingId/actions',
    description: 'Record an action out of the meeting — what, who, and by when',
    schema: {
      type: 'object',
      required: ['what', 'owner', 'ownerOrganisation', 'by'],
      properties: {
        what: { type: 'string' },
        owner: stringField,
        ownerOrganisation: stringField,
        by: stringField,
        // Both present together carry an action forward from an earlier meeting
        // without resetting its clock.
        raisedAtMeeting: stringField,
        originallyDue: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      meetings.recordAction(projectContext(platform, ctx), ctx.params.meetingId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/meetings/:meetingId/actions/close',
    description: 'Close an action with what actually discharged it — permitted after the minutes are issued',
    schema: {
      type: 'object',
      required: ['reference', 'closureNote'],
      properties: { reference: stringField, closureNote: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      meetings.closeAction(projectContext(platform, ctx), ctx.params.meetingId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/meetings/:meetingId/issue',
    description: 'Issue the minutes. After this they are the record of what was agreed and are not amended',
    // Takes no body. The empty schema is not a formality — it refuses one
    // carrying fields, so a caller who thinks this route accepts arguments finds
    // out here rather than by having them silently ignored.
    schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (platform, ctx) => meetings.issueMinutes(projectContext(platform, ctx), ctx.params.meetingId as string),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/meetings/:meetingId/corrections',
    description: 'Record a correction against issued minutes — beside them, never applied to them',
    schema: {
      type: 'object',
      required: ['raisedBy', 'what'],
      properties: { raisedBy: stringField, what: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      meetings.recordCorrection(projectContext(platform, ctx), ctx.params.meetingId as string, body(ctx)),
  },

  // ------------------------------------------------------- CM-WF-01 systemisation and the commissioning plan
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/systemisation',
    description: 'The system hierarchy, whether it holds together, the plans and what is running temporarily',
    handler: (platform, ctx) => systemisation.systemisationPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/systems',
    description: 'Define a node of the facility, system, subsystem and equipment hierarchy',
    schema: {
      type: 'object',
      required: ['tag', 'level', 'name', 'boundary'],
      properties: {
        tag: stringField,
        level: { type: 'string', enum: [...systemisation.SYSTEM_LEVEL] },
        parentTag: stringField,
        name: stringField,
        boundary: { type: 'string' },
        location: stringField,
        assetTags: { type: 'array', items: { type: 'string' } },
        energisationSequence: { type: 'number' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => systemisation.defineSystem(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/systems/integrity',
    description: 'Assets in two boundaries, assets in none, and boundaries around nothing',
    handler: (platform, ctx) => systemisation.checkHierarchy(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/systems/approve',
    description: 'Approve the systemisation — after this the tags are what every test hangs off',
    schema: {
      type: 'object',
      required: ['approvedBy'],
      properties: { approvedBy: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) => systemisation.approveHierarchy(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/commissioning-plans',
    description: 'Draft the commissioning plan: the test matrix and the programme it hangs on',
    schema: {
      type: 'object',
      required: ['title', 'tests', 'milestones'],
      properties: {
        title: stringField,
        tests: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'reference',
              'systemTag',
              'stage',
              'objective',
              'owner',
              'witness',
              'acceptanceCriteria',
              'criteriaSource',
              'prerequisite',
              'noticePeriodDays',
            ],
            properties: {
              reference: stringField,
              systemTag: stringField,
              stage: { type: 'string', enum: [...systemisation.TEST_STAGE] },
              objective: { type: 'string' },
              owner: stringField,
              witness: stringField,
              acceptanceCriteria: { type: 'string' },
              criteriaSource: stringField,
              prerequisite: { type: 'string' },
              noticePeriodDays: { type: 'number' },
            },
            additionalProperties: false,
          },
        },
        milestones: {
          type: 'array',
          items: {
            type: 'object',
            required: ['milestone', 'type', 'date'],
            properties: {
              milestone: stringField,
              type: { type: 'string', enum: ['CONSTRUCTION', 'COMMISSIONING', 'HANDOVER'] },
              date: stringField,
              dependsOn: stringField,
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => systemisation.draftCommissioningPlan(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/commissioning-plans/:planId/approve',
    description: 'Approve the plan, and record the test pack each planned test now owes',
    schema: {
      type: 'object',
      required: ['approvedBy'],
      properties: { approvedBy: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      systemisation.approveCommissioningPlan(projectContext(platform, ctx), ctx.params.planId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/commissioning-plans/:planId/baseline',
    description: 'Change the approved baseline, stating the impact on tests, assets and handover',
    schema: {
      type: 'object',
      required: ['change', 'impactOnTests', 'impactOnAssets', 'impactOnHandover', 'updatedBy'],
      properties: {
        change: { type: 'string' },
        impactOnTests: { type: 'string' },
        impactOnAssets: { type: 'string' },
        impactOnHandover: { type: 'string' },
        updatedBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      systemisation.updateCommissioningBaseline(projectContext(platform, ctx), ctx.params.planId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/temporary-operation',
    description: 'Declare temporary operation of a system — a controlled state, never implicit commissioning',
    schema: {
      type: 'object',
      required: ['systemTag', 'purpose', 'from', 'until', 'responsibleParty', 'conditions'],
      properties: {
        systemTag: stringField,
        purpose: { type: 'string' },
        from: stringField,
        until: stringField,
        responsibleParty: stringField,
        conditions: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => systemisation.declareTemporaryOperation(projectContext(platform, ctx), body(ctx)),
  },

  // ------------------------------------------------------- H-WF-06 operator training, competence and readiness
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/operator-readiness',
    description: 'Who can actually run the building, role by role, and what blocks the handover',
    handler: (platform, ctx) => operatorreadiness.operatorReadinessPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/training-needs',
    description: 'Define what the operating model needs, role by role, with the competences each requires',
    schema: {
      type: 'object',
      required: ['reference', 'operatingModel', 'roles', 'definedBy'],
      properties: {
        reference: stringField,
        operatingModel: { type: 'string' },
        definedBy: stringField,
        roles: {
          type: 'array',
          items: {
            type: 'object',
            required: ['role', 'headcountRequired', 'competences', 'assessmentRequired', 'critical'],
            properties: {
              role: stringField,
              headcountRequired: { type: 'number' },
              competences: { type: 'array', items: { type: 'string' } },
              assessmentRequired: { type: 'boolean' },
              critical: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => operatorreadiness.defineTrainingNeeds(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/competence-assessments',
    description: 'Assess a person against the competence the role requires. Attendance is not competence',
    schema: {
      type: 'object',
      required: ['person', 'employer', 'role', 'sessionReference', 'method', 'result', 'assessedBy', 'evidence'],
      properties: {
        person: stringField,
        employer: stringField,
        role: stringField,
        sessionReference: stringField,
        method: { type: 'string', enum: ['PRACTICAL_DEMONSTRATION', 'WRITTEN', 'OBSERVATION'] },
        result: { type: 'string', enum: ['COMPETENT', 'NOT_YET_COMPETENT'] },
        assessedBy: stringField,
        evidence: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => operatorreadiness.assessCompetence(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/training-gap-plans',
    description: 'Record a controlled gap plan: what is missing, what happens meanwhile, who owns it and by when',
    schema: {
      type: 'object',
      required: ['role', 'gap', 'interimArrangement', 'owner', 'by'],
      properties: {
        role: stringField,
        gap: { type: 'string' },
        interimArrangement: { type: 'string' },
        owner: stringField,
        by: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => operatorreadiness.recordGapPlan(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/retraining',
    description: 'Require retraining for a role where a change has invalidated what was taught',
    schema: {
      type: 'object',
      required: ['role', 'reason', 'owner', 'by'],
      properties: { role: stringField, reason: { type: 'string' }, owner: stringField, by: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) => operatorreadiness.requireRetraining(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/operator-readiness',
    description: 'Accept that the operator is ready, with the outstanding support arrangement stated',
    schema: {
      type: 'object',
      required: ['acceptedBy', 'forOperator', 'supportPlan'],
      properties: { acceptedBy: stringField, forOperator: stringField, supportPlan: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) => operatorreadiness.acceptOperatorReadiness(projectContext(platform, ctx), body(ctx)),
  },

  // ------------------------------------------------------- H-WF-07 keys, credentials, spares, tools and service transfer
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/transfer',
    description: 'The transfer inventory, shortages and their owners, lost items and the service contacts',
    handler: (platform, ctx) => transfer.transferPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/transfer-items',
    description: 'Register a key, card, spare, tool or credential for transfer. A credential carries a vault reference, never a value',
    schema: {
      type: 'object',
      required: [
        'reference',
        'kind',
        'description',
        'quantityRequired',
        'quantityHeld',
        'condition',
        'storageLocation',
        'critical',
        'transferOwner',
      ],
      properties: {
        reference: stringField,
        kind: {
          type: 'string',
          enum: ['KEY', 'ACCESS_CARD', 'CREDENTIAL', 'SPARE', 'CONSUMABLE', 'SPECIAL_TOOL', 'TEST_EQUIPMENT'],
        },
        description: { type: 'string' },
        quantityRequired: { type: 'number' },
        quantityHeld: { type: 'number' },
        condition: stringField,
        storageLocation: stringField,
        critical: { type: 'boolean' },
        transferOwner: stringField,
        // The schema admits an identifier and nothing that could hold a secret.
        vaultReference: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => transfer.registerTransferItem(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/transfer-items/:itemId/accept',
    description: 'Hand an item over with both parties named, the retained receipt and any shortage owned from the moment it is counted',
    schema: {
      type: 'object',
      required: ['quantityReceived', 'condition', 'sender', 'recipient', 'location', 'receiptReference', 'receiptHash'],
      properties: {
        quantityReceived: { type: 'number' },
        condition: stringField,
        sender: stringField,
        recipient: stringField,
        location: stringField,
        receiptReference: stringField,
        receiptHash: stringField,
        shortage: {
          type: 'object',
          required: ['owner', 'by', 'note'],
          properties: { owner: stringField, by: stringField, note: { type: 'string' } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      transfer.acceptTransfer(projectContext(platform, ctx), ctx.params.itemId!, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/transfer-items/:itemId/confirm-credential',
    description: 'Confirm a credential moved through the approved mechanism. Status metadata only',
    schema: {
      type: 'object',
      required: ['mechanism', 'confirmedBy'],
      properties: { mechanism: { type: 'string' }, confirmedBy: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      transfer.confirmCredentialTransfer(projectContext(platform, ctx), ctx.params.itemId!, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/transfer-items/:itemId/lost',
    description: 'Report a key or card that cannot be accounted for. A security incident, not a shortage',
    schema: {
      type: 'object',
      required: ['what', 'reportedBy'],
      properties: { what: { type: 'string' }, reportedBy: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) => transfer.reportLostItem(projectContext(platform, ctx), ctx.params.itemId!, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/service-contacts',
    description: 'Register a service or warranty contact with its response time, escalation route and cover end date',
    schema: {
      type: 'object',
      required: [
        'system',
        'provider',
        'contractReference',
        'contact',
        'telephone',
        'responseTime',
        'escalation',
        'coverUntil',
      ],
      properties: {
        system: stringField,
        provider: stringField,
        contractReference: stringField,
        contact: stringField,
        telephone: stringField,
        responseTime: stringField,
        escalation: { type: 'string' },
        coverUntil: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => transfer.registerServiceContact(projectContext(platform, ctx), body(ctx)),
  },

  // ------------------------------------------------------- H-WF-08 defects, completion and commercial closeout
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/practical-completion',
    description: 'Inspection items by classification, the certificates and their triggered dates, securities and final accounts',
    handler: (platform, ctx) => practicalcompletion.practicalCompletionPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/completion-inspections',
    description: 'Record a completion inspection, classifying every item and naming who fixes it, by when and with what access',
    schema: {
      type: 'object',
      required: ['reference', 'scope', 'inspectedBy', 'attendees', 'evidenceHash', 'items'],
      properties: {
        reference: stringField,
        scope: { type: 'string' },
        inspectedBy: stringField,
        attendees: { type: 'array', items: { type: 'string' } },
        evidenceHash: stringField,
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['location', 'description', 'classification', 'contractor', 'dueDate', 'accessWindow'],
            properties: {
              location: stringField,
              description: { type: 'string' },
              classification: {
                type: 'string',
                enum: ['BLOCKER', 'MINOR_DEFECT', 'OUTSTANDING_WORK', 'POST_COMPLETION_OBLIGATION'],
              },
              contractor: stringField,
              dueDate: stringField,
              accessWindow: stringField,
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => practicalcompletion.recordCompletionInspection(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/completion-items/:itemId/close',
    description: 'Close an item against rectification somebody other than the contractor re-inspected and accepted',
    schema: {
      type: 'object',
      required: ['rectification', 'acceptedBy', 'reinspectedBy', 'evidenceHash'],
      properties: {
        rectification: { type: 'string' },
        acceptedBy: stringField,
        reinspectedBy: stringField,
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      practicalcompletion.closeInspectionItem(projectContext(platform, ctx), ctx.params.itemId!, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/completion-items/:itemId/defer',
    description: 'Defer an item with its owner, risk, access constraint and what will count as it being put right',
    schema: {
      type: 'object',
      required: ['reason', 'owner', 'by', 'risk', 'accessConstraint', 'acceptanceCondition'],
      properties: {
        reason: { type: 'string' },
        owner: stringField,
        by: stringField,
        risk: { type: 'string' },
        accessConstraint: stringField,
        acceptanceCondition: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      practicalcompletion.deferInspectionItem(projectContext(platform, ctx), ctx.params.itemId!, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/contract-clauses/:clauseId/validate',
    description: 'A person agrees or disagrees with what the extraction engine read. Until this, no date derives from it',
    schema: {
      type: 'object',
      required: ['agrees', 'note', 'validatedBy'],
      properties: {
        agrees: { type: 'boolean' },
        correctedClauseRef: stringField,
        periodDays: { type: 'number' },
        note: { type: 'string' },
        validatedBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      practicalcompletion.validateContractClause(projectContext(platform, ctx), ctx.params.clauseId!, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/completion-records',
    description: 'Issue practical or sectional completion under a named contractual authority and set its dates running once',
    schema: {
      type: 'object',
      required: ['reference', 'kind', 'scopeBoundary', 'completionDate', 'authority', 'decidedBy', 'evidenceHash', 'periods'],
      properties: {
        reference: stringField,
        kind: { type: 'string', enum: ['PRACTICAL', 'SECTIONAL'] },
        sectionReference: stringField,
        scopeBoundary: { type: 'string' },
        completionDate: stringField,
        authority: stringField,
        decidedBy: stringField,
        evidenceHash: stringField,
        aiReadinessScore: {
          type: 'object',
          required: ['score', 'basis'],
          properties: { score: { type: 'number' }, basis: { type: 'string' } },
          additionalProperties: false,
        },
        periods: {
          type: 'array',
          items: {
            type: 'object',
            required: ['key', 'periodDays', 'ruleSource'],
            properties: {
              key: {
                type: 'string',
                enum: [
                  'POSSESSION',
                  'INSURANCE_TRANSFER',
                  'LIQUIDATED_DAMAGES_END',
                  'DEFECTS_PERIOD_END',
                  'RETENTION_FIRST_RELEASE',
                  'RETENTION_FINAL_RELEASE',
                ],
              },
              periodDays: { type: 'number' },
              ruleSource: stringField,
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => practicalcompletion.issueCompletionCertificate(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/completion-records/:completionId/revise-dates',
    description: 'Move a triggered date visibly, under a named authority, keeping the hash of the set it replaced',
    schema: {
      type: 'object',
      required: ['authority', 'reason', 'periods'],
      properties: {
        authority: stringField,
        reason: { type: 'string' },
        periods: {
          type: 'array',
          items: {
            type: 'object',
            required: ['key', 'periodDays', 'ruleSource'],
            properties: {
              key: {
                type: 'string',
                enum: [
                  'POSSESSION',
                  'INSURANCE_TRANSFER',
                  'LIQUIDATED_DAMAGES_END',
                  'DEFECTS_PERIOD_END',
                  'RETENTION_FIRST_RELEASE',
                  'RETENTION_FINAL_RELEASE',
                ],
              },
              periodDays: { type: 'number' },
              ruleSource: stringField,
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      practicalcompletion.reviseTriggeredDates(projectContext(platform, ctx), ctx.params.completionId!, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/commercial-securities',
    description: 'Record where a retention, bond, guarantee, collateral warranty or insurance certificate stands at closeout',
    schema: {
      type: 'object',
      required: ['kind', 'reference', 'holder', 'status', 'note'],
      properties: {
        kind: {
          type: 'string',
          enum: ['RETENTION', 'PERFORMANCE_BOND', 'PARENT_COMPANY_GUARANTEE', 'COLLATERAL_WARRANTY', 'INSURANCE_CERTIFICATE'],
        },
        reference: stringField,
        holder: stringField,
        status: stringField,
        expiresOn: stringField,
        note: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => practicalcompletion.recordSecurityPosition(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/final-accounts',
    description: 'Agree the final account against the figures the value chain already holds. The money is not re-entered here',
    schema: {
      type: 'object',
      required: ['subjectRef', 'agreedBy', 'forContractor', 'note'],
      properties: {
        subjectRef: stringField,
        agreedBy: stringField,
        forContractor: stringField,
        note: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => practicalcompletion.agreeFinalAccount(projectContext(platform, ctx), body(ctx)),
  },

  // ------------------------------------------------------- H-WF-09 acceptance, activation and archive
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/handover-acceptance',
    description: 'The eight-domain validation, the packs and their decisions, the activation, the baseline and what is still owed',
    handler: (platform, ctx) => handoveracceptance.handoverAcceptancePosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/handover-packs/:packId/manifest',
    description: 'Compile the machine-readable evidence manifest: every entity, its hash and its source version',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (platform, ctx) => handoveracceptance.compileManifest(projectContext(platform, ctx), ctx.params.packId!),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/handover-manifests/:manifestId/verify',
    description: 'Re-hash every manifest entry against the live record and report what drifted, by name',
    handler: (platform, ctx) => handoveracceptance.verifyManifest(projectContext(platform, ctx), ctx.params.manifestId!),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/handover-packs/:packId/decide',
    description: 'Accept, accept with conditions, or reject. Conditions carry a risk owner, a due date, an expiry and an escalation',
    schema: {
      type: 'object',
      required: ['decision', 'decidedBy', 'forOrganisation', 'reasons'],
      properties: {
        decision: { type: 'string', enum: ['ACCEPTED', 'ACCEPTED_WITH_CONDITIONS', 'REJECTED'] },
        decidedBy: stringField,
        forOrganisation: stringField,
        reasons: { type: 'string' },
        manifestId: stringField,
        conditions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['description', 'riskOwner', 'dueDate', 'expiresOn', 'escalateTo'],
            properties: {
              description: { type: 'string' },
              riskOwner: stringField,
              dueDate: stringField,
              expiresOn: stringField,
              escalateTo: stringField,
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      handoveracceptance.decideHandover(projectContext(platform, ctx), ctx.params.packId!, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/handover-packs/:packId/activate-operations',
    description: 'Raise maintenance and warranty obligations from the accepted asset register. No asset field is accepted here',
    schema: {
      type: 'object',
      required: ['activatedBy', 'maintenanceStartsOn'],
      properties: { activatedBy: stringField, maintenanceStartsOn: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      handoveracceptance.activateOperations(projectContext(platform, ctx), ctx.params.packId!, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/handover-baseline',
    description: 'Freeze the handover set under a named retention policy, preserving any legal hold',
    schema: {
      type: 'object',
      required: ['baselinedBy', 'retentionPolicy', 'retainUntil', 'legalHold'],
      properties: {
        baselinedBy: stringField,
        retentionPolicy: { type: 'string' },
        retainUntil: stringField,
        legalHold: { type: 'boolean' },
        legalHoldReason: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => handoveracceptance.baselineHandover(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/residual-obligations/transfer',
    description: 'Hand the residual obligations to their operations and aftercare owners. The list itself stays derived',
    schema: {
      type: 'object',
      required: ['toOperations', 'toAftercare', 'note'],
      properties: { toOperations: stringField, toAftercare: stringField, note: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) => handoveracceptance.transferResidualObligations(projectContext(platform, ctx), body(ctx)),
  },

  // ------------------------------------------------------- H-WF-10 aftercare, seasonal testing and feedback
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/aftercare',
    description: 'The aftercare plan and next review, seasonal tests owed and done, performance gaps, feedback clusters and residuals',
    handler: (platform, ctx) => aftercare.aftercarePosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/aftercare-plans',
    description: 'Open the aftercare period with its helpdesk, escalation, response targets and scheduled review dates',
    schema: {
      type: 'object',
      required: [
        'reference',
        'durationMonths',
        'startsOn',
        'helpdesk',
        'escalation',
        'responseTargets',
        'reviewDates',
        'aftercareOwner',
      ],
      properties: {
        reference: stringField,
        durationMonths: { type: 'number' },
        startsOn: stringField,
        helpdesk: stringField,
        escalation: { type: 'string' },
        responseTargets: stringField,
        reviewDates: { type: 'array', items: { type: 'string' } },
        aftercareOwner: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => aftercare.startAftercare(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/seasonal-tests/:reference/complete',
    description: 'Close a seasonal test CM-WF-06 raised, recording the conditions on the day. A fail leaves it outstanding',
    schema: {
      type: 'object',
      required: ['testedOn', 'conditionsObserved', 'result', 'findings', 'testedBy', 'evidenceHash'],
      properties: {
        testedOn: stringField,
        conditionsObserved: { type: 'string' },
        result: { type: 'string', enum: ['PASS', 'FAIL'] },
        findings: { type: 'string' },
        testedBy: stringField,
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      aftercare.completeSeasonalTest(projectContext(platform, ctx), ctx.params.reference!, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/performance-comparisons',
    description: 'Compare measured performance against design intent or the commissioning result, with period, baseline and context',
    schema: {
      type: 'object',
      required: [
        'reference',
        'metric',
        'unit',
        'baselineSource',
        'baselineValue',
        'measuredValue',
        'periodFrom',
        'periodTo',
        'operatingContext',
        'dataSource',
        'assessedBy',
      ],
      properties: {
        reference: stringField,
        metric: stringField,
        unit: stringField,
        baselineSource: { type: 'string', enum: ['DESIGN_INTENT', 'COMMISSIONING_RESULT'] },
        baselineValue: { type: 'number' },
        measuredValue: { type: 'number' },
        periodFrom: stringField,
        periodTo: stringField,
        operatingContext: { type: 'string' },
        dataSource: stringField,
        assessedBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => aftercare.recordPerformanceComparison(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/occupant-feedback',
    description: 'Record feedback against a role and a location. There is no field on this route a person could be named in',
    schema: {
      type: 'object',
      required: ['theme', 'reportedByRole', 'location', 'description', 'severity', 'occurrences'],
      properties: {
        theme: {
          type: 'string',
          enum: [
            'THERMAL_COMFORT',
            'AIR_QUALITY',
            'LIGHTING',
            'ACOUSTICS',
            'CONTROLS_USABILITY',
            'CLEANLINESS',
            'ACCESSIBILITY',
            'OTHER',
          ],
        },
        reportedByRole: stringField,
        location: stringField,
        description: { type: 'string' },
        severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
        occurrences: { type: 'number' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => aftercare.recordFeedback(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/post-occupancy-reviews',
    description: 'Complete the post-occupancy review. Refuses to run with no comparison and no feedback to review',
    schema: {
      type: 'object',
      required: ['reference', 'reviewedBy', 'period', 'findings', 'correctiveActions', 'evidenceHash'],
      properties: {
        reference: stringField,
        reviewedBy: stringField,
        period: stringField,
        findings: { type: 'string' },
        evidenceHash: stringField,
        correctiveActions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['description', 'owner', 'by', 'priority'],
            properties: {
              description: { type: 'string' },
              owner: stringField,
              by: stringField,
              priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => aftercare.completePostOccupancyReview(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/lessons/:lessonId/approve',
    description: 'Approve a captured lesson for reuse and tag the sectors and stages where it actually applies',
    schema: {
      type: 'object',
      required: ['approvedBy', 'sectors', 'stages', 'applicabilityNote'],
      properties: {
        approvedBy: stringField,
        sectors: { type: 'array', items: { type: 'string' } },
        stages: { type: 'array', items: { type: 'string' } },
        applicabilityNote: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => aftercare.approveLesson(projectContext(platform, ctx), ctx.params.lessonId!, body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/lessons/reusable',
    description: 'Approved lessons only, filtered to the sector and stage their own tags say they apply to',
    handler: (platform, ctx) =>
      aftercare.reusableLessons(projectContext(platform, ctx), {
        sector: ctx.query?.get('sector') ?? undefined,
        stage: ctx.query?.get('stage') ?? undefined,
      }),
  },

  // ------------------------------------------------------- H-WF-05 regulatory completion and Golden Thread transfer
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/regulatory-completion',
    description: 'Readiness checks, packs, the decision and its conditions, and whether the thread has transferred',
    handler: (platform, ctx) => regulatorycompletion.regulatoryPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/regulatory-completion/readiness',
    description: 'Run the completion checklist. The jurisdiction is recorded; the platform does not encode its law',
    schema: {
      type: 'object',
      required: ['reference', 'jurisdiction', 'evidence', 'checkedBy'],
      properties: {
        reference: stringField,
        jurisdiction: stringField,
        checkedBy: stringField,
        blockers: { type: 'array', items: { type: 'string' } },
        evidence: {
          type: 'array',
          items: {
            type: 'object',
            required: ['key', 'reference', 'version', 'evidenceRef'],
            properties: {
              key: { type: 'string', enum: regulatorycompletion.COMPLETION_EVIDENCE.map((entry) => entry.key) },
              reference: stringField,
              version: stringField,
              evidenceRef: stringField,
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => regulatorycompletion.checkCompletionReadiness(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/regulatory-completion/:readinessId/pack',
    description: 'Approve the pack for submission, under a named declaration by a named role',
    schema: {
      type: 'object',
      required: ['reference', 'approvedBy', 'approverRole', 'declaration'],
      properties: {
        reference: stringField,
        approvedBy: stringField,
        approverRole: stringField,
        declaration: { type: 'string' },
        supersedes: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      regulatorycompletion.approveRegulatoryPack(
        projectContext(platform, ctx),
        ctx.params.readinessId as string,
        body(ctx),
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/regulatory-packs/:packId/submission',
    description: 'Record that the application was submitted, with the receipt that came back',
    schema: {
      type: 'object',
      required: ['regulator', 'route', 'submissionReference', 'submittedBy', 'submittedAt', 'receipt'],
      properties: {
        regulator: stringField,
        route: { type: 'string', enum: ['INTEGRATED', 'MANUAL'] },
        submissionReference: stringField,
        submittedBy: stringField,
        submittedAt: stringField,
        receipt: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      regulatorycompletion.recordSubmission(projectContext(platform, ctx), ctx.params.packId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/regulatory-packs/:packId/decision',
    description: 'Record the regulator’s decision. A refusal preserves the pack that was submitted',
    schema: {
      type: 'object',
      required: ['decision', 'decisionReference', 'decidedOn', 'recordedBy'],
      properties: {
        decision: { type: 'string', enum: ['GRANTED', 'REFUSED'] },
        decisionReference: stringField,
        decidedOn: stringField,
        recordedBy: stringField,
        certificateHash: stringField,
        reasons: { type: 'array', items: { type: 'string' } },
        conditions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['reference', 'condition', 'owner', 'by'],
            properties: { reference: stringField, condition: { type: 'string' }, owner: stringField, by: stringField },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      regulatorycompletion.recordCompletionDecision(
        projectContext(platform, ctx),
        ctx.params.packId as string,
        body(ctx),
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/golden-thread/transfer',
    description: 'Transfer control of the golden thread. The recipient confirms access, completeness and usable format',
    schema: {
      type: 'object',
      required: ['toParty', 'toPerson', 'role', 'format', 'scope', 'transferredBy', 'recipientConfirmation'],
      properties: {
        toParty: stringField,
        toPerson: stringField,
        role: { type: 'string', enum: [...regulatorycompletion.RESPONSIBLE_ROLE] },
        format: stringField,
        scope: { type: 'string' },
        transferredBy: stringField,
        recipientConfirmation: {
          type: 'object',
          required: ['access', 'completeness', 'usableFormat', 'confirmedBy'],
          properties: {
            access: { type: 'boolean' },
            completeness: { type: 'boolean' },
            usableFormat: { type: 'boolean' },
            confirmedBy: stringField,
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => regulatorycompletion.transferGoldenThread(projectContext(platform, ctx), body(ctx)),
  },

  // ------------------------------------------------------- H-WF-04 asset register validation and exchange
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/asset-register',
    description: 'Attribute completeness, duplicate identities, declared Unknowns and every unreconciled export',
    handler: (platform, ctx) => assetregister.assetRegisterPosition(projectContext(platform, ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/asset-register/validate',
    description: 'Machine-readable validation errors, computed rather than stored',
    handler: (platform, ctx) => assetregister.validateRegister(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/asset-register/unknowns',
    description: 'Declare what is not known about an asset, with an owner and a date. Blank is not pass',
    schema: {
      type: 'object',
      required: ['assetTag', 'declaredUnknowns', 'declaredBy'],
      properties: {
        assetTag: stringField,
        declaredBy: stringField,
        declaredUnknowns: {
          type: 'array',
          items: {
            type: 'object',
            required: ['attribute', 'owner', 'reason', 'by'],
            properties: {
              attribute: { type: 'string', enum: assetregister.ASSET_ATTRIBUTE.map((entry) => entry.key) },
              owner: stringField,
              reason: { type: 'string' },
              by: stringField,
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => assetregister.declareUnknowns(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/asset-register/exports',
    description: 'Export the register to an external system, refused while the selected assets carry errors',
    schema: {
      type: 'object',
      required: ['reference', 'format', 'externalSystem', 'assetTags', 'exportedBy'],
      properties: {
        reference: stringField,
        format: { type: 'string', enum: [...assetregister.EXCHANGE_FORMAT] },
        externalSystem: stringField,
        assetTags: { type: 'array', items: { type: 'string' } },
        exportedBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => assetregister.exportExchange(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/asset-register/exports/:exportId/reconcile',
    description: 'Reconcile what the target system actually accepted. The totals have to add up',
    schema: {
      type: 'object',
      required: ['rowsAccepted', 'rejected', 'reconciledBy'],
      properties: {
        rowsAccepted: { type: 'number' },
        reconciledBy: stringField,
        rejected: {
          type: 'array',
          items: {
            type: 'object',
            required: ['externalId', 'reason'],
            properties: { externalId: stringField, reason: { type: 'string' } },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      assetregister.reconcileExchange(projectContext(platform, ctx), ctx.params.exportId as string, body(ctx)),
  },

  // ------------------------------------------------------- H-WF-03 O&M manuals and the technical file
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/om-manuals',
    description: 'Manual completeness by section, AI drafts nobody accepted, and sections the asset data has overtaken',
    handler: (platform, ctx) => ommanual.omManualPosition(projectContext(platform, ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/om-manuals/search',
    description: 'Search by asset tag, system, symptom or task — symptom being what an operator actually starts from',
    handler: (platform, ctx) => {
      const query = ctx.query;
      return ommanual.searchManuals(projectContext(platform, ctx), {
        assetTag: query?.get('assetTag') ?? undefined,
        systemTag: query?.get('systemTag') ?? undefined,
        symptom: query?.get('symptom') ?? undefined,
        task: query?.get('task') ?? undefined,
      });
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/om-manuals',
    description: 'Create the manual structure for a system and the installed assets it covers',
    schema: {
      type: 'object',
      required: ['reference', 'systemTag', 'assetTags', 'title', 'author'],
      properties: {
        reference: stringField,
        systemTag: stringField,
        assetTags: { type: 'array', items: { type: 'string' } },
        title: stringField,
        author: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => ommanual.createManual(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/om-manuals/:manualId/sections',
    description: 'Write a section with its source, revision and the installed tags it actually describes',
    schema: {
      type: 'object',
      required: ['key', 'content', 'source', 'mappedAssetTags', 'authoredBy', 'aiDrafted'],
      properties: {
        key: { type: 'string', enum: ommanual.MANUAL_SECTION.map((section) => section.key) },
        content: { type: 'string' },
        source: {
          type: 'object',
          required: ['kind', 'reference', 'revision'],
          properties: {
            kind: { type: 'string', enum: [...ommanual.SOURCE_KIND] },
            reference: stringField,
            revision: stringField,
          },
          additionalProperties: false,
        },
        mappedAssetTags: { type: 'array', items: { type: 'string' } },
        symptoms: {
          type: 'array',
          items: {
            type: 'object',
            required: ['symptom', 'probableCause', 'task'],
            properties: { symptom: stringField, probableCause: stringField, task: stringField },
            additionalProperties: false,
          },
        },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            required: ['task', 'frequency', 'skill'],
            properties: { task: stringField, frequency: stringField, skill: stringField },
            additionalProperties: false,
          },
        },
        authoredBy: stringField,
        aiDrafted: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      ommanual.writeSection(projectContext(platform, ctx), ctx.params.manualId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/om-manuals/:manualId/reviews',
    description: 'Review a section as the technical checker or as the operator who has to use it',
    schema: {
      type: 'object',
      required: ['key', 'role', 'decision', 'reviewedBy', 'comment'],
      properties: {
        key: { type: 'string', enum: ommanual.MANUAL_SECTION.map((section) => section.key) },
        role: { type: 'string', enum: ['CHECKER', 'OPERATOR'] },
        decision: { type: 'string', enum: ['ACCEPTED', 'REJECTED'] },
        reviewedBy: stringField,
        comment: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      ommanual.reviewSection(projectContext(platform, ctx), ctx.params.manualId as string, body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/om-manuals/:manualId/validate',
    description: 'What is missing, unaccepted, contradictory or overtaken, computed rather than stored',
    handler: (platform, ctx) => ommanual.validateManual(projectContext(platform, ctx), ctx.params.manualId as string),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/om-manuals/:manualId/accept',
    description: 'Accept the manual for operational use, for a named operator',
    schema: {
      type: 'object',
      required: ['acceptedBy', 'forOperator'],
      properties: { acceptedBy: stringField, forOperator: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      ommanual.acceptManual(projectContext(platform, ctx), ctx.params.manualId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/om-manuals/:manualId/reject',
    description: 'Reject it, naming what is wrong — a manual rejected with no reasons comes back unchanged',
    schema: {
      type: 'object',
      required: ['reasons', 'rejectedBy'],
      properties: { reasons: { type: 'array', items: { type: 'string' } }, rejectedBy: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      ommanual.rejectManual(projectContext(platform, ctx), ctx.params.manualId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/om-manuals/asset-change',
    description: 'Record an asset data change, flagging every manual section that described the old one',
    schema: {
      type: 'object',
      required: ['assetTag', 'what', 'changedBy'],
      properties: { assetTag: stringField, what: { type: 'string' }, changedBy: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) => ommanual.flagAssetDataChange(projectContext(platform, ctx), body(ctx)),
  },

  // ------------------------------------------------------- H-WF-02 as-built verification
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/as-built',
    description: 'As-built sets, who verified each, and the material variances blocking a handover',
    handler: (platform, ctx) => asbuilt.asBuiltPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/as-built',
    description: 'Submit an as-built set against the approved design and every change implemented since',
    schema: {
      type: 'object',
      required: [
        'reference',
        'systemTag',
        'discipline',
        'approvedDesignRefs',
        'implementedChanges',
        'deliverables',
        'metadata',
        'submittedBy',
      ],
      properties: {
        reference: stringField,
        systemTag: stringField,
        discipline: stringField,
        submittedBy: stringField,
        approvedDesignRefs: {
          type: 'array',
          items: {
            type: 'object',
            required: ['reference', 'revision'],
            properties: { reference: stringField, revision: stringField },
            additionalProperties: false,
          },
        },
        implementedChanges: {
          type: 'array',
          items: {
            type: 'object',
            required: ['changeRef', 'reflected', 'note'],
            properties: {
              changeRef: stringField,
              reflected: { type: 'string', enum: ['REFLECTED', 'NOT_APPLICABLE'] },
              note: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        deliverables: {
          type: 'array',
          items: {
            type: 'object',
            required: ['format', 'reference', 'fileHash'],
            properties: {
              format: { type: 'string', enum: [...asbuilt.DELIVERABLE_FORMAT] },
              reference: stringField,
              fileHash: stringField,
              conversionNotes: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        metadata: {
          type: 'object',
          required: ['coordinateSystem', 'units', 'taggedObjects', 'totalObjects'],
          properties: {
            coordinateSystem: stringField,
            units: stringField,
            taggedObjects: { type: 'number' },
            totalObjects: { type: 'number' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => asbuilt.submitAsBuiltSet(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/as-built/:setId/variances',
    description: 'Record a difference between the as-built information and what is installed',
    schema: {
      type: 'object',
      required: ['reference', 'description', 'material', 'location', 'raisedBy'],
      properties: {
        reference: stringField,
        description: { type: 'string' },
        material: { type: 'boolean' },
        location: stringField,
        raisedBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      asbuilt.recordVariance(projectContext(platform, ctx), ctx.params.setId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/as-built/:setId/variances/resolve',
    description: 'Resolve a variance: the drawing corrected, the installation changed, or the difference accepted',
    schema: {
      type: 'object',
      required: ['reference', 'resolution', 'resolvedBy'],
      properties: { reference: stringField, resolution: { type: 'string' }, resolvedBy: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      asbuilt.resolveVariance(projectContext(platform, ctx), ctx.params.setId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/as-built/:setId/verify',
    description: 'Verify the set — the act that makes it as-built, signed by a named professional',
    schema: {
      type: 'object',
      required: ['verifiedBy', 'discipline', 'registration', 'statement'],
      properties: {
        verifiedBy: stringField,
        discipline: stringField,
        registration: stringField,
        statement: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      asbuilt.verifyAsBuiltSet(projectContext(platform, ctx), ctx.params.setId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/as-built/:setId/publish',
    description: 'Publish the verified set for operational use, superseding the working information',
    schema: {
      type: 'object',
      required: ['publishedBy', 'supersedes'],
      properties: { publishedBy: stringField, supersedes: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      asbuilt.publishAsBuiltSet(projectContext(platform, ctx), ctx.params.setId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/asset-information-links',
    description: 'Link a maintainable asset to where it is shown. One record answers both directions',
    schema: {
      type: 'object',
      required: ['assetTag', 'setId', 'drawingReference', 'location'],
      properties: {
        assetTag: stringField,
        setId: stringField,
        drawingReference: stringField,
        modelElementId: stringField,
        location: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => asbuilt.linkAssetInformation(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/assets/:assetTag/information',
    description: 'What information shows this asset — the tag-on-a-plate direction',
    handler: (platform, ctx) =>
      asbuilt.informationForAsset(projectContext(platform, ctx), ctx.params.assetTag as string),
  },

  // ------------------------------------------------------- H-WF-01 handover requirements matrix and readiness
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/handover-readiness',
    description: 'Weighted readiness over the mandatory requirements, drilling straight to each unmet one and its source',
    handler: (platform, ctx) => handoverrequirements.handoverReadiness(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/handover-requirements',
    description: 'Record one handover obligation with its source, clause, acceptance party and evidence rule',
    schema: {
      type: 'object',
      required: [
        'reference',
        'source',
        'sourceVersion',
        'sourceClause',
        'description',
        'acceptanceCriteria',
        'evidenceRule',
        'acceptanceParty',
        'dependency',
        'mandatory',
        'statutory',
        'weight',
      ],
      properties: {
        reference: stringField,
        source: stringField,
        sourceVersion: stringField,
        sourceClause: stringField,
        description: { type: 'string' },
        acceptanceCriteria: { type: 'string' },
        evidenceRule: { type: 'string' },
        acceptanceParty: stringField,
        dependency: { type: 'string', enum: [...handoverrequirements.REQUIREMENT_DEPENDENCY] },
        mandatory: { type: 'boolean' },
        statutory: { type: 'boolean' },
        weight: { type: 'number' },
        systemTag: stringField,
        area: stringField,
        assetTag: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => handoverrequirements.createRequirement(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/handover-requirements/:requirementId/assign',
    description: 'Map the deliverable to a producer, a checker, an approver and a required date',
    schema: {
      type: 'object',
      required: ['producer', 'checker', 'approver', 'requiredBy'],
      properties: {
        producer: stringField,
        checker: stringField,
        approver: stringField,
        requiredBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      handoverrequirements.assignDeliverable(
        projectContext(platform, ctx),
        ctx.params.requirementId as string,
        body(ctx),
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/handover-matrices',
    description: 'Baseline the matrix. After this a requirement is added by delta rather than quietly',
    schema: {
      type: 'object',
      required: ['baselinedBy'],
      properties: { baselinedBy: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) => handoverrequirements.baselineMatrix(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/handover-requirements/:requirementId/submit',
    description: 'Submit the deliverable against a requirement',
    schema: {
      type: 'object',
      required: ['evidence', 'submittedBy'],
      properties: { evidence: stringField, submittedBy: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      handoverrequirements.submitRequirement(
        projectContext(platform, ctx),
        ctx.params.requirementId as string,
        body(ctx),
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/handover-requirements/:requirementId/decide',
    description: 'Decide it — by the named acceptance party, against the evidence rule, never by a file being present',
    schema: {
      type: 'object',
      required: ['decision', 'acceptedBy', 'forParty', 'reason'],
      properties: {
        decision: { type: 'string', enum: ['ACCEPTED', 'ACCEPTED_WITH_CONDITIONS', 'REJECTED'] },
        acceptedBy: stringField,
        forParty: stringField,
        reason: { type: 'string' },
        conditions: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      handoverrequirements.decideRequirement(
        projectContext(platform, ctx),
        ctx.params.requirementId as string,
        body(ctx),
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/handover-requirements/:requirementId/waive',
    description: 'Waive a requirement with a reason and an expiry. A statutory one is never waivable here',
    schema: {
      type: 'object',
      required: ['reason', 'approvedBy', 'expiresOn'],
      properties: { reason: { type: 'string' }, approvedBy: stringField, expiresOn: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      handoverrequirements.waiveRequirement(
        projectContext(platform, ctx),
        ctx.params.requirementId as string,
        body(ctx),
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/handover-requirements/source-reissue',
    description: 'Flag every requirement drawn from a version that has been reissued, for delta review',
    schema: {
      type: 'object',
      required: ['source', 'fromVersion', 'toVersion', 'recordedBy'],
      properties: {
        source: stringField,
        fromVersion: stringField,
        toVersion: stringField,
        recordedBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => handoverrequirements.recordSourceReissue(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/handover-sections',
    description: 'Define a sectional handover: an independent boundary and its own subset of requirements',
    schema: {
      type: 'object',
      required: ['reference', 'boundary', 'requirementRefs', 'definedBy'],
      properties: {
        reference: stringField,
        boundary: { type: 'string' },
        requirementRefs: { type: 'array', items: { type: 'string' } },
        definedBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => handoverrequirements.defineHandoverSection(projectContext(platform, ctx), body(ctx)),
  },

  // ------------------------------------------------------- CM-WF-08 training, dossier, acceptance and the gate
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/commissioning-close',
    description: 'Dossier completeness by system, training and what it rests on, acceptances, and what handover inherits',
    handler: (platform, ctx) => commissioningclose.commissioningClosePosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/training-records',
    description: 'Record a delivered session against the information it taught, at the revision taught',
    schema: {
      type: 'object',
      required: ['reference', 'systemTag', 'role', 'deliveredAgainst', 'deliveredBy', 'deliveredAt', 'attendees'],
      properties: {
        reference: stringField,
        systemTag: stringField,
        role: stringField,
        deliveredBy: stringField,
        deliveredAt: stringField,
        deliveredAgainst: {
          type: 'array',
          items: {
            type: 'object',
            required: ['reference', 'revision'],
            properties: { reference: stringField, revision: stringField },
            additionalProperties: false,
          },
        },
        attendees: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'role', 'organisation', 'competent'],
            properties: {
              name: stringField,
              role: stringField,
              organisation: stringField,
              competent: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => commissioningclose.recordTraining(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/training-records/supersede',
    description: 'Supersede a document, invalidating every session taught from the revision it replaces',
    schema: {
      type: 'object',
      required: ['reference', 'supersededRevision', 'newRevision', 'recordedBy'],
      properties: {
        reference: stringField,
        supersededRevision: stringField,
        newRevision: stringField,
        recordedBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => commissioningclose.supersedeTrainingInformation(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/commissioning-dossiers',
    description: 'Compile the dossier for one system. Completeness is over the required records, not the file count',
    schema: {
      type: 'object',
      required: ['systemTag', 'entries', 'compiledBy'],
      properties: {
        systemTag: stringField,
        compiledBy: stringField,
        entries: {
          type: 'array',
          items: {
            type: 'object',
            required: ['key', 'reference', 'revision', 'evidenceRef'],
            properties: {
              key: { type: 'string', enum: commissioningclose.DOSSIER_RECORD.map((record) => record.key) },
              reference: stringField,
              revision: stringField,
              evidenceRef: stringField,
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => commissioningclose.compileDossier(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/system-acceptances',
    description: 'Accept a system into operation, acknowledged by the named party that will be running it',
    schema: {
      type: 'object',
      required: ['systemTag', 'decision', 'acknowledgedBy', 'acknowledgedForOrganisation', 'note'],
      properties: {
        systemTag: stringField,
        decision: { type: 'string', enum: ['ACCEPTED', 'CONDITIONAL', 'REJECTED'] },
        acknowledgedBy: stringField,
        acknowledgedForOrganisation: stringField,
        note: { type: 'string' },
        conditions: {
          type: 'object',
          required: ['operatingLimits', 'riskOwner', 'expiresOn', 'closurePlan'],
          properties: {
            operatingLimits: { type: 'string' },
            riskOwner: stringField,
            expiresOn: stringField,
            closurePlan: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => commissioningclose.acceptSystem(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/handover-obligations',
    description: 'Every obligation handover inherits, by the identifier it already has — read, never copied',
    handler: (platform, ctx) => commissioningclose.handoverObligations(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/commissioning-complete',
    description: 'Close the commissioning stage once every system carries a decision and none was rejected',
    schema: {
      type: 'object',
      required: ['acceptedBy', 'statement'],
      properties: { acceptedBy: stringField, statement: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) => commissioningclose.completeCommissioning(projectContext(platform, ctx), body(ctx)),
  },

  // ------------------------------------------------------- CM-WF-06 reliability, soak and the seasonal plan
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/reliability',
    description: 'Reliability runs with their metrics recomputed from the trend, and the seasonal tests still owed',
    handler: (platform, ctx) => reliability.reliabilityPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/reliability',
    description: 'Configure and start a soak run: window, duration, envelope, availability target and reset rule',
    schema: {
      type: 'object',
      required: [
        'reference',
        'systemTag',
        'from',
        'to',
        'requiredHours',
        'operatingEnvelope',
        'availabilityTargetPercent',
        'permittedInterruptionMinutes',
        'dataGapToleranceMinutes',
        'resetRule',
        'operationsAttendance',
      ],
      properties: {
        reference: stringField,
        systemTag: stringField,
        from: stringField,
        to: stringField,
        requiredHours: { type: 'number' },
        operatingEnvelope: { type: 'string' },
        availabilityTargetPercent: { type: 'number' },
        permittedInterruptionMinutes: { type: 'number' },
        dataGapToleranceMinutes: { type: 'number' },
        resetRule: { type: 'string' },
        operationsAttendance: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => reliability.startReliabilityRun(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/reliability/:runId/trend',
    description: 'Import a segment of trend data. Coverage, gaps and availability are derived from these',
    schema: {
      type: 'object',
      required: ['source', 'from', 'to', 'points', 'datasetHash'],
      properties: {
        source: stringField,
        from: stringField,
        to: stringField,
        points: { type: 'number' },
        datasetHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      reliability.importTrendSegment(projectContext(platform, ctx), ctx.params.runId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/reliability/:runId/interventions',
    description: 'Log an intervention or downtime. A manual override counts against availability like a failure',
    schema: {
      type: 'object',
      required: ['at', 'kind', 'description', 'downtimeMinutes', 'by'],
      properties: {
        at: stringField,
        kind: { type: 'string', enum: [...reliability.INTERVENTION_KIND] },
        description: { type: 'string' },
        downtimeMinutes: { type: 'number' },
        by: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      reliability.recordIntervention(projectContext(platform, ctx), ctx.params.runId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/reliability/:runId/anomalies',
    description: 'Flag a drift, data gap, hidden intervention or performance anomaly, which pauses the run',
    schema: {
      type: 'object',
      required: ['reference', 'kind', 'detail', 'detectedBy'],
      properties: {
        reference: stringField,
        kind: { type: 'string', enum: ['DATA_GAP', 'DRIFT', 'HIDDEN_INTERVENTION', 'PERFORMANCE'] },
        detail: { type: 'string' },
        detectedBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      reliability.flagAnomaly(projectContext(platform, ctx), ctx.params.runId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/reliability/:runId/anomaly-decision',
    description: 'Continue, reset or retest, under a named authority with the reasoning behind it',
    schema: {
      type: 'object',
      required: ['reference', 'decision', 'rationale', 'authorisedBy'],
      properties: {
        reference: stringField,
        decision: { type: 'string', enum: ['CONTINUE', 'RESET', 'RETEST'] },
        rationale: { type: 'string' },
        authorisedBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      reliability.decideAnomaly(projectContext(platform, ctx), ctx.params.runId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/reliability/:runId/accept',
    description: 'Accept the run. Every refusal is arithmetic: duration, availability and missing trend',
    schema: {
      type: 'object',
      required: ['acceptedBy', 'note'],
      properties: { acceptedBy: stringField, note: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      reliability.acceptReliabilityRun(projectContext(platform, ctx), ctx.params.runId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/seasonal-tests',
    description: 'Plan a test that cannot happen before handover, with criteria fixed now and responsibility accepted',
    schema: {
      type: 'object',
      required: [
        'reference',
        'systemTag',
        'condition',
        'criteria',
        'owner',
        'ownerOrganisation',
        'responsibilityAcceptedBy',
        'windowFrom',
        'windowTo',
      ],
      properties: {
        reference: stringField,
        systemTag: stringField,
        condition: { type: 'string' },
        criteria: { type: 'string' },
        owner: stringField,
        ownerOrganisation: stringField,
        responsibilityAcceptedBy: stringField,
        windowFrom: stringField,
        windowTo: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => reliability.planSeasonalTest(projectContext(platform, ctx), body(ctx)),
  },

  // ------------------------------------------------------- CM-WF-05 functional and integrated systems testing
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/functional-tests',
    description: 'Functional and integrated tests, which systems are proven, what was aborted and what awaits retest',
    handler: (platform, ctx) => functionaltest.functionalTestPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/functional-tests',
    description: 'Start a functional or integrated test. An integrated one names its dependencies and its scenario',
    schema: {
      type: 'object',
      required: ['reference', 'kind', 'packId', 'systemTag', 'witnesses'],
      properties: {
        reference: stringField,
        kind: { type: 'string', enum: [...functionaltest.FUNCTIONAL_TEST_KIND] },
        packId: stringField,
        systemTag: stringField,
        dependentSystems: { type: 'array', items: { type: 'string' } },
        scenario: { type: 'string' },
        retestOf: stringField,
        witnesses: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'organisation', 'attended'],
            properties: { name: stringField, organisation: stringField, attended: { type: 'boolean' } },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => functionaltest.startFunctionalTest(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/functional-tests/:testId/steps',
    description: 'Record what the system did at one step, timestamped, with the value or response time behind it',
    schema: {
      type: 'object',
      required: ['step', 'actualResponse', 'performedBy'],
      properties: {
        step: { type: 'number' },
        criterionRef: stringField,
        actualResponse: { type: 'string' },
        value: { type: 'number' },
        unit: stringField,
        instrumentId: stringField,
        responseTimeSeconds: { type: 'number' },
        performedBy: stringField,
        observedAt: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      functionaltest.recordStepResult(projectContext(platform, ctx), ctx.params.testId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/functional-tests/:testId/trends',
    description: 'Attach the trend or alarm dataset by hash — never a summary of one',
    schema: {
      type: 'object',
      required: ['source', 'from', 'to', 'points', 'datasetHash'],
      properties: {
        source: stringField,
        from: stringField,
        to: stringField,
        points: { type: 'number' },
        datasetHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      functionaltest.attachTrendDataset(projectContext(platform, ctx), ctx.params.testId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/functional-tests/:testId/deviations',
    description: 'Annotate a deviation from the script, authorised by name, with whether the result still stands',
    schema: {
      type: 'object',
      required: ['step', 'deviation', 'authorisedBy', 'invalidatesResult'],
      properties: {
        step: { type: 'number' },
        deviation: { type: 'string' },
        authorisedBy: stringField,
        invalidatesResult: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      functionaltest.recordScriptDeviation(projectContext(platform, ctx), ctx.params.testId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/functional-tests/:testId/abort',
    description: 'Abort the test, keeping the partial data. An abort is not a failure',
    schema: {
      type: 'object',
      required: ['reason', 'abortedBy'],
      properties: { reason: { type: 'string' }, abortedBy: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      functionaltest.abortTest(projectContext(platform, ctx), ctx.params.testId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/functional-tests/:testId/decide',
    description: 'Decide the test. The calculated result stands beside the decision and is never overwritten by it',
    schema: {
      type: 'object',
      required: ['decision', 'decidedBy', 'decisionNote'],
      properties: {
        decision: { type: 'string', enum: ['PASS', 'FAIL', 'CONDITIONAL'] },
        decidedBy: stringField,
        decisionNote: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      functionaltest.completeFunctionalTest(projectContext(platform, ctx), ctx.params.testId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/functional-tests/:testId/retest-required',
    description: 'Route a failure to a retest, linking the exception and saying what is different this time',
    schema: {
      type: 'object',
      required: ['exceptionReference', 'changedCondition', 'requestedBy'],
      properties: {
        exceptionReference: stringField,
        changedCondition: { type: 'string' },
        requestedBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      functionaltest.requireRetest(projectContext(platform, ctx), ctx.params.testId as string, body(ctx)),
  },

  // ------------------------------------------------------- CM-WF-04 pre-functional and static completion
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/pre-functional-checks',
    description: 'Weighted readiness per system from accepted checks, safety-critical failures and rework invalidations',
    handler: (platform, ctx) => prefunctional.preFunctionalPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/pre-functional-checks',
    description: 'Start a pre-functional check against a subsystem or piece of equipment',
    schema: {
      type: 'object',
      required: ['reference', 'systemTag', 'location', 'inspectedBy'],
      properties: {
        reference: stringField,
        systemTag: stringField,
        equipmentTag: stringField,
        location: stringField,
        inspectedBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => prefunctional.startPreFunctionalCheck(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/pre-functional-checks/:checkId/items',
    description: 'Record one checklist item. A failure needs a responsibility and a route back; N/A needs an approver',
    schema: {
      type: 'object',
      required: ['key', 'result', 'note'],
      properties: {
        key: { type: 'string', enum: prefunctional.PRE_FUNCTIONAL_CHECK.map((item) => item.key) },
        result: { type: 'string', enum: ['PASS', 'FAIL', 'OBSERVATION', 'NOT_APPLICABLE'] },
        note: { type: 'string' },
        evidenceRef: stringField,
        responsibility: stringField,
        route: { type: 'string', enum: ['RETURN_TO_CONSTRUCTION', 'COMMISSIONING_EXCEPTION'] },
        notApplicableRationale: { type: 'string' },
        notApplicableApprovedBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      prefunctional.recordCheckItem(projectContext(platform, ctx), ctx.params.checkId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/pre-functional-checks/:checkId/static-complete',
    description: 'Accept static completion — the statement that the system is safe to operate, not a percentage',
    schema: {
      type: 'object',
      required: ['acceptedBy'],
      properties: { acceptedBy: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      prefunctional.acceptStaticCompletion(projectContext(platform, ctx), ctx.params.checkId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/pre-functional-checks/:checkId/functional-release',
    description: 'Release the system for functional testing',
    schema: {
      type: 'object',
      required: ['releasedBy'],
      properties: { releasedBy: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      prefunctional.releaseForFunctionalTesting(projectContext(platform, ctx), ctx.params.checkId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/pre-functional-checks/:checkId/rework',
    description: 'Record construction rework, naming the checks it reaches — which invalidates their static completion',
    schema: {
      type: 'object',
      required: ['reason', 'affectedChecks', 'recordedBy'],
      properties: {
        reason: { type: 'string' },
        affectedChecks: {
          type: 'array',
          items: { type: 'string', enum: prefunctional.PRE_FUNCTIONAL_CHECK.map((item) => item.key) },
        },
        recordedBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      prefunctional.recordRework(projectContext(platform, ctx), ctx.params.checkId as string, body(ctx)),
  },

  // ------------------------------------------------------- CM-WF-07 commissioning exception, punch and retest
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/commissioning-exceptions',
    description: 'Open exceptions, what they invalidate, who is failing repeatedly and what is conditionally accepted',
    handler: (platform, ctx) => commissioningexception.exceptionPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/commissioning-exceptions',
    description: 'Raise an exception from the failed item, carrying its raw result rather than retyping it',
    schema: {
      type: 'object',
      required: ['reference', 'source', 'systemTag', 'location', 'severity', 'blocker', 'probableCause', 'responsibleParty'],
      properties: {
        reference: stringField,
        source: {
          type: 'object',
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: ['VENDOR_TEST', 'PRE_FUNCTIONAL', 'FUNCTIONAL'] },
            testId: stringField,
            criterionRef: stringField,
            checkId: stringField,
            itemKey: stringField,
          },
          additionalProperties: false,
        },
        systemTag: stringField,
        equipmentTag: stringField,
        location: stringField,
        severity: { type: 'string', enum: [...commissioningexception.EXCEPTION_SEVERITY] },
        blocker: { type: 'boolean' },
        probableCause: { type: 'string' },
        responsibleParty: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => commissioningexception.raiseException(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/commissioning-exceptions/:exceptionId/corrective-action',
    description: 'Record containment and corrective action with the evidence behind them',
    schema: {
      type: 'object',
      required: ['containment', 'corrective', 'evidenceHash', 'completedBy'],
      properties: {
        containment: { type: 'string' },
        corrective: { type: 'string' },
        evidenceHash: stringField,
        changeLinkage: stringField,
        completedBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      commissioningexception.completeCorrectiveAction(
        projectContext(platform, ctx),
        ctx.params.exceptionId as string,
        body(ctx),
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/commissioning-exceptions/:exceptionId/impact',
    description: 'Confirm which tests this invalidates. The platform proposes nothing; a person confirms the scope',
    schema: {
      type: 'object',
      required: ['invalidatedTests', 'rationale', 'confirmedBy'],
      properties: {
        invalidatedTests: { type: 'array', items: { type: 'string' } },
        rationale: { type: 'string' },
        confirmedBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      commissioningexception.assessImpact(projectContext(platform, ctx), ctx.params.exceptionId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/commissioning-exceptions/:exceptionId/retest',
    description: 'Start a controlled retest against a released pack revision',
    schema: {
      type: 'object',
      required: ['packId', 'startedBy'],
      properties: { packId: stringField, startedBy: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      commissioningexception.startRetest(projectContext(platform, ctx), ctx.params.exceptionId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/commissioning-exceptions/:exceptionId/retest-result',
    description: 'Record what the retest found. A failing retest is kept; the sequence is what repeated failure counts',
    schema: {
      type: 'object',
      required: ['retestId', 'result', 'evidence'],
      properties: {
        retestId: stringField,
        result: { type: 'string', enum: ['PASS', 'FAIL'] },
        evidence: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      commissioningexception.recordRetestResult(
        projectContext(platform, ctx),
        ctx.params.exceptionId as string,
        body(ctx),
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/commissioning-exceptions/:exceptionId/close',
    description: 'Close by adding a verified succeeding result. The failed evidence stays exactly where it was',
    schema: {
      type: 'object',
      required: ['verifiedBy', 'verification'],
      properties: { verifiedBy: stringField, verification: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      commissioningexception.closeException(projectContext(platform, ctx), ctx.params.exceptionId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/commissioning-exceptions/:exceptionId/conditional-acceptance',
    description: 'Accept a safety-critical exception conditionally: exceptional authority, operating restriction, review date',
    schema: {
      type: 'object',
      required: ['authority', 'operatingRestriction', 'reviewBy'],
      properties: { authority: stringField, operatingRestriction: { type: 'string' }, reviewBy: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      commissioningexception.acceptConditionally(
        projectContext(platform, ctx),
        ctx.params.exceptionId as string,
        body(ctx),
      ),
  },

  // ------------------------------------------------------- CM-WF-03 FAT, SAT and vendor test control
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/vendor-tests',
    description: 'Factory and site tests, their calculated results, open exceptions and conditional acceptances',
    handler: (platform, ctx) => vendortest.vendorTestPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/vendor-tests',
    description: 'Start a FAT or SAT against a released pack, recording the serial ordered and the serial in the room',
    schema: {
      type: 'object',
      required: ['kind', 'packId', 'equipmentTag', 'orderedSerial', 'observedSerial', 'purchaseOrder', 'attendance'],
      properties: {
        kind: { type: 'string', enum: [...vendortest.VENDOR_TEST_KIND] },
        packId: stringField,
        equipmentTag: stringField,
        orderedSerial: stringField,
        observedSerial: stringField,
        purchaseOrder: stringField,
        attendance: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'organisation', 'role', 'attended'],
            properties: {
              name: stringField,
              organisation: stringField,
              role: stringField,
              attended: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => vendortest.startVendorTest(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/vendor-tests/:testId/readings',
    description: 'Record one reading with its instrument, unit, performer and time. Within-limits is computed here',
    schema: {
      type: 'object',
      required: ['criterionRef', 'value', 'unit', 'instrumentId', 'performedBy'],
      properties: {
        criterionRef: stringField,
        value: { type: 'number' },
        unit: stringField,
        instrumentId: stringField,
        performedBy: stringField,
        takenAt: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      vendortest.recordReading(projectContext(platform, ctx), ctx.params.testId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/vendor-tests/:testId/exceptions',
    description: 'Raise an exception or punch item that travels with the equipment',
    schema: {
      type: 'object',
      required: ['reference', 'description', 'blocking', 'owner', 'by'],
      properties: {
        reference: stringField,
        description: { type: 'string' },
        blocking: { type: 'boolean' },
        owner: stringField,
        by: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      vendortest.raiseVendorException(projectContext(platform, ctx), ctx.params.testId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/vendor-tests/:testId/exceptions/close',
    description: 'Close an exception with what was verified, not with the vendor’s assurance that it was rectified',
    schema: {
      type: 'object',
      required: ['reference', 'closedBy', 'verification'],
      properties: { reference: stringField, closedBy: stringField, verification: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      vendortest.closeVendorException(projectContext(platform, ctx), ctx.params.testId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/vendor-tests/:testId/complete',
    description: 'Complete the test. The result is calculated from the readings; the decision is recorded beside it',
    schema: {
      type: 'object',
      required: ['decision', 'decidedBy'],
      properties: {
        decision: { type: 'string', enum: ['PASS', 'FAIL', 'CONDITIONAL'] },
        decidedBy: stringField,
        restrictions: { type: 'string' },
        restrictionClearBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      vendortest.completeVendorTest(projectContext(platform, ctx), ctx.params.testId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/vendor-tests/:testId/shipping-release',
    description: 'Release the equipment for shipping under a designated authority, with the serials matching',
    schema: {
      type: 'object',
      required: ['releasedBy', 'authority'],
      properties: { releasedBy: stringField, authority: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      vendortest.releaseForShipping(projectContext(platform, ctx), ctx.params.testId as string, body(ctx)),
  },

  // ------------------------------------------------------- CM-WF-02 test procedure, pack and readiness release
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/test-packs',
    description: 'Every test pack, its revision and status, what blocks it and what the plan requires that nobody raised',
    handler: (platform, ctx) => testpack.testPackPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/test-packs',
    description: 'Create the controlled procedure: steps, and every criterion mapped to a source, a reading and a unit',
    schema: {
      type: 'object',
      required: ['reference', 'systemTag', 'title', 'objective', 'steps', 'criteria', 'instrumentIds'],
      properties: {
        reference: stringField,
        systemTag: stringField,
        title: stringField,
        objective: { type: 'string' },
        requirementRef: stringField,
        steps: {
          type: 'array',
          items: {
            type: 'object',
            required: ['step', 'instruction'],
            properties: { step: { type: 'number' }, instruction: { type: 'string' } },
            additionalProperties: false,
          },
        },
        criteria: {
          type: 'array',
          items: {
            type: 'object',
            required: ['reference', 'criterion', 'source', 'requiredReading', 'unit'],
            properties: {
              reference: stringField,
              criterion: { type: 'string' },
              source: stringField,
              requiredReading: stringField,
              unit: stringField,
              lowerLimit: { type: 'number' },
              upperLimit: { type: 'number' },
            },
            additionalProperties: false,
          },
        },
        instrumentIds: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => testpack.createTestPack(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/test-packs/:packId/revise',
    description: 'Revise the procedure — which cancels any release, because readiness was checked against the old steps',
    schema: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: { type: 'string' },
        steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
        criteria: { type: 'array', items: { type: 'object', additionalProperties: true } },
        instrumentIds: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      testpack.reviseTestPack(projectContext(platform, ctx), ctx.params.packId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/test-packs/:packId/readiness-check',
    description: 'Run the nine-item readiness check. Instrument calibration is read from the register, never declared',
    schema: {
      type: 'object',
      required: ['checkedBy', 'items'],
      properties: {
        checkedBy: stringField,
        on: stringField,
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['key', 'ready', 'note'],
            properties: {
              key: { type: 'string', enum: testpack.READINESS_ITEM.map((item) => item.key) },
              ready: { type: 'boolean' },
              note: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      testpack.checkTestReadiness(projectContext(platform, ctx), ctx.params.packId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/test-packs/:packId/witness-notifications',
    description: 'Notify a named witness at a named organisation, time-stamped',
    schema: {
      type: 'object',
      required: ['recipient', 'organisation', 'testDate', 'noticeDays'],
      properties: {
        recipient: stringField,
        organisation: stringField,
        testDate: stringField,
        noticeDays: { type: 'number' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      testpack.notifyWitness(projectContext(platform, ctx), ctx.params.packId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/test-packs/:packId/witness-response',
    description: 'Record what the witness said, or an authorised waiver naming the contract rule that permits it',
    schema: {
      type: 'object',
      required: ['notificationId'],
      properties: {
        notificationId: stringField,
        attending: { type: 'boolean' },
        note: { type: 'string' },
        waivedBy: stringField,
        contractRule: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      testpack.recordWitnessResponse(projectContext(platform, ctx), ctx.params.packId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/test-packs/:packId/release',
    description: 'Release to test, freezing the revision the result must have been executed against',
    schema: {
      type: 'object',
      required: ['releasedBy'],
      properties: { releasedBy: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      testpack.releaseForTest(projectContext(platform, ctx), ctx.params.packId as string, body(ctx)),
  },

  // ------------------------------------------------------- CN-WF-12 reporting, recovery, turnover and completion
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/completion',
    description: 'Period snapshots, recovery plans, systems released to commissioning and whether completion is accepted',
    handler: (platform, ctx) => completion.completionPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/reports/snapshot',
    description: 'Take a cut-off snapshot of the ledger, naming what is stale and what is not reported at all',
    schema: {
      type: 'object',
      required: ['cutOff', 'audience'],
      properties: { cutOff: stringField, audience: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) => completion.createSnapshot(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/reports/:snapshotId/reconcile',
    description: 'Re-run a snapshot cut-off and confirm the figures a report was built on still hold',
    handler: (platform, ctx) =>
      completion.reconcileSnapshot(projectContext(platform, ctx), ctx.params.snapshotId as string),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/recovery-plans',
    description: 'Approve a recovery plan — the platform forecasts and costs the options, a person selects them',
    schema: {
      type: 'object',
      required: ['delayDaysForecast', 'measures', 'approvedBy', 'rationale'],
      properties: {
        delayDaysForecast: { type: 'number' },
        measures: {
          type: 'array',
          items: {
            type: 'object',
            required: ['measure', 'recoveryDays', 'costMinor', 'owner'],
            properties: {
              measure: { type: 'string' },
              recoveryDays: { type: 'number' },
              costMinor: { type: 'number' },
              owner: stringField,
            },
            additionalProperties: false,
          },
        },
        approvedBy: stringField,
        rationale: { type: 'string' },
        forecastRef: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => completion.approveRecoveryPlan(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/systems/turnover',
    description: 'Release a system to commissioning: boundary, isolations, retained obligations and residual defects',
    schema: {
      type: 'object',
      required: [
        'systemId',
        'systemName',
        'boundary',
        'isolations',
        'retainedObligations',
        'residualDefects',
        'evidenceRefs',
        'releasedBy',
      ],
      properties: {
        systemId: stringField,
        systemName: stringField,
        boundary: { type: 'string' },
        isolations: {
          type: 'array',
          items: {
            type: 'object',
            required: ['point', 'heldBy'],
            properties: { point: stringField, heldBy: stringField },
            additionalProperties: false,
          },
        },
        retainedObligations: { type: 'array', items: { type: 'string' } },
        residualDefects: {
          type: 'array',
          items: {
            type: 'object',
            required: ['reference', 'description', 'classification', 'owner', 'completionCondition', 'by'],
            properties: {
              reference: stringField,
              description: { type: 'string' },
              classification: { type: 'string', enum: ['BLOCKING', 'RESTRICTING', 'NON_BLOCKING'] },
              owner: stringField,
              completionCondition: { type: 'string' },
              by: stringField,
            },
            additionalProperties: false,
          },
        },
        evidenceRefs: {
          type: 'array',
          items: {
            type: 'object',
            required: ['check', 'reference'],
            properties: {
              check: { type: 'string', enum: completion.TURNOVER_CHECK.map((check) => check.key) },
              reference: stringField,
            },
            additionalProperties: false,
          },
        },
        releasedBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => completion.releaseSystemForTurnover(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/systems/turnover-exception',
    description: 'Accept commissioning on an unreleased system — signed, explained and with an expiry',
    schema: {
      type: 'object',
      required: ['systemId', 'systemName', 'whatIsMissing', 'why', 'acceptedBy', 'expiresOn'],
      properties: {
        systemId: stringField,
        systemName: stringField,
        whatIsMissing: { type: 'string' },
        why: { type: 'string' },
        acceptedBy: stringField,
        expiresOn: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => completion.recordTurnoverException(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/construction-complete',
    description: 'Accept construction completion — the stage 9 exit, issued only by an authorised party',
    schema: {
      type: 'object',
      required: ['acceptedBy', 'statement', 'certificateHash'],
      properties: { acceptedBy: stringField, statement: { type: 'string' }, certificateHash: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) => completion.acceptConstructionCompletion(projectContext(platform, ctx), body(ctx)),
  },

  // ------------------------------------------------------- CN-WF-11 approved minutes, actions and decisions
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/meetings/:meetingId/approve-minutes',
    description: 'The chair approves the minutes as they stand, hashing exactly what was approved',
    schema: {
      type: 'object',
      required: ['approvedBy'],
      properties: { approvedBy: stringField, note: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      decisioncontrol.approveMinutes(projectContext(platform, ctx), ctx.params.meetingId as string, body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/meetings/:meetingId/approved-version',
    description: 'The exact text that was approved, for anything that reproduces the minutes',
    handler: (platform, ctx) =>
      decisioncontrol.approvedVersionOf(projectContext(platform, ctx), ctx.params.meetingId as string) ?? null,
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/actions',
    description: 'Every open commitment across meetings, NCRs, safety observations and stage gates — once each',
    handler: (platform, ctx) => decisioncontrol.actionRegister(projectContext(platform, ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/decisions',
    description: 'The action register by owner, the escalations, and the decisions with what else was considered',
    handler: (platform, ctx) => decisioncontrol.decisionControlPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/decisions',
    description: 'Record a material decision: authority, rationale, alternatives not taken and impact per dimension',
    schema: {
      type: 'object',
      required: ['subject', 'decision', 'rationale', 'authority', 'alternatives', 'impacts'],
      properties: {
        subject: stringField,
        decision: { type: 'string' },
        rationale: { type: 'string' },
        authority: {
          type: 'object',
          required: ['name', 'role', 'basis'],
          properties: { name: stringField, role: stringField, basis: { type: 'string' } },
          additionalProperties: false,
        },
        // No `minItems` here either. "A decision with no alternative beside it is
        // an instruction being minuted" is the sentence the caller needs.
        alternatives: {
          type: 'array',
          items: {
            type: 'object',
            required: ['option', 'whyNot'],
            properties: { option: stringField, whyNot: { type: 'string' } },
            additionalProperties: false,
          },
        },
        impacts: {
          type: 'array',
          items: {
            type: 'object',
            required: ['dimension', 'effect', 'detail'],
            properties: {
              dimension: { type: 'string', enum: [...decisioncontrol.IMPACT_DIMENSION] },
              effect: { type: 'string', enum: ['NONE', 'ADVERSE', 'BENEFICIAL', 'UNQUANTIFIED'] },
              detail: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        references: {
          type: 'array',
          items: {
            type: 'object',
            required: ['register', 'reference'],
            properties: { register: stringField, reference: stringField },
            additionalProperties: false,
          },
        },
        meetingId: stringField,
        confidentiality: { type: 'string', enum: ['INTERNAL', 'COMMERCIAL_L3', 'LEGAL_L4'] },
        requiresInstruction: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => decisioncontrol.recordDecision(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/decisions/:decisionId/instruction',
    description: 'Record the instruction that gave effect to a decision — a person issues it, the platform never does',
    schema: {
      type: 'object',
      required: ['instructionReference'],
      properties: { instructionReference: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      decisioncontrol.linkInstruction(projectContext(platform, ctx), ctx.params.decisionId as string, body(ctx)),
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

  // ----------------------------------------- CN-WF-01 mobilisation and start-work readiness
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/mobilisation',
    description: 'Readiness by package, what is not ready and why, and which start authorities the information has overtaken',
    handler: (platform, ctx) => mobilisation.mobilisationPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/mobilisation-plans',
    description: 'Open the mobilisation checklist by site, zone and package. Start authority is by package, so the plan is too',
    schema: {
      type: 'object',
      required: ['reference', 'site', 'workPackageIds'],
      properties: {
        reference: stringField,
        site: stringField,
        workPackageIds: { type: 'array', items: stringField },
        zoneOf: { type: 'object', additionalProperties: { type: 'string' } },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => mobilisation.openMobilisation(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/mobilisation-plans/:planId/readiness-checks',
    description: 'Run the readiness review. What the platform can verify it verifies; the rest is declared, with a name on it',
    schema: {
      type: 'object',
      required: ['workPackageId', 'window', 'declarations', 'note'],
      properties: {
        workPackageId: stringField,
        window: {
          type: 'object',
          required: ['from', 'to'],
          properties: { from: stringField, to: stringField },
          additionalProperties: false,
        },
        operativeIds: { type: 'array', items: stringField },
        designPackageReference: stringField,
        permitActivity: stringField,
        temporaryWorksPackageReference: stringField,
        declarations: {
          type: 'array',
          items: {
            type: 'object',
            required: ['kind', 'met', 'detail', 'declaredBy'],
            properties: {
              kind: { type: 'string', enum: [...mobilisation.PREREQUISITE_KINDS] },
              met: { type: 'boolean' },
              detail: { type: 'string' },
              declaredBy: stringField,
            },
            additionalProperties: false,
          },
        },
        conditions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['what', 'owner', 'by'],
            properties: { what: { type: 'string' }, owner: stringField, by: stringField },
            additionalProperties: false,
          },
        },
        expiresAt: stringField,
        note: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      mobilisation.checkReadiness(projectContext(platform, ctx), ctx.params.planId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/readiness-checks/:checkId/authorise-start',
    description: 'Authorise a start against a named scope, location, window and the exact information revisions it runs on',
    schema: {
      type: 'object',
      required: ['scope', 'location', 'window', 'informationRevisions'],
      properties: {
        scope: { type: 'string' },
        location: stringField,
        window: {
          type: 'object',
          required: ['from', 'to'],
          properties: { from: stringField, to: stringField },
          additionalProperties: false,
        },
        informationRevisions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['reference', 'revision', 'source'],
            properties: { reference: stringField, revision: stringField, source: stringField },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      mobilisation.authoriseStart(projectContext(platform, ctx), ctx.params.checkId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/start-authorisations/:authorisationId/revoke',
    description: 'Withdraw a start authority. Not a deletion — people may have been working under it',
    schema: {
      type: 'object',
      required: ['reason'],
      properties: { reason: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      mobilisation.revokeAuthorisation(projectContext(platform, ctx), ctx.params.authorisationId as string, body(ctx)),
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
    pattern: '/v1/projects/:projectId/cde',
    readOnly: true,
    description: 'The common data environment — every container, its state, and what may be built from',
    handler: (platform, ctx) => cde.register(projectContext(platform, ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/cde/:reference/buildable',
    readOnly: true,
    description: 'The current revision of a document, and whether its suitability authorises building from it',
    handler: (platform, ctx) => cde.buildableFrom(projectContext(platform, ctx), ctx.params.reference as string),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cde/containers',
    description: 'Deposit a file into the environment at work in progress',
    schema: {
      type: 'object',
      required: ['reference', 'revision', 'title', 'kind', 'discipline', 'author', 'fileHash'],
      properties: {
        reference: stringField,
        revision: stringField,
        title: stringField,
        kind: { type: 'string', enum: [...cde.CONTAINER_KIND] },
        discipline: stringField,
        author: stringField,
        fileHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => cde.depositContainer(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cde/containers/:containerId/share',
    description: 'Share a container — somebody other than the author saying it is fit to be seen',
    schema: {
      type: 'object',
      required: ['checker', 'suitability'],
      properties: {
        checker: stringField,
        suitability: { type: 'string', enum: [...cde.SUITABILITY_CODES] },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      cde.shareContainer(projectContext(platform, ctx), {
        containerId: ctx.params.containerId as string,
        ...body<{ checker: string; suitability: cde.SuitabilityCode }>(ctx),
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cde/containers/:containerId/publish',
    description: 'Publish a container, superseding whatever revision it replaces in the same act',
    schema: {
      type: 'object',
      required: ['approver', 'suitability'],
      properties: {
        approver: stringField,
        suitability: { type: 'string', enum: [...cde.SUITABILITY_CODES] },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      cde.publishContainer(projectContext(platform, ctx), {
        containerId: ctx.params.containerId as string,
        ...body<{ approver: string; suitability: cde.SuitabilityCode }>(ctx),
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/cde/containers/:containerId/archive',
    description: 'Withdraw a container from use without a replacement',
    schema: {
      type: 'object',
      required: ['reason'],
      properties: { reason: { type: 'string', minLength: 10 } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      cde.archiveContainer(projectContext(platform, ctx), {
        containerId: ctx.params.containerId as string,
        reason: body<{ reason: string }>(ctx).reason,
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/rfi/:rfiId/close',
    description: 'Close an RFI — the asker agreeing the answer is usable, which the answerer cannot do',
    schema: {
      type: 'object',
      required: ['outcome', 'note', 'closedBy', 'evidenceHash'],
      properties: {
        outcome: { type: 'string', enum: [...bim.RFI_CLOSURE_OUTCOMES] },
        note: { type: 'string', minLength: 10 },
        closedBy: stringField,
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      bim.closeRFI(projectContext(platform, ctx), {
        ...body<Omit<Parameters<typeof bim.closeRFI>[1], 'rfiId'>>(ctx),
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

  // --- Commitments read out of the post --------------------------------------
  //
  // The letters are full of dates nobody is tracking. Reading one produces
  // candidate obligations quoting the sentence they came from; confirming one
  // registers it in the obligation calendar that already exists.
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/commitments',
    readOnly: true,
    description: 'What has been read out of the post, what is being tracked, and how many letters nobody has read',
    handler: (platform, ctx) => commitments.commitmentPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/correspondence/:correspondenceId/commitments',
    description: 'Read one letter for what it promises and what it demands, quoting the letter for each',
    ai: { engine: 'CONTRACTS_CLAIMS', taskType: 'commitment_extraction', capability: 'REASONING' },
    // No body: the letter is named in the path and its text is already held.
    schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (platform, ctx) =>
      commitments.readCommitments(projectContext(platform, ctx), {
        correspondenceId: ctx.params.correspondenceId as string,
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/commitments/:commitmentId/track',
    description: 'Confirm a reading and put the date into the obligation calendar, against an owner',
    schema: {
      type: 'object',
      required: ['contractId', 'owner', 'dueDate'],
      properties: {
        contractId: stringField,
        owner: stringField,
        // Required rather than defaulted from the letter: "within ten working
        // days" is a period, and which day it lands on is not something to
        // infer from prose and file against a party.
        dueDate: stringField,
        description: { type: 'string', minLength: 4 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      commitments.trackCommitment(projectContext(platform, ctx), {
        ...body<Omit<Parameters<typeof commitments.trackCommitment>[1], 'commitmentId'>>(ctx),
        commitmentId: ctx.params.commitmentId as string,
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/commitments/:commitmentId/discard',
    description: 'Reject a reading, saying why. What was read is kept.',
    schema: {
      type: 'object',
      required: ['reason'],
      properties: { reason: { type: 'string', minLength: 4 } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      commitments.discardCommitment(projectContext(platform, ctx), {
        reason: body<{ reason: string }>(ctx).reason,
        commitmentId: ctx.params.commitmentId as string,
      }),
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

  // ------------------------------------------------------- D-WF-01 design packages and the MIDP
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/design-packages',
    description: 'The design plan: packages, their deliverables and interfaces, and what the MIDP reconciles to',
    handler: (platform, ctx) => designplan.designPlanPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design-packages',
    description: 'Create a design package with a named lead — a package with no lead has no interface owner',
    schema: {
      type: 'object',
      required: ['reference', 'title', 'discipline', 'zone', 'leadDesigner', 'leadOrganisation'],
      properties: {
        reference: stringField,
        title: stringField,
        discipline: stringField,
        zone: stringField,
        leadDesigner: stringField,
        leadOrganisation: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => designplan.createPackage(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design-packages/:packageId/deliverables',
    description: 'Plan a deliverable. The slack between issue, review and the date it is needed is computed, not asked for',
    schema: {
      type: 'object',
      required: [
        'reference',
        'title',
        'kind',
        'purpose',
        'format',
        'author',
        'checker',
        'approver',
        'acceptingParty',
        'dueBy',
        'neededBy',
        'neededFor',
        'reviewDays',
      ],
      properties: {
        reference: stringField,
        title: stringField,
        kind: { type: 'string', enum: [...designplan.DELIVERABLE_KIND] },
        purpose: stringField,
        format: stringField,
        author: stringField,
        checker: stringField,
        approver: stringField,
        acceptingParty: stringField,
        dueBy: stringField,
        neededBy: stringField,
        neededFor: stringField,
        reviewDays: { type: 'number', minimum: 0 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      designplan.planDeliverable(projectContext(platform, ctx), ctx.params.packageId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design-packages/:packageId/interfaces',
    description: 'Record an interface, owned on both sides. One owner is a boundary somebody drew and nobody agreed',
    schema: {
      type: 'object',
      required: ['reference', 'description', 'withPackage', 'ourOwner', 'theirOwner', 'resolveBy'],
      properties: {
        reference: stringField,
        description: { type: 'string' },
        withPackage: stringField,
        ourOwner: stringField,
        theirOwner: stringField,
        resolveBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      designplan.recordInterface(projectContext(platform, ctx), ctx.params.packageId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design-packages/:packageId/interfaces/agree',
    description: 'Agree an interface, with what was actually agreed rather than a tick',
    schema: {
      type: 'object',
      required: ['reference', 'what'],
      properties: { reference: stringField, what: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      designplan.agreeInterface(projectContext(platform, ctx), ctx.params.packageId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design-packages/:packageId/deliverables/delegate',
    description: 'Sublet production. The author of record and the package’s interface obligations do not move',
    schema: {
      type: 'object',
      required: ['deliverableReference', 'party', 'organisation', 'why'],
      properties: {
        deliverableReference: stringField,
        party: stringField,
        organisation: stringField,
        why: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      designplan.delegate(projectContext(platform, ctx), ctx.params.packageId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design-packages/:packageId/deliverables/transfer',
    description: 'Move a responsibility. Needs the outgoing party’s release and the incoming party’s acceptance',
    schema: {
      type: 'object',
      required: ['deliverableReference', 'role', 'to', 'acceptedByOutgoing', 'acceptedByIncoming', 'reason'],
      properties: {
        deliverableReference: stringField,
        role: { type: 'string', enum: ['author', 'checker', 'approver', 'acceptingParty'] },
        to: stringField,
        acceptedByOutgoing: stringField,
        acceptedByIncoming: stringField,
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      designplan.transferResponsibility(projectContext(platform, ctx), ctx.params.packageId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design-packages/:packageId/deliverables/advance',
    description: 'Move a deliverable along the CDE ladder. Nothing reaches Shared without an author, a checker and its metadata',
    schema: {
      type: 'object',
      required: ['reference', 'to'],
      properties: { reference: stringField, to: { type: 'string', enum: [...designplan.CDE_STATE] } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      designplan.advanceDeliverable(projectContext(platform, ctx), ctx.params.packageId as string, body(ctx)),
  },

  // ------------------------------------------------------- D-WF-07 constructability and residual design risk
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/constructability',
    description: 'Reviews held, findings still open, what blocks a package freeze and which residual risks nobody has passed on',
    handler: (platform, ctx) => constructability.constructabilityPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/constructability',
    description: 'Hold the review. Refused without construction, design, HSE and operations in the room',
    schema: {
      type: 'object',
      required: ['packageReference', 'zone', 'heldAt', 'attendees'],
      properties: {
        packageReference: stringField,
        zone: stringField,
        heldAt: stringField,
        attendees: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'organisation', 'discipline'],
            properties: { name: stringField, organisation: stringField, discipline: stringField },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => constructability.holdReview(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/constructability/:reviewId/findings',
    description: 'Record a finding with the disposition it becomes — a change, a risk, an RFI, a method constraint or an acceptance',
    schema: {
      type: 'object',
      required: ['area', 'severity', 'what', 'location', 'raisedBy', 'disposition', 'rationale', 'owner', 'by'],
      properties: {
        area: { type: 'string', enum: [...constructability.FINDING_AREA] },
        severity: { type: 'string', enum: [...constructability.SEVERITY] },
        what: { type: 'string' },
        location: stringField,
        raisedBy: stringField,
        disposition: { type: 'string', enum: [...constructability.DISPOSITION] },
        rationale: { type: 'string' },
        owner: stringField,
        by: stringField,
        linkedRef: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      constructability.recordFinding(projectContext(platform, ctx), ctx.params.reviewId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/constructability/:reviewId/findings/close',
    description: 'Close a finding with what actually resolved it',
    schema: {
      type: 'object',
      required: ['reference', 'what'],
      properties: { reference: stringField, what: { type: 'string' }, linkedRef: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      constructability.closeFinding(projectContext(platform, ctx), ctx.params.reviewId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/constructability/:reviewId/residual-risks',
    description: 'Record a residual design risk: eliminated, reduced or communicated, and who is exposed to it',
    schema: {
      type: 'object',
      required: ['hazard', 'whoIsExposed', 'treatment', 'what', 'shownOn'],
      properties: {
        hazard: { type: 'string' },
        whoIsExposed: stringField,
        treatment: { type: 'string', enum: [...constructability.RISK_TREATMENT] },
        what: { type: 'string' },
        shownOn: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      constructability.recordResidualRisk(projectContext(platform, ctx), ctx.params.reviewId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/constructability/:reviewId/residual-risks/communicate',
    description: 'Record that a residual risk has reached the pre-construction information or a method statement, by reference',
    schema: {
      type: 'object',
      required: ['reference', 'reached', 'where'],
      properties: {
        reference: stringField,
        reached: { type: 'string', enum: ['PRE_CONSTRUCTION_INFORMATION', 'METHOD_STATEMENT'] },
        where: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      constructability.communicateRisk(projectContext(platform, ctx), ctx.params.reviewId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/constructability/:reviewId/temporary-works',
    description: 'Raise a temporary works interface with the BS 5975 category a competent person assigned, and who assigned it',
    schema: {
      type: 'object',
      required: ['description', 'category', 'assignedBy', 'designer', 'checker', 'permanentWorksAssumption'],
      properties: {
        description: { type: 'string' },
        category: { type: 'string', enum: ['0', '1', '2', '3'] },
        assignedBy: stringField,
        designer: stringField,
        checker: stringField,
        permanentWorksAssumption: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      constructability.raiseTemporaryWorks(projectContext(platform, ctx), ctx.params.reviewId as string, body(ctx)),
  },


  // ------------------------------------------------------- D-WF-04 federation, clash runs and coordination issues
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/coordination',
    description: 'Federation sets, the issues grouped out of their runs, and which critical ones are still unresolved',
    handler: (platform, ctx) => coordination.coordinationPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/federation-sets',
    description: 'Form an immutable set from exact model revisions. Refused where units or coordinate systems disagree',
    schema: {
      type: 'object',
      required: ['reference', 'models'],
      properties: {
        reference: stringField,
        models: {
          type: 'array',
          // No `minItems`: "one model clashes with nothing" is a sentence worth
          // reading and VALIDATION_FAILED is not.
          items: {
            type: 'object',
            required: ['modelId', 'discipline', 'revision', 'fileHash', 'units', 'coordinateSystem'],
            properties: {
              modelId: stringField,
              discipline: stringField,
              revision: stringField,
              fileHash: stringField,
              units: { type: 'string', enum: [...coordination.UNITS] },
              coordinateSystem: stringField,
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => coordination.createFederationSet(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/federation-sets/:federationSetId/runs',
    description: 'Run the checks and group what they find into issues — four thousand clashes are usually forty problems',
    schema: {
      type: 'object',
      required: ['ruleSet', 'clashes'],
      properties: {
        ruleSet: stringField,
        clashes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['elementA', 'elementB', 'disciplineA', 'disciplineB', 'systemA', 'systemB', 'overlapVolume', 'location'],
            properties: {
              elementA: stringField,
              elementB: stringField,
              disciplineA: stringField,
              disciplineB: stringField,
              systemA: stringField,
              systemB: stringField,
              overlapVolume: { type: 'number', minimum: 0 },
              location: stringField,
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      coordination.runClashDetection(projectContext(platform, ctx), ctx.params.federationSetId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/coordination-issues/:issueId/assign',
    description: 'Give an issue one owner, the parties it affects, a date and the model revision it will be fixed in',
    schema: {
      type: 'object',
      required: ['owner', 'affectedParties', 'by', 'targetRevision'],
      properties: {
        owner: stringField,
        affectedParties: { type: 'array', items: stringField },
        by: stringField,
        targetRevision: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      coordination.assignIssue(projectContext(platform, ctx), ctx.params.issueId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/coordination-issues/:issueId/advance',
    description: 'Move an issue along its ladder. Verification can send it back, which is why the state exists',
    schema: {
      type: 'object',
      required: ['to', 'note'],
      properties: { to: { type: 'string', enum: [...coordination.ISSUE_STATE] }, note: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      coordination.advanceIssue(projectContext(platform, ctx), ctx.params.issueId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/coordination-issues/:issueId/accept',
    description: 'Accept a clash rather than resolve it — with a reason and a named risk owner, and never marked resolved',
    schema: {
      type: 'object',
      required: ['reason', 'riskOwner'],
      properties: { reason: { type: 'string' }, riskOwner: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      coordination.acceptIssue(projectContext(platform, ctx), ctx.params.issueId as string, body(ctx)),
  },

  // ------------------------------------------------------------ D-WF-06 design change and impact control
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/design-changes',
    description: 'The design change register: approval route, domains still unassessed, and what was implemented unapproved',
    handler: (platform, ctx) => designchange.designChangePosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design-changes',
    description: 'Propose a change to approved design. The approval route is derived from its share of the project, not a figure',
    schema: {
      type: 'object',
      required: [
        'title',
        'classification',
        'origin',
        'reason',
        'currentRevision',
        'proposedRevision',
        'affects',
        'touchesSafety',
        'touchesStatutoryApproval',
        'estimatedCostMinor',
      ],
      properties: {
        title: stringField,
        classification: { type: 'string', enum: [...designchange.CHANGE_CLASS] },
        origin: stringField,
        reason: { type: 'string' },
        currentRevision: stringField,
        proposedRevision: stringField,
        affects: {
          type: 'array',
          items: {
            type: 'object',
            required: ['kind', 'reference'],
            properties: { kind: stringField, reference: stringField },
            additionalProperties: false,
          },
        },
        touchesSafety: { type: 'boolean' },
        touchesStatutoryApproval: { type: 'boolean' },
        estimatedCostMinor: { type: 'number', minimum: 0 },
        emergency: {
          type: 'object',
          required: ['why'],
          properties: { why: { type: 'string' } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => designchange.proposeChange(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design-changes/:changeId/impacts',
    description: 'Assess one of the six domains, or record with a reason that it does not apply. Silence is not an assessment',
    schema: {
      type: 'object',
      required: ['domain', 'applicable', 'assessment', 'assessedBy'],
      properties: {
        domain: { type: 'string', enum: [...designchange.IMPACT_DOMAIN] },
        applicable: { type: 'boolean' },
        assessment: { type: 'string' },
        assessedBy: stringField,
        costMinor: { type: 'number' },
        days: { type: 'number' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      designchange.assessImpact(projectContext(platform, ctx), ctx.params.changeId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design-changes/:changeId/decision',
    description: 'Approve, reject, or ask for more. Approval is refused while any of the six domains is unassessed',
    schema: {
      type: 'object',
      required: ['decision', 'rationale'],
      properties: { decision: { type: 'string', enum: [...designchange.DECISION] }, rationale: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      designchange.decideChange(projectContext(platform, ctx), ctx.params.changeId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design-changes/:changeId/implemented',
    description: 'Record the change made in the design. Refused before approval unless it was raised as an emergency',
    schema: {
      type: 'object',
      required: ['note'],
      properties: { note: { type: 'string' }, changeRequestRef: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      designchange.recordImplemented(projectContext(platform, ctx), ctx.params.changeId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design-changes/:changeId/affected',
    description: 'Confirm one affected thing was revised, or that it turned out not to be affected — with the reason either way',
    schema: {
      type: 'object',
      required: ['reference', 'outcome', 'note'],
      properties: {
        reference: stringField,
        outcome: { type: 'string', enum: ['REVISED', 'UNAFFECTED'] },
        note: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      designchange.confirmAffected(projectContext(platform, ctx), ctx.params.changeId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design-changes/:changeId/close',
    description: 'Close the change. Refused while anything it named is unconfirmed or an emergency approval is still owed',
    schema: {
      type: 'object',
      required: ['note'],
      properties: { note: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      designchange.closeChange(projectContext(platform, ctx), ctx.params.changeId as string, body(ctx)),
  },

  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/midp',
    description: 'Approve the master information delivery plan. Refused while the reconciliation shows a contradiction',
    schema: {
      type: 'object',
      required: ['cutOff', 'note'],
      properties: { cutOff: stringField, note: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) => designplan.approveMIDP(projectContext(platform, ctx), body(ctx)),
  },

  // ------------------------------------------------------- material and technical submittals
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/submittals',
    description: 'The submittal register ordered by when the decision is needed, not by when it was raised',
    handler: (platform, ctx) => submittals.submittalPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/submittals',
    description: 'Raise a submittal against a specification clause, with the compliance comparison and the lead time',
    schema: {
      type: 'object',
      required: [
        'kind',
        'title',
        'clauseId',
        'manufacturer',
        'productReference',
        'claims',
        'procurementLeadTimeDays',
        'requiredOnSiteBy',
        'reviewPeriodDays',
      ],
      properties: {
        kind: { type: 'string', enum: [...submittals.SUBMITTAL_KIND] },
        title: stringField,
        clauseId: stringField,
        manufacturer: stringField,
        productReference: stringField,
        // No `minItems`, for the usual reason: "a submittal with no requirement
        // compared is a product data sheet with a cover sheet on it" is worth
        // reading, and VALIDATION_FAILED is not.
        claims: {
          type: 'array',
          items: {
            type: 'object',
            required: ['requirement', 'specified', 'offered', 'compliant'],
            properties: {
              requirement: stringField,
              specified: stringField,
              offered: stringField,
              compliant: { type: 'boolean' },
              justification: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        procurementLeadTimeDays: { type: 'number', minimum: 0 },
        requiredOnSiteBy: stringField,
        reviewPeriodDays: { type: 'number', minimum: 0 },
        substitution: {
          type: 'object',
          required: ['differsFrom', 'whyProposed'],
          properties: { differsFrom: { type: 'string' }, whyProposed: { type: 'string' } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => submittals.raiseSubmittal(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/submittals/:submittalId/submit',
    description: 'Send it for review, which starts the contractual clock and fixes the review due date',
    // Takes no body. The empty schema is not a formality — it refuses one
    // carrying fields, so a caller who thinks this route accepts arguments finds
    // out here rather than by having them silently ignored.
    schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (platform, ctx) =>
      submittals.submitForReview(projectContext(platform, ctx), ctx.params.submittalId as string),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/submittals/:submittalId/review',
    description: 'Decide it — approved, approved with comments, revise and resubmit, or rejected',
    schema: {
      type: 'object',
      required: ['outcome', 'comments'],
      properties: {
        outcome: { type: 'string', enum: [...submittals.REVIEW_OUTCOME] },
        comments: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      submittals.reviewSubmittal(projectContext(platform, ctx), ctx.params.submittalId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/submittals/:submittalId/resubmit',
    description: 'Resubmit as the next revision on the same record, saying what changed',
    schema: {
      type: 'object',
      required: ['claims', 'whatChanged'],
      properties: {
        manufacturer: { type: 'string' },
        productReference: { type: 'string' },
        claims: {
          type: 'array',
          items: {
            type: 'object',
            required: ['requirement', 'specified', 'offered', 'compliant'],
            properties: {
              requirement: stringField,
              specified: stringField,
              offered: stringField,
              compliant: { type: 'boolean' },
              justification: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        substitution: {
          type: 'object',
          required: ['differsFrom', 'whyProposed'],
          properties: { differsFrom: { type: 'string' }, whyProposed: { type: 'string' } },
          additionalProperties: false,
        },
        whatChanged: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      submittals.resubmit(projectContext(platform, ctx), ctx.params.submittalId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/submittals/:submittalId/ordered',
    description: 'Record the order. Before approval it is recorded as placed at risk, with the reason it was worth taking',
    schema: {
      type: 'object',
      required: ['orderReference'],
      properties: {
        orderReference: stringField,
        atRisk: { type: 'boolean' },
        justification: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      submittals.recordOrdered(projectContext(platform, ctx), ctx.params.submittalId as string, body(ctx)),
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
    pattern: '/v1/projects/:projectId/contracts/:contractId/execute',
    description: 'Engine F — execute a contract that was negotiated rather than tendered',
    schema: {
      type: 'object',
      required: ['signedDocumentHash', 'signatureMethod'],
      properties: {
        signedDocumentHash: { type: 'string', minLength: 64, maxLength: 64 },
        signatureMethod: { type: 'string', enum: ['WET_INK', 'E_SIGNATURE', 'DEED'] },
        executedOn: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      claims.executeContract(projectContext(platform, ctx), {
        contractId: String(ctx.params.contractId),
        ...body<{ signedDocumentHash: string; signatureMethod: string; executedOn?: string }>(ctx),
      }),
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
    method: 'POST',
    pattern: '/v1/projects/:projectId/consistency/chain-exceptions',
    description: 'Raise a break in the bid-to-CVR data flow as an exception to whoever owns the commercial position',
    // POST rather than GET, and separate from the report above, because this
    // writes: reading what disagrees must never be the act that alerts somebody,
    // or every dashboard refresh becomes an escalation.
    schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (platform, ctx) => {
      const escalation = consistency.escalateChainBreaks(projectContext(platform, ctx));

      // The record is written whatever happens next. The notice is the second
      // half, and a mail server that is down must not lose the exception.
      for (const exception of escalation.raised) {
        const recipients = platform
          .users(auth(ctx).tenantId)
          .filter((user) => user.roles.some((role) => (consistency.CHAIN_EXCEPTION_ROLES as readonly string[]).includes(role)))
          .map((user) => ({ id: user.id, name: user.name, email: user.email, tenantId: user.tenantId }));

        if (recipients.length === 0) continue;

        await notifyEngine.notify(platform, {
          code: 'commercial.chain_broken',
          recipients,
          payload: {
            project: ctx.params.projectId as string,
            item: exception.check,
            actionUrl: `/app/#/projects/${ctx.params.projectId}/consistency`,
            actionLabel: 'Open the commercial position',
            detail: `${exception.finding} ${exception.consequence}`,
          },
          branding: platform.exports.branding(auth(ctx).tenantId, ctx.params.projectId as string),
          actorId: auth(ctx).actorId,
          correlationId: ctx.correlationId,
        });
      }

      return {
        ...escalation,
        // Said plainly rather than implied. An exception owed to nobody is a
        // configuration problem on the tenancy, not a delivery failure.
        unaddressed:
          escalation.raised.length > 0 &&
          platform
            .users(auth(ctx).tenantId)
            .every((user) => !user.roles.some((role) => (consistency.CHAIN_EXCEPTION_ROLES as readonly string[]).includes(role))),
      };
    },
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
    method: 'GET',
    pattern: '/v1/developer/keys',
    readOnly: true,
    description: 'Every API key this tenancy has issued, with the secret nowhere in it',
    handler: (platform, ctx) => ({
      keys: keyRegister(tenantContext(platform, ctx)),
      grantableScopes: grantableScopes(tenantContext(platform, ctx).auth.roles),
    }),
  },
  {
    method: 'POST',
    pattern: '/v1/developer/keys',
    description: 'Issue an API key, scoped no wider than you, in sandbox or live',
    schema: {
      type: 'object',
      required: ['name', 'mode', 'scopes'],
      properties: {
        name: { type: 'string' },
        mode: { type: 'string', enum: ['SANDBOX', 'LIVE'] },
        scopes: { type: 'array', items: { type: 'string' } },
        expiresInDays: { type: 'number' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const issued = issueKey(tenantContext(platform, ctx), body(ctx));
      const { secretHash: _held, ...key } = issued.key;
      return {
        key,
        secret: issued.secret,
        // Said at the point of issue, where somebody is looking, rather than in
        // documentation they will read afterwards if at all.
        notice: 'This is the only time the secret is shown. It is stored as a digest and cannot be recovered.',
      };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/developer/keys/:keyId/revoke',
    description: 'Withdraw an API key. The next request made with it is refused',
    schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } }, additionalProperties: false },
    handler: (platform, ctx) => {
      const { secretHash: _held, ...key } = revokeKey(tenantContext(platform, ctx), {
        keyId: ctx.params.keyId as string,
        reason: body<{ reason: string }>(ctx).reason,
      });
      return key;
    },
  },
  {
    method: 'GET',
    pattern: '/v1/developer/webhooks',
    readOnly: true,
    description: 'Webhook subscriptions and what the platform owes them',
    handler: (platform, ctx) => {
      const context = tenantContext(platform, ctx);
      return { subscriptions: subscriptionRegister(context), position: webhookPosition(context) };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/developer/webhooks',
    description: 'Subscribe an https endpoint to events, and receive its signing secret once',
    schema: {
      type: 'object',
      required: ['name', 'url'],
      properties: {
        name: { type: 'string' },
        url: { type: 'string' },
        eventTypes: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['SANDBOX', 'LIVE'] },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const created = subscribe(tenantContext(platform, ctx), body(ctx));
      return {
        ...created,
        notice:
          'This is the only time the signing secret is shown. Verify x-construx-signature as t=<seconds>,v1=HMAC-SHA256 over "<t>.<body>", and reject a timestamp older than 300 seconds.',
      };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/developer/webhooks/:subscriptionId/disable',
    description: 'Stop delivering to an endpoint',
    schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } }, additionalProperties: false },
    handler: (platform, ctx) => {
      unsubscribe(tenantContext(platform, ctx), {
        subscriptionId: ctx.params.subscriptionId as string,
        reason: body<{ reason: string }>(ctx).reason,
      });
      return { disabled: true };
    },
  },
  {
    method: 'GET',
    pattern: '/v1/command-centre/functions',
    readOnly: true,
    description: 'The seven command-centre functions and what each is for, so a client never hardcodes them',
    handler: () => ({ functions: centreCatalogue() }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/command-centre',
    readOnly: true,
    description: 'The command centre for whoever is asking: what is happening, what changed, what is at risk, what next',
    handler: (platform, ctx) => {
      // No authorisation call here on purpose. Every function inside calls the
      // ordinary domain read, which authorises exactly as it does for any other
      // caller — a check at this level would be a second source of truth for
      // who may see what, and the two would eventually disagree.
      const only = (ctx.query.get('function') ?? '')
        .split(',')
        .map((id) => id.trim().toUpperCase())
        .filter(Boolean) as CentreFunctionId[];
      return commandCentre(projectContext(platform, ctx), { only });
    },
  },
  {
    method: 'GET',
    pattern: '/v1/agents/ladder',
    description: 'The four rungs of the mandate ladder and who is in the loop at each',
    handler: () => ({ ladder: LADDER, automatableCommands: AUTOMATABLE_COMMANDS }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/agents/envelopes',
    description: 'Every grant of unattended authority ever made, live or withdrawn',
    handler: (platform, ctx) => ({ envelopes: envelopeRegister(projectContext(platform, ctx)) }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/agents/envelopes',
    description: 'Grant an agent authority to run named commands unattended, until a stated date',
    schema: {
      type: 'object',
      required: ['agent', 'commands', 'from', 'until', 'note'],
      properties: {
        agent: { type: 'string' },
        commands: { type: 'array', items: { type: 'string' } },
        valueCeilingMinor: { type: 'number' },
        from: { type: 'string' },
        until: { type: 'string' },
        note: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => grantEnvelope(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/agents/envelopes/:envelopeId/revoke',
    description: 'Withdraw a grant of unattended authority; takes effect on the next evaluation',
    schema: {
      type: 'object',
      required: ['reason'],
      properties: { reason: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      revokeEnvelope(projectContext(platform, ctx), {
        envelopeId: ctx.params.envelopeId as string,
        reason: body<{ reason: string }>(ctx).reason,
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/agents/run',
    description: 'Run the agent fleet over current project state and raise proposals',
    schema: {
      type: 'object',
      properties: {
        only: { type: 'array', items: { type: 'string' } },
        // Trigger routing. Omitted, this is a sweep — a person asking to look
        // at everything now — which is what this route has always done.
        trigger: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['SWEEP', 'EVENT', 'SCHEDULE'] },
            eventTypes: { type: 'array', items: { type: 'string' } },
            at: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
            day: { type: 'integer', minimum: 0, maximum: 6 },
          },
          required: ['kind'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => agents.runAgents(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/agents/run-changes',
    description: 'Wake only the agents the events since the last run actually trigger',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (platform, ctx) => agents.runAgentsForChanges(projectContext(platform, ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/proposals',
    description: 'Proposals awaiting a human decision, most urgent first; narrow with ?area=A,B',
    handler: (platform, ctx) => {
      const context = projectContext(platform, ctx);
      const all = agents.pendingProposals(context);

      // Every command centre carries this panel, and each one asks about its own
      // areas. Filtering here rather than in each screen means the narrowing is
      // one rule the whole product shares, and a screen cannot quietly widen it.
      //
      // An item is in an area if the command it proposes exercises that area —
      // that is what the reader would act on.
      //
      // Where a proposal names no command it is an observation, and it is placed
      // by **what it is about**: the capability areas of the records in its own
      // evidence, read from `ENTITY_ACCESS`. That is the same classification the
      // entity read and the audit feed already use, so nothing new is asserted
      // and an agent cannot widen its own reach.
      //
      // Matching an observation on the raising agent's *read mandate* was the
      // obvious version and it is far too loose: an agent that reads eight areas
      // then appears on eight screens, so a handover finding landed on the field
      // command centre because the handover agent happens to read quality data.
      // An agent reading something is not the same as a finding being about it.
      const wanted = (ctx.query.get('area') ?? '')
        .split(',')
        .map((area) => area.trim())
        .filter(Boolean);
      if (wanted.length === 0) return { proposals: all, areas: [] };

      const proposals = all.filter((proposal) => {
        if (proposal.command) return wanted.includes(proposal.command.area);

        const evidence = proposal.finding?.evidence ?? [];
        return evidence.some((item) => {
          const classification = classifyEntity(item.refType);
          return classification !== undefined && wanted.includes(classification.area);
        });
      });

      return { proposals, areas: wanted, ofTotal: all.length };
    },
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
    pattern: '/v1/projects/:projectId/proposals/:proposalId/mitigate',
    description: 'Close a finding that was right and is being handled another way, stating what that way is',
    schema: {
      type: 'object',
      required: ['mitigation'],
      properties: { mitigation: { type: 'string', minLength: 10 } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      agents.mitigateProposal(
        projectContext(platform, ctx),
        ctx.params.proposalId as string,
        body<{ mitigation: string }>(ctx).mitigation,
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/proposals/:proposalId/assign',
    description: 'Name the person who will decide a proposal. Not a decision — it stays open',
    schema: {
      type: 'object',
      required: ['userId'],
      properties: { userId: stringField, note: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      const { userId, note } = body<{ userId: string; note?: string }>(ctx);

      // Resolved from the tenancy rather than taken from the request. A client
      // that could name the assignee's roles could assign a proposal to somebody
      // who cannot decide it by simply claiming they can.
      const assignee = platform.users(actor.tenantId).find((user) => user.id === userId);
      if (!assignee) throw new NotFoundError(`No identity ${userId} in this tenancy`);

      return agents.assignProposal(projectContext(platform, ctx), ctx.params.proposalId as string, {
        assignee: { id: assignee.id, name: assignee.name, roles: assignee.roles },
        note,
      });
    },
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/proposals/:proposalId/owners',
    description: 'Who could decide this proposal, most specialised first, for the assign action',
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      const record = platform.ledger.get({ refType: 'AgentProposal', refId: ctx.params.proposalId as string });
      if (!record || record.tenantId !== actor.tenantId) throw new NotFoundError('No such proposal');

      const approvers = new Set((record.state.approvers ?? []) as string[]);
      const identities = platform
        .users(actor.tenantId)
        .filter((user) => user.roles.some((role) => approvers.has(role)))
        .map((user) => ({ id: user.id, name: user.name, email: user.email, roles: user.roles }));

      // Two questions, and asking the wrong one returns nobody.
      //
      // Where the proposal has a command, ownership is the capability that
      // command exercises: approving it means holding what it will do. Where it
      // has none it is an observation, there is no capability to intersect
      // with, and the nominated approver roles are themselves the answer.
      const command = record.state.command as { area?: string; code?: string } | undefined;
      return {
        owners: command?.area
          ? ownersFor(identities, command.area as CapabilityArea, (command.code ?? 'A') as PermissionCode)
          : ownersByRole(identities, [...approvers]),
        approverRoles: [...approvers],
        // Said plainly, because "assign" offering an empty list is otherwise
        // indistinguishable from a broken screen.
        basis: command?.area ? `capability ${command.code ?? 'A'} on ${command.area}` : 'the roles nominated to decide it',
      };
    },
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
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/sync/conflicts',
    readOnly: true,
    description: 'Offline conflicts the engine resolved on its own, and what a person decided about them',
    handler: (platform, ctx) => conflicts.conflictPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/sync/conflicts/:conflictId/resolve',
    description: 'Decide what should have happened — confirm the engine, or apply the device’s record',
    schema: {
      type: 'object',
      required: ['decision', 'reason'],
      properties: {
        decision: { type: 'string', enum: [...conflicts.CONFLICT_DECISION] },
        reason: { type: 'string', minLength: 4 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      conflicts.resolveSyncConflict(projectContext(platform, ctx), {
        conflictId: ctx.params.conflictId as string,
        ...body<{ decision: conflicts.ConflictDecision; reason: string }>(ctx),
      }),
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
    pattern: '/v1/projects/:projectId/site-visits/:visitId/report.pdf',
    binary: true,
    description: 'The site visit report — findings, what is already late, the logistics checks, and the photographs',
    schema: {
      type: 'object',
      properties: {
        audience: { type: 'string', enum: ['INTERNAL', 'CLIENT', 'SUPPLIER', 'REGULATOR', 'INSURER', 'ADJUDICATOR', 'COURT'] },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const projectId = ctx.params.projectId as string;
      const engineCtx = projectContext(platform, ctx);
      const { title, subtitle, blocks } = sitevisit.siteVisitReportBlocks(engineCtx, ctx.params.visitId as string);

      const actor = auth(ctx);
      const document = platform.exports.document(actor, projectId, {
        title,
        subtitle,
        blocks,
        audience: actor.roles.includes('REGULATOR') ? 'REGULATOR' : (body<{ audience?: ExportAudience }>(ctx).audience ?? 'INTERNAL'),
        correlationId: ctx.correlationId,
      });

      return {
        contentType: 'application/pdf',
        filename: `${document.reference}.pdf`,
        // The resolver, not the store: the renderer is handed a way to fetch
        // one tenant's bytes by hash, and never the store itself. A photograph
        // the platform does not hold — still on a device, or aged out under the
        // retention policy — comes back undefined and the page says so.
        bytes: platform.exports.toPdf(document, (hash) => {
          try {
            const held = platform.evidence.get(actor.tenantId, hash);
            return { mime: held.contentType, bytes: held.bytes };
          } catch {
            return undefined;
          }
        }),
      };
    },
  },
  // --------------------------------------------- reading the tender documents (T-WF-02)
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/tender-reviews',
    description: 'What is missing, what nobody owns, what two people own, and what the contract says',
    handler: (platform, ctx) => tenderreview.tenderReviewPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender-reviews',
    description: 'Open the review, naming the contract form and edition the bid is priced against',
    schema: {
      type: 'object',
      required: ['title', 'form'],
      properties: {
        title: stringField,
        form: {
          type: 'object',
          required: ['suite', 'edition', 'amendmentsStated'],
          properties: {
            suite: stringField,
            edition: stringField,
            amendmentsStated: { type: 'boolean' },
            amendmentDocument: stringField,
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => tenderreview.openReview(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender-reviews/:reviewId/documents',
    description: 'Record the register and validate it — missing, unreadable and contradictory',
    schema: {
      type: 'object',
      required: ['documents'],
      properties: {
        documents: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['reference', 'title', 'revision', 'readable', 'informsPackages'],
            properties: {
              reference: stringField,
              title: stringField,
              revision: stringField,
              readable: { type: 'boolean' },
              informsPackages: { type: 'array', items: { type: 'string' } },
              cites: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      tenderreview.recordDocuments(
        projectContext(platform, ctx),
        ctx.params.reviewId as string,
        body<{ documents: tenderreview.TenderDocument[] }>(ctx).documents,
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender-reviews/:reviewId/scope',
    description: 'Map the scope onto the packages that carry it, and find the gaps and overlaps',
    schema: {
      type: 'object',
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['reference', 'description', 'source', 'packages'],
            properties: {
              reference: stringField,
              description: { type: 'string' },
              source: {
                type: 'object',
                required: ['document'],
                properties: { document: stringField, clause: { type: 'string' }, page: { type: 'integer', minimum: 1 } },
                additionalProperties: false,
              },
              packages: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      tenderreview.mapScope(
        projectContext(platform, ctx),
        ctx.params.reviewId as string,
        body<{ items: tenderreview.ScopeItem[] }>(ctx).items,
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender-reviews/:reviewId/contract',
    description: 'Record what the contract says, verbatim, and what the reader takes it to mean',
    schema: {
      type: 'object',
      required: ['obligations'],
      properties: {
        obligations: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['reference', 'clause', 'wording', 'interpretation', 'category', 'response', 'owner'],
            properties: {
              reference: stringField,
              clause: stringField,
              page: { type: 'integer', minimum: 1 },
              wording: { type: 'string' },
              interpretation: { type: 'string' },
              category: {
                type: 'string',
                enum: ['PAYMENT', 'CHANGE', 'DELAY', 'INSURANCE', 'SECURITY', 'LIABILITY', 'DEADLINE', 'OTHER'],
              },
              response: { type: 'string', enum: ['PRICED', 'PROGRAMMED', 'CLARIFICATION', 'ACCEPTED_RISK'] },
              owner: stringField,
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      tenderreview.interpretContract(
        projectContext(platform, ctx),
        ctx.params.reviewId as string,
        body<{ obligations: Parameters<typeof tenderreview.interpretContract>[2] }>(ctx).obligations,
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender-reviews/:reviewId/obligations/:obligationReference/review',
    description: 'A legal or commercial owner accepts or rejects the reading',
    schema: {
      type: 'object',
      required: ['status'],
      properties: { status: { type: 'string', enum: ['ACCEPTED', 'REJECTED'] }, note: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      tenderreview.reviewObligation(
        projectContext(platform, ctx),
        ctx.params.reviewId as string,
        ctx.params.obligationReference as string,
        body(ctx),
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender-reviews/:reviewId/qualifications',
    description: 'Record an exclusion or assumption, and the gap or obligation it answers',
    schema: {
      type: 'object',
      required: ['kind', 'text', 'tracesTo'],
      properties: {
        kind: { type: 'string', enum: ['EXCLUSION', 'ASSUMPTION'] },
        text: { type: 'string' },
        tracesTo: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      tenderreview.recordQualification(projectContext(platform, ctx), ctx.params.reviewId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender-reviews/:reviewId/freeze',
    description: 'Freeze the information the price is built on',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (platform, ctx) => tenderreview.freezeReview(projectContext(platform, ctx), ctx.params.reviewId as string),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender-reviews/:reviewId/addenda',
    description: 'What an addendum touches in the frozen review — prices, programme and submissions',
    schema: {
      type: 'object',
      required: ['addendum', 'changedDocuments'],
      properties: {
        addendum: stringField,
        changedDocuments: { type: 'array', items: { type: 'string' } },
        changedClauses: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      tenderreview.assessAddendum(projectContext(platform, ctx), ctx.params.reviewId as string, body(ctx)),
  },

  // -------------------------------------------- generated site documents
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/documents',
    description: 'Every document type, whether it can be generated, and what is missing where it cannot',
    handler: (platform, ctx) => documents.documentCatalogue(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/documents',
    description: 'Generate a branded document composed from the records this project holds',
    schema: {
      type: 'object',
      required: ['code', 'preparedBy'],
      properties: {
        code: stringField,
        subjectId: { type: 'string' },
        preparedBy: stringField,
        checkedBy: { type: 'string' },
        approvedBy: { type: 'string' },
        revision: { type: 'string' },
        status: { type: 'string', enum: ['DRAFT', 'FOR_REVIEW', 'ISSUED', 'SUPERSEDED'] },
        distribution: { type: 'array', items: { type: 'string' } },
        audience: { type: 'string', enum: ['INTERNAL', 'CLIENT', 'SUPPLIER', 'REGULATOR', 'INSURER', 'ADJUDICATOR', 'COURT'] },
        format: { type: 'string', enum: ['PDF', 'JSON_BUNDLE', 'CSV', 'HTML'] },
        withNarrative: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      const input = body<{
        code: string;
        subjectId?: string;
        preparedBy: string;
        checkedBy?: string;
        approvedBy?: string;
        revision?: string;
        status?: 'DRAFT' | 'FOR_REVIEW' | 'ISSUED' | 'SUPERSEDED';
        distribution?: string[];
        audience?: Parameters<typeof documents.generateDocument>[2]['audience'];
        format?: Parameters<typeof documents.generateDocument>[2]['format'];
        withNarrative?: boolean;
      }>(ctx);
      return documents.generateDocument(projectContext(platform, ctx), platform.exports, {
        code: input.code,
        subjectId: input.subjectId,
        control: {
          preparedBy: input.preparedBy,
          checkedBy: input.checkedBy,
          approvedBy: input.approvedBy,
          revision: input.revision,
          status: input.status ?? 'DRAFT',
          distribution: input.distribution,
        },
        audience: input.audience,
        format: input.format,
        withNarrative: input.withNarrative,
        correlationId: ctx.correlationId,
      });
    },
  },

  // ------------------------------- the stage gate Definition of Done (7.4, 8.4)
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/stage-gate',
    description: 'The seven-clause Definition of Done for the phase the project is in, answered from the ledger',
    handler: (platform, ctx) => stagegate.gateFor(projectContext(platform, ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/stages/design/validate',
    description: 'Steps 1 to 4 of the design gate: what may freeze, what is late for its need date, and what tender is waiting for',
    handler: (platform, ctx) => designbaseline.validateDesignStage(projectContext(platform, ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/design-baselines',
    description: 'Frozen packages, approved baselines, and which freezes a later revision has invalidated',
    handler: (platform, ctx) => designbaseline.designBaselinePosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design-packages/:packageId/freeze',
    description: 'Freeze a package at its exact published revisions. A partial freeze needs a boundary and its interfaces checked',
    schema: {
      type: 'object',
      required: ['scope', 'note'],
      properties: {
        scope: { type: 'string', enum: ['FULL', 'PARTIAL'] },
        boundary: { type: 'string' },
        interfaceChecks: {
          type: 'array',
          items: {
            type: 'object',
            required: ['reference', 'withPackage', 'finding', 'checkedBy'],
            properties: {
              reference: stringField,
              withPackage: stringField,
              finding: { type: 'string' },
              checkedBy: stringField,
            },
            additionalProperties: false,
          },
        },
        deliverableRefs: { type: 'array', items: stringField },
        note: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      designbaseline.freezePackage(projectContext(platform, ctx), ctx.params.packageId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/design-baselines',
    description: 'Approve a baseline over frozen packages, with one cut-off and a cost snapshot that names its source',
    schema: {
      type: 'object',
      required: ['reference', 'cutOff', 'freezeIds', 'snapshots', 'note'],
      properties: {
        reference: stringField,
        cutOff: stringField,
        freezeIds: { type: 'array', items: stringField },
        snapshots: {
          type: 'object',
          properties: {
            costMinor: { type: 'number', minimum: 0 },
            costSource: { type: 'string' },
            programmeRef: { type: 'string' },
            riskRef: { type: 'string' },
          },
          additionalProperties: false,
        },
        note: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => designbaseline.approveBaseline(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/stage-gate/decisions',
    description: 'Every gate decision, its conditions, and which of them are past their date',
    handler: (platform, ctx) => stagegate.stageGatePosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/stage-gate',
    description: 'Decide the gate — pass, pass with time-bound conditions, or hold',
    schema: {
      type: 'object',
      required: ['decision', 'rationale'],
      properties: {
        decision: { type: 'string', enum: [...stagegate.GATE_DECISION] },
        rationale: stringField,
        conditions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['clause', 'what', 'owner', 'by'],
            properties: {
              clause: { type: 'string', enum: [...stagegate.GATE_CLAUSE] },
              what: stringField,
              owner: stringField,
              by: stringField,
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => stagegate.decideGate(projectContext(platform, ctx), body(ctx)),
  },

  // ------------------------------------------ buy it or do it (T-WF-05)
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/pricing-routes',
    description: 'Every package route, and where the cheapest evaluated option was not the one chosen',
    handler: (platform, ctx) => pricingroute.pricingRoutePosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/pricing-routes',
    description: 'Open the buy-or-build decision for one package',
    schema: {
      type: 'object',
      required: ['packageReference'],
      properties: { packageReference: stringField, comparisonId: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) => pricingroute.openRoute(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/pricing-routes/:routeId/self-perform',
    description: 'What it costs us to do the work ourselves, kept independent of the quotations',
    schema: {
      type: 'object',
      required: ['directCostMinor', 'durationWeeks', 'peakLabour', 'basis'],
      properties: {
        directCostMinor: { type: 'integer' },
        durationWeeks: { type: 'number' },
        peakLabour: { type: 'number' },
        basis: stringField,
        retainedRisks: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      pricingroute.recordSelfPerform(projectContext(platform, ctx), ctx.params.routeId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/pricing-routes/:routeId/evaluation',
    description: 'What choosing a route costs beyond its price — risk, interface, management, programme',
    schema: {
      type: 'object',
      required: ['head', 'amountMinor', 'basis'],
      properties: {
        partyId: { type: 'string' },
        head: { type: 'string', enum: [...pricingroute.EVALUATION_HEAD] },
        amountMinor: { type: 'integer' },
        basis: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      pricingroute.evaluateRoute(projectContext(platform, ctx), ctx.params.routeId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/pricing-routes/:routeId/exclusions',
    description: 'Price it, clarify it, or accept it as a project exclusion — every exclusion is somebody’s cost',
    schema: {
      type: 'object',
      required: ['partyId', 'exclusion', 'disposition'],
      properties: {
        partyId: stringField,
        exclusion: stringField,
        disposition: { type: 'string', enum: [...pricingroute.EXCLUSION_DISPOSITION] },
        reference: { type: 'string' },
        amountMinor: { type: 'integer' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      pricingroute.disposeExclusion(projectContext(platform, ctx), ctx.params.routeId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/pricing-routes/:routeId/interests',
    description: 'Declare a connection to a firm being priced, before the selection',
    schema: {
      type: 'object',
      required: ['partyId', 'name', 'nature'],
      properties: { partyId: stringField, name: stringField, nature: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      pricingroute.declareInterest(projectContext(platform, ctx), ctx.params.routeId as string, body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/pricing-routes/:routeId',
    description: 'Raw, normalised and evaluated side by side for every route on the package',
    handler: (platform, ctx) =>
      pricingroute.routePosition(projectContext(platform, ctx), ctx.params.routeId as string),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/pricing-routes/:routeId/select',
    description: 'Choose the route, on cost, risk, programme and capacity together',
    schema: {
      type: 'object',
      required: ['route', 'rationale', 'costBasis', 'riskBasis', 'programmeBasis', 'capacityBasis'],
      properties: {
        route: { type: 'string', enum: [...pricingroute.ROUTE] },
        partyId: { type: 'string' },
        rationale: stringField,
        costBasis: stringField,
        riskBasis: stringField,
        programmeBasis: stringField,
        capacityBasis: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      pricingroute.selectRoute(projectContext(platform, ctx), ctx.params.routeId as string, body(ctx)),
  },

  // ------------------------------ the enquiry pack and who holds it (T-WF-04)
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/enquiries',
    description: 'Every enquiry, its current revision, and which firms hold a superseded pack',
    handler: (platform, ctx) => enquiry.enquiryPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/enquiries',
    description: 'Open an enquiry against a package',
    schema: {
      type: 'object',
      required: ['packageReference', 'title', 'returnDeadline'],
      properties: { packageReference: stringField, title: stringField, returnDeadline: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) => enquiry.openEnquiry(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/enquiries/:enquiryId/revisions',
    description: 'Compose a revision of the pack; after issue this is the addendum',
    schema: {
      type: 'object',
      required: ['documents'],
      properties: {
        documents: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['reference', 'title', 'revision', 'kind'],
            properties: { reference: stringField, title: stringField, revision: stringField, kind: stringField },
            additionalProperties: false,
          },
        },
        exception: {
          type: 'object',
          required: ['missing', 'reason', 'authorisedBy'],
          properties: {
            missing: { type: 'array', items: { type: 'string' } },
            supersededDesign: { type: 'string' },
            reason: stringField,
            authorisedBy: stringField,
          },
          additionalProperties: false,
        },
        note: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      enquiry.composeRevision(projectContext(platform, ctx), ctx.params.enquiryId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/enquiries/:enquiryId/approve',
    description: 'Approve the current revision for issue — never by the person who assembled it',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (platform, ctx) => enquiry.approveRevision(projectContext(platform, ctx), ctx.params.enquiryId as string),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/enquiries/:enquiryId/issue',
    description: 'Issue the approved revision, recording per firm which revision they hold',
    schema: {
      type: 'object',
      required: ['recipients'],
      properties: {
        recipients: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['partyId', 'name'],
            properties: { partyId: stringField, name: stringField },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => enquiry.issueTo(projectContext(platform, ctx), ctx.params.enquiryId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/enquiries/:enquiryId/state',
    description: 'Record delivery, opening, acknowledgement or decline for one firm',
    schema: {
      type: 'object',
      required: ['partyId', 'state'],
      properties: {
        partyId: stringField,
        state: { type: 'string', enum: [...enquiry.ISSUE_STATE] },
        at: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      enquiry.recordIssueState(projectContext(platform, ctx), ctx.params.enquiryId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/enquiries/:enquiryId/revoke',
    description: 'Remove a firm from the enquiry; the issue evidence is preserved',
    schema: {
      type: 'object',
      required: ['partyId', 'reason'],
      properties: { partyId: stringField, reason: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      enquiry.revokeAccess(projectContext(platform, ctx), ctx.params.enquiryId as string, body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/enquiries/:enquiryId/bidder/:partyId',
    description: 'What one firm may see — its own pack revision, and nothing about the field',
    handler: (platform, ctx) =>
      enquiry.bidderView(projectContext(platform, ctx), ctx.params.enquiryId as string, ctx.params.partyId as string),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/enquiries/:enquiryId/close',
    description: 'Close the return period',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (platform, ctx) => enquiry.closeReturns(projectContext(platform, ctx), ctx.params.enquiryId as string),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/enquiries/:enquiryId/late',
    description: 'Accept a return after the deadline, under a named authority',
    schema: {
      type: 'object',
      required: ['partyId', 'reason', 'authority'],
      properties: { partyId: stringField, reason: stringField, authority: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      enquiry.acceptLateReturn(projectContext(platform, ctx), ctx.params.enquiryId as string, body(ctx)),
  },

  // --------------------------------------- measurement and the bill (T-WF-03)
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/measurement',
    description: 'Every measurement schedule, what it totals, and what stops it freezing',
    handler: (platform, ctx) => measurement.measurementPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/measurement',
    description: 'Open a measurement schedule against a package',
    schema: {
      type: 'object',
      required: ['packageReference', 'title'],
      properties: {
        packageReference: stringField,
        title: stringField,
        measurementRule: { type: 'string' },
        currency: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => measurement.openSchedule(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/measurement/:scheduleId/items',
    description: 'Record measured items, each naming the drawing and revision it came off',
    schema: {
      type: 'object',
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['reference', 'description', 'unit', 'quantity', 'basis', 'source'],
            properties: {
              reference: stringField,
              parent: { type: 'string' },
              description: stringField,
              unit: stringField,
              quantity: { type: 'number' },
              basis: { type: 'string', enum: [...measurement.QUANTITY_BASIS] },
              source: {
                type: 'object',
                properties: {
                  drawing: { type: 'string' },
                  revision: { type: 'string' },
                  sheet: { type: 'string' },
                  modelObjectSet: { type: 'string' },
                  allowanceBasis: { type: 'string' },
                  authorisedBy: { type: 'string' },
                },
                additionalProperties: false,
              },
              formula: { type: 'string' },
              measurementRule: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      measurement.recordItems(
        projectContext(platform, ctx),
        ctx.params.scheduleId as string,
        body<{ items: measurement.MeasuredItem[] }>(ctx).items,
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/measurement/:scheduleId/rates',
    description: 'Build the rate for one item from its resource constants and costs',
    schema: {
      type: 'object',
      required: ['reference', 'components'],
      properties: {
        reference: stringField,
        components: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['kind', 'description', 'unitCostMinor', 'constant'],
            properties: {
              kind: { type: 'string', enum: [...measurement.RATE_COMPONENT_KIND] },
              description: stringField,
              unitCostMinor: { type: 'integer' },
              constant: { type: 'number' },
              wastePercent: { type: 'number' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      measurement.priceItem(projectContext(platform, ctx), ctx.params.scheduleId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/measurement/:scheduleId/revisions',
    description: 'A drawing is reissued — name every item measured from the superseded revision',
    schema: {
      type: 'object',
      required: ['drawing', 'fromRevision', 'toRevision'],
      properties: { drawing: stringField, fromRevision: stringField, toRevision: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      measurement.reviseDrawing(projectContext(platform, ctx), ctx.params.scheduleId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/measurement/:scheduleId/remeasure',
    description: 'Record what a remeasurement found, including that it found nothing',
    schema: {
      type: 'object',
      required: ['reference', 'revision', 'outcome'],
      properties: {
        reference: stringField,
        revision: stringField,
        outcome: stringField,
        quantity: { type: 'number' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      measurement.confirmRemeasure(projectContext(platform, ctx), ctx.params.scheduleId as string, body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/measurement/:scheduleId',
    description: 'Item, rate and amount for every line, with what is unpriced and what is not firm',
    handler: (platform, ctx) =>
      measurement.scheduleTotals(projectContext(platform, ctx), ctx.params.scheduleId as string),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/measurement/:scheduleId/uncertainty',
    description: 'How much of the direct cost sits on a quantity that is not firm, and which lines',
    handler: (platform, ctx) =>
      measurement.uncertaintyReport(projectContext(platform, ctx), ctx.params.scheduleId as string),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/measurement/:scheduleId/freeze',
    description: 'Freeze the schedule the price is built on',
    schema: {
      type: 'object',
      required: ['reason'],
      properties: { reason: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      measurement.freezeSchedule(projectContext(platform, ctx), ctx.params.scheduleId as string, body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/measurement/:scheduleId/reconciliation/:againstId',
    description: 'Where the money went between two schedules, item by item',
    handler: (platform, ctx) =>
      measurement.reconcile(
        projectContext(platform, ctx),
        ctx.params.againstId as string,
        ctx.params.scheduleId as string,
      ),
  },

  // --------------------------------- clarifications and return intelligence (T-WF-06)
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/tender-intelligence',
    description: 'The clarification register and every return comparison, with its confidence',
    handler: (platform, ctx) => tenderintel.tenderIntelPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender-clarifications',
    description: 'Raise a clarification against the controlled information it concerns',
    schema: {
      type: 'object',
      required: ['side', 'subject', 'question', 'links'],
      properties: {
        side: { type: 'string', enum: [...tenderintel.CLARIFICATION_SIDE] },
        subject: stringField,
        question: stringField,
        links: {
          type: 'object',
          properties: {
            document: { type: 'string' },
            clause: { type: 'string' },
            drawing: { type: 'string' },
            package: { type: 'string' },
            scopeItem: { type: 'string' },
          },
          additionalProperties: false,
        },
        responseDeadline: { type: 'string' },
        confidentiality: { type: 'string', enum: [...tenderintel.CONFIDENTIALITY] },
        bidderPartyId: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => tenderintel.raiseTenderClarification(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender-clarifications/:clarificationId/issue',
    description: 'Issue the approved response to everybody entitled to it, and record who and when',
    schema: {
      type: 'object',
      required: ['response', 'recipients'],
      properties: {
        response: stringField,
        recipients: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['partyId', 'name', 'isBidder'],
            properties: { partyId: stringField, name: stringField, isBidder: { type: 'boolean' } },
            additionalProperties: false,
          },
        },
        entitledBidders: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      tenderintel.issueClarification(projectContext(platform, ctx), {
        clarificationId: ctx.params.clarificationId as string,
        ...body<{ response: string; recipients: tenderintel.ClarificationRecipient[]; entitledBidders?: string[] }>(ctx),
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/tender-clarifications/:clarificationId/acknowledge',
    description: 'Record that a recipient has read the answer',
    schema: {
      type: 'object',
      required: ['partyId'],
      properties: { partyId: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      tenderintel.acknowledgeClarification(projectContext(platform, ctx), {
        clarificationId: ctx.params.clarificationId as string,
        partyId: body<{ partyId: string }>(ctx).partyId,
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/return-comparisons',
    description: 'Open a comparison of the returns against one package',
    schema: {
      type: 'object',
      required: ['packageReference', 'returnDeadline', 'informationCutOff', 'bidders'],
      properties: {
        packageReference: stringField,
        returnDeadline: stringField,
        informationCutOff: stringField,
        bidders: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            required: ['partyId', 'name'],
            properties: { partyId: stringField, name: stringField },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => tenderintel.openComparison(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/return-comparisons/:comparisonId/returns',
    description: 'Record a return exactly as it arrived; it is never edited afterwards',
    schema: {
      type: 'object',
      required: ['bidderPartyId', 'submittedAt', 'lines'],
      properties: {
        bidderPartyId: stringField,
        submittedAt: stringField,
        lines: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['reference', 'description', 'amountMinor'],
            properties: { reference: stringField, description: stringField, amountMinor: { type: 'integer' } },
            additionalProperties: false,
          },
        },
        exclusions: { type: 'array', items: { type: 'string' } },
        qualifications: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      tenderintel.recordRawReturn(projectContext(platform, ctx), ctx.params.comparisonId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/return-comparisons/:comparisonId/adjustments',
    description: 'Adjust a return onto the common basis, citing the line or the clarification behind it',
    schema: {
      type: 'object',
      required: ['bidderPartyId', 'category', 'amountMinor', 'reason'],
      properties: {
        bidderPartyId: stringField,
        category: { type: 'string', enum: [...tenderintel.ADJUSTMENT_BASIS_CATEGORY] },
        amountMinor: { type: 'integer' },
        reason: stringField,
        fromReturnLine: { type: 'string' },
        fromClarification: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      tenderintel.adjustComparison(projectContext(platform, ctx), ctx.params.comparisonId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/return-comparisons/:comparisonId/queries',
    description: 'Raise a query against a return, and what it is worth if it goes the wrong way',
    schema: {
      type: 'object',
      required: ['bidderPartyId', 'subject', 'material', 'valueAtRiskMinor'],
      properties: {
        bidderPartyId: stringField,
        subject: stringField,
        material: { type: 'boolean' },
        valueAtRiskMinor: { type: 'integer' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      tenderintel.raiseComparisonQuery(projectContext(platform, ctx), ctx.params.comparisonId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/return-comparisons/:comparisonId/queries/resolve',
    description: 'Resolve a query and say what the answer was',
    schema: {
      type: 'object',
      required: ['reference', 'resolution'],
      properties: { reference: stringField, resolution: stringField, clarification: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      tenderintel.resolveComparisonQuery(projectContext(platform, ctx), ctx.params.comparisonId as string, body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/return-comparisons/:comparisonId',
    description: 'Raw, adjustments and evaluated side by side, with completeness and carried risk',
    handler: (platform, ctx) =>
      tenderintel.compareReturns(projectContext(platform, ctx), ctx.params.comparisonId as string),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/return-comparisons/:comparisonId/close',
    description: 'Close the comparison for adjudication, naming the risk it carries',
    schema: {
      type: 'object',
      required: ['rationale'],
      properties: { rationale: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      tenderintel.closeComparison(projectContext(platform, ctx), ctx.params.comparisonId as string, body(ctx)),
  },

  // ------------------------------------------------------- the settlement meeting (T-WF-07)
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/settlements',
    description: 'The adjustment bridge, the actions, and whether the price and the programme share a cut-off',
    handler: (platform, ctx) => settlement.settlementPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/settlements',
    description: 'Freeze the pre-settlement position and open the meeting',
    schema: {
      type: 'object',
      required: ['estimateId', 'cutOff'],
      properties: {
        estimateId: stringField,
        cutOff: {
          type: 'object',
          required: ['informationAt'],
          properties: { addendum: { type: 'string' }, informationAt: stringField },
          additionalProperties: false,
        },
        agenda: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => settlement.openSettlement(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/settlements/:settlementId/adjustments',
    description: 'Move the price, with the reason and the person who decided',
    schema: {
      type: 'object',
      required: ['category', 'amountMinor', 'reason', 'owner'],
      properties: {
        category: { type: 'string', enum: [...settlement.ADJUSTMENT_CATEGORY] },
        // Signed, and no minimum: taking money out of a price is the commonest
        // thing that happens in this meeting.
        amountMinor: { type: 'integer' },
        reason: { type: 'string' },
        owner: stringField,
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      settlement.recordAdjustment(projectContext(platform, ctx), ctx.params.settlementId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/settlements/:settlementId/actions',
    description: 'Record something the meeting decided somebody would do',
    schema: {
      type: 'object',
      required: ['description', 'owner'],
      properties: { description: { type: 'string' }, owner: stringField, dueBy: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      settlement.raiseAction(projectContext(platform, ctx), ctx.params.settlementId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/settlements/:settlementId/actions/:actionReference/settle',
    description: 'Close an action, or carry it as a condition the submission declares',
    schema: {
      type: 'object',
      required: ['ending', 'outcome'],
      properties: { ending: { type: 'string', enum: ['CLOSED', 'CARRIED'] }, outcome: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      settlement.settleAction(
        projectContext(platform, ctx),
        ctx.params.settlementId as string,
        ctx.params.actionReference as string,
        body(ctx),
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/settlements/:settlementId/programme',
    description: 'Approve the programme the price was built on, at the price’s own cut-off',
    schema: {
      type: 'object',
      required: ['programmeRef', 'cutOff', 'durationWeeks'],
      properties: {
        programmeRef: {
          type: 'object',
          required: ['refType', 'refId'],
          properties: { refType: stringField, refId: stringField },
          additionalProperties: false,
        },
        cutOff: {
          type: 'object',
          required: ['informationAt'],
          properties: { addendum: { type: 'string' }, informationAt: stringField },
          additionalProperties: false,
        },
        durationWeeks: { type: 'integer', minimum: 1 },
        note: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      settlement.approveBidProgramme(projectContext(platform, ctx), ctx.params.settlementId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/settlements/:settlementId/approve',
    description: 'Approve the settled price, under a named authority and within its limit',
    schema: {
      type: 'object',
      required: ['finalPriceMinor', 'authority', 'summary'],
      properties: {
        finalPriceMinor: { type: 'integer', minimum: 0 },
        authority: {
          type: 'object',
          required: ['delegatedTo', 'limitMinor'],
          properties: { delegatedTo: stringField, limitMinor: { type: 'integer', minimum: 0 }, reference: { type: 'string' } },
          additionalProperties: false,
        },
        summary: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      settlement.approveSettlement(projectContext(platform, ctx), ctx.params.settlementId as string, body(ctx)),
  },

  // ---------------------------------------------- submission, award and conversion (T-WF-08)
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/awards',
    description: 'Submission packs, their receipts, the award departures and what has converted',
    handler: (platform, ctx) => award.awardPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/bid-packs/:packId/submit',
    description: 'Record the submission and the receipt, bound to the exact pack hash',
    schema: {
      type: 'object',
      required: ['reference', 'channel', 'receivedAt', 'evidenceHash'],
      properties: {
        reference: stringField,
        channel: { type: 'string', enum: [...award.SUBMISSION_CHANNEL] },
        receivedAt: stringField,
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      award.recordSubmission(projectContext(platform, ctx), ctx.params.packId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/bid-packs/:packId/award',
    description: 'Record the client’s award and compute what departs from what was bid',
    schema: {
      type: 'object',
      required: ['outcome', 'reference', 'receivedOn'],
      properties: {
        outcome: { type: 'string', enum: [...award.AWARD_OUTCOME] },
        reference: stringField,
        receivedOn: stringField,
        terms: {
          type: 'object',
          properties: {
            contractSumMinor: { type: 'integer', minimum: 0 },
            commencementDate: stringField,
            completionDate: stringField,
            liquidatedDamagesPerDayMinor: { type: 'integer', minimum: 0 },
            ldCapPercent: { type: 'number', minimum: 0 },
            retentionPercent: { type: 'number', minimum: 0 },
            defectsLiabilityMonths: { type: 'integer', minimum: 0 },
            acceptedQualifications: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        winner: {
          type: 'object',
          properties: { name: { type: 'string' }, sumMinor: { type: 'integer', minimum: 0 } },
          additionalProperties: false,
        },
        notes: { type: 'string' },
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      award.recordAward(projectContext(platform, ctx), ctx.params.packId as string, body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/bid-packs/:packId/departures/:departureId/accept',
    description: 'Take a departure on knowingly, with the reason it is acceptable',
    schema: {
      type: 'object',
      required: ['reason'],
      properties: { reason: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      award.acceptDeparture(
        projectContext(platform, ctx),
        ctx.params.packId as string,
        ctx.params.departureId as string,
        body<{ reason: string }>(ctx).reason,
      ),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/bid-packs/:packId/convert',
    description: 'Carry the awarded submission into the budget and the buyout targets, without re-entry',
    schema: {
      type: 'object',
      required: ['budgetVersion', 'contingencyMinor', 'managementReserveMinor', 'tenderMarginPercent'],
      properties: {
        budgetVersion: stringField,
        contingencyMinor: { type: 'integer', minimum: 0 },
        managementReserveMinor: { type: 'integer', minimum: 0 },
        tenderMarginPercent: { type: 'number', minimum: 0 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      award.convertAward(projectContext(platform, ctx), ctx.params.packId as string, body(ctx)),
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
    description: "Configure the tenancy's own identity, used where a project has no client branding of its own",
    schema: {
      type: 'object',
      required: ['clientName', 'primaryColour', 'legalFooter', 'documentReferencePrefix'],
      properties: {
        clientName: stringField,
        logoRef: { type: 'string' },
        /** The mark in the evidence store, so a document's hash commits to it. */
        logoEvidenceHash: { type: 'string' },
        /**
         * A cover image, in the evidence store, by its hash.
         *
         * Same path as the logo and for the same reason: the document's content
         * hash commits to exactly which image was on its cover, so one swapped
         * afterwards makes the document stop verifying. Optional — a document
         * with no cover image gets a typographic cover rather than a blank page.
         */
        coverEvidenceHash: { type: 'string' },
        /** Who carries the duty, which is never automatically the client. */
        issuingEntity: { type: 'string' },
        primaryColour: stringField,
        legalFooter: stringField,
        documentReferencePrefix: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      // Authorised, which it was not.
      //
      // This route enforced nothing: any authenticated identity in a tenancy
      // could change the name, the mark and the registered legal detail that
      // every document the tenancy produces goes out under — including
      // instruments a client, an adjudicator or a regulator reads. The console
      // was the only thing that had not offered the button, which is to say
      // nothing was stopping it.
      //
      // ENTERPRISE_STRUCTURE update, which only the enterprise administrator
      // holds: this is the tenancy configuring its own identity, which is that
      // area's whole subject. The project-level route already took
      // PROJECT_SETUP update for the same reason at its own scope.
      const actor = authoriseTenant(ctx, 'ENTERPRISE_STRUCTURE', 'U');
      platform.exports.setBranding(actor.tenantId, body(ctx), undefined, actor.actorId);
      return platform.exports.branding(actor.tenantId);
    },
  },
  {
    method: 'POST',
    pattern: '/v1/branding/cover',
    upload: true,
    // A cover, not a drawing set. The evidence ceiling is sized for the latter
    // and leaving it here would let anybody make this process buffer 50MB.
    maxBytes: config.site.mediaMaxBytes,
    description: "Set the cover image on this tenancy's documents. PNG, JPEG or WebP, read from the file itself",
    handler: async (platform, ctx) => {
      const actor = auth(ctx);
      // The same authority the tenancy-level identity itself takes.
      authoriseTenant(ctx, 'ENTERPRISE_STRUCTURE', 'U');
      // Never absent: `createTenant` establishes an identity at onboarding
      // precisely so an export is never discovered to be unbrandable at the
      // moment somebody needs one. The project route below guards the case that
      // can actually happen — a project with no client identity of its own.
      const existing = platform.exports.branding(actor.tenantId);
      const stored = await storeBrandImage(platform, actor.tenantId, ctx.rawBody ?? Buffer.alloc(0));
      platform.exports.setBranding(actor.tenantId, { ...existing, coverEvidenceHash: stored.hash }, undefined, actor.actorId);
      return stored;
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/branding/cover',
    upload: true,
    maxBytes: config.site.mediaMaxBytes,
    description: "Set the cover image on this project's client-facing documents",
    handler: async (platform, ctx) => {
      const engine = projectContext(platform, ctx);
      // The same authority the identity itself takes. The image is part of the
      // branding, not a separate thing with its own permission — a role that may
      // set the client's name on every document may set the picture above it.
      authorise(engine, 'PROJECT_SETUP', 'U');
      // `branding` resolves the project's own identity where it has one and the
      // tenancy's otherwise, and refuses when there is neither — which cannot
      // happen, because `createTenant` establishes one at onboarding. A guard
      // here for the unbranded case would be a refusal nobody can reach, and a
      // refusal that cannot fire is worse than none: it reads as cover.
      const existing = platform.exports.branding(engine.tenantId, engine.projectId);
      const stored = await storeBrandImage(platform, engine.tenantId, ctx.rawBody ?? Buffer.alloc(0));
      platform.exports.setBranding(
        engine.tenantId,
        { ...existing, coverEvidenceHash: stored.hash },
        engine.projectId,
        engine.auth.actorId,
      );
      return stored;
    },
  },
  {
    method: 'PUT',
    pattern: '/v1/projects/:projectId/branding',
    description: "The client identity on this project's documents — their name, logo and colour, not the tenancy's",
    schema: {
      type: 'object',
      required: ['clientName', 'primaryColour', 'legalFooter', 'documentReferencePrefix'],
      properties: {
        clientName: stringField,
        /**
         * The client's mark, as a data URI or a stored reference.
         *
         * Optional because a client may not supply one, and a document with no
         * logo is honest where a document with somebody else's logo is not.
         */
        logoRef: { type: 'string' },
        /** The mark in the evidence store, so a document's hash commits to it. */
        logoEvidenceHash: { type: 'string' },
        /**
         * A cover image, in the evidence store, by its hash.
         *
         * Same path as the logo and for the same reason: the document's content
         * hash commits to exactly which image was on its cover, so one swapped
         * afterwards makes the document stop verifying. Optional — a document
         * with no cover image gets a typographic cover rather than a blank page.
         */
        coverEvidenceHash: { type: 'string' },
        /**
         * Who issues the document on this project.
         *
         * Set only where the issuing party differs from the tenancy's own —
         * a joint venture, or a subsidiary contracting in its own name. Left
         * unset, the tenancy's issuing entity carries through, which is right
         * far more often than the client's name would be.
         */
        issuingEntity: { type: 'string' },
        primaryColour: stringField,
        legalFooter: stringField,
        documentReferencePrefix: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      // One branding per tenancy was wrong in a way that only appears on a real
      // estate: a contractor running three projects for three clients had one
      // slot for all of them, so every export carried whichever client had been
      // configured last. The header prints "Prepared for: {clientName}"
      // verbatim, so a report for one client went out named for another.
      const engine = projectContext(platform, ctx);
      authorise(engine, 'PROJECT_SETUP', 'U');
      platform.exports.setBranding(engine.tenantId, body(ctx), engine.projectId, engine.auth.actorId);
      return platform.exports.branding(engine.tenantId, engine.projectId);
    },
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/branding',
    description: 'What identity this project\'s documents will carry, and where it came from',
    readOnly: true,
    handler: (platform, ctx) => {
      const engine = projectContext(platform, ctx);
      authorise(engine, 'PROJECT_SETUP', 'R');
      const own = platform.exports.projectBranding(engine.tenantId, engine.projectId);
      const effective = platform.exports.brandingIfConfigured(engine.tenantId, engine.projectId);
      return {
        // Said out loud, because "which client's name is on this document" is
        // exactly the question somebody asks after it has gone out wrong.
        source: own ? 'PROJECT' : effective ? 'TENANCY' : 'NONE',
        branding: effective ?? null,
      };
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
    description: 'Golden Thread events for the project; narrow with ?refs=Type:id,Type:id to drill a figure to its sources',
    handler: (platform, ctx) => {
      const actor = auth(ctx);
      const projectId = ctx.params.projectId as string;

      // The Build Standard requires every KPI to drill to its source events.
      // A tile knows which records it was computed from; this is where it asks
      // what happened to them. Filtering here rather than adding a route keeps
      // one place where an event's content is authorised — a second path would
      // be a second chance to get that wrong.
      const wanted = (ctx.query.get('refs') ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          // Split on the FIRST colon only. A ULID carries no colon but an
          // imported reference might, and splitting on every one would silently
          // drop the tail of the id and return the wrong record's events.
          const at = entry.indexOf(':');
          return at === -1 ? undefined : `${entry.slice(0, at)}:${entry.slice(at + 1)}`;
        })
        .filter((entry): entry is string => entry !== undefined);
      const filter = wanted.length > 0 ? new Set(wanted) : undefined;

      // An audit trail has two jobs, and they need separating. Proving the
      // record is complete and untampered needs the envelope — who, when, what
      // type, and the hashes that chain it. Reading what actually changed needs
      // the patch, and that is entity content: withholding it here is the same
      // decision the entity read makes, or the audit feed becomes the way round
      // every capability boundary in the system.
      const events = platform.ledger
        .events({ tenantId: actor.tenantId, projectId })
        .filter((event) => !filter || filter.has(`${event.entity.refType}:${event.entity.refId}`))
        .map((event) => {
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
        // Said rather than left to be inferred from an empty list. A drill that
        // returns nothing because the records have no events yet is a different
        // answer from one that returns nothing because the refs were malformed.
        ...(filter ? { requestedRefs: [...filter], matchedRefs: new Set(events.map((e) => `${e.entity.refType}:${e.entity.refId}`)).size } : {}),
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
    pattern: '/v1/billing/checkout',
    description: 'Open a Stripe checkout page for a recorded top-up request',
    schema: {
      type: 'object',
      required: ['intentId'],
      properties: { intentId: stringField },
      additionalProperties: false,
    },
    handler: async (platform, ctx) => {
      const actor = authoriseTenant(ctx, 'BILLING_ACU', 'U');
      const { intentId } = body<{ intentId: string }>(ctx);

      // The amount comes from the intent already on record, not from this
      // request. A customer choosing what to pay is fine; a customer choosing
      // what they are credited is the hole this whole design exists to close.
      const intent = platform.topUpIntents(actor.tenantId).find((i) => i.id === intentId);
      if (!intent) throw new NotFoundError(`No top-up request ${intentId}`);
      if (intent.status !== 'AWAITING_PAYMENT') {
        throw new DomainError('TOPUP_ALREADY_SETTLED', 'That top-up request has already been settled or cancelled', 409);
      }

      const session = await stripe.createCheckoutSession({
        intentId: intent.id,
        tenantId: actor.tenantId,
        amountMinor: intent.amountMinor,
        customerEmail: platform.user(actor.actorId).email,
        successUrl: config.stripe.successUrl || `${config.publicBaseUrl}/app/billing?paid=1`,
        cancelUrl: config.stripe.cancelUrl || `${config.publicBaseUrl}/app/billing`,
      });

      // The URL, and nothing about the balance: it has not moved and will not
      // until Stripe says the money arrived.
      return { checkoutUrl: session.url, sessionId: session.id, intentId: intent.id };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/billing/koda/checkout',
    description: 'Open a mobile-money checkout for a recorded top-up request',
    schema: {
      type: 'object',
      required: ['intentId'],
      properties: { intentId: stringField },
      additionalProperties: false,
    },
    handler: async (platform, ctx) => {
      const actor = authoriseTenant(ctx, 'BILLING_ACU', 'U');
      const { intentId } = body<{ intentId: string }>(ctx);

      // Same rule as the card rail: the amount comes from the intent on record,
      // never from this request.
      const intent = platform.topUpIntents(actor.tenantId).find((i) => i.id === intentId);
      if (!intent) throw new NotFoundError(`No top-up request ${intentId}`);
      if (intent.status !== 'AWAITING_PAYMENT') {
        throw new DomainError('TOPUP_ALREADY_SETTLED', 'That top-up request has already been settled or cancelled', 409);
      }

      // The rate quoted here is the rate the customer is charged at and the
      // rate the credit is computed with when the money lands. Pinning it to
      // the intent is what stops an operator moving KODA_USD_PER_GBP mid-payment
      // and crediting somebody an amount they never agreed to.
      const quoted = platform.quoteMobileMoney(intent.id, actor.tenantId);

      const checkout = await koda.createCheckout({
        intentId: intent.id,
        tenantId: actor.tenantId,
        amountMinorUsd: quoted.amountMinor,
        successUrl: config.koda.successUrl || `${config.publicBaseUrl}/app/billing?paid=1`,
      });

      return {
        checkoutUrl: checkout.url,
        intentId: intent.id,
        // Said out loud, because the customer is about to be charged in a
        // currency that is not the one the top-up was quoted in.
        charged: { amountMinor: quoted.amountMinor, currency: quoted.currency },
        ratePerBillingUnit: quoted.ratePerBillingUnit,
      };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/webhooks/koda',
    public: true,
    // Raw bytes: the signature is an HMAC over exactly what was sent, and
    // re-serialising the JSON would change it.
    upload: true,
    maxBytes: 256 * 1024,
    description: 'KODA mobile-money webhook. Signature-verified; credits a wallet when a payment is verified',
    handler: (platform, ctx) => {
      // Public because KODA holds no credential of ours. The signature is the
      // credential, and it is checked before the body is read.
      const event = koda.verifyKodaWebhook(ctx.rawBody ?? Buffer.alloc(0), ctx.kodaSignature);
      const settlement = koda.kodaSettlement(event);

      if (!settlement) return { received: true, acted: false, type: event.type };

      const credited = platform.creditFromMobileMoney(settlement);
      return {
        received: true,
        acted: true,
        receiptId: credited.receipt.id,
        alreadyRecorded: credited.alreadyRecorded,
      };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/webhooks/stripe',
    public: true,
    // Raw bytes, because the signature is over exactly what was sent. Parsing
    // to JSON and re-serialising changes whitespace and key order, and the HMAC
    // would never match again.
    upload: true,
    // A Stripe event is a few kilobytes. The evidence ceiling is 50MB and is
    // sized for a drawing set; leaving it in place on a route anybody may post
    // to would let anybody make this process buffer 50MB per connection.
    maxBytes: 256 * 1024,
    description: 'Stripe payment webhook. Signature-verified; the only unauthenticated route that moves money',
    handler: (platform, ctx) => {
      // Public because Stripe holds no credential of ours, which makes the
      // signature the entire defence. Unverified, this is a URL that credits
      // wallets to anybody who finds it.
      const event = stripe.verifyWebhook(ctx.rawBody ?? Buffer.alloc(0), ctx.webhookSignature);
      const payment = stripe.settledPayment(event);

      // Acknowledged, not acted on. Stripe sends dozens of event types and
      // retries anything that is not a 2xx for days; answering 400 to an event
      // we were never going to process would have it retried until it expired.
      if (!payment) return { received: true, acted: false, type: event.type };

      const { receipt, alreadyRecorded } = platform.creditFromPayment({
        tenantId: payment.tenantId,
        amountMinor: payment.amountMinor,
        method: 'CARD',
        // The event id. Stripe delivers at least once by design, and
        // `creditFromPayment` spends a reference exactly once, so a redelivery
        // credits nothing further.
        reference: payment.reference,
        ...(payment.intentId ? { intentId: payment.intentId } : {}),
        recordedBy: 'stripe',
        // Stripe is holding the money and has signed for it. That is what makes
        // a second payment against a spent request a credit rather than a 409.
        source: 'PROVIDER',
        note: `Stripe ${event.type}`,
      });

      return { received: true, acted: true, receiptId: receipt.id, alreadyRecorded };
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
        // A person typing. A second credit against a request already settled is
        // refused here, because the likeliest explanation is the same payment
        // entered twice under a mistyped reference.
        source: 'OPERATOR',
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
        // How the card route is actually behaving, because a webhook secret can
        // be present and wrong — and then customers pay, every delivery is
        // refused, and nothing is credited. Rejections climbing while
        // `accepted` stays at zero is that, and nothing else.
        cardPayments: {
          configured: stripe.stripeConfigured(),
          webhook: stripe.webhookHealth(),
        },
        mobileMoney: {
          configured: koda.kodaConfigured(),
          webhook: koda.kodaWebhookHealth(),
          // The rate every mobile-money credit is computed at, so a wrong one
          // is visible here rather than only in the arithmetic of a receipt.
          usdPerGbp: config.koda.usdPerGbp,
        },
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

      // An AI route with no project in its path spends the platform's own
      // wallet rather than a tenancy's — today that is the blog draft, and the
      // exception is named in `quote.test.ts` rather than left implicit.
      //
      // Without this the quote refused, the console's submit button stayed
      // disabled waiting for a price that never arrived, and the action was
      // unreachable: the rule that nothing spends without showing its cost
      // first had made the one honest path impossible.
      if (!projectId) {
        const actor = auth(ctx);
        if (!actor.roles.includes('PLATFORM_ADMIN')) {
          throw new DomainError('QUOTE_SCOPE', 'AI actions are quoted against a project', 400);
        }
        const platformCtx = platform.context(actor, blog.BLOG_PROJECT_ID, { correlationId: ctx.correlationId });
        authorise(platformCtx, 'AI_EXECUTION', 'X');
        return platform.orchestrator.quote({
          capability: matched.route.ai.capability,
          engine: matched.route.ai.engine,
          taskType: matched.route.ai.taskType,
          wallet: platformCtx.wallet,
          projectId: blog.BLOG_PROJECT_ID,
        });
      }

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
    handler: async (platform, ctx) => {
      const engineCtx = projectContext(platform, ctx);
      authorise(engineCtx, 'EVIDENCE_AUDIT', 'R');

      const entries = await evidence.projectRegister(
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

  // --- Ingestion -------------------------------------------------------------
  //
  // Knowing what a held file actually is. The register above says a hash was
  // named as evidence and whether the bytes are here; this says the bytes are a
  // specification rather than a photograph, that its text is readable, and — the
  // reason it exists — that one of them is a Windows executable renamed to .pdf.
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/ingestion',
    readOnly: true,
    description: 'What has been read from the project’s files, what was quarantined, and what has never been looked at',
    handler: async (platform, ctx) => {
      const engineCtx = projectContext(platform, ctx);
      return {
        position: await ingestion.ingestionPosition(engineCtx, platform.evidence),
        files: ingestion.ingestedFiles(engineCtx),
      };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/ingestion',
    description: 'Inspect, classify and read a stored file, and quarantine it if it should not have been accepted',
    schema: {
      type: 'object',
      required: ['hash'],
      properties: {
        hash: stringField,
        // The name it was uploaded under, which the store does not keep: the
        // address is the hash. It is a signal to the classifier and it is what
        // the mismatch check compares against, so a `.pdf` holding a PE header
        // is visible as the lie it is.
        filename: { type: 'string', minLength: 1, maxLength: 255 },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      ingestion.ingestFile(
        projectContext(platform, ctx),
        platform.evidence,
        body<{ hash: string; filename?: string }>(ctx),
      ),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/ingestion/:ingestionId/similar',
    readOnly: true,
    description: 'Other files on the project whose text overlaps this one — lexical, so near-duplicates, not meaning',
    handler: (platform, ctx) => {
      const threshold = Number(ctx.query.get('threshold') ?? '');
      return {
        matches: ingestion.similarFiles(
          projectContext(platform, ctx),
          ctx.params.ingestionId as string,
          Number.isFinite(threshold) && threshold > 0 && threshold <= 1 ? threshold : undefined,
        ),
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
    handler: async (platform, ctx) => {
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
      return await evidence.retentionPosition(platform.ledger, platform.evidence, actor.tenantId);
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

  // --- The landing page's own pictures ---------------------------------------
  //
  // Not customer data and not in any tenancy: these are the five photographs on
  // the platform's own marketing page. They lived only in the checkout, so on a
  // deployed container filling a slot meant a rebuild — the pictures could not
  // be put there by the person whose pictures they are.
  //
  // Operator-only, in both directions. A customer has no business editing the
  // marketing site, and the operator has no business in customer delivery data
  // — the evidence upload above refuses a PLATFORM_ADMIN for exactly the
  // mirror-image reason.
  {
    method: 'GET',
    pattern: '/v1/site/media',
    readOnly: true,
    description: 'The landing page picture slots, what each is for, and which are filled',
    handler: (_platform, ctx) => {
      operatorOnly(ctx, 'see the landing page pictures');
      return { directory: siteMedia.mediaDir(), maxBytes: config.site.mediaMaxBytes, slots: siteMedia.mediaState() };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/site/media/:slot',
    upload: true,
    // The per-picture ceiling, applied at the socket as well as in the module,
    // so an oversized upload is refused before the process buffers it.
    maxBytes: config.site.mediaMaxBytes,
    description: 'Put a picture in one of the five landing page slots',
    handler: (_platform, ctx) => {
      operatorOnly(ctx, 'change the landing page pictures');
      // The slot id is matched against five literals inside `putSlotImage`, and
      // the stored extension comes from the file's own magic bytes. Neither the
      // path nor the type is ever the caller's, which is what stops a route
      // that writes into a served directory from being the obvious hole.
      return siteMedia.putSlotImage(ctx.params.slot as string, ctx.rawBody ?? Buffer.alloc(0));
    },
  },
  {
    method: 'DELETE',
    pattern: '/v1/site/media/:slot',
    // Closed and empty: the slot is in the path and there is nothing else to
    // say, so a stray body is refused rather than ignored.
    schema: { type: 'object', properties: {}, additionalProperties: false },
    description: 'Take the picture out of a landing page slot',
    handler: (_platform, ctx) => {
      operatorOnly(ctx, 'change the landing page pictures');
      return siteMedia.removeSlotImage(ctx.params.slot as string);
    },
  },

  // --- The blog -------------------------------------------------------------
  //
  // Operator-only in both directions, for the same reason the landing page
  // pictures are: this is the company's own marketing site, and a customer has
  // no business in it. A model may draft; only a person may publish.
  {
    method: 'GET',
    pattern: '/v1/site/posts',
    readOnly: true,
    description: 'Every blog post, its state, and what is stopping it being published',
    handler: (platform, ctx) => {
      operatorOnly(ctx, 'read the blog');
      // Views are passed in rather than imported inside the blog module: the
      // blog is about posts and the view log is about traffic, and a module
      // that reached for the other would make one untestable without the other.
      return { ...blog.blogPosition(platform, views.viewsFor), views: views.viewsPosition() };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/site/posts/audit',
    readOnly: true,
    description: 'Ask the reasoning engine to audit the blog and propose what to write next',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    ai: { engine: 'EXECUTIVE', taskType: 'site_blog_audit', capability: 'REASONING' },
    handler: async (platform, ctx) => {
      operatorOnly(ctx, 'audit the blog');
      // POST because it spends ACUs and reaches a provider, `readOnly` because
      // it creates nothing — the same shape the quote route already understands.
      const engine = platform.context(auth(ctx), blog.BLOG_PROJECT_ID, {
        correlationId: ctx.correlationId,
        source: sourceOf(ctx),
      });
      return blog.auditBlog(engine, platform, views.viewsFor);
    },
  },
  {
    method: 'POST',
    pattern: '/v1/site/posts/draft',
    ai: { engine: 'EXECUTIVE', taskType: 'site_blog_draft', capability: 'REASONING' },
    description: 'Ask the reasoning engine for a draft article. Writes a draft and publishes nothing',
    schema: {
      type: 'object',
      required: ['keyword', 'angle'],
      properties: { keyword: stringField, angle: stringField, tag: { type: 'string' } },
      additionalProperties: false,
    },
    handler: async (platform, ctx) => {
      operatorOnly(ctx, 'draft a blog post');
      const context = platform.context(auth(ctx), blog.BLOG_PROJECT_ID, { correlationId: ctx.correlationId });
      return blog.draftPost(context, platform, body(ctx));
    },
  },
  {
    method: 'POST',
    pattern: '/v1/site/posts',
    description: 'Write a post by hand. No model is involved and the record says so',
    schema: {
      type: 'object',
      required: ['title', 'standfirst', 'metaDescription', 'body', 'keyword'],
      properties: {
        title: stringField,
        standfirst: stringField,
        metaDescription: stringField,
        body: { type: 'array', minItems: 1, items: { type: 'string' } },
        keyword: stringField,
        tag: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      operatorOnly(ctx, 'write a blog post');
      const context = platform.context(auth(ctx), blog.BLOG_PROJECT_ID, { correlationId: ctx.correlationId });
      return blog.writePost(context, platform, body(ctx));
    },
  },
  {
    method: 'POST',
    pattern: '/v1/site/posts/:postId/revise',
    description: 'Edit a draft. A live post is withdrawn before it can be changed',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        standfirst: { type: 'string' },
        metaDescription: { type: 'string' },
        body: { type: 'array', items: { type: 'string' } },
        keyword: { type: 'string' },
        tag: { type: 'string' },
        slug: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      operatorOnly(ctx, 'edit a blog post');
      const context = platform.context(auth(ctx), blog.BLOG_PROJECT_ID, { correlationId: ctx.correlationId });
      return blog.revisePost(context, platform, ctx.params.postId as string, body(ctx));
    },
  },
  {
    method: 'POST',
    pattern: '/v1/site/posts/:postId/publish',
    description: 'Put a post on the public site. Refused while any SEO check fails',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (platform, ctx) => {
      operatorOnly(ctx, 'publish a blog post');
      const context = platform.context(auth(ctx), blog.BLOG_PROJECT_ID, { correlationId: ctx.correlationId });
      return blog.publishPost(context, platform, ctx.params.postId as string);
    },
  },
  {
    method: 'POST',
    pattern: '/v1/site/posts/:postId/withdraw',
    description: 'Take a post down. The record stays; the URL stops answering',
    schema: {
      type: 'object',
      required: ['reason'],
      properties: { reason: { type: 'string', minLength: 10 } },
      additionalProperties: false,
    },
    handler: (platform, ctx) => {
      operatorOnly(ctx, 'withdraw a blog post');
      const context = platform.context(auth(ctx), blog.BLOG_PROJECT_ID, { correlationId: ctx.correlationId });
      return { post: blog.withdrawPost(context, platform, ctx.params.postId as string, body<{ reason: string }>(ctx).reason) };
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
        // nothing else arrives: the fields below name where a confirmed
        // extraction is filed, and a stray property in this body would be a
        // caller trying to redirect it.
        corrections: { type: 'object' },
        packageId: stringField,
        costCodePrefix: stringField,
        observedBy: stringField,
        actionByDate: stringField,
        category: stringField,
        // The four fields a photograph cannot show. A progress claim is against
        // one activity for one period, and neither is in the image.
        taskId: stringField,
        periodFrom: stringField,
        periodTo: stringField,
        costCode: stringField,
        itemIndex: { type: 'integer', minimum: 0 },
        rework: { type: 'boolean' },
        observationType: { type: 'string', enum: ['UNSAFE_ACT', 'UNSAFE_CONDITION', 'NEAR_MISS', 'GOOD_PRACTICE'] },
        workPackageId: stringField,
        inspectionId: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      perception.confirm(projectContext(platform, ctx), {
        draftId: ctx.params.draftId as string,
        ...body<Omit<perception.ConfirmInput, 'draftId'>>(ctx),
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
  // =========================================================== Concept, stage 6
  //
  // C-WF-01 to C-WF-08. One console door per command, following the rule that
  // holds everywhere else here: a write the platform can perform and the UI
  // cannot reach is a capability that does not exist.

  // ------------------------------------------------- C-WF-01 initiation
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/concept/initiation',
    description: 'The configuration in force, its version history, the authority matrix and what blocks baseline work',
    handler: (platform, ctx) => conceptinitiation.initiationPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/configuration',
    description: 'Version the project configuration. Reconfiguring after approved work requires an impact assessment',
    schema: {
      type: 'object',
      required: [
        'projectCode', 'jurisdiction', 'jurisdictionPack', 'classificationPack', 'contractCalendarPack',
        'calendar', 'reportingCurrency', 'measurementSystem', 'sponsorId', 'projectDirectorId',
        'dataResidency', 'retentionYears', 'defaultSensitivity', 'reason',
      ],
      properties: {
        projectCode: stringField,
        jurisdiction: stringField,
        jurisdictionPack: stringField,
        classificationPack: stringField,
        contractCalendarPack: stringField,
        calendar: {
          type: 'object',
          required: ['timeZone', 'workingDays', 'holidays'],
          properties: {
            timeZone: stringField,
            workingDays: { type: 'array', items: { type: 'number' } },
            holidays: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        reportingCurrency: stringField,
        measurementSystem: { type: 'string', enum: ['METRIC', 'IMPERIAL'] },
        sponsorId: stringField,
        projectDirectorId: stringField,
        dataResidency: stringField,
        retentionYears: { type: 'number' },
        defaultSensitivity: stringField,
        reason: { type: 'string' },
        impactAssessment: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => conceptinitiation.versionConfiguration(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/authority-matrix',
    description: 'Approve the delegated authority matrix. Bound to the configuration version it was approved under',
    schema: {
      type: 'object',
      required: ['delegations'],
      properties: {
        delegations: {
          type: 'array',
          items: {
            type: 'object',
            required: ['decision', 'holderId'],
            properties: {
              decision: stringField,
              holderId: stringField,
              limitMinor: { type: 'number' },
              escalatesToId: stringField,
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => conceptinitiation.approveAuthorityMatrix(projectContext(platform, ctx), body(ctx)),
  },

  // ------------------------------------------------- C-WF-02 brief
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/concept/brief',
    description: 'The requirements position: counts by status and category, the baseline, drift and open conflicts',
    handler: (platform, ctx) => conceptbrief.briefPosition(projectContext(platform, ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/concept/requirements',
    description: 'Every requirement, superseded ones included',
    handler: (platform, ctx) => ({ requirements: conceptbrief.requirementRegister(projectContext(platform, ctx)) }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/requirements',
    description: 'Record a requirement. An extracted one below the confidence threshold lands as NEEDS_REVIEW',
    schema: {
      type: 'object',
      required: [
        'reference', 'category', 'statement', 'source', 'sourceAnchor', 'ownerId',
        'priority', 'verification', 'acceptanceCriteria', 'origin',
      ],
      properties: {
        reference: stringField,
        category: { type: 'string', enum: [...conceptbrief.REQUIREMENT_CATEGORY] },
        statement: { type: 'string' },
        source: stringField,
        sourceAnchor: stringField,
        ownerId: stringField,
        priority: { type: 'string', enum: [...conceptbrief.REQUIREMENT_PRIORITY] },
        verification: {
          type: 'object',
          required: ['method', 'stage'],
          properties: {
            method: { type: 'string' },
            stage: { type: 'string', enum: [...conceptbrief.VERIFICATION_STAGE] },
          },
          additionalProperties: false,
        },
        acceptanceCriteria: { type: 'string' },
        origin: { type: 'string', enum: ['AI', 'HUMAN'] },
        confidence: { type: 'number' },
        conflictsWith: { type: 'array', items: { type: 'string' } },
        confidenceThreshold: { type: 'number' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => conceptbrief.extractRequirement(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/requirements/:requirementId/accept',
    description: 'A person accepts an extracted requirement into the brief. Until then it stays visibly unadopted',
    schema: { type: 'object', properties: { note: { type: 'string' } }, additionalProperties: false },
    handler: (platform, ctx) =>
      conceptbrief.acceptRequirement(projectContext(platform, ctx), {
        requirementId: ctx.params.requirementId as string,
        ...body<{ note?: string }>(ctx),
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/requirements/:requirementId/supersede',
    description: 'Supersede a requirement with a reason. Deletion after baseline is prohibited',
    schema: {
      type: 'object',
      required: ['reason'],
      properties: { reason: { type: 'string' }, replacedByRequirementId: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      conceptbrief.supersedeRequirement(projectContext(platform, ctx), {
        requirementId: ctx.params.requirementId as string,
        ...body<{ reason: string; replacedByRequirementId?: string }>(ctx),
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/brief/baseline',
    description: 'Freeze the brief, recording the hash of every accepted requirement at the moment of freezing',
    schema: {
      type: 'object',
      required: ['evidenceHash'],
      properties: { evidenceHash: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) => conceptbrief.baselineBrief(projectContext(platform, ctx), body(ctx)),
  },

  // ------------------------------------------------- C-WF-03 due diligence
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/concept/due-diligence',
    description: 'Survey coverage, the constraint register, open investigations and the readiness score',
    handler: (platform, ctx) => conceptduediligence.dueDiligencePosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/surveys',
    description: 'Register a survey with its coordinate system and its limitations. Both are mandatory',
    schema: {
      type: 'object',
      required: ['reference', 'discipline', 'author', 'surveyedOn', 'coverage', 'coordinateSystem', 'limitations', 'evidenceHash'],
      properties: {
        reference: stringField,
        discipline: stringField,
        author: stringField,
        surveyedOn: stringField,
        coverage: { type: 'array', items: { type: 'string', enum: [...conceptduediligence.IMPACT_CATEGORY] } },
        coordinateSystem: stringField,
        limitations: { type: 'string' },
        relianceStatus: { type: 'string', enum: [...conceptduediligence.RELIANCE_STATUS] },
        validUntil: stringField,
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => conceptduediligence.registerSurvey(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/surveys/:surveyId/supersede',
    description: 'Supersede a survey with a later one. It stays readable as historic evidence and stops counting toward coverage',
    schema: {
      type: 'object',
      required: ['replacedBySurveyId', 'reason'],
      properties: { replacedBySurveyId: stringField, reason: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      conceptduediligence.supersedeSurvey(projectContext(platform, ctx), {
        surveyId: ctx.params.surveyId as string,
        ...body<{ replacedBySurveyId: string; reason: string }>(ctx),
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/constraints',
    description: 'Identify a site constraint against the survey that evidences it',
    schema: {
      type: 'object',
      required: ['reference', 'description', 'constraintClass', 'severity', 'impacts', 'spatialScope', 'surveyId', 'ownerId'],
      properties: {
        reference: stringField,
        description: { type: 'string' },
        constraintClass: { type: 'string', enum: [...conceptduediligence.CONSTRAINT_CLASS] },
        severity: { type: 'string', enum: [...conceptduediligence.CONSTRAINT_SEVERITY] },
        impacts: { type: 'array', items: { type: 'string', enum: [...conceptduediligence.IMPACT_CATEGORY] } },
        spatialScope: { type: 'string' },
        geometryRef: stringField,
        surveyId: stringField,
        ownerId: stringField,
        allowanceMinor: { type: 'number' },
        origin: { type: 'string', enum: ['AI', 'HUMAN'] },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => conceptduediligence.identifyConstraint(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/constraints/:constraintId/assess',
    description: 'Assess a constraint. An assumption leaves here with an allowance or a named acceptance',
    schema: {
      type: 'object',
      required: ['assessment'],
      properties: {
        assessment: { type: 'string' },
        allowanceMinor: { type: 'number' },
        acceptedUnknownBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      conceptduediligence.assessConstraint(projectContext(platform, ctx), {
        constraintId: ctx.params.constraintId as string,
        ...body<{ assessment: string; allowanceMinor?: number; acceptedUnknownBy?: string }>(ctx),
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/investigations',
    description: 'Assign further investigation against a constraint or a coverage gap',
    schema: {
      type: 'object',
      required: ['reference', 'description', 'ownerId', 'dueDate'],
      properties: {
        reference: stringField,
        description: { type: 'string' },
        constraintId: stringField,
        coverageGap: { type: 'string', enum: [...conceptduediligence.IMPACT_CATEGORY] },
        ownerId: stringField,
        dueDate: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => conceptduediligence.assignInvestigation(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/investigations/:actionId/close',
    description: 'Close an investigation with what it found. A closure with no finding records only that somebody stopped looking',
    schema: {
      type: 'object',
      required: ['finding', 'evidenceHash'],
      properties: { finding: { type: 'string' }, evidenceHash: stringField },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      conceptduediligence.closeInvestigation(projectContext(platform, ctx), {
        actionId: ctx.params.actionId as string,
        ...body<{ finding: string; evidenceHash: string }>(ctx),
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/due-diligence/review',
    description: 'Record a due-diligence review. The readiness figure is stored as it stood, not recomputed later',
    schema: {
      type: 'object',
      required: ['note'],
      properties: { note: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) => conceptduediligence.reviewDueDiligence(projectContext(platform, ctx), body(ctx)),
  },

  // ------------------------------------------------- C-WF-04 options
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/concept/options',
    description: 'The options, the comparison, the selected one and every rejection with its reason',
    handler: (platform, ctx) => conceptoptions.optionPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/options',
    description: 'Create a feasibility option with its scope, assumptions, price base and ranges',
    schema: {
      type: 'object',
      required: [
        'reference', 'name', 'description', 'scopeStatement', 'assumptions', 'exclusions',
        'baseDate', 'currency', 'orderOfCostMinor', 'costLowMinor', 'costHighMinor',
        'durationDaysLow', 'durationDaysMostLikely', 'durationDaysHigh',
      ],
      properties: {
        reference: stringField,
        name: stringField,
        description: { type: 'string' },
        scopeStatement: { type: 'string' },
        assumptions: { type: 'array', items: { type: 'string' } },
        exclusions: { type: 'array', items: { type: 'string' } },
        dependencies: { type: 'array', items: { type: 'string' } },
        baseDate: stringField,
        currency: stringField,
        orderOfCostMinor: { type: 'number' },
        costLowMinor: { type: 'number' },
        costHighMinor: { type: 'number' },
        durationDaysLow: { type: 'number' },
        durationDaysMostLikely: { type: 'number' },
        durationDaysHigh: { type: 'number' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => conceptoptions.createOption(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/options/:optionId/analyse',
    description: 'Score an option. Raw values are preserved separately from the weighted total',
    schema: {
      type: 'object',
      required: ['scores'],
      properties: {
        scores: {
          type: 'array',
          items: {
            type: 'object',
            required: ['criterion', 'rawValue', 'weight', 'basis'],
            properties: {
              criterion: stringField,
              rawValue: { type: 'number' },
              weight: { type: 'number' },
              basis: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      conceptoptions.analyseOption(projectContext(platform, ctx), {
        optionId: ctx.params.optionId as string,
        ...body<{ scores: [] }>(ctx),
      }),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/concept/options/sensitivity',
    description: 'Vary one criterion and report whether the leading option changes',
    handler: (platform, ctx) =>
      conceptoptions.sensitivity(projectContext(platform, ctx), {
        criterion: ctx.query.get('criterion') ?? '',
        changePercent: Number(ctx.query.get('changePercent') ?? '10'),
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/options/:optionId/select',
    description: 'Select the option, freezing the brief baseline hash it was chosen against',
    schema: {
      type: 'object',
      required: ['rationale', 'evidenceHash'],
      properties: {
        rationale: { type: 'string' },
        decisionRecordId: stringField,
        evidenceHash: stringField,
        exception: {
          type: 'object',
          required: ['approvedBy', 'reason'],
          properties: { approvedBy: stringField, reason: { type: 'string' } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      conceptoptions.selectOption(projectContext(platform, ctx), {
        optionId: ctx.params.optionId as string,
        ...body<{ rationale: string; evidenceHash: string }>(ctx),
      }),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/options/:optionId/reject',
    description: 'Reject an option with its reason. A rejection with no reason is the option somebody proposes again next year',
    schema: {
      type: 'object',
      required: ['rationale'],
      properties: { rationale: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      conceptoptions.rejectOption(projectContext(platform, ctx), {
        optionId: ctx.params.optionId as string,
        ...body<{ rationale: string }>(ctx),
      }),
  },

  // ------------------------------------------------- C-WF-05 controls
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/concept/controls',
    description: 'The cost plan and its totals, the milestone programme, the cashflow and the approved position',
    handler: (platform, ctx) => conceptcontrols.conceptControlsPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/cost-plan',
    description: 'Open a concept cost plan against the selected option, in the project reporting currency',
    schema: {
      type: 'object',
      required: ['baseDate'],
      properties: {
        baseDate: stringField,
        rangeMethod: { type: 'string', enum: [...conceptcontrols.RANGE_METHOD] },
        budgetCapMinor: { type: 'number' },
        tolerancePercent: { type: 'number' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => conceptcontrols.createCostPlan(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/cost-plan/lines',
    description: 'Add a cost line. A rate with no source and base date is provisional and excluded from the high-confidence total',
    schema: {
      type: 'object',
      required: ['wbsCode', 'category', 'description', 'quantity', 'unit', 'rateMinor'],
      properties: {
        wbsCode: stringField,
        category: { type: 'string', enum: [...conceptcontrols.COST_CATEGORY] },
        description: { type: 'string' },
        quantity: { type: 'number' },
        unit: stringField,
        rateMinor: { type: 'number' },
        rateSource: { type: 'string' },
        rateBaseDate: { type: 'string' },
        locationFactor: { type: 'number' },
        lowMinor: { type: 'number' },
        highMinor: { type: 'number' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => conceptcontrols.addCostLine(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/programme',
    description: 'Create the milestone programme. An undeclared open start or finish is refused',
    schema: {
      type: 'object',
      required: ['dataDate', 'milestones'],
      properties: {
        dataDate: stringField,
        milestones: {
          type: 'array',
          items: {
            type: 'object',
            required: ['reference', 'name', 'plannedDate'],
            properties: {
              reference: stringField,
              name: stringField,
              plannedDate: stringField,
              predecessors: { type: 'array', items: { type: 'string' } },
              openStartReason: { type: 'string' },
              openFinishReason: { type: 'string' },
              statutory: { type: 'boolean' },
              leadTimeDays: { type: 'number' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => conceptcontrols.createMilestoneProgramme(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/cashflow',
    description: 'Time-phase the cost plan. A cashflow that does not reconcile to its own cost plan is refused',
    schema: {
      type: 'object',
      required: ['periods'],
      properties: {
        periods: {
          type: 'array',
          items: {
            type: 'object',
            required: ['period', 'spendMinor'],
            properties: {
              period: stringField,
              spendMinor: { type: 'number' },
              fundingMinor: { type: 'number' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => conceptcontrols.generateCashflow(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/controls/approve',
    description: 'Approve cost, programme and cashflow together under one declared cut-off',
    schema: {
      type: 'object',
      required: ['cutOffDate', 'evidenceHash'],
      properties: {
        cutOffDate: stringField,
        affordabilityActions: { type: 'array', items: { type: 'string' } },
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => conceptcontrols.approveConceptControls(projectContext(platform, ctx), body(ctx)),
  },

  // ------------------------------------------------- C-WF-06 strategy
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/concept/strategy',
    description: 'The procurement route, the packages, the contract family, long-lead items and any scope gap or overlap',
    handler: (platform, ctx) => conceptstrategy.strategyPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/procurement-strategy',
    description: 'Choose the procurement route against weighted criteria. A single-source route needs an authorised justification',
    schema: {
      type: 'object',
      required: ['weights', 'assessments', 'selectedRoute', 'rationale', 'designResponsibility', 'riskAppetite'],
      properties: {
        weights: { type: 'object' },
        assessments: {
          type: 'array',
          items: {
            type: 'object',
            required: ['route', 'scores', 'note'],
            properties: {
              route: { type: 'string', enum: [...conceptstrategy.PROCUREMENT_ROUTE] },
              scores: { type: 'object' },
              note: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        selectedRoute: { type: 'string', enum: [...conceptstrategy.PROCUREMENT_ROUTE] },
        rationale: { type: 'string' },
        designResponsibility: { type: 'string' },
        riskAppetite: { type: 'string' },
        socialValueObligations: { type: 'array', items: { type: 'string' } },
        singleSourceJustification: { type: 'string' },
        singleSourceApprovedBy: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => conceptstrategy.createProcurementStrategy(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/package-strategy',
    description: 'Approve the packages. A scope element in two packages or in none refuses the approval',
    schema: {
      type: 'object',
      required: ['worksScopeElements', 'packages'],
      properties: {
        worksScopeElements: { type: 'array', items: { type: 'string' } },
        packages: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'reference', 'name', 'scopeElements', 'interfaces', 'ownerId',
              'requiredOnSiteMilestoneRef', 'enquiryDate', 'awardDate', 'leadTimeWeeks',
            ],
            properties: {
              reference: stringField,
              name: stringField,
              scopeElements: { type: 'array', items: { type: 'string' } },
              interfaces: { type: 'array', items: { type: 'string' } },
              ownerId: stringField,
              requiredOnSiteMilestoneRef: stringField,
              enquiryDate: stringField,
              awardDate: stringField,
              leadTimeWeeks: { type: 'number' },
              retainedRisks: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => conceptstrategy.approvePackageStrategy(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/contract-strategy',
    description: 'Select the contract-form family. Provisional until the executed contract is ingested and validated',
    schema: {
      type: 'object',
      required: ['contractFamily', 'contractOption', 'paymentTerms', 'insuranceRequirements', 'bondsAndGuarantees', 'provisionalNotices'],
      properties: {
        contractFamily: stringField,
        contractOption: stringField,
        paymentTerms: { type: 'string' },
        insuranceRequirements: { type: 'array', items: { type: 'string' } },
        bondsAndGuarantees: { type: 'array', items: { type: 'string' } },
        provisionalNotices: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => conceptstrategy.selectContractStrategy(projectContext(platform, ctx), body(ctx)),
  },

  // ------------------------------------------------- C-WF-07 risk and compliance
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/concept/compliance',
    description: 'The statutory screening, the risk exposure and the allowance reconciliation against the cost plan',
    handler: (platform, ctx) => conceptcompliance.compliancePosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/compliance-screen',
    description: 'Confirm which statutory regimes apply. Requires a named competent person and their basis',
    schema: {
      type: 'object',
      required: ['regimes', 'confirmedByName', 'confirmedByRole', 'competenceBasis', 'evidenceHash'],
      properties: {
        regimes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['regime', 'applicable', 'basis'],
            properties: {
              regime: { type: 'string', enum: [...conceptcompliance.COMPLIANCE_REGIME] },
              applicable: { type: 'boolean' },
              basis: { type: 'string' },
              milestoneRef: stringField,
            },
            additionalProperties: false,
          },
        },
        confirmedByName: stringField,
        confirmedByRole: stringField,
        competenceBasis: { type: 'string' },
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      conceptcompliance.confirmComplianceApplicability(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/risk-review',
    description: 'Approve the concept risk review, reconciling the declared allowance against the cost plan',
    schema: {
      type: 'object',
      required: ['declaredAllowanceMinor', 'retainedExposureNote', 'evidenceHash'],
      properties: {
        declaredAllowanceMinor: { type: 'number' },
        retainedExposureNote: { type: 'string' },
        escalated: { type: 'array', items: { type: 'string' } },
        reconciliationToleranceMinor: { type: 'number' },
        evidenceHash: stringField,
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) => conceptcompliance.approveRiskReview(projectContext(platform, ctx), body(ctx)),
  },

  // ------------------------------------------------- C-WF-08 the gate
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/concept/gate',
    description: 'The 6.4 Definition of Done, evaluated from the ledger. A clause the platform cannot assess is reported unassessable, never passed',
    handler: (platform, ctx) => stagegate.evaluateConceptGate(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/concept/baseline',
    description: 'Freeze the concept baseline: every component with its version and the hash of its state',
    schema: {
      type: 'object',
      required: ['evidenceHash'],
      properties: { evidenceHash: stringField, note: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (platform, ctx) => stagegate.approveConceptBaseline(projectContext(platform, ctx), body(ctx)),
  },
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/concept/baseline/drift',
    description: 'Components that have moved since the concept baseline froze them',
    handler: (platform, ctx) => ({ drift: stagegate.conceptBaselineDrift(projectContext(platform, ctx)) }),
  },
  // --------------------------------------------- AI output disposition
  //
  // The third of the three things every stage gate's fifth clause asked for.
  // The other two are written onto the AI event itself; this one is a later act
  // by a person, so it is its own record.
  {
    method: 'GET',
    pattern: '/v1/projects/:projectId/ai/dispositions',
    description: 'How much of this project’s AI output a person has stood behind, and which executions nobody has decided about',
    handler: (platform, ctx) => aidisposition.aiDispositionPosition(projectContext(platform, ctx)),
  },
  {
    method: 'POST',
    pattern: '/v1/projects/:projectId/ai/executions/:executionId/dispose',
    description: 'Accept, accept with change, or reject an AI output. A model cannot dispose of its own work',
    schema: {
      type: 'object',
      required: ['decision'],
      properties: {
        decision: { type: 'string', enum: [...aidisposition.AI_DISPOSITION] },
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (platform, ctx) =>
      aidisposition.disposeAIOutput(projectContext(platform, ctx), {
        executionId: ctx.params.executionId as string,
        ...body<{ decision: aidisposition.AIDisposition; reason?: string }>(ctx),
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
