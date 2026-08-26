import { LIFECYCLE_ORDER, phaseIndex, type LifecyclePhase } from './phases.ts';
import { atLeastProject, projectBand, projectScale, type ProjectScale } from './scale.ts';

/**
 * The corporate project control standard.
 *
 * Every project runs through the same four stages and the same item list. That
 * is the whole idea: a contractor whose projects are each controlled slightly
 * differently has no way to compare them, no way to know what "properly run"
 * looks like, and no way to learn anything that survives the team disbanding.
 *
 * This is deliberately *not* the phase gate in `phases.ts`, and the difference
 * matters. A phase gate is a hard stop at a transition — a small number of
 * conditions that must hold before a project may move on, enforced fail-closed
 * on the write path. This is the continuous view: what should this project have
 * in place right now, given where it is, and what does it actually have. Most
 * of these items will never be a gate. A project can legally reach handover
 * having kept no site diary; it should not be able to do so quietly.
 *
 * Three rules keep it honest:
 *
 *   1. **An item the platform cannot evidence is `NOT_TRACKED`, never
 *      `PRESENT` and never `MISSING`.** Some things on a real contractor's
 *      control checklist have no home in this platform yet. Reporting those as
 *      satisfied would be a lie; reporting them as missing would be blaming the
 *      project for the platform's gap. They are named, with the reason, and
 *      excluded from the completeness figure.
 *   2. **An item not yet due is `NOT_YET_DUE`.** A project in design is not
 *      failing because it has no site diary.
 *   3. **Completeness is measured over what is due and trackable**, so the
 *      percentage means something rather than drifting with the phase.
 */

export type ControlStage = 'PRECONSTRUCTION' | 'MOBILISATION' | 'DELIVERY' | 'COMPLETION';

export const CONTROL_STAGES: Array<{ stage: ControlStage; label: string; purpose: string }> = [
  {
    stage: 'PRECONSTRUCTION',
    label: 'Preconstruction',
    purpose: 'Know what is being built, on what information, with what risk and by whom.',
  },
  {
    stage: 'MOBILISATION',
    label: 'Mobilisation',
    purpose: 'Everything that must be in place before the first person works on site.',
  },
  {
    stage: 'DELIVERY',
    label: 'Delivery',
    purpose: 'The record that is kept while the work happens, because it cannot be reconstructed after.',
  },
  {
    stage: 'COMPLETION',
    label: 'Completion',
    purpose: 'Prove it works, hand it over with its evidence, settle it, and keep what was learned.',
  },
];

export type ControlItemStatus = 'PRESENT' | 'MISSING' | 'NOT_YET_DUE' | 'NOT_TRACKED' | 'NOT_PROPORTIONATE';

export type ControlItem = {
  id: string;
  stage: ControlStage;
  label: string;
  /** What goes wrong without it. An item nobody can justify should not be on the list. */
  purpose: string;
  /** The lifecycle phase from which this item is expected to exist. */
  dueFrom: LifecyclePhase;
  /**
   * How the ledger evidences it. Absent means the platform does not track this
   * item, which is stated rather than implied.
   */
  evidence?: {
    refType: string;
    predicate: (state: Record<string, unknown>) => boolean;
    minimum: number;
    /** What is being counted, in words, so a zero is interpretable. */
    counts: string;
  };
  /** Present only when there is no evidence path. Names the gap. */
  notTrackedReason?: string;
  /**
   * True when this item is also enforced as a phase-gate exit criterion. Held
   * here as a cross-reference rather than a second copy of the rule: the gate
   * in `phases.ts` remains the only thing that enforces.
   */
  gateEnforced?: boolean;
  /**
   * The smallest project this item is proportionate on. A programme baseline,
   * a document control procedure and a written cost report are all correct on a
   * hospital and all absurd on a two-day repair — demanding them anyway is how
   * a control standard gets ignored by the people it is meant to help.
   *
   * Defaults to MINOR: an item with no floor applies to everything, which is
   * the right default for scope, RAMS and the record of what was built.
   */
  appliesFrom?: ProjectScale;
};

const any = (): boolean => true;
const approved = (s: Record<string, unknown>): boolean => s.status === 'APPROVED';

/**
 * The standard.
 *
 * Ordered as a contractor would walk it, not as the data model happens to be
 * arranged, because the list is read by people running jobs.
 */
export const CONTROL_ITEMS: ControlItem[] = [
  // --- Preconstruction -------------------------------------------------------
  {
    id: 'PRE.SCOPE',
    stage: 'PRECONSTRUCTION',
    label: 'Scope',
    purpose: 'What is and is not included. Every later argument about change starts here.',
    dueFrom: 'CONCEPT',
    evidence: { refType: 'ScopePackage', predicate: any, minimum: 1, counts: 'scope packages' },
    gateEnforced: true,
  },
  {
    id: 'PRE.DRAWINGS',
    appliesFrom: 'SMALL',
    stage: 'PRECONSTRUCTION',
    label: 'Drawings',
    purpose: 'The information the work is priced and built from, at a known revision.',
    dueFrom: 'DESIGN',
    evidence: { refType: 'Drawing', predicate: any, minimum: 1, counts: 'drawings' },
  },
  {
    id: 'PRE.SPECIFICATIONS',
    appliesFrom: 'MEDIUM',
    stage: 'PRECONSTRUCTION',
    label: 'Specifications',
    purpose: 'The standard the work is measured against when somebody says it is not good enough.',
    dueFrom: 'DESIGN',
    evidence: { refType: 'Specification', predicate: any, minimum: 1, counts: 'specifications' },
  },
  {
    id: 'PRE.SURVEYS',
    appliesFrom: 'MEDIUM',
    stage: 'PRECONSTRUCTION',
    label: 'Surveys',
    purpose: 'Ground, topographic, asbestos, measured. What was not surveyed becomes a claim.',
    dueFrom: 'DESIGN',
    notTrackedReason:
      'There is no Survey entity. Survey reports can be registered as evidence items, but nothing distinguishes them from other evidence, so their presence cannot be asserted.',
  },
  {
    id: 'PRE.CONSTRAINTS',
    appliesFrom: 'SMALL',
    stage: 'PRECONSTRUCTION',
    label: 'Constraints',
    purpose: 'Access, possessions, permits, neighbours, operating restrictions — the things that decide the programme.',
    dueFrom: 'DESIGN',
    evidence: { refType: 'Constraint', predicate: any, minimum: 1, counts: 'constraints' },
  },
  {
    id: 'PRE.RISK_REGISTER',
    appliesFrom: 'SMALL',
    stage: 'PRECONSTRUCTION',
    label: 'Risk register',
    purpose: 'Quantified risk. Without it, contingency is a number somebody liked.',
    dueFrom: 'DESIGN',
    evidence: { refType: 'RiskRegisterItem', predicate: any, minimum: 1, counts: 'risks' },
  },
  {
    id: 'PRE.PROGRAMME',
    appliesFrom: 'SMALL',
    stage: 'PRECONSTRUCTION',
    label: 'Programme',
    purpose: 'The sequence and duration the price was built on.',
    dueFrom: 'TENDER',
    evidence: { refType: 'Task', predicate: any, minimum: 1, counts: 'programme activities' },
  },
  {
    id: 'PRE.PROCUREMENT_SCHEDULE',
    appliesFrom: 'MEDIUM',
    stage: 'PRECONSTRUCTION',
    label: 'Procurement schedule',
    purpose: 'When each package must be enquired, returned and let to hold the programme.',
    dueFrom: 'TENDER',
    notTrackedReason:
      'Enquiries and packages are tracked individually, but nothing holds the dated plan of when each package must be let, so lateness against it cannot be measured.',
  },
  {
    id: 'PRE.DESIGN_RESPONSIBILITIES',
    appliesFrom: 'MEDIUM',
    stage: 'PRECONSTRUCTION',
    label: 'Design responsibilities',
    purpose: 'Who designs what. The gap between two parties each assuming the other did is where liability sits.',
    dueFrom: 'TENDER',
    evidence: {
      refType: 'TenderPackage',
      predicate: (s) => Array.isArray(s.designResponsibilityMatrix) && s.designResponsibilityMatrix.length > 0,
      minimum: 1,
      counts: 'packages carrying a design responsibility matrix',
    },
  },

  // --- Mobilisation ----------------------------------------------------------
  {
    id: 'MOB.CPP',
    stage: 'MOBILISATION',
    label: 'Construction Phase Plan',
    purpose: 'A CDM duty. No construction work may start without it, and it must be kept current.',
    dueFrom: 'CONSTRUCTION',
    evidence: {
      refType: 'CDMDocument',
      predicate: (s) => s.type === 'CONSTRUCTION_PHASE_PLAN' && s.status === 'APPROVED',
      minimum: 1,
      counts: 'approved construction phase plans',
    },
  },
  {
    id: 'MOB.RAMS',
    stage: 'MOBILISATION',
    label: 'RAMS',
    purpose: 'How each activity is done safely, approved by somebody competent to approve it.',
    dueFrom: 'CONSTRUCTION',
    evidence: { refType: 'RAMS', predicate: (s) => s.status === 'APPROVED', minimum: 1, counts: 'approved method statements' },
  },
  {
    id: 'MOB.SITE_SETUP',
    appliesFrom: 'SMALL',
    stage: 'MOBILISATION',
    label: 'Site setup',
    purpose: 'Welfare, hoarding, access, utilities, logistics. A CDM duty and the first thing an inspector looks at.',
    dueFrom: 'CONSTRUCTION',
    notTrackedReason:
      'Site establishment is priced in the estimate and described in the construction phase plan, but no record asserts that it was actually completed on the ground.',
  },
  {
    id: 'MOB.INSURANCE',
    stage: 'MOBILISATION',
    label: 'Insurance',
    purpose: 'Contract works, public and employers liability, professional indemnity — in force before anyone starts.',
    dueFrom: 'CONSTRUCTION',
    notTrackedReason:
      'Subcontractor insurances are held and expiry-checked on the supply chain register, but the project\'s own policies are priced rather than recorded, so cover cannot be asserted.',
  },
  {
    id: 'MOB.APPOINTMENTS',
    appliesFrom: 'MEDIUM',
    stage: 'MOBILISATION',
    label: 'Appointments',
    purpose: 'Named, competent people in the duty-holder roles. CDM requires the competence to be checked, not assumed.',
    dueFrom: 'CONSTRUCTION',
    evidence: { refType: 'Competency', predicate: any, minimum: 1, counts: 'recorded competencies' },
  },
  {
    id: 'MOB.SUBCONTRACTS',
    appliesFrom: 'SMALL',
    stage: 'MOBILISATION',
    label: 'Subcontract agreements',
    purpose: 'Signed before the work starts. A subcontractor on site without an executed agreement is a dispute waiting.',
    dueFrom: 'CONSTRUCTION',
    evidence: { refType: 'Subcontract', predicate: any, minimum: 1, counts: 'subcontracts' },
  },
  {
    id: 'MOB.BASELINE',
    appliesFrom: 'MEDIUM',
    stage: 'MOBILISATION',
    label: 'Programme baseline',
    purpose: 'The frozen programme every later delay is measured against. Without it, no delay claim can be proved or defended.',
    dueFrom: 'CONSTRUCTION',
    evidence: { refType: 'ProgrammeBaseline', predicate: approved, minimum: 1, counts: 'approved baselines' },
    gateEnforced: true,
  },
  {
    id: 'MOB.BUDGET',
    appliesFrom: 'SMALL',
    stage: 'MOBILISATION',
    label: 'Cost baseline',
    purpose: 'The approved budget the cost report reports against.',
    dueFrom: 'CONSTRUCTION',
    evidence: { refType: 'Budget', predicate: approved, minimum: 1, counts: 'approved budgets' },
    gateEnforced: true,
  },
  {
    id: 'MOB.DOCUMENT_CONTROL',
    appliesFrom: 'MEDIUM',
    stage: 'MOBILISATION',
    label: 'Document control',
    purpose: 'One current revision of everything, and proof of what was issued to whom and when.',
    dueFrom: 'CONSTRUCTION',
    evidence: {
      refType: 'Drawing',
      predicate: (s) => typeof s.revision === 'string' && String(s.revision).length > 0,
      minimum: 1,
      counts: 'drawings carrying a revision',
    },
  },

  // --- Delivery --------------------------------------------------------------
  {
    id: 'DEL.DIARY',
    appliesFrom: 'SMALL',
    stage: 'DELIVERY',
    label: 'Daily diary',
    purpose: 'Weather, labour, plant, events. The contemporaneous record no delay claim survives without.',
    dueFrom: 'CONSTRUCTION',
    evidence: { refType: 'SiteDiary', predicate: any, minimum: 1, counts: 'site diary entries' },
  },
  {
    id: 'DEL.PROGRESS',
    appliesFrom: 'MEDIUM',
    stage: 'DELIVERY',
    label: 'Weekly progress',
    purpose: 'Measured progress against the baseline, weekly, while it is still cheap to correct.',
    dueFrom: 'CONSTRUCTION',
    evidence: { refType: 'ProgressMeasurement', predicate: any, minimum: 1, counts: 'progress measurements' },
  },
  {
    id: 'DEL.RFI',
    appliesFrom: 'MEDIUM',
    stage: 'DELIVERY',
    label: 'RFIs',
    purpose: 'Questions asked and answered, dated. An unanswered RFI is a programme risk with a name.',
    dueFrom: 'CONSTRUCTION',
    evidence: { refType: 'RFI', predicate: any, minimum: 1, counts: 'RFIs' },
  },
  {
    id: 'DEL.SUBMITTALS',
    appliesFrom: 'MEDIUM',
    stage: 'DELIVERY',
    label: 'Technical submittals',
    purpose: 'Materials and details approved before they are ordered or built.',
    dueFrom: 'CONSTRUCTION',
    notTrackedReason:
      'Supplier submissions are tender returns, not technical submittals. Nothing tracks a product or detail submitted for approval, so the approval status of what is being installed cannot be asserted.',
  },
  {
    id: 'DEL.INSPECTIONS',
    appliesFrom: 'SMALL',
    stage: 'DELIVERY',
    label: 'Quality inspections',
    purpose: 'Inspected against the ITP at the point it can still be seen, with hold points honoured.',
    dueFrom: 'CONSTRUCTION',
    evidence: { refType: 'QualityInspection', predicate: any, minimum: 1, counts: 'inspections' },
  },
  {
    id: 'DEL.COST_REPORT',
    appliesFrom: 'MEDIUM',
    stage: 'DELIVERY',
    label: 'Cost report',
    purpose: 'Cost against value, monthly. A job that reports late reports a loss it can no longer recover.',
    dueFrom: 'CONSTRUCTION',
    evidence: { refType: 'CVR', predicate: any, minimum: 1, counts: 'cost reports' },
  },
  {
    id: 'DEL.PROGRAMME_UPDATE',
    appliesFrom: 'MEDIUM',
    stage: 'DELIVERY',
    label: 'Programme update',
    purpose: 'The programme re-run against actual progress, so the completion date is a forecast rather than a hope.',
    dueFrom: 'CONSTRUCTION',
    evidence: {
      refType: 'Task',
      predicate: (s) => s.percentComplete !== undefined && Number(s.percentComplete) > 0,
      minimum: 1,
      counts: 'activities carrying actual progress',
    },
  },
  {
    id: 'DEL.RISK_REGISTER',
    appliesFrom: 'SMALL',
    stage: 'DELIVERY',
    label: 'Risk register maintained',
    purpose: 'Reviewed as risks close and new ones arrive. A register written once at tender is a document, not a control.',
    dueFrom: 'CONSTRUCTION',
    evidence: { refType: 'RiskRegisterItem', predicate: any, minimum: 1, counts: 'risks' },
  },
  {
    id: 'DEL.CHANGE_LOG',
    appliesFrom: 'SMALL',
    stage: 'DELIVERY',
    label: 'Change log',
    purpose: 'Every instruction and variation, valued or not. Unlogged change is unpaid change.',
    dueFrom: 'CONSTRUCTION',
    evidence: { refType: 'ChangeRequest', predicate: any, minimum: 1, counts: 'change requests' },
  },

  // --- Completion ------------------------------------------------------------
  {
    id: 'COM.SNAGGING',
    stage: 'COMPLETION',
    label: 'Snagging',
    purpose: 'Defects found, dispatched and closed with evidence, rather than listed and forgotten.',
    dueFrom: 'COMMISSIONING',
    evidence: { refType: 'Snag', predicate: any, minimum: 1, counts: 'snags' },
  },
  {
    id: 'COM.TESTING',
    appliesFrom: 'SMALL',
    stage: 'COMPLETION',
    label: 'Testing',
    purpose: 'Materials and systems tested to the specification, with results kept.',
    dueFrom: 'COMMISSIONING',
    evidence: { refType: 'CommissioningTest', predicate: any, minimum: 1, counts: 'tests' },
  },
  {
    id: 'COM.COMMISSIONING',
    appliesFrom: 'MEDIUM',
    stage: 'COMPLETION',
    label: 'Commissioning',
    purpose: 'The asset proven to perform as designed before anybody takes responsibility for it.',
    dueFrom: 'COMMISSIONING',
    evidence: {
      refType: 'CommissioningTest',
      predicate: (s) => s.status === 'ACCEPTED',
      minimum: 1,
      counts: 'accepted commissioning tests',
    },
    gateEnforced: true,
  },
  {
    id: 'COM.OM_MANUAL',
    appliesFrom: 'SMALL',
    stage: 'COMPLETION',
    label: 'O&M manuals',
    purpose: 'How to run and maintain it, for the thirty years that cost more than building it did.',
    dueFrom: 'HANDOVER',
    evidence: { refType: 'OMManual', predicate: any, minimum: 1, counts: 'O&M manuals' },
  },
  {
    id: 'COM.AS_BUILTS',
    appliesFrom: 'MEDIUM',
    stage: 'COMPLETION',
    label: 'As-builts',
    purpose: 'What was actually built, not what was drawn. The next project on this asset depends on it.',
    dueFrom: 'HANDOVER',
    evidence: { refType: 'Model', predicate: (s) => s.status === 'AS_BUILT', minimum: 1, counts: 'as-built models' },
  },
  {
    id: 'COM.TRAINING',
    appliesFrom: 'MEDIUM',
    stage: 'COMPLETION',
    label: 'Training',
    purpose: 'The people who will operate it shown how, and a record that they were.',
    dueFrom: 'HANDOVER',
    evidence: { refType: 'TrainingRecord', predicate: any, minimum: 1, counts: 'training records' },
  },
  {
    id: 'COM.HANDOVER',
    appliesFrom: 'SMALL',
    stage: 'COMPLETION',
    label: 'Handover',
    purpose: 'A complete evidenced asset accepted by the receiving party — not a box of PDFs.',
    dueFrom: 'HANDOVER',
    evidence: {
      refType: 'HandoverPack',
      predicate: (s) => s.status === 'ACCEPTED',
      minimum: 1,
      counts: 'accepted handover packs',
    },
    gateEnforced: true,
  },
  {
    id: 'COM.FINAL_ACCOUNT',
    appliesFrom: 'SMALL',
    stage: 'COMPLETION',
    label: 'Final account',
    purpose: 'The agreed final sum, with every variation settled and retention released.',
    dueFrom: 'HANDOVER',
    notTrackedReason:
      'Payment cycles, variations and retention are each tracked, but nothing records the agreed final sum that closes them, so a settled account cannot be distinguished from an open one.',
  },
  {
    id: 'COM.LESSONS_LEARNED',
    stage: 'COMPLETION',
    label: 'Lessons learned',
    purpose: 'What this job taught the business, in a form the next job can find. Otherwise it is paid for twice.',
    dueFrom: 'HANDOVER',
    evidence: { refType: 'LessonLearned', predicate: any, minimum: 1, counts: 'lessons captured' },
  },
];

const ITEMS_BY_STAGE = new Map<ControlStage, ControlItem[]>(
  CONTROL_STAGES.map(({ stage }) => [stage, CONTROL_ITEMS.filter((i) => i.stage === stage)]),
);

export function controlItem(id: string): ControlItem | undefined {
  return CONTROL_ITEMS.find((i) => i.id === id);
}

// --- Evaluation ----------------------------------------------------------------

export type EvaluatedItem = {
  id: string;
  stage: ControlStage;
  label: string;
  purpose: string;
  status: ControlItemStatus;
  /** How many records were found, for a trackable item. */
  found?: number;
  required?: number;
  counts?: string;
  notTrackedReason?: string;
  gateEnforced: boolean;
  /** The smallest project this item is proportionate on. */
  appliesFrom: ProjectScale;
  /**
   * The records that satisfied this item, so the count can be opened rather
   * than believed.
   *
   * The evaluation already had them — it filtered the ledger and then kept only
   * `.length`. A screen showing "4 of 5 in place" with no way to reach the four
   * is asking to be trusted, and the Build Standard's rule is that every figure
   * drills to the events behind it.
   *
   * Capped, because an item evidenced by four hundred progress measurements
   * produces a drill nobody can read. The cap is stated on the item rather than
   * silently applied, so a truncated list is not mistaken for the whole one.
   */
  evidenceRefs?: Array<{ refType: string; refId: string }>;
  /** True where `evidenceRefs` is a sample rather than everything found. */
  evidenceTruncated?: boolean;
};

export type StageReport = {
  stage: ControlStage;
  label: string;
  purpose: string;
  items: EvaluatedItem[];
  /** Items due, trackable, and evidenced. */
  present: number;
  /** Items due, trackable, and absent. */
  missing: number;
  notYetDue: number;
  notTracked: number;
  /** Items this project is too small to need. Excluded from the score. */
  notProportionate: number;
  /**
   * Present over (present + missing). Null when nothing in the stage is yet
   * due — which is a different statement from zero per cent.
   */
  completenessPercent: number | null;
};

export type ControlReport = {
  phase: LifecyclePhase;
  /** The band this project was measured as, and why that changes the list. */
  projectScale: ProjectScale;
  projectScaleLabel: string;
  /** How many of the standard's items apply at this size. */
  applicableItems: number;
  stages: StageReport[];
  /** Over every due, trackable item on the project. */
  completenessPercent: number | null;
  /** Due, trackable and absent — the list somebody has to act on. */
  gaps: Array<{ id: string; stage: ControlStage; label: string; purpose: string }>;
  /**
   * Gaps that are also phase-gate criteria. These stop the project moving on;
   * the rest are discipline, and the difference is worth stating plainly.
   */
  blockingGaps: string[];
  /** What the platform itself does not track, so the report is not read as complete. */
  notTracked: Array<{ id: string; label: string; reason: string }>;
};

/**
 * Evaluate the standard against one project.
 *
 * Pure, like `evaluatePhaseGate` — it takes a lookup rather than a ledger, so
 * the standard can be tested without standing a platform up and so a caller can
 * evaluate a hypothetical project state.
 */
/**
 * How many source records a control item carries to the screen.
 *
 * High enough that most items list everything, low enough that an item
 * evidenced by hundreds of records does not turn a drill into a scroll.
 */
const EVIDENCE_REF_CAP = 25;

export function evaluateControl(
  phase: LifecyclePhase,
  entitiesByType: (refType: string) => Array<Record<string, unknown>>,
  /**
   * Contract value, so the list is proportionate. Omitting it measures against
   * the whole standard, which is the right default for a project whose value
   * nobody recorded — the alternative would be quietly excusing items on a job
   * that might be enormous.
   */
  projectValueMinor?: number,
): ControlReport {
  const currentIndex = phaseIndex(phase);
  const scale = projectValueMinor === undefined ? 'MEGA' : projectScale(projectValueMinor);

  const evaluate = (item: ControlItem): EvaluatedItem => {
    const appliesFrom = item.appliesFrom ?? 'MINOR';
    const base = {
      id: item.id,
      stage: item.stage,
      label: item.label,
      purpose: item.purpose,
      gateEnforced: Boolean(item.gateEnforced),
      appliesFrom,
    };

    // Proportionality is checked before anything else. A £3,000 repair is not
    // missing a programme baseline; it is a job that does not have one, and
    // saying otherwise is how a control standard gets ignored.
    if (!atLeastProject(scale, appliesFrom)) {
      return { ...base, status: 'NOT_PROPORTIONATE' };
    }

    if (!item.evidence) {
      return { ...base, status: 'NOT_TRACKED', notTrackedReason: item.notTrackedReason };
    }
    if (currentIndex < phaseIndex(item.dueFrom)) {
      return { ...base, status: 'NOT_YET_DUE', required: item.evidence.minimum, counts: item.evidence.counts };
    }

    const matching = entitiesByType(item.evidence.refType).filter(item.evidence.predicate);
    // `id` is the refId on every entity the ledger stores — the write path sets
    // both from the same value. Anything without one is dropped rather than
    // guessed at, so a ref that reaches a screen always resolves.
    const refs = matching
      .map((record) => ({ refType: item.evidence!.refType, refId: String(record.id ?? '') }))
      .filter((ref) => ref.refId !== '');

    return {
      ...base,
      status: matching.length >= item.evidence.minimum ? 'PRESENT' : 'MISSING',
      found: matching.length,
      required: item.evidence.minimum,
      counts: item.evidence.counts,
      evidenceRefs: refs.slice(0, EVIDENCE_REF_CAP),
      ...(refs.length > EVIDENCE_REF_CAP ? { evidenceTruncated: true } : {}),
    };
  };

  const stages: StageReport[] = CONTROL_STAGES.map(({ stage, label, purpose }) => {
    const items = (ITEMS_BY_STAGE.get(stage) ?? []).map(evaluate);
    const present = items.filter((i) => i.status === 'PRESENT').length;
    const missing = items.filter((i) => i.status === 'MISSING').length;
    return {
      stage,
      label,
      purpose,
      items,
      present,
      missing,
      notYetDue: items.filter((i) => i.status === 'NOT_YET_DUE').length,
      notTracked: items.filter((i) => i.status === 'NOT_TRACKED').length,
      notProportionate: items.filter((i) => i.status === 'NOT_PROPORTIONATE').length,
      completenessPercent: present + missing === 0 ? null : Math.round((present / (present + missing)) * 10000) / 100,
    };
  });

  const all = stages.flatMap((s) => s.items);
  const present = all.filter((i) => i.status === 'PRESENT').length;
  const missing = all.filter((i) => i.status === 'MISSING').length;

  const gaps = all
    .filter((i) => i.status === 'MISSING')
    .map((i) => ({ id: i.id, stage: i.stage, label: i.label, purpose: i.purpose }));

  return {
    phase,
    projectScale: scale,
    projectScaleLabel: projectBand(scale).label,
    applicableItems: all.filter((i) => i.status !== 'NOT_PROPORTIONATE').length,
    stages,
    completenessPercent: present + missing === 0 ? null : Math.round((present / (present + missing)) * 10000) / 100,
    gaps,
    blockingGaps: all.filter((i) => i.status === 'MISSING' && i.gateEnforced).map((i) => i.id),
    notTracked: all
      .filter((i) => i.status === 'NOT_TRACKED')
      .map((i) => ({ id: i.id, label: i.label, reason: i.notTrackedReason ?? 'No evidence path' })),
  };
}

/** Every phase from which at least one item becomes due, for the interface. */
export const CONTROL_DUE_PHASES: LifecyclePhase[] = LIFECYCLE_ORDER.filter((p) =>
  CONTROL_ITEMS.some((i) => i.dueFrom === p),
);
