import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';

/**
 * CDM 2015 and the Principal Contractor's duties.
 *
 * The temptation with this stage is to build a document generator: pick a
 * template, merge the project name in, produce a PDF. That is what most of the
 * market sells and it is why so many Construction Phase Plans are generic
 * documents nobody reads.
 *
 * The duties are not documents. Under CDM the Principal Contractor must plan,
 * manage, monitor and coordinate the construction phase; prepare the
 * Construction Phase Plan before the site is set up and keep it current; ensure
 * appointments are competent; induct everyone who works there; and provide
 * welfare. A platform that produces the paperwork but lets work start without
 * it has automated the wrong half.
 *
 * So the documents here are composed from real project state and are refused
 * when the state does not support them — and the duties are enforced as gates:
 *
 *   - No construction-phase work before an approved Construction Phase Plan.
 *   - No worker on site without a recorded induction.
 *   - No document issued without a named competent approver.
 *
 * An agent may draft. A competent person approves. That is the same division
 * the rest of this platform uses, and here it is also the law: a RAMS or a CPP
 * signed by nobody is not a control, it is a file.
 */

// --- Document catalogue --------------------------------------------------------

export type CDMDocumentType =
  | 'CONSTRUCTION_PHASE_PLAN'
  | 'RAMS'
  | 'COSHH_ASSESSMENT'
  | 'TEMPORARY_WORKS_DESIGN_BRIEF'
  | 'LIFTING_PLAN'
  | 'WORKING_AT_HEIGHT_PLAN'
  | 'FIRE_SAFETY_PLAN'
  | 'EMERGENCY_ARRANGEMENTS'
  | 'ENVIRONMENTAL_CONTROL_PLAN'
  | 'TRAFFIC_MANAGEMENT_PLAN'
  | 'SITE_LOGISTICS_PLAN'
  | 'UNDERGROUND_SERVICES_PLAN'
  | 'EXCAVATION_PLAN'
  | 'WORK_EQUIPMENT_REGISTER'
  | 'SITE_INDUCTION'
  | 'TOOLBOX_TALK';

export type DocumentSpec = {
  type: CDMDocumentType;
  label: string;
  /**
   * Sections the document is not valid without. A draft missing one is refused
   * rather than issued with a gap, because the gap is exactly what an inspector
   * looks for.
   */
  requiredSections: string[];
  /** Which role signs it off. Competence is a legal requirement, not a preference. */
  approver: 'SAFETY' | 'PM' | 'EPC';
  /** True where the document must exist before construction-phase work begins. */
  gatesConstruction?: boolean;
};

/**
 * Required sections follow HSE guidance on what a Construction Phase Plan and
 * its supporting documents must actually contain. They are a floor, not a
 * house style — a plan can say more, but not less.
 */
export const CDM_DOCUMENTS: DocumentSpec[] = [
  {
    type: 'CONSTRUCTION_PHASE_PLAN',
    label: 'Construction Phase Plan',
    approver: 'SAFETY',
    gatesConstruction: true,
    requiredSections: [
      'Project description and programme',
      'Management of the work',
      'Duty holders and organisational structure',
      'Health and safety aims',
      'Site rules',
      'Arrangements for controlling significant site risks',
      'Welfare facilities',
      'Fire and emergency procedures',
      'Site induction arrangements',
      'Consultation with workers',
      'Site security',
      'Existing site conditions and pre-construction information',
    ],
  },
  {
    type: 'RAMS',
    label: 'Risk assessment and method statement',
    approver: 'SAFETY',
    requiredSections: ['Scope of works', 'Sequence of operations', 'Hazards and controls', 'Plant and equipment', 'Competence and supervision', 'Emergency arrangements'],
  },
  {
    type: 'COSHH_ASSESSMENT',
    label: 'COSHH assessment',
    approver: 'SAFETY',
    requiredSections: ['Substance and supplier', 'Hazard classification', 'Exposure routes and duration', 'Control measures', 'Personal protective equipment', 'First aid and spillage response', 'Health surveillance'],
  },
  {
    type: 'TEMPORARY_WORKS_DESIGN_BRIEF',
    label: 'Temporary works design brief',
    approver: 'EPC',
    requiredSections: ['Design brief and loadings', 'Temporary works coordinator', 'Design check category', 'Erection and dismantling sequence', 'Inspection regime', 'Permit to load and permit to strike'],
  },
  {
    type: 'LIFTING_PLAN',
    label: 'Lifting plan',
    approver: 'EPC',
    requiredSections: ['Load and lifting equipment', 'Appointed person', 'Ground conditions and outrigger loads', 'Exclusion zones', 'Slinging arrangement', 'Weather limits', 'Communication and signalling'],
  },
  {
    type: 'WORKING_AT_HEIGHT_PLAN',
    label: 'Working at height plan',
    approver: 'SAFETY',
    requiredSections: ['Hierarchy of control applied', 'Access and egress', 'Edge protection', 'Fall arrest and rescue plan', 'Inspection regime', 'Competence of operatives'],
  },
  {
    type: 'FIRE_SAFETY_PLAN',
    label: 'Fire safety plan',
    approver: 'SAFETY',
    requiredSections: ['Fire risk assessment', 'Hot works permit regime', 'Means of escape and signage', 'Fire points and extinguishers', 'Alarm and detection', 'Assembly points', 'Fire marshals'],
  },
  {
    type: 'EMERGENCY_ARRANGEMENTS',
    label: 'Emergency arrangements',
    approver: 'SAFETY',
    requiredSections: ['Emergency scenarios', 'Raising the alarm', 'Assembly and roll call', 'First aid provision', 'Emergency services access', 'Nearest A&E and rescue arrangements', 'Out-of-hours contacts'],
  },
  {
    type: 'ENVIRONMENTAL_CONTROL_PLAN',
    label: 'Environmental control plan',
    approver: 'SAFETY',
    requiredSections: ['Consents and permits', 'Dust and air quality', 'Noise and vibration limits', 'Water and pollution prevention', 'Waste and duty of care', 'Ecology and protected species', 'Spill response'],
  },
  // --- Site management ------------------------------------------------------
  //
  // The four below were missing, and they are not fringe: between them they
  // cover how people and vehicles move on a site and what is under it. Every
  // one of them is a document a site runs on daily and an inspector asks for
  // first, and none of them had anywhere to live in this catalogue — which
  // meant the platform could hold a lifting plan and not a traffic plan, on a
  // site where being run over is a far commoner way to be killed than a
  // dropped load.
  //
  // Authored, not generated. These carry a site's specific arrangements —
  // which gate, which route, whose banksman, which utility's records — and a
  // model does not know any of them. The sections are the floor the document
  // is not valid without; the content is a person's.
  {
    type: 'TRAFFIC_MANAGEMENT_PLAN',
    label: 'Traffic management plan',
    approver: 'SAFETY',
    // Vehicle–pedestrian segregation is the first section for a reason: it is
    // the single control that prevents the commonest fatal site accident, and
    // a plan that describes routes without describing the separation between
    // them has not addressed the hazard it exists for.
    requiredSections: [
      'Vehicle and pedestrian segregation',
      'Site access and egress points',
      'Internal haul routes and one-way system',
      'Speed limits and enforcement',
      'Reversing, banksman and marshalling arrangements',
      'Delivery booking and holding areas',
      'Public highway interface and permissions',
      'Signage, barriers and lighting',
      'Emergency vehicle access',
    ],
  },
  {
    type: 'SITE_LOGISTICS_PLAN',
    label: 'Site logistics plan',
    approver: 'EPC',
    requiredSections: [
      'Site setup and compound layout',
      'Material storage and laydown areas',
      'Craneage and hoisting arrangements',
      'Waste and skip management',
      'Welfare and parking provision',
      'Utilities and temporary supplies',
      'Neighbour and stakeholder constraints',
    ],
  },
  {
    type: 'UNDERGROUND_SERVICES_PLAN',
    label: 'Underground services plan',
    approver: 'EPC',
    // HSG47. Striking a buried service is one of the few site events that can
    // kill somebody who is nowhere near the excavation, and the controls are
    // sequential — plans, then locate, then dig safely — which is why the
    // sections are in that order rather than alphabetical.
    requiredSections: [
      'Utility records obtained and their date',
      'Survey and detection method',
      'Marking on the ground',
      'Safe digging practice and tool restrictions',
      'Trial holes and hand-dig zones',
      'Service diversions and isolations',
      'Emergency procedure on a strike',
    ],
  },
  {
    type: 'EXCAVATION_PLAN',
    label: 'Excavation plan',
    approver: 'EPC',
    requiredSections: [
      'Excavation extent and depth',
      'Ground conditions and groundwater',
      'Support system and design check',
      'Edge protection and access',
      'Spoil placement and surcharge',
      'Adjacent structures and services',
      'Inspection regime and permit to enter',
    ],
  },
  {
    type: 'WORK_EQUIPMENT_REGISTER',
    label: 'Work equipment register',
    approver: 'EPC',
    requiredSections: ['Equipment and identification', 'Statutory inspection dates', 'Thorough examination certificates', 'Operator competence', 'Defect reporting'],
  },
  {
    type: 'SITE_INDUCTION',
    label: 'Site induction',
    approver: 'SAFETY',
    requiredSections: ['Project and duty holders', 'Site rules and PPE', 'Significant risks on this site', 'Welfare and first aid', 'Fire and emergency', 'Reporting incidents and near misses', 'Consultation arrangements'],
  },
  {
    type: 'TOOLBOX_TALK',
    label: 'Toolbox talk',
    approver: 'SAFETY',
    requiredSections: ['Subject', 'Key points', 'Site-specific application', 'Questions raised', 'Attendance'],
  },
];

export function documentSpec(type: CDMDocumentType): DocumentSpec {
  const spec = CDM_DOCUMENTS.find((d) => d.type === type);
  if (!spec) throw new DomainError('CDM_DOCUMENT_TYPE_UNKNOWN', `${type} is not a CDM document type`);
  return spec;
}

// --- Drafting ------------------------------------------------------------------

export type DocumentSection = { heading: string; body: string };

export type DraftResult = {
  documentId: string;
  reference: string;
  type: CDMDocumentType;
  status: 'DRAFT';
  /** Sections the draft could not populate from project state. */
  gaps: string[];
  sections: DocumentSection[];
};

/**
 * Draft a CDM document against the project.
 *
 * The branding, the project name, the duty holders and the significant risks
 * come from the ledger — this is why the document is project-specific rather
 * than a template with a name merged in. Where the platform holds nothing for a
 * required section, the section is emitted with the gap named rather than
 * filled with plausible text. An invented control measure is worse than an
 * empty one, because somebody will read it and believe it.
 */
export function draftDocument(
  ctx: EngineContext,
  input: {
    type: CDMDocumentType;
    title: string;
    /** Sections the author supplies. Anything not supplied is drawn from state or reported as a gap. */
    sections?: DocumentSection[];
    workPackageId?: string;
    /** Set when an agent produced the draft, so authorship is never ambiguous. */
    draftedByAgent?: string;
  },
): DraftResult {
  authorise(ctx, 'SAFETY_RAMS', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'SAFETY_L2' });

  const spec = documentSpec(input.type);
  const supplied = new Map((input.sections ?? []).map((s) => [s.heading, s.body]));

  // What the platform already knows about this project, used to populate the
  // sections that can be populated truthfully.
  const project = ctx.ledger.get({ refType: 'Project', refId: ctx.projectId });
  const risks = ctx.ledger
    .list(ctx.projectId, 'RiskRegisterItem')
    .filter((r) => r.state.status === 'OPEN')
    .map((r) => r.state);
  const rams = ctx.ledger.list(ctx.projectId, 'RAMS').filter((r) => r.state.status === 'APPROVED');

  const fromState = (heading: string): string | undefined => {
    if (!project) return undefined;
    switch (heading) {
      case 'Project description and programme':
        return `${String(project.state.name)} — ${String(project.state.assetType)}. Planned ${String(project.state.plannedStart)} to ${String(project.state.plannedCompletion)}. Contract value ${String(project.state.contractValueMinor)} minor units.`;
      case 'Arrangements for controlling significant site risks':
      case 'Significant risks on this site':
        return risks.length === 0
          ? undefined
          : risks
              .slice(0, 12)
              .map((r) => `${String(r.title)} (${String(r.category)}, severity ${String(r.severity)})`)
              .join('; ');
      case 'Competence and supervision':
        return rams.length === 0 ? undefined : `${rams.length} approved RAMS in force on this project.`;
      case 'Existing site conditions and pre-construction information':
        return `${String((project.state.location as { city?: string }).city ?? '')}, ${String((project.state.location as { countryCode?: string }).countryCode ?? '')}. Sector ${String(project.state.sectorType)}.`;
      default:
        return undefined;
    }
  };

  const gaps: string[] = [];
  const sections: DocumentSection[] = spec.requiredSections.map((heading) => {
    const body = supplied.get(heading) ?? fromState(heading);
    if (!body) {
      gaps.push(heading);
      // Named, not invented. A reader must be able to see what is missing.
      return { heading, body: '[Not yet provided — this section is required before the document can be approved]' };
    }
    return { heading, body };
  });

  // Anything the author added beyond the required floor is kept.
  for (const [heading, body] of supplied) {
    if (!spec.requiredSections.includes(heading)) sections.push({ heading, body });
  }

  const documentId = ulid();
  const sequence = ctx.ledger.list(ctx.projectId, 'CDMDocument').length + 1;
  const reference = `${input.type.split('_')[0]}-${String(sequence).padStart(4, '0')}`;

  write(ctx, {
    eventType: 'CDM_DOCUMENT_DRAFTED',
    entity: { refType: 'CDMDocument', refId: documentId },
    // An agent-authored draft is recorded as such. It is still a draft either
    // way; what changes is who the record says wrote it.
    actor: input.draftedByAgent ? { refType: 'AI', refId: input.draftedByAgent } : undefined,
    nextState: {
      id: documentId,
      projectId: ctx.projectId,
      reference,
      type: input.type,
      label: spec.label,
      title: input.title,
      workPackageId: input.workPackageId,
      sections,
      gaps,
      requiredApprover: spec.approver,
      status: 'DRAFT',
      draftedByAgent: input.draftedByAgent,
      draftedBy: ctx.auth.actorId,
      draftedAt: new Date().toISOString(),
    },
  });

  return { documentId, reference, type: input.type, status: 'DRAFT', gaps, sections };
}

// --- Approval ------------------------------------------------------------------

/**
 * Approve a CDM document.
 *
 * Refuses while any required section is unfilled. This is the point of the
 * whole module: a Construction Phase Plan approved with an empty emergency
 * arrangements section is not a plan, and the platform will not put a
 * competent person's name against one.
 */
export function approveDocument(
  ctx: EngineContext,
  documentId: string,
  input: { comments: string },
): { reference: string; status: string } {
  authorise(ctx, 'SAFETY_RAMS', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'SAFETY_L2' });

  const record = ctx.ledger.get({ refType: 'CDMDocument', refId: documentId });
  if (!record) throw new DomainError('CDM_DOCUMENT_NOT_FOUND', `No document ${documentId}`, 404);
  if (record.state.status === 'APPROVED') {
    throw new DomainError('CDM_DOCUMENT_APPROVED', 'This document is already approved');
  }

  const gaps = (record.state.gaps as string[]) ?? [];
  if (gaps.length > 0) {
    throw new DomainError(
      'CDM_DOCUMENT_INCOMPLETE',
      `This document cannot be approved with ${gaps.length} required section(s) unfilled: ${gaps.join('; ')}`,
    );
  }

  // The role that signs is fixed by the document type. Competence under CDM is
  // a legal requirement, not a routing preference.
  const required = String(record.state.requiredApprover);
  if (!ctx.auth.roles.includes(required as never)) {
    throw new DomainError(
      'CDM_APPROVER_NOT_COMPETENT',
      `A ${String(record.state.label)} is signed off by ${required}, not by ${ctx.auth.roles.join('/')}`,
      403,
    );
  }

  const evidence = registerEvidence(ctx, {
    type: 'CDM_APPROVAL',
    hash: hashEvidence(`${documentId}:${input.comments}:${ctx.auth.actorId}`),
    description: `${String(record.state.label)} ${String(record.state.reference)} approved`,
    linkedEntities: [{ refType: 'CDMDocument', refId: documentId }],
  });

  write(ctx, {
    eventType: 'CDM_DOCUMENT_APPROVED',
    entity: { refType: 'CDMDocument', refId: documentId },
    evidenceRefs: [evidence],
    nextState: {
      ...record.state,
      status: 'APPROVED',
      approvalComments: input.comments,
      approvedBy: ctx.auth.actorId,
      approvedAt: new Date().toISOString(),
      // A CDM document is a living document; a revision resets this.
      revision: Number(record.state.revision ?? 0) + 1,
    },
  });

  return { reference: String(record.state.reference), status: 'APPROVED' };
}

// --- The Principal Contractor's gates -------------------------------------------

/** Is there a current, approved Construction Phase Plan? */
export function constructionPhasePlan(ctx: EngineContext): Record<string, unknown> | undefined {
  return ctx.ledger
    .list(ctx.projectId, 'CDMDocument')
    .map((r) => r.state)
    .filter((d) => d.type === 'CONSTRUCTION_PHASE_PLAN' && d.status === 'APPROVED')
    .at(-1);
}

/**
 * Refuse construction-phase work without an approved Construction Phase Plan.
 *
 * CDM requires the plan before the site is set up, not before the first
 * inspection. A platform that lets work be recorded without one is recording a
 * breach and calling it progress.
 */
export function assertConstructionPhasePlan(ctx: EngineContext): void {
  if (!constructionPhasePlan(ctx)) {
    throw new DomainError(
      'CONSTRUCTION_PHASE_PLAN_REQUIRED',
      'No approved Construction Phase Plan is in place. Under CDM the plan must be prepared before the construction phase begins.',
    );
  }
}

/** Record a site induction. Nobody works on site without one. */
export function recordInduction(
  ctx: EngineContext,
  input: {
    personId: string;
    personName: string;
    employer: string;
    inductedBy: string;
    /** Competencies presented and checked at induction — CSCS, CPCS, SSSTS. */
    competenciesChecked: string[];
    documentId?: string;
  },
): { inductionId: string; validUntil: string } {
  authorise(ctx, 'SAFETY_RAMS', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'SAFETY_L2' });

  // An induction against a site with no plan is a formality with nothing behind
  // it: there are no site rules to brief because nobody has approved any.
  assertConstructionPhasePlan(ctx);

  const inductionId = ulid();
  const validUntil = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);

  write(ctx, {
    eventType: 'INDUCTION_RECORDED',
    entity: { refType: 'Induction', refId: inductionId },
    nextState: {
      id: inductionId,
      projectId: ctx.projectId,
      personId: input.personId,
      personName: input.personName,
      employer: input.employer,
      inductedBy: input.inductedBy,
      competenciesChecked: input.competenciesChecked,
      documentId: input.documentId,
      validUntil,
      recordedBy: ctx.auth.actorId,
      recordedAt: new Date().toISOString(),
    },
  });

  return { inductionId, validUntil };
}

/** Has this person been inducted onto this site, and is it still current? */
export function isInducted(ctx: EngineContext, personId: string, today = new Date().toISOString().slice(0, 10)): boolean {
  return ctx.ledger
    .list(ctx.projectId, 'Induction')
    .some((r) => r.state.personId === personId && String(r.state.validUntil) >= today);
}

export function assertInducted(ctx: EngineContext, personId: string): void {
  if (!isInducted(ctx, personId)) {
    throw new DomainError(
      'INDUCTION_REQUIRED',
      `${personId} has no current site induction. Under CDM the Principal Contractor must induct everyone who works on the site.`,
    );
  }
}

/** Record a toolbox talk and who attended it. */
export function recordToolboxTalk(
  ctx: EngineContext,
  input: { subject: string; deliveredBy: string; keyPoints: string[]; attendees: string[]; documentId?: string },
): { talkId: string; attendees: number } {
  authorise(ctx, 'SAFETY_RAMS', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'SAFETY_L2' });

  if (input.attendees.length === 0) {
    throw new DomainError('ATTENDANCE_REQUIRED', 'A toolbox talk with no attendance recorded briefed nobody');
  }

  const talkId = ulid();
  write(ctx, {
    eventType: 'TOOLBOX_TALK_DELIVERED',
    entity: { refType: 'ToolboxTalk', refId: talkId },
    nextState: {
      id: talkId,
      projectId: ctx.projectId,
      subject: input.subject,
      deliveredBy: input.deliveredBy,
      keyPoints: input.keyPoints,
      attendees: input.attendees,
      documentId: input.documentId,
      deliveredAt: new Date().toISOString(),
      recordedBy: ctx.auth.actorId,
    },
  });

  return { talkId, attendees: input.attendees.length };
}

// --- Duty position ---------------------------------------------------------------

export type PrincipalContractorPosition = {
  constructionPhasePlan: { inPlace: boolean; reference?: string; approvedAt?: string; revision?: number };
  documents: Array<{ type: string; label: string; approved: number; draft: number; gaps: number }>;
  inductions: { total: number; current: number };
  toolboxTalks: { delivered: number; attendances: number };
  /** Duties the platform can see are not being met. */
  breaches: string[];
};

/**
 * What the Principal Contractor can and cannot evidence.
 *
 * Written as breaches rather than a score. A percentage invites somebody to
 * report 87% compliant; a list of named failures does not.
 */
export function principalContractorPosition(ctx: EngineContext): PrincipalContractorPosition {
  authorise(ctx, 'SAFETY_RAMS', 'R');

  const documents = ctx.ledger.list(ctx.projectId, 'CDMDocument').map((r) => r.state);
  const inductions = ctx.ledger.list(ctx.projectId, 'Induction').map((r) => r.state);
  const talks = ctx.ledger.list(ctx.projectId, 'ToolboxTalk').map((r) => r.state);
  const today = new Date().toISOString().slice(0, 10);
  const cpp = constructionPhasePlan(ctx);
  const phase = currentPhase(ctx);

  const breaches: string[] = [];
  if (!cpp && (phase === 'CONSTRUCTION' || phase === 'COMMISSIONING')) {
    breaches.push('Construction phase has begun with no approved Construction Phase Plan');
  }
  if (cpp && inductions.length === 0) {
    breaches.push('No site inductions recorded');
  }
  for (const document of documents.filter((d) => d.status === 'DRAFT' && ((d.gaps as string[]) ?? []).length > 0)) {
    breaches.push(`${String(document.label)} ${String(document.reference)} has ${((document.gaps as string[]) ?? []).length} unfilled required section(s)`);
  }

  return {
    constructionPhasePlan: cpp
      ? { inPlace: true, reference: String(cpp.reference), approvedAt: String(cpp.approvedAt), revision: Number(cpp.revision ?? 1) }
      : { inPlace: false },
    documents: CDM_DOCUMENTS.map((spec) => {
      const of = documents.filter((d) => d.type === spec.type);
      return {
        type: spec.type,
        label: spec.label,
        approved: of.filter((d) => d.status === 'APPROVED').length,
        draft: of.filter((d) => d.status === 'DRAFT').length,
        gaps: of.reduce((sum, d) => sum + ((d.gaps as string[]) ?? []).length, 0),
      };
    }),
    inductions: { total: inductions.length, current: inductions.filter((i) => String(i.validUntil) >= today).length },
    toolboxTalks: {
      delivered: talks.length,
      attendances: talks.reduce((sum, t) => sum + ((t.attendees as string[]) ?? []).length, 0),
    },
    breaches,
  };
}
