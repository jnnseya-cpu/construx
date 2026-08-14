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
 */
export function assertTransitionAllowed(
  from: LifecyclePhase,
  to: LifecyclePhase,
  evaluation: GateEvaluation,
): { direction: 'FORWARD' | 'REGRESSION' } {
  const fromIndex = phaseIndex(from);
  const toIndex = phaseIndex(to);

  if (fromIndex === toIndex) throw new DomainError('PHASE_NO_CHANGE', `Project is already in ${to}`);

  if (toIndex < fromIndex) return { direction: 'REGRESSION' };

  if (toIndex > fromIndex + 1) {
    throw new DomainError('PHASE_SKIP_FORBIDDEN', `Cannot skip from ${from} directly to ${to}`);
  }
  if (!evaluation.passed) {
    const failing = evaluation.criteria.filter((c) => !c.satisfied).map((c) => c.id);
    throw new DomainError('PHASE_GATE_FAILED', `Exit criteria not met for ${from}: ${failing.join(', ')}`);
  }
  return { direction: 'FORWARD' };
}
