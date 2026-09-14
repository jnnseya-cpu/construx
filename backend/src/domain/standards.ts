import { CDM_DOCUMENTS } from './cdm.ts';
import { LIFECYCLE_ORDER, PHASE_GATES, type LifecyclePhase } from '../lifecycle/phases.ts';

/**
 * The standards this platform works to, and exactly what it does about each.
 *
 * Published from here rather than written into the landing page, for one
 * reason: a marketing page that names a standard is a claim, and a claim
 * nothing checks drifts the first time the code moves. Every entry below names
 * the module that implements it and says whether the platform **enforces** the
 * standard — refuses to proceed without it — or **carries** it, which means the
 * record is structured to the standard and a person still decides.
 *
 * The distinction is the whole point. "CDM 2015 compliant" is a sentence
 * anybody can type. "A Construction Phase Plan that nobody has approved gates
 * the CONSTRUCTION phase, and the gate is `PHASE_GATES`" is a sentence somebody
 * can check, and it is the one a buyer's compliance officer will ask about.
 *
 * Nothing here is aspirational. A standard the platform does not implement is
 * absent from this list, and the two half-measures on it say which half.
 */

export type Standard = {
  key: string;
  /** The standard as its own publisher names it. */
  name: string;
  /** The shortest true sentence about what this platform does with it. */
  does: string;
  /**
   * `ENFORCED` — the platform refuses the work without it.
   * `CARRIED`  — the record is structured to it; a person still decides.
   */
  strength: 'ENFORCED' | 'CARRIED';
  /** Where it lives, so the claim can be checked rather than believed. */
  mechanism: string;
  /** What this platform deliberately does *not* claim about the standard. */
  notClaimed?: string;
};

/**
 * RIBA Plan of Work 2020 against this platform's seven gated phases.
 *
 * Stated as a mapping rather than as an equivalence, because it is not one.
 * RIBA has eight stages and this platform has seven phases, and the difference
 * is procurement: in the Plan of Work procurement is a **task bar** running
 * across stages, not a stage of its own. Here it is a gated phase, because an
 * award is a decision with money on it and a decision with money on it needs a
 * gate. Saying "we are RIBA" would paper over that; showing the mapping does
 * not, and a practice that works to the Plan of Work can see exactly where
 * their stage sits.
 */
export const RIBA_STAGES: Array<{
  stage: number;
  name: string;
  goal: string;
  /** The phase a project is *in* while at this stage. */
  phase: LifecyclePhase;
  /**
   * A second phase this stage also spans.
   *
   * Only stage 6 has one. RIBA's Handover is a single stage; here it is two
   * phases, because proving the asset performs and transferring responsibility
   * for it are different decisions with different gates. The stage still has
   * one canonical phase — the one `stagePosition` reads — and this says which
   * other phase carries it, so a phase is never reported as carrying no stage
   * when it does.
   */
  alsoPhase?: LifecyclePhase;
  note?: string;
}> = [
  {
    stage: 0,
    name: 'Strategic Definition',
    goal: 'Set project goals, assess feasibility and establish the business case before any design begins.',
    phase: 'CONCEPT',
  },
  {
    stage: 1,
    name: 'Preparation and Briefing',
    goal: 'Assemble the project team, outline spatial requirements, agree budgets and develop the client brief.',
    phase: 'CONCEPT',
  },
  {
    stage: 2,
    name: 'Concept Design',
    goal: 'Create early architectural concepts and spatial layouts that respond to the brief and the site.',
    phase: 'DESIGN',
  },
  {
    stage: 3,
    name: 'Spatial Coordination',
    goal: 'Coordinate the design across disciplines and submit for planning approval.',
    phase: 'DESIGN',
  },
  {
    stage: 4,
    name: 'Technical Design',
    goal: 'Produce detailed drawings, specifications and building regulation packages ready for contractor pricing.',
    phase: 'DESIGN',
    note: 'Technical design matures inside DESIGN; the TENDER phase carries the procurement task bar, which the Plan of Work runs across stages rather than as a stage of its own.',
  },
  {
    stage: 5,
    name: 'Manufacturing and Construction',
    goal: 'Build or assemble the project on site, manage logistics and monitor construction quality.',
    phase: 'CONSTRUCTION',
  },
  {
    stage: 6,
    name: 'Handover',
    goal: 'Hand the completed building over, resolve snags and defects, and start aftercare.',
    phase: 'HANDOVER',
    alsoPhase: 'COMMISSIONING',
    note: 'Split across two phases here: COMMISSIONING proves the asset performs before HANDOVER transfers responsibility for it.',
  },
  {
    stage: 7,
    name: 'Use',
    goal: 'Monitor long-term performance, run post-occupancy evaluation and review energy efficiency.',
    phase: 'OPERATIONS',
  },
];

/** The CDM document that gates construction, read from the catalogue rather than named twice. */
const CDM_GATING = CDM_DOCUMENTS.filter((document) => document.gatesConstruction).map((document) => document.label);

export const STANDARDS: Standard[] = [
  {
    key: 'RIBA_2020',
    name: 'RIBA Plan of Work 2020, stages 0–7',
    does:
      'Every stage maps onto one of seven gated phases, and a project cannot leave a phase until the gate is met. ' +
      'Design maturity is assessed per discipline at its RIBA stage, and the DESIGN gate refuses to open without one.',
    strength: 'ENFORCED',
    mechanism: 'lifecycle/phases.ts — PHASE_GATES, evaluated on every advance; DesignMaturityAssessment carries a 0–7 stage per discipline',
    notClaimed:
      'This platform is not a RIBA-certified tool and does not issue RIBA deliverables. Procurement is a gated phase here and a task bar there; the mapping says so.',
  },
  {
    key: 'CDM_2015',
    name: 'Construction (Design and Management) Regulations 2015',
    does:
      `${CDM_DOCUMENTS.length} duty document types, each with the sections the regulations require, drafted against the project's own record. ` +
      `${CDM_GATING.join(' and ')} gates the construction phase: unapproved, the work cannot start.`,
    strength: 'ENFORCED',
    mechanism: 'domain/cdm.ts — CDM_DOCUMENTS with required sections and the approver role; the gate refuses an unapproved plan',
    notClaimed:
      'Drafting a duty document is not discharging the duty. The dutyholder approves it, and the platform records who did and when.',
  },
  {
    key: 'CONSTRUCTION_ACT',
    name: 'Housing Grants, Construction and Regeneration Act 1996 (as amended 2009)',
    does:
      'Due dates, payment notices, pay less notices and the notified sum, counted in days as the Act counts them. ' +
      'A missing payment notice makes the applied sum payable in full, and the platform says so before the date rather than after.',
    strength: 'ENFORCED',
    mechanism: 'engines/maths/constructionAct.ts — statutory periods, with s.116(3) handled separately from service dates',
    notClaimed: 'It is not legal advice, and an adjudicator decides what a notice meant.',
  },
  {
    key: 'ISO_19650',
    name: 'ISO 19650-2 information management',
    does:
      'Every container in the common data environment carries a suitability code, and a code the standard does not define is refused. ' +
      'A drawing issued for comment is not a drawing to build from, and the record knows the difference.',
    strength: 'ENFORCED',
    mechanism: 'domain/cde.ts — suitability refused with SUITABILITY_UNKNOWN',
    notClaimed: 'The platform does not certify a BIM execution plan or audit an organisation against the standard.',
  },
  {
    key: 'BUILDING_SAFETY',
    name: 'Building Safety Act 2022 — the golden thread',
    does:
      'Every governance act is an append-only, hash-chained event with its author, its evidence and its correlation. ' +
      'The chain is verifiable by anybody holding the export, including after this platform is gone.',
    strength: 'ENFORCED',
    mechanism: 'goldenthread/ — the chain; export/exporter.ts — a verifiable export; erasure keeps the safety record the Act requires',
    notClaimed:
      'The Act places duties on dutyholders, not on software. This keeps the record they are required to keep; it does not make anybody a dutyholder or discharge one.',
  },
  {
    key: 'CONTRACT_FORMS',
    name: 'JCT 2016, NEC4, FIDIC 2017 Red Book, IChemE and MF/1',
    does:
      'Obligations resolve to the clause that imposes them under the form the parties actually signed — notice periods, ' +
      'retention release, defects, extension of time, variations. Where a form has no equivalent clause the entry is absent rather than approximated.',
    strength: 'CARRIED',
    mechanism: 'engines/maths/contractClauses.ts — clause references per suite; an absent obligation is left absent',
    notClaimed:
      'An amended standard form is the amendment, not the standard. A wrong clause reference is worse than none, because it gets quoted in a letter.',
  },
];

/** The phases a RIBA stage maps onto, for a reader who works in stages rather than phases. */
export function phasesForStage(stage: number): LifecyclePhase[] {
  const entry = RIBA_STAGES.find((candidate) => candidate.stage === stage);
  if (!entry) return [];
  return entry.alsoPhase ? [entry.alsoPhase, entry.phase] : [entry.phase];
}

/** The lifecycle, with the RIBA stages each phase carries and what its gate requires. */
export function lifecycleWithStages(): Array<{
  phase: LifecyclePhase;
  purpose: string;
  stages: number[];
  gate: string[];
}> {
  return LIFECYCLE_ORDER.map((phase) => {
    const gate = PHASE_GATES.find((entry) => entry.phase === phase);
    return {
      phase,
      purpose: gate?.purpose ?? '',
      stages: RIBA_STAGES.filter((entry) => entry.phase === phase || entry.alsoPhase === phase).map((entry) => entry.stage),
      gate: (gate?.exitCriteria ?? []).map((criterion) => criterion.description),
    };
  });
}

// --- Where a project is, in stages ------------------------------------------

export type StageState = 'COMPLETE' | 'CURRENT' | 'NOT_STARTED';

export type StagePosition = {
  stage: number;
  name: string;
  goal: string;
  phase: LifecyclePhase;
  state: StageState;
  /** What the platform actually holds for this stage. Empty is empty, not implied. */
  evidence: string[];
  /** Why the state is what it is, in one sentence a person can argue with. */
  because: string;
  note?: string;
};

/**
 * The project's position across RIBA 0–7.
 *
 * Derived, never stored. There is one lifecycle on this platform and it is
 * `LIFECYCLE_ORDER`; a second state machine holding a stage number beside it
 * would be a second answer to "where is this project", and the two would
 * disagree the first time somebody advanced one and not the other. So a stage
 * is a *view* of the phase the project is in, refined by what the record holds.
 *
 * The refinement matters where a phase carries several stages. CONCEPT carries
 * 0 and 1, DESIGN carries 2, 3 and 4 — and inside DESIGN the platform can be
 * precise, because `assessDesignMaturity` already records a RIBA stage per
 * discipline. The highest stage any discipline has reached is the stage the
 * design is at, and the disciplines are named on it.
 *
 * Where it cannot be precise it says so rather than guessing. A project in
 * CONCEPT with a scope package has met what the concept gate asks; whether it
 * is at stage 0 or stage 1 is not something the record distinguishes, and
 * inventing a distinction would put a number on a screen that nothing behind it
 * supports.
 */
export function stagePosition(input: {
  phase: LifecyclePhase;
  /** Discipline scores from the latest design maturity assessment, if there is one. */
  disciplineStages: Array<{ discipline: string; ribaStage: number; frozen: boolean }>;
  /** Exit criteria of the current phase, as the gate evaluated them. */
  gate: Array<{ description: string; satisfied: boolean }>;
}): StagePosition[] {
  const here = LIFECYCLE_ORDER.indexOf(input.phase);
  // The furthest stage any discipline has been assessed at. A discipline at
  // stage 4 means technical design has started, whatever the others are doing.
  const designReach = input.disciplineStages.reduce((highest, entry) => Math.max(highest, entry.ribaStage), -1);

  return RIBA_STAGES.map((entry) => {
    const at = LIFECYCLE_ORDER.indexOf(entry.phase);
    const evidence: string[] = [];
    let state: StageState;
    let because: string;

    if (at < here) {
      state = 'COMPLETE';
      because = `The project has moved past ${entry.phase.toLowerCase()}, and the gate out of it was met.`;
    } else if (at > here) {
      state = 'NOT_STARTED';
      because = `The project is in ${input.phase.toLowerCase()} and this stage belongs to ${entry.phase.toLowerCase()}.`;
    } else {
      state = 'CURRENT';
      because = `The project is in ${input.phase.toLowerCase()}, which this stage belongs to.`;
      for (const criterion of input.gate) {
        evidence.push(`${criterion.satisfied ? 'Met' : 'Outstanding'} — ${criterion.description}`);
      }
    }

    // Inside DESIGN the record is more precise than the phase is, so use it.
    if (entry.phase === 'DESIGN' && at === here) {
      if (designReach < 0) {
        because = 'The project is in design and no design maturity has been assessed, so the record cannot say which stage the design has reached.';
      } else {
        const atThis = input.disciplineStages.filter((score) => score.ribaStage === entry.stage);
        const beyond = input.disciplineStages.filter((score) => score.ribaStage > entry.stage);
        if (entry.stage < designReach) {
          state = 'COMPLETE';
          because = `Every assessed discipline has passed stage ${entry.stage}; the design has reached stage ${designReach}.`;
        } else if (entry.stage === designReach) {
          state = 'CURRENT';
          because = `The design has been assessed at stage ${designReach}.`;
        } else {
          state = 'NOT_STARTED';
          because = `The design has been assessed at stage ${designReach}, which is short of this one.`;
        }
        for (const score of atThis) {
          evidence.push(`${score.discipline} assessed at stage ${score.ribaStage}${score.frozen ? ', frozen' : ', still moving'}`);
        }
        if (beyond.length > 0) evidence.push(`${beyond.length} discipline${beyond.length === 1 ? '' : 's'} already beyond this stage`);
      }
    }

    return {
      stage: entry.stage,
      name: entry.name,
      goal: entry.goal,
      phase: entry.phase,
      state,
      evidence,
      because,
      ...(entry.note ? { note: entry.note } : {}),
    };
  });
}
