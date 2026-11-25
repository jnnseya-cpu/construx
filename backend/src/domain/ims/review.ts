import { DomainError } from '../../core/errors.ts';
import { canonicalize, sha256 } from '../../core/canonical.ts';
import { ulid } from '../../core/ids.ts';
import { write, type EngineContext } from '../../engines/context.ts';
import { riddorPosition } from '../riddor.ts';
import { actions, raiseAction } from './actions.ts';
import { auditProgramme, findings } from './audits.ts';
import { isStandard, type Standard } from './clauses.ts';
import { documentRegister } from './documents.ts';
import { activePeople, addMonths, guard, isoDate, nameOf, nextReference, stateOf, text, today, type Person } from './ims.ts';
import { competenceMatrix, supplierPerformance } from './monitoring.ts';
import { registersPosition } from './registers.ts';
import { complaints, consultations, drills, surveys } from './engagement.ts';

/**
 * The company-wide view, and management review (clause 9.3 of all three).
 *
 * `companyPosition` rolls up every project and the system itself for a period:
 * incidents and the RIDDOR clock, NCRs, corrective actions, audit results,
 * compliance evaluations, significant aspects, objectives, supplier performance,
 * competence and the state of the documents. Each figure is counted from the
 * records, never entered.
 *
 * A management review **freezes** that position as its inputs when it is opened
 * — so what top management reviewed is what is on the record, with its hash —
 * and records the discussion of each input, the decisions and the actions they
 * raise. It is approved by top management, not by the person who prepared it,
 * and only once every input has been discussed and at least one output
 * recorded. Once approved it does not change.
 */

/** Who counts as top management for approving a management review. */
export const TOP_MANAGEMENT_ROLES = ['OWNER', 'EXECUTIVE', 'PROJECT_DIRECTOR'] as const;

export type ReviewInput = { key: string; title: string; clauses: string; summary: string; figures: Record<string, number | string | null> };

const inPeriod = (value: unknown, from: string, to: string) => {
  const date = String(value ?? '').slice(0, 10);
  return date >= from && date <= to;
};

export function companyPosition(ctx: EngineContext, people: readonly Person[], period: { from: string; to: string }) {
  guard(ctx, 'R');
  const from = isoDate(period.from, 'from');
  const to = isoDate(period.to, 'to');
  if (to < from) throw new DomainError('IMS_PERIOD', 'The period ends after it starts.', 422, [{ field: 'to', message: 'after from' }]);
  const on = today();
  const projects = ctx.ledger.listByTenant(ctx.tenantId, 'Project').filter((record) => !record.refId.endsWith('-governance'));
  const delivery = (type: string) => ctx.ledger.listByTenant(ctx.tenantId, type).filter((record) => !record.projectId.endsWith('-governance'));

  const incidents = delivery('Incident').filter((record) => inPeriod(record.state.occurredAt, from, to));
  const riddor = incidents.map((record) => riddorPosition({ refId: record.refId, projectId: record.projectId, state: record.state as Record<string, unknown> }, on)).filter((entry) => entry !== null);
  const byCategory: Record<string, number> = {};
  for (const record of incidents) byCategory[String(record.state.category)] = (byCategory[String(record.state.category)] ?? 0) + 1;

  const ncrs = delivery('NCR');
  const ncrsRaised = ncrs.filter((record) => inPeriod(record.state.raisedAt, from, to));
  const allActions = actions(ctx);
  const verifiedInPeriod = allActions.filter((action) => action.verification && inPeriod(action.verification.on, from, to));
  const programme = auditProgramme(ctx, people);
  const completedAudits = programme.audits.filter((audit) => audit.status === 'COMPLETED' && inPeriod(audit.completed?.on, from, to));
  const periodFindings = findings(ctx).filter((finding) => completedAudits.some((audit) => audit.id === finding.auditId));
  const registers = registersPosition(ctx, people);
  const evaluations = registers.obligations.flatMap((entry) => entry.evaluations.filter((evaluation) => inPeriod(evaluation.on, from, to)));
  const suppliers = supplierPerformance(ctx, people);
  const competence = competenceMatrix(ctx, people);
  const library = documentRegister(ctx, people);
  const previousReviews = reviews(ctx).filter((review) => review.status === 'APPROVED' && review.heldOn < from);
  const previous = previousReviews.at(-1);
  const previousActions = previous ? allActions.filter((action) => action.source.kind === 'MANAGEMENT_REVIEW' && action.source.refId === previous.id) : [];
  const count = (list: unknown[]) => list.length;
  const periodSurveys = surveys(ctx).filter((entry) => inPeriod(entry.surveyedOn, from, to));
  const averageScore = periodSurveys.length ? Math.round((periodSurveys.reduce((sum, entry) => sum + entry.score, 0) / periodSurveys.length) * 10) / 10 : null;
  const periodComplaints = complaints(ctx).filter((entry) => inPeriod(entry.receivedOn, from, to));
  const periodConsultations = consultations(ctx).filter((entry) => inPeriod(entry.on, from, to));
  const allDrills = drills(ctx);
  const periodDrills = allDrills.filter((entry) => entry.status === 'HELD' && inPeriod(entry.held?.on, from, to));
  const grade = (value: string) => periodFindings.filter((finding) => finding.grade === value).length;

  const inputs: ReviewInput[] = [
    {
      key: 'previousActions',
      title: 'Status of actions from previous management reviews',
      clauses: '9.3.2 a',
      summary: previous
        ? `${previous.reference} (${previous.heldOn}) raised ${previousActions.length} action(s): ${previousActions.filter((action) => action.status === 'CLOSED').length} closed, ${previousActions.filter((action) => action.status !== 'CLOSED').length} still open.`
        : 'No earlier management review is on the record.',
      figures: { previousReview: previous?.reference ?? null, raised: previousActions.length, closed: previousActions.filter((action) => action.status === 'CLOSED').length },
    },
    {
      key: 'objectives',
      title: 'Extent to which objectives have been met',
      clauses: '9.3.2 c',
      summary: `${count(registers.objectives)} objective(s): ${registers.objectives.filter((objective) => objective.status === 'ACHIEVED').length} achieved, ${registers.objectives.filter((objective) => objective.status === 'NOT_ACHIEVED').length} not achieved, ${registers.objectives.filter((objective) => objective.status === 'OPEN').length} open (${registers.objectives.filter((objective) => objective.overdue).length} past their date).`,
      figures: {
        total: registers.objectives.length,
        achieved: registers.objectives.filter((objective) => objective.status === 'ACHIEVED').length,
        notAchieved: registers.objectives.filter((objective) => objective.status === 'NOT_ACHIEVED').length,
        open: registers.objectives.filter((objective) => objective.status === 'OPEN').length,
        overdue: registers.objectives.filter((objective) => objective.overdue).length,
      },
    },
    {
      key: 'nonconformities',
      title: 'Nonconformities and corrective actions',
      clauses: '9.3.2 c, 10.2',
      summary: `${ncrsRaised.length} NCR(s) raised on the projects in the period (${ncrs.filter((record) => record.state.status === 'OPEN').length} open now). ${allActions.filter((action) => action.status !== 'CLOSED').length} corrective or improvement action(s) open, ${allActions.filter((action) => action.status === 'OPEN' && action.dueOn < on).length} past due; ${verifiedInPeriod.filter((action) => action.verification!.effective).length} verified effective and ${verifiedInPeriod.filter((action) => !action.verification!.effective).length} found not effective in the period.`,
      figures: {
        ncrsRaised: ncrsRaised.length,
        ncrsOpen: ncrs.filter((record) => record.state.status === 'OPEN').length,
        actionsOpen: allActions.filter((action) => action.status !== 'CLOSED').length,
        actionsOverdue: allActions.filter((action) => action.status === 'OPEN' && action.dueOn < on).length,
        verifiedEffective: verifiedInPeriod.filter((action) => action.verification!.effective).length,
        notEffective: verifiedInPeriod.filter((action) => !action.verification!.effective).length,
      },
    },
    {
      key: 'incidents',
      title: 'Incidents, and the RIDDOR position',
      clauses: 'ISO 45001 9.3 d, 10.2',
      summary: `${incidents.length} incident(s) recorded across ${projects.length} project(s) in the period${
        Object.keys(byCategory).length ? ` (${Object.entries(byCategory).map(([category, n]) => `${n} ${category.toLowerCase().replace(/_/g, ' ')}`).join(', ')})` : ''
      }. ${riddor.length} reportable under RIDDOR: ${riddor.filter((entry) => entry.status === 'REPORTED').length} reported on time, ${riddor.filter((entry) => entry.status === 'REPORTED_LATE').length} late, ${riddor.filter((entry) => entry.status === 'DUE' || entry.status === 'OVERDUE' || entry.status === 'UNCLASSIFIED').length} not yet reported.`,
      figures: {
        incidents: incidents.length,
        reportable: riddor.length,
        reportedOnTime: riddor.filter((entry) => entry.status === 'REPORTED').length,
        reportedLate: riddor.filter((entry) => entry.status === 'REPORTED_LATE').length,
        notReported: riddor.filter((entry) => entry.status === 'DUE' || entry.status === 'OVERDUE' || entry.status === 'UNCLASSIFIED').length,
      },
    },
    {
      key: 'audits',
      title: 'Audit results',
      clauses: '9.3.2 c',
      summary: `${completedAudits.length} internal audit(s) completed in the period with ${grade('MAJOR_NC')} major and ${grade('MINOR_NC')} minor nonconformities, ${grade('OBSERVATION')} observations and ${grade('OPPORTUNITY')} opportunities. ${programme.coverage.filter((entry) => entry.uncovered).length} clause(s) not covered by the programme.`,
      figures: { completed: completedAudits.length, majorNc: grade('MAJOR_NC'), minorNc: grade('MINOR_NC'), observations: grade('OBSERVATION'), uncoveredClauses: programme.coverage.filter((entry) => entry.uncovered).length },
    },
    {
      key: 'compliance',
      title: 'Evaluation of compliance with legal and other requirements',
      clauses: 'ISO 14001 / 45001 9.1.2, 9.3',
      summary: `${registers.obligations.filter((entry) => entry.status === 'ACTIVE').length} requirement(s) in the register; ${evaluations.length} evaluation(s) in the period — ${evaluations.filter((evaluation) => evaluation.result === 'COMPLIANT').length} compliant, ${evaluations.filter((evaluation) => evaluation.result === 'PARTIAL').length} partial, ${evaluations.filter((evaluation) => evaluation.result === 'NON_COMPLIANT').length} not compliant. ${registers.obligations.filter((entry) => entry.evaluationDue).length} due for evaluation now.`,
      figures: {
        requirements: registers.obligations.filter((entry) => entry.status === 'ACTIVE').length,
        evaluated: evaluations.length,
        partial: evaluations.filter((evaluation) => evaluation.result === 'PARTIAL').length,
        nonCompliant: evaluations.filter((evaluation) => evaluation.result === 'NON_COMPLIANT').length,
        due: registers.obligations.filter((entry) => entry.evaluationDue).length,
      },
    },
    {
      key: 'aspects',
      title: 'Significant environmental aspects',
      clauses: 'ISO 14001 9.3 b',
      summary: `${registers.aspects.filter((aspect) => aspect.status === 'ACTIVE').length} active aspect(s), ${registers.aspects.filter((aspect) => aspect.significant).length} significant at the company’s threshold of ${registers.threshold}.`,
      figures: { active: registers.aspects.filter((aspect) => aspect.status === 'ACTIVE').length, significant: registers.aspects.filter((aspect) => aspect.significant).length },
    },
    {
      key: 'suppliers',
      title: 'Performance of external providers',
      clauses: 'ISO 9001 9.3.2 c',
      summary: `${suppliers.length} supplier(s) in the register: ${suppliers.filter((supplier) => supplier.latest).length} evaluated, ${suppliers.filter((supplier) => supplier.toReview).length} below the company’s score and put to review, ${suppliers.filter((supplier) => supplier.evaluationDue).length} due for evaluation.`,
      figures: { suppliers: suppliers.length, evaluated: suppliers.filter((supplier) => supplier.latest).length, toReview: suppliers.filter((supplier) => supplier.toReview).length, due: suppliers.filter((supplier) => supplier.evaluationDue).length },
    },
    {
      key: 'resources',
      title: 'Adequacy of resources, including competence',
      clauses: '9.3.2 d, 7.2',
      summary: `${competence.rows.length} people in roles with competence requirements; ${competence.gaps} gap(s) (missing or expired), ${competence.expiring} expiring soon. ${activePeople(people).length} active people in the company.`,
      figures: { peopleInScope: competence.rows.length, gaps: competence.gaps, expiring: competence.expiring },
    },
    {
      key: 'documents',
      title: 'The documented system',
      clauses: '7.5',
      summary: `${library.filter((document) => document.status === 'EFFECTIVE').length} document(s) in force, ${library.filter((document) => document.draft).length} draft(s) awaiting approval, ${library.filter((document) => document.reviewOverdue).length} past review; ${library.reduce((sum, document) => sum + document.acknowledgement.outstanding.length, 0)} read-and-understood acknowledgement(s) outstanding.`,
      figures: {
        inForce: library.filter((document) => document.status === 'EFFECTIVE').length,
        drafts: library.filter((document) => document.draft).length,
        reviewOverdue: library.filter((document) => document.reviewOverdue).length,
        acknowledgementsOutstanding: library.reduce((sum, document) => sum + document.acknowledgement.outstanding.length, 0),
      },
    },
    {
      key: 'context',
      title: 'Changes in external and internal issues, and in the needs of interested parties',
      clauses: '9.3.2 b',
      summary: 'Not held in the records: the review records what has changed — the market, legislation, clients, the workforce, the climate.',
      figures: {},
    },
    {
      key: 'customers',
      title: 'Customer satisfaction and complaints',
      clauses: 'ISO 9001 9.3.2 c, 9.1.2',
      summary: `${periodSurveys.length} satisfaction survey(s) in the period${periodSurveys.length ? `, averaging ${averageScore} out of 5` : ''}. ${periodComplaints.length} complaint(s) received: ${periodComplaints.filter((entry) => entry.status !== 'OPEN').length} answered, ${periodComplaints.filter((entry) => entry.status === 'OPEN').length} not yet answered, ${periodComplaints.filter((entry) => entry.actionId).length} raised a corrective action.`,
      figures: {
        surveys: periodSurveys.length,
        averageScore,
        complaints: periodComplaints.length,
        unanswered: periodComplaints.filter((entry) => entry.status === 'OPEN').length,
        actioned: periodComplaints.filter((entry) => entry.actionId).length,
      },
    },
    {
      key: 'consultation',
      title: 'Consultation and participation of workers, and communication with interested parties',
      clauses: 'ISO 45001 9.3 d, 5.4; ISO 14001 9.3 c',
      summary: `${periodConsultations.length} consultation(s) with ${periodConsultations.reduce((sum, entry) => sum + entry.participants, 0)} worker participation(s) in the period; ${periodConsultations.filter((entry) => entry.status === 'ANSWERED').length} answered, ${periodConsultations.filter((entry) => entry.status === 'OPEN').length} not yet answered. Other communications with interested parties are minuted by the review.`,
      figures: {
        consultations: periodConsultations.length,
        participations: periodConsultations.reduce((sum, entry) => sum + entry.participants, 0),
        unanswered: periodConsultations.filter((entry) => entry.status === 'OPEN').length,
      },
    },
    {
      key: 'emergency',
      title: 'Emergency preparedness',
      clauses: 'ISO 14001 / 45001 8.2',
      summary: `${periodDrills.length} drill(s) held in the period — ${periodDrills.filter((entry) => entry.held?.outcome === 'EFFECTIVE').length} effective, ${periodDrills.filter((entry) => entry.held?.outcome === 'PARTLY_EFFECTIVE').length} partly, ${periodDrills.filter((entry) => entry.held?.outcome === 'NOT_EFFECTIVE').length} not effective; ${allDrills.filter((entry) => entry.status === 'PLANNED' && entry.plannedOn < on).length} planned drill(s) overdue.`,
      figures: {
        held: periodDrills.length,
        effective: periodDrills.filter((entry) => entry.held?.outcome === 'EFFECTIVE').length,
        notFullyEffective: periodDrills.filter((entry) => entry.held && entry.held.outcome !== 'EFFECTIVE').length,
        overdue: allDrills.filter((entry) => entry.status === 'PLANNED' && entry.plannedOn < on).length,
      },
    },
  ];
  return { period: { from, to }, projects: projects.length, inputs };
}

// =============================================================================
// The management review
// =============================================================================

export const OUTPUT_KINDS = ['IMPROVEMENT', 'CHANGE', 'RESOURCE', 'DECISION'] as const;

export type ImsManagementReview = {
  id: string;
  reference: string;
  periodFrom: string;
  periodTo: string;
  heldOn: string;
  chairId: string;
  attendees: string[];
  inputs: ReviewInput[];
  inputsHash: string;
  frozenAt: string;
  minutes: Record<string, string>;
  outputs: Array<{ id: string; kind: (typeof OUTPUT_KINDS)[number]; text: string; actionId?: string }>;
  status: 'DRAFT' | 'APPROVED';
  approved?: { by: string; at: string; note: string };
  preparedBy: string;
  preparedAt: string;
};

export const reviews = (ctx: EngineContext): Array<ImsManagementReview & { version: number }> =>
  ctx.ledger
    .list(ctx.projectId, 'ImsManagementReview')
    .map((record) => ({ ...(record.state as unknown as ImsManagementReview), version: record.version }))
    .sort((a, b) => a.heldOn.localeCompare(b.heldOn));

export function reviewOf(ctx: EngineContext, id: string): ImsManagementReview & { version: number } {
  const found = stateOf<ImsManagementReview>(ctx, 'ImsManagementReview', id);
  if (!found) throw new DomainError('IMS_REVIEW_NOT_FOUND', 'No such management review.', 404);
  return found;
}

const stripVersion = <T extends { version?: number }>(value: T): Omit<T, 'version'> => {
  const { version: _version, ...rest } = value;
  return rest;
};

function draftOf(ctx: EngineContext, id: string) {
  const review = reviewOf(ctx, id);
  if (review.status !== 'DRAFT') throw new DomainError('IMS_REVIEW_APPROVED', `${review.reference} is approved; it does not change.`, 409);
  return review;
}

function frozen(ctx: EngineContext, people: readonly Person[], from: string, to: string) {
  const position = companyPosition(ctx, people, { from, to });
  return { inputs: position.inputs, inputsHash: sha256(canonicalize(position.inputs)), frozenAt: new Date().toISOString() };
}

/** Open a review for a period: the company's position for it is frozen as the review's inputs. */
export function openReview(ctx: EngineContext, people: readonly Person[], input: { periodFrom: string; periodTo: string; heldOn: string; chairId: string; attendees?: string[] }): ImsManagementReview {
  guard(ctx, 'C');
  const periodFrom = isoDate(input.periodFrom, 'periodFrom');
  const periodTo = isoDate(input.periodTo, 'periodTo');
  const heldOn = isoDate(input.heldOn, 'heldOn', 'The date it is held, YYYY-MM-DD.');
  const chair = activePeople(people).find((person) => person.id === input.chairId);
  if (!chair) throw new DomainError('IMS_PERSON_NOT_FOUND', 'The chair must be an active person in the company.', 422, [{ field: 'chairId', message: 'choose a person' }]);
  if (!chair.roles.some((role) => (TOP_MANAGEMENT_ROLES as readonly string[]).includes(role))) {
    throw new DomainError('IMS_REVIEW_CHAIR', 'A management review is chaired by top management — the owner, an executive or a project director.', 422, [{ field: 'chairId', message: 'top management' }]);
  }
  const review: ImsManagementReview = {
    id: ulid(),
    reference: nextReference(ctx, 'ImsManagementReview', 'MR'),
    periodFrom,
    periodTo,
    heldOn,
    chairId: chair.id,
    attendees: [...new Set((input.attendees ?? []).map((name) => String(name).trim()).filter(Boolean))].slice(0, 40),
    ...frozen(ctx, people, periodFrom, periodTo),
    minutes: {},
    outputs: [],
    status: 'DRAFT',
    preparedBy: ctx.auth.actorId,
    preparedAt: new Date().toISOString(),
  };
  write(ctx, { eventType: 'IMS_REVIEW_OPENED', entity: { refType: 'ImsManagementReview', refId: review.id }, nextState: review as unknown as Record<string, unknown>, reason: `${review.reference} for ${periodFrom} to ${periodTo}, held ${heldOn}; inputs frozen ${review.inputsHash.replace(/^sha256:/, '').slice(0, 12)}` });
  return review;
}

/** Freeze the position again — for a review prepared ahead of the meeting — while it is a draft. */
export function refreshInputs(ctx: EngineContext, people: readonly Person[], id: string): ImsManagementReview {
  guard(ctx, 'U');
  const review = draftOf(ctx, id);
  const next = { ...stripVersion(review), ...frozen(ctx, people, review.periodFrom, review.periodTo) };
  write(ctx, { eventType: 'IMS_REVIEW_INPUTS_REFRESHED', entity: { refType: 'ImsManagementReview', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${review.reference} inputs frozen again ${next.inputsHash.replace(/^sha256:/, '').slice(0, 12)}` });
  return next;
}

/** The discussion of one input, as minuted. */
export function minuteInput(ctx: EngineContext, id: string, input: { key: string; text: string }): ImsManagementReview {
  guard(ctx, 'U');
  const review = draftOf(ctx, id);
  if (!review.inputs.some((entry) => entry.key === input.key)) throw new DomainError('IMS_REVIEW_INPUT', 'Not an input of this review.', 422, [{ field: 'key', message: 'an input' }]);
  const minute = text(input.text, 'text', 10, 'Minute what was concluded about this input.', 8000);
  // The same words again change nothing, and say so by changing nothing.
  if (review.minutes[input.key] === minute) return stripVersion(review);
  const next = { ...stripVersion(review), minutes: { ...review.minutes, [input.key]: minute } };
  write(ctx, { eventType: 'IMS_REVIEW_MINUTED', entity: { refType: 'ImsManagementReview', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${review.reference}: ${input.key} minuted` });
  return next;
}

/** A decision or action of the review. One with an owner and a date raises its action, sourced to the review. */
export function addOutput(
  ctx: EngineContext,
  id: string,
  input: { kind: string; text: string; action?: { ownerId: string; dueOn: string; standards: string[] } },
): ImsManagementReview {
  guard(ctx, 'U');
  const review = draftOf(ctx, id);
  if (!(OUTPUT_KINDS as readonly string[]).includes(input.kind)) throw new DomainError('IMS_REVIEW_OUTPUT', `The output is one of ${OUTPUT_KINDS.join(', ')}.`, 422, [{ field: 'kind', message: 'choose one' }]);
  const outputText = text(input.text, 'text', 10, 'State the decision or the action.', 4000);
  let actionId: string | undefined;
  if (input.action) {
    const standards = (input.action.standards ?? []).filter(isStandard) as Standard[];
    actionId = raiseAction(
      ctx,
      {
        kind: 'IMPROVEMENT',
        source: { kind: 'MANAGEMENT_REVIEW', refType: 'ImsManagementReview', refId: review.id, label: `${review.reference} management review` },
        standards: standards.length ? standards : ['ISO9001'],
        description: outputText,
        ownerId: input.action.ownerId,
        dueOn: input.action.dueOn,
      },
      { eventCause: `Raised by management review ${review.reference}` },
    ).id;
  }
  const current = reviewOf(ctx, id);
  const next = { ...stripVersion(current), outputs: [...current.outputs, { id: ulid(), kind: input.kind as ImsManagementReview['outputs'][number]['kind'], text: outputText, ...(actionId ? { actionId } : {}) }] };
  write(ctx, { eventType: 'IMS_REVIEW_OUTPUT_ADDED', entity: { refType: 'ImsManagementReview', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${review.reference}: ${input.kind.toLowerCase()} — ${outputText.slice(0, 120)}` });
  return next;
}

export function approveReview(ctx: EngineContext, id: string, input: { note: string }): ImsManagementReview {
  guard(ctx, 'A');
  const review = draftOf(ctx, id);
  if (!ctx.auth.roles.some((role) => (TOP_MANAGEMENT_ROLES as readonly string[]).includes(role))) {
    throw new DomainError('IMS_REVIEW_TOP_MANAGEMENT', 'A management review is approved by top management.', 403);
  }
  if (review.preparedBy === ctx.auth.actorId) throw new DomainError('IMS_REVIEW_SAME_PERSON', 'A management review is approved by somebody other than the person who prepared it.', 403);
  const undiscussed = review.inputs.filter((entry) => !review.minutes[entry.key]);
  if (undiscussed.length) {
    throw new DomainError('IMS_REVIEW_INCOMPLETE', `Every input is considered: not yet minuted — ${undiscussed.map((entry) => entry.title).join('; ')}.`, 409, undiscussed.map((entry) => ({ field: `minutes.${entry.key}`, message: 'not minuted' })));
  }
  if (review.outputs.length === 0) throw new DomainError('IMS_REVIEW_NO_OUTPUT', 'A review records its decisions and actions: add at least one output.', 409);
  const note = text(input.note, 'note', 5, 'Say what is approved.', 2000);
  const next = { ...stripVersion(review), status: 'APPROVED' as const, approved: { by: ctx.auth.actorId, at: new Date().toISOString(), note } };
  write(ctx, { eventType: 'IMS_REVIEW_APPROVED', entity: { refType: 'ImsManagementReview', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${review.reference} approved: ${note}` });
  return next;
}

export function reviewRegister(ctx: EngineContext, people: readonly Person[]) {
  guard(ctx, 'R');
  const all = reviews(ctx);
  const lastApproved = all.filter((review) => review.status === 'APPROVED').at(-1);
  return {
    reviews: all.map((review) => ({ ...review, chair: nameOf(people, review.chairId), preparer: nameOf(people, review.preparedBy) })),
    lastApprovedOn: lastApproved?.heldOn ?? null,
    nextDueBy: lastApproved ? addMonths(lastApproved.heldOn, 12) : null,
    outputKinds: OUTPUT_KINDS,
    topManagementRoles: TOP_MANAGEMENT_ROLES,
  };
}
