import type { LifecyclePhase } from '../lifecycle/phases.ts';

/**
 * The field modules, and the controls that never belong on a handset.
 *
 * Four stages run work in the field — tender, construction, commissioning and
 * handover — and the specification gives each the same shape: a module
 * workspace under `/work/{module}`, a set of home indicators a person checks
 * before they walk out, and a list of controls that are **web-only**. This is
 * the one place all four are declared, because four copies of "which controls
 * are web-only" would be four answers within a year, and the answer is a
 * security boundary.
 *
 * ## What web-only can and cannot mean here
 *
 * This is the part worth reading before trusting the control.
 *
 * The obvious implementation — read the `?client=` parameter the app already
 * sends — is worthless. `sourceOf` says so in its own comment: the client
 * asserts it, and the value is a provenance note rather than a permission. A
 * handset that wanted to reach an adjudication screen would simply not send it.
 *
 * The one surface signal the platform can actually stand behind is the
 * **enrolled device**. A device's platform is fixed at enrolment inside an
 * authenticated, MFA-satisfied session; every request from that session proves
 * possession of the device secret; and an administrator can see and revoke it.
 * So the rule is: a web-only control is refused where the request is bound to a
 * device enrolled as `MOBILE` or `TABLET`.
 *
 * **The honest limit.** Where a session is not bound to a device at all, the
 * platform does not know what it is talking to and this gate cannot see it.
 * That is a property of `config.auth.requireDeviceBinding`, which is off by
 * default: with it on, every session is bound and the gate covers the estate;
 * with it off, the gate catches enrolled field devices and nothing else. It is
 * recorded that way in `docs/STATE.md` rather than described as a control that
 * covers more than it does.
 *
 * That is still worth having. The field application enrols as a device — it is
 * the surface this exists for — so in practice the handset is bound, and a
 * caller who strips the binding to get past this loses the session entirely on
 * any deployment where binding is required.
 */

export const FIELD_MODULE = ['TENDER', 'CONSTRUCTION', 'COMMISSIONING', 'HANDOVER'] as const;
export type FieldModuleId = (typeof FIELD_MODULE)[number];

/** The six tabs every module workspace carries, in the order the specification gives them. */
export const MODULE_TAB = ['ACTION_QUEUE', 'CAPTURE', 'PLANS_CRITERIA', 'RECORDS', 'EVIDENCE', 'HISTORY'] as const;
export type ModuleTab = (typeof MODULE_TAB)[number];

/**
 * A home indicator: a label, and the records it is counted from.
 *
 * **No indicator invents a status vocabulary.** The tempting shape here is
 * `where: (state) => state.status === 'OPEN'`, and it is wrong: the statuses
 * differ per entity, they are not all named `status`, and a predicate that
 * guesses one produces a confident wrong number on a screen somebody makes a
 * site decision from. So an indicator counts records of declared types and,
 * where the specification asks for a split, names the *field* to split on —
 * the groups themselves come from whatever values the data actually holds.
 *
 * `pending` is for a figure nothing in the platform yet produces. It is
 * published as unmeasured with the workflow that will produce it named, rather
 * than shown as a zero. A zero and "not measured" look the same on a handset
 * and mean opposite things.
 */
export type ModuleIndicator = {
  label: string;
  /** Entity types the figure is counted over. Empty where `pending` is set. */
  entities: string[];
  /** A field to break the count down by. Groups are discovered from the records. */
  breakdownBy?: string;
  /** Where nothing yet produces this figure, the workflow that will. */
  pending?: string;
};

export type FieldModule = {
  id: FieldModuleId;
  /** The path segment: `/projects/{projectId}/work/{slug}`. */
  slug: string;
  label: string;
  /** What the stage is for, in the specification's own words. */
  outcome: string;
  /** The lifecycle phases the module is open in. Outside them it is not offered. */
  phases: LifecyclePhase[];
  /**
   * What a person checks before walking out, named exactly as the specification
   * names them. Each is computed by the workspace read from the records it
   * declares rather than counted here.
   */
  indicators: ModuleIndicator[];
  /** The records this module's work produces. The Records tab, and the History filter. */
  records: string[];
  /** The approved criteria the module works to. The Plans & Criteria tab. */
  plans: string[];
  /** Records that can sit in somebody's queue. A subset of `records`. */
  queue: string[];
  /**
   * Controls that never belong on a handset, in the specification's words.
   *
   * These are the sentences a refusal quotes. The routes they cover are
   * declared on the routes themselves — a list of path patterns kept here would
   * be a second place to update when a route moves, and the one that gets
   * forgotten.
   */
  webOnly: string[];
};

export const FIELD_MODULES: Record<FieldModuleId, FieldModule> = {
  TENDER: {
    id: 'TENDER',
    slug: 'tender',
    label: 'Tender field',
    outcome:
      'Run controlled bidder and site visits and capture comparable site evidence, logistics constraints and ' +
      'clarifications without exposing confidential pricing or adjudication.',
    phases: ['TENDER'],
    indicators: [
      { label: 'Visits today', entities: ['SiteVisit'], breakdownBy: 'visitedOn' },
      { label: 'Bidders expected', entities: ['TenderResponse'], breakdownBy: 'status' },
      { label: 'Inductions outstanding', entities: ['Induction'], breakdownBy: 'status' },
      { label: 'Questions raised', entities: ['Clarification'], breakdownBy: 'status' },
      { label: 'Clarifications due', entities: ['Clarification'], breakdownBy: 'status' },
      { label: 'Site evidence gaps', entities: ['SiteFinding'], breakdownBy: 'status' },
      {
        label: 'Pack acknowledgements',
        entities: [],
        pending: 'T-MOB-WF-02, the common evidence pack a bidder acknowledges on the visit',
      },
    ],
    records: ['SiteVisit', 'SiteFinding', 'Clarification', 'Induction', 'SiteObservation'],
    plans: ['TenderInvitation', 'TenderPackage', 'SiteLogisticsPlan', 'RAMS'],
    queue: ['SiteFinding', 'Clarification'],
    webOnly: [
      'BoQ and estimate authoring',
      'Supplier pricing',
      'Commercial comparison',
      'Adjudication and ranking',
      'Bid submission and award',
      'Contract execution',
    ],
  },

  CONSTRUCTION: {
    id: 'CONSTRUCTION',
    slug: 'construction',
    label: 'Construction field',
    outcome:
      'Control safe, quality-assured and commercially traceable work from mobilisation to physical completion using ' +
      'field evidence as the live source of truth.',
    phases: ['CONSTRUCTION'],
    indicators: [
      { label: 'Workfaces ready or blocked', entities: ['WorkPackage'], breakdownBy: 'status' },
      { label: 'Crew, plant and material', entities: ['PlantItem', 'Delivery'], breakdownBy: 'status' },
      { label: 'Inspections and permits due', entities: ['InspectionRequest', 'Permit'], breakdownBy: 'status' },
      { label: 'Verified progress', entities: ['ProgressMeasurement', 'AcceptedProgress'] },
      { label: 'Safety and quality alerts', entities: ['SafetyObservation', 'NCR', 'Incident'], breakdownBy: 'status' },
      { label: 'Change candidates', entities: ['ChangeRequest', 'UnconfirmedDirection'], breakdownBy: 'status' },
      { label: 'Shift completeness', entities: ['SiteDiary'], breakdownBy: 'status' },
      { label: 'Turnover readiness', entities: ['SystemTurnover'], breakdownBy: 'status' },
    ],
    records: [
      'SiteDiary',
      'ProgressMeasurement',
      'InspectionRequest',
      'Permit',
      'NCR',
      'SafetyObservation',
      'Incident',
      'ChangeRequest',
      'UnconfirmedDirection',
      'Delivery',
      'SiteObservation',
    ],
    plans: ['WorkPackage', 'RAMS', 'InspectionPlan', 'LookaheadPlan', 'Drawing', 'Specification'],
    queue: ['InspectionRequest', 'Permit', 'NCR', 'ChangeRequest', 'UnconfirmedDirection', 'SafetyObservation'],
    webOnly: [
      'Baseline edit and approval',
      'Formal valuation and payment certification',
      'Contract instruction and notice approval outside delegation',
      'CVR approval',
      'Enterprise procurement and accounting',
    ],
  },

  COMMISSIONING: {
    id: 'COMMISSIONING',
    slug: 'commissioning',
    label: 'Commissioning field',
    outcome:
      'Execute controlled, witnessed testing with immutable raw readings and prove each system is complete, safe, ' +
      'integrated and ready for operational transfer.',
    phases: ['COMMISSIONING'],
    indicators: [
      { label: 'Systems ready or not ready', entities: ['SystemNode', 'PreFunctionalCheck'], breakdownBy: 'status' },
      { label: 'Tests today', entities: ['CommissioningTest', 'FunctionalTest'], breakdownBy: 'status' },
      { label: 'Witnesses due', entities: ['FunctionalTest'], breakdownBy: 'status' },
      { label: 'Calibration expiry', entities: ['Instrument'], breakdownBy: 'status' },
      { label: 'Pass, conditional or fail', entities: ['SystemAcceptance'], breakdownBy: 'status' },
      { label: 'Open exceptions and retests', entities: ['CommissioningException'], breakdownBy: 'status' },
      { label: 'Turnover readiness', entities: ['SystemTurnover', 'TurnoverException'], breakdownBy: 'status' },
      // The one indicator that is not a count of records: it is what this
      // device has not yet been given, and the workspace header computes it
      // from the sync cursor rather than from any entity.
      { label: 'Unsynced readings', entities: [], pending: 'the header carries it as “records waiting”, per device' },
    ],
    records: [
      'CommissioningTest',
      'FunctionalTest',
      'PreFunctionalCheck',
      'CommissioningException',
      'SystemAcceptance',
      'SystemTurnover',
      'TurnoverException',
      'Instrument',
    ],
    plans: ['CommissioningPlan', 'TestPack', 'TestPackRequirement', 'SystemNode', 'Specification'],
    queue: ['CommissioningException', 'FunctionalTest', 'TurnoverException'],
    webOnly: [
      'Commissioning baseline approval',
      'System acceptance outside mobile delegation',
      'Final O&M publication',
      'Commercial settlement',
      'Regulatory submission approval',
    ],
  },

  HANDOVER: {
    id: 'HANDOVER',
    slug: 'handover',
    label: 'Handover field',
    outcome:
      'Transfer a safe, usable, legally compliant and information-complete asset to the operator with physical, ' +
      'digital and accountability evidence aligned.',
    phases: ['HANDOVER'],
    indicators: [
      { label: 'Requirements accepted or pending', entities: ['HandoverRequirement'], breakdownBy: 'status' },
      { label: 'Snags by severity', entities: ['Snag'], breakdownBy: 'severity' },
      { label: 'Assets scanned and validated', entities: ['AssetRegisterItem', 'AssetValidation'], breakdownBy: 'status' },
      { label: 'O&M gaps', entities: ['OMManual', 'OMManualStructure'], breakdownBy: 'status' },
      { label: 'Training and competence', entities: ['TrainingSession', 'CompetenceAssessment'], breakdownBy: 'status' },
      { label: 'Keys and spares transfers', entities: ['TransferItem'], breakdownBy: 'status' },
      { label: 'Acceptance walkdowns', entities: ['CompletionInspection'], breakdownBy: 'status' },
      { label: 'Residual and aftercare obligations', entities: ['ResidualTransfer', 'AftercarePlan'], breakdownBy: 'status' },
    ],
    records: [
      'HandoverRequirement',
      'Snag',
      'AssetValidation',
      'CompletionInspection',
      'TransferItem',
      'TrainingSession',
      'CompetenceAssessment',
      'ResidualTransfer',
    ],
    plans: ['HandoverBaseline', 'HandoverManifest', 'AssetRegisterItem', 'OMManualStructure', 'AsBuiltSet'],
    queue: ['HandoverRequirement', 'Snag', 'CompletionInspection', 'ResidualTransfer'],
    webOnly: [
      'Final account agreement',
      'Formal regulatory application approval',
      'Controlled as-built and O&M publication',
      'Enterprise EAM configuration',
      'Legal waiver of deliverables',
    ],
  },
};

export function isFieldModuleId(value: string): value is FieldModuleId {
  return (FIELD_MODULE as readonly string[]).includes(value);
}

/** The module a path slug names, or undefined. */
export function moduleBySlug(slug: string): FieldModule | undefined {
  return Object.values(FIELD_MODULES).find((entry) => entry.slug === slug);
}

/** Device classes that are a field surface. A desktop or a browser is not one. */
const FIELD_PLATFORMS = new Set(['MOBILE', 'TABLET']);

/**
 * Whether this request is demonstrably on a field surface.
 *
 * `undefined` device means the platform does not know — an unbound session, or
 * a deployment that does not require binding. That is not treated as a field
 * surface, and the reasoning is in the module comment above: refusing what
 * cannot be identified would break every ordinary console session, and
 * *pretending* an unidentified session is a desktop is the honest default
 * because the gate's own limit is recorded rather than hidden.
 */
export function onFieldSurface(device: { platform?: string } | undefined): boolean {
  return device?.platform !== undefined && FIELD_PLATFORMS.has(device.platform);
}

/**
 * The refusal a web-only control gives a field device.
 *
 * It names the control and where to do it, because a person holding a handset
 * on a scaffold needs to know that the answer is "at a desk", not "you are not
 * allowed". Refusing a control somebody genuinely holds, with no explanation of
 * why the surface matters, is how a field application gets worked around.
 */
export function webOnlyRefusal(control: string): string {
  return (
    `${control} is not done from a field device. It is a control that decides money, a baseline or an award, and ` +
    'those are taken at a desk where the whole position is on screen rather than on a handset in the rain. Open it ' +
    'in the console.'
  );
}
