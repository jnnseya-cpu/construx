import { DomainError } from '../core/errors.ts';

/**
 * The asset lifecycle — one continuous spine from first idea to end of
 * operational life. The platform runs across all of it without a migration or a
 * handover to another system, which is what makes 30-year traceability possible.
 *
 *   CONCEPT -> DESIGN -> TENDER -> CONSTRUCTION -> COMMISSIONING -> HANDOVER -> OPERATIONS
 */

export type LifecyclePhase =
  | 'CONCEPT'
  | 'DESIGN'
  | 'TENDER'
  | 'CONSTRUCTION'
  | 'COMMISSIONING'
  | 'HANDOVER'
  | 'OPERATIONS';

export const LIFECYCLE_ORDER: LifecyclePhase[] = [
  'CONCEPT',
  'DESIGN',
  'TENDER',
  'CONSTRUCTION',
  'COMMISSIONING',
  'HANDOVER',
  'OPERATIONS',
];

export type PhaseGate = {
  phase: LifecyclePhase;
  purpose: string;
  /**
   * Conditions that must hold before the project may leave this phase.
   * Each is checked against materialised project state — a gate that cannot be
   * evaluated from the Golden Thread is not a gate, it is a wish.
   */
  exitCriteria: Array<{
    id: string;
    description: string;
    /** Entity types that must exist, and the state predicate they must satisfy. */
    requires: { refType: string; predicate: (state: Record<string, unknown>) => boolean; minimum: number };
  }>;
};

const approved = (state: Record<string, unknown>): boolean => state.status === 'APPROVED';
const exists = (): boolean => true;

export const PHASE_GATES: PhaseGate[] = [
  {
    phase: 'CONCEPT',
    purpose: 'Establish the asset, its sector, its funding envelope and its governance.',
    exitCriteria: [
      {
        id: 'CONCEPT.SCOPE_DEFINED',
        description: 'At least one scope package defines what is being built',
        requires: { refType: 'ScopePackage', predicate: exists, minimum: 1 },
      },
    ],
  },
  {
    phase: 'DESIGN',
    purpose: 'Mature the design to the point where quantities can be measured and risk priced.',
    exitCriteria: [
      {
        id: 'DESIGN.MATURITY_ASSESSED',
        description: 'Design maturity has been formally assessed for the package being priced',
        requires: { refType: 'DesignMaturityAssessment', predicate: exists, minimum: 1 },
      },
    ],
  },
  {
    phase: 'TENDER',
    purpose: 'Price the work, test the market, adjudicate and award on evidence.',
    exitCriteria: [
      {
        id: 'TENDER.ESTIMATE_FROZEN',
        description: 'A tender estimate has been frozen before bid submission',
        requires: { refType: 'Estimate', predicate: (s) => s.status === 'FROZEN', minimum: 1 },
      },
      {
        id: 'TENDER.CONTRACT_IN_PLACE',
        description: 'An executed contract exists before construction begins',
        requires: { refType: 'Contract', predicate: (s) => s.status === 'EXECUTED', minimum: 1 },
      },
    ],
  },
  {
    phase: 'CONSTRUCTION',
    purpose: 'Build against a frozen baseline, with progress, cost and risk measured continuously.',
    exitCriteria: [
      {
        id: 'CONSTRUCTION.BASELINE_APPROVED',
        description: 'An approved programme baseline governs the works',
        requires: { refType: 'ProgrammeBaseline', predicate: approved, minimum: 1 },
      },
      {
        id: 'CONSTRUCTION.BUDGET_APPROVED',
        description: 'An approved cost baseline governs the works',
        requires: { refType: 'Budget', predicate: approved, minimum: 1 },
      },
    ],
  },
  {
    phase: 'COMMISSIONING',
    purpose: 'Prove the asset performs as designed before anyone takes responsibility for it.',
    exitCriteria: [
      {
        id: 'COMMISSIONING.SYSTEMS_ACCEPTED',
        description: 'Commissioning tests recorded and accepted',
        requires: { refType: 'CommissioningTest', predicate: (s) => s.status === 'ACCEPTED', minimum: 1 },
      },
    ],
  },
  {
    phase: 'HANDOVER',
    purpose: 'Transfer a complete, evidenced asset — not a box of PDFs — to the operator.',
    exitCriteria: [
      {
        id: 'HANDOVER.PACK_ACCEPTED',
        description: 'Handover pack compiled and accepted by the receiving party',
        requires: { refType: 'HandoverPack', predicate: (s) => s.status === 'ACCEPTED', minimum: 1 },
      },
      {
        id: 'HANDOVER.ASSETS_REGISTERED',
        description: 'Asset register populated for operations',
        requires: { refType: 'AssetRegisterItem', predicate: exists, minimum: 1 },
      },
    ],
  },
  {
    phase: 'OPERATIONS',
    purpose: 'Operate at minimum lifecycle cost for 30+ years, on the same data spine.',
    exitCriteria: [],
  },
];

const GATE_BY_PHASE = new Map(PHASE_GATES.map((g) => [g.phase, g]));

export function phaseIndex(phase: LifecyclePhase): number {
  return LIFECYCLE_ORDER.indexOf(phase);
}

export function nextPhase(phase: LifecyclePhase): LifecyclePhase | undefined {
  return LIFECYCLE_ORDER[phaseIndex(phase) + 1];
}

export type GateEvaluation = {
  phase: LifecyclePhase;
  passed: boolean;
  criteria: Array<{ id: string; description: string; satisfied: boolean; found: number; required: number }>;
};

/** Evaluate a phase's exit criteria against materialised project state. */
export function evaluatePhaseGate(
  phase: LifecyclePhase,
  entitiesByType: (refType: string) => Array<Record<string, unknown>>,
): GateEvaluation {
  const gate = GATE_BY_PHASE.get(phase);
  if (!gate) throw new DomainError('PHASE_UNKNOWN', `Unknown lifecycle phase "${phase}"`);

  const criteria = gate.exitCriteria.map((criterion) => {
    const found = entitiesByType(criterion.requires.refType).filter(criterion.requires.predicate).length;
    return {
      id: criterion.id,
      description: criterion.description,
      satisfied: found >= criterion.requires.minimum,
      found,
      required: criterion.requires.minimum,
    };
  });

  return { phase, passed: criteria.every((c) => c.satisfied), criteria };
}

/**
 * A phase transition is a governed event, not a dropdown. Forward moves must
 * clear the gate; backward moves are permitted (projects genuinely do re-tender
 * or re-enter design) but are recorded explicitly as regressions.
 *
 * ## A phase already occupied is not a phase being skipped
 *
 * `traversed` is what the project has actually been through, and without it the
 * in-place conversion model produces a project that cannot move.
 *
 * A design-and-build contractor registers at `TENDER`, wins, and the conversion
 * opens delivery at `DESIGN` — which is *earlier* in this order, because the
 * order is the asset's and the asset's order is the client's. The job then goes
 * to site, and `DESIGN → CONSTRUCTION` steps over `TENDER`. Read as a skip it is
 * refused, and the only way out is a "regression" to `TENDER` the project is not
 * in fact re-entering: a false statement in the record, made to satisfy a check.
 *
 * So the rule is not "one step at a time". It is that **nothing may be passed
 * over unseen**: a forward move is permitted when every phase strictly between
 * the two has already been occupied. A project genuinely leaping from `CONCEPT`
 * to `CONSTRUCTION` is still refused, which is the failure the check exists for.
 */
export function assertTransitionAllowed(
  from: LifecyclePhase,
  to: LifecyclePhase,
  evaluation: GateEvaluation,
  traversed: readonly LifecyclePhase[] = [],
): { direction: 'FORWARD' | 'REGRESSION' } {
  const fromIndex = phaseIndex(from);
  const toIndex = phaseIndex(to);

  if (fromIndex === toIndex) throw new DomainError('PHASE_NO_CHANGE', `Project is already in ${to}`);

  if (toIndex < fromIndex) return { direction: 'REGRESSION' };

  const steppedOver = LIFECYCLE_ORDER.slice(fromIndex + 1, toIndex);
  const unseen = steppedOver.filter((phase) => !traversed.includes(phase));
  if (unseen.length > 0) {
    throw new DomainError(
      'PHASE_SKIP_FORBIDDEN',
      `Cannot move from ${from} to ${to} without ${unseen.join(', ')}. ` +
        'A phase the project has already been through may be stepped over; one it has not may not.',
      422,
      [{ field: 'to', message: `${unseen.join(', ')} ${unseen.length === 1 ? 'has' : 'have'} not been reached` }],
    );
  }
  if (!evaluation.passed) {
    const failing = evaluation.criteria.filter((c) => !c.satisfied).map((c) => c.id);
    throw new DomainError('PHASE_GATE_FAILED', `Exit criteria not met for ${from}: ${failing.join(', ')}`);
  }
  return { direction: 'FORWARD' };
}

// ------------------------------------------------- where a project starts

/**
 * Why a project may open at a phase other than the first one.
 *
 * `CONCEPT -> ... -> OPERATIONS` is the asset's lifecycle, not the business's
 * involvement in it. A contractor pricing somebody else's design has no concept
 * phase and no design phase; an operator taking over a finished asset has
 * neither and no construction phase either. Forcing either of them to start at
 * `CONCEPT` means fabricating a scope package and a design maturity assessment
 * whose only purpose is to satisfy a gate — which is the platform teaching
 * people to put invented records into the Golden Thread on day one.
 *
 * So a project may open at any phase. What it may **not** do is pretend it
 * passed the gates in front of it.
 *
 * ## Starting late is a fact about the record, not a shortcut through it
 *
 * A project that opened at `TENDER` never had its `CONCEPT.SCOPE_DEFINED` or
 * `DESIGN.MATURITY_ASSESSED` criteria evaluated here. Three years later a
 * reader looking at a project in `CONSTRUCTION` must be able to tell one that
 * came through those gates from one that began after them, and no amount of
 * reading `phaseHistory` backwards will tell them if the entry looks identical.
 *
 * `phasesBefore` is therefore recorded on the project as phases **not
 * traversed**, a reason is required for any start past `CONCEPT`, and the two
 * together are what a gate evaluation, an audit or an expert report reads.
 */
export function phasesBefore(phase: LifecyclePhase): LifecyclePhase[] {
  return LIFECYCLE_ORDER.slice(0, phaseIndex(phase));
}

/**
 * Check a starting phase, and say what starting there means.
 *
 * Returns the phases the project is skipping. Throws when the phase is not one,
 * or when a start past `CONCEPT` carries no reason — because the reason is the
 * only thing that distinguishes a deliberate mid-lifecycle start from a
 * mis-selected dropdown, and it is the sentence somebody reads years later.
 */
export function assertStartingPhase(
  phase: LifecyclePhase,
  reason: string | undefined,
): { skipped: LifecyclePhase[] } {
  if (!LIFECYCLE_ORDER.includes(phase)) {
    throw new DomainError('PHASE_UNKNOWN', `"${phase}" is not a lifecycle phase`, 422, [
      { field: 'startingPhase', message: `Expected one of ${LIFECYCLE_ORDER.join(', ')}` },
    ]);
  }

  const skipped = phasesBefore(phase);
  if (skipped.length === 0) return { skipped };

  if (!reason || reason.trim().length < 10) {
    throw new DomainError(
      'STARTING_PHASE_UNEXPLAINED',
      `A project opening at ${phase} never has its ${skipped.join(' and ')} ` +
        `gate${skipped.length === 1 ? '' : 's'} evaluated here. Say why it starts there — a reader three years from ` +
        'now has to be able to tell a project that passed those gates from one that began after them.',
      422,
      [{ field: 'startingPhaseReason', message: 'Required when the project does not start at CONCEPT' }],
    );
  }

  return { skipped };
}
