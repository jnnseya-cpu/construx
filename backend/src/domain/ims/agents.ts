import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { expertPersona } from '../../ai/expertise.ts';
import { SOURCE_MATERIAL_RULE } from '../../ai/sourcematerial.ts';
import { runAI, write, type EngineContext } from '../../engines/context.ts';
import { isRole } from '../../identity/roles.ts';
import { actionOf, updateAction } from './actions.ts';
import { auditOf, setChecklist } from './audits.ts';
import { CLAUSES, clauseById, clauseLabel, isClauseId, isStandard, STANDARDS, type Standard } from './clauses.ts';
import { DOCUMENT_TYPES, documentOf, documents, draftDocument, redraftDocument } from './documents.ts';
import { activePeople, guard, stateOf, states, today, type Person } from './ims.ts';
import { LEGISLATION, legislationByKey } from './legislation.ts';
import { aspects, CONDITIONS, obligations, recordAspect, recordObligation, setObjective } from './registers.ts';
import { addOutput, companyPosition, minuteInput, OUTPUT_KINDS, reviewOf } from './review.ts';

/**
 * The management system's agents: the AI drafts, a person decides.
 *
 * Eight agents on the Risk, Safety & Compliance engine, each filing proposals —
 * never the record itself:
 *
 * - **Procedure**: a policy (or a brief) turned into a working procedure, with
 *   the clauses it meets and the roles it is issued to.
 * - **Clause mapping**: which clauses of its standards a document meets.
 * - **Audit checklist**: the questions an audit asks, against its clauses and
 *   the procedures it samples.
 * - **Root cause**: the likely cause of a problem and the actions on it.
 * - **Review minutes**: a minute for each input of a management review drawn
 *   from its frozen figures, and the decisions they suggest.
 * - **Aspects**: the environmental aspects of the company's activities, scored.
 * - **Legal register**: which requirements apply — chosen **only** from the
 *   legislation list, so it cannot invent an Act.
 * - **Objectives**: measurable objectives from the company position.
 *
 * Everything the agent returns is checked in code before anybody sees it: a
 * clause that is not a clause of the document's standards, a role that does not
 * exist, a checklist item outside the audit's scope, an input the review does
 * not have, a score outside 1–5, an Act not on the list, a date in the past —
 * each is dropped and counted. Accepting runs the ordinary command **as the
 * person accepting it**, with any edits they make: a drafted procedure is still
 * a draft that somebody other than its author must approve, a drafted minute is
 * still part of a review top management must approve.
 */

export const AGENT_KINDS = ['PROCEDURE', 'CLAUSE_MAPPING', 'AUDIT_CHECKLIST', 'ROOT_CAUSE', 'REVIEW_MINUTES', 'ASPECT', 'OBLIGATION', 'OBJECTIVE'] as const;
export type ImsAgentKind = (typeof AGENT_KINDS)[number];

export type ImsAgentProposal = {
  id: string;
  kind: ImsAgentKind;
  runId: string;
  summary: string;
  payload: Record<string, unknown>;
  status: 'PROPOSED' | 'ACCEPTED' | 'REJECTED';
  proposedAt: string;
  requestedBy: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
  result?: { refType: string; refId: string };
};

export type AgentRun = { runId: string; proposed: number; dropped: number; provider: string; modelClass?: string };

export const agentProposals = (ctx: EngineContext): ImsAgentProposal[] => states<ImsAgentProposal>(ctx, 'ImsAgentProposal');

const MODEL_REQUIRED = {
  code: 'IMS_AGENT_NEEDS_A_MODEL',
  message: 'The management system agents need a reasoning model; the local stand-in cannot draft procedures or registers. Configure a provider cleared for this data.',
};

const ENGINE = 'RISK_SAFETY' as const;
const str = (value: unknown, max: number): string => String(value ?? '').trim().slice(0, max);
const persona = expertPersona('QUALITY_MANAGER');

function proposal(ctx: EngineContext, runId: string, kind: ImsAgentKind, summary: string, payload: Record<string, unknown>) {
  const entry: ImsAgentProposal = { id: ulid(), kind, runId, summary: summary.slice(0, 300), payload, status: 'PROPOSED', proposedAt: new Date().toISOString(), requestedBy: ctx.auth.actorId };
  return { eventType: 'IMS_AGENT_PROPOSED', entity: { refType: 'ImsAgentProposal', refId: entry.id }, nextState: entry as unknown as Record<string, unknown> };
}

const finished = (runId: string, counts: { proposed: number; dropped: number }, result: { provider: string; modelClass?: string }): AgentRun => ({
  runId,
  ...counts,
  provider: result.provider,
  ...(result.modelClass ? { modelClass: result.modelClass } : {}),
});

const clauseCatalogue = (standards: readonly Standard[]) => CLAUSES.filter((clause) => standards.includes(clause.standard)).map((clause) => ({ id: clause.id, label: clauseLabel(clause.id) }));
const validClauses = (ids: unknown, standards: readonly Standard[]): { kept: string[]; dropped: number } => {
  const list = Array.isArray(ids) ? [...new Set(ids.map(String))] : [];
  const kept = list.filter((id) => isClauseId(id) && standards.includes(clauseById(id)!.standard));
  return { kept, dropped: list.length - kept.length };
};
const roleList = () => ['ENTERPRISE_ADMIN', 'OWNER', 'EXECUTIVE', 'PROJECT_DIRECTOR', 'COMMERCIAL_MANAGER', 'PRINCIPAL_DESIGNER', 'QS', 'PM', 'PLANNER', 'SAFETY', 'QAQC', 'DESIGNER', 'BIM', 'CONSTRUCTION_MANAGER', 'SUPERVISOR', 'FM'];

// =============================================================================
// 1. A procedure from a policy
// =============================================================================

export async function draftProcedure(ctx: EngineContext, input: { title: string; type?: string; standards: string[]; policyDocumentId?: string; brief?: string }): Promise<AgentRun> {
  guard(ctx, 'C');
  const title = str(input.title, 200);
  if (title.length < 3) throw new DomainError('IMS_FIELD_REQUIRED', 'Say what the procedure is for.', 422, [{ field: 'title', message: 'a title' }]);
  const type = input.type ?? 'PROCEDURE';
  if (!(DOCUMENT_TYPES as readonly string[]).includes(type)) throw new DomainError('IMS_DOCUMENT_TYPE', `The type is one of ${DOCUMENT_TYPES.join(', ')}.`, 422, [{ field: 'type', message: 'choose one' }]);
  const standards = [...new Set(input.standards ?? [])].filter(isStandard) as Standard[];
  if (standards.length === 0) throw new DomainError('IMS_STANDARDS', 'Name the standards it serves.', 422, [{ field: 'standards', message: 'one or more' }]);
  let policyText = '';
  let basedOn = 'the brief given';
  if (input.policyDocumentId) {
    const policy = documentOf(ctx, input.policyDocumentId);
    const revision = policy.revisions.find((entry) => entry.status === 'EFFECTIVE') ?? policy.revisions.at(-1)!;
    policyText = revision.content;
    basedOn = `${policy.reference} ${policy.title}, revision ${revision.revision}`;
  }
  const brief = str(input.brief, 8000);
  if (!policyText && brief.length < 20) throw new DomainError('IMS_AGENT_BRIEF', 'Give the policy it puts to work, or a brief of what it must cover.', 422, [{ field: 'brief', message: 'a policy or a brief' }]);
  const runId = ulid();
  const counts = { proposed: 0, dropped: 0 };
  const result = await runAI(ctx, {
    engine: ENGINE,
    taskType: 'ims_procedure',
    capability: 'REASONING',
    inputRefs: input.policyDocumentId ? [{ refType: 'ImsDocument', refId: input.policyDocumentId }] : [],
    requireModel: MODEL_REQUIRED,
    request: {
      task:
        `${persona} Draft a ${type.toLowerCase().replace('_', ' ')} for a UK construction company's integrated management system, putting the policy ` +
        'into practice: purpose, scope, responsibilities, the procedure step by step, the records kept, and how it is monitored. Write ' +
        'it for the people who will follow it, in plain English. Where something only the company can say is needed — a name, a ' +
        'system, a threshold — write "[to be confirmed: …]" rather than inventing it. Map it to the clauses it meets, chosen only from ' +
        'the list given, and name the roles it should be issued to, chosen only from the list given.',
      payload: { title, policy: policyText || null, brief: brief || null, standards: standards.map((id) => STANDARDS[id].label), clauses: clauseCatalogue(standards), roles: roleList() },
      responseSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          purpose: { type: 'string' },
          content: { type: 'string' },
          clauses: { type: 'array', items: { type: 'string' } },
          distribution: { type: 'array', items: { type: 'string' } },
        },
        required: ['content', 'clauses', 'distribution'],
      },
    },
    toWrites: (output) => {
      const content = str(output.content, 100_000);
      if (content.length < 200) {
        counts.dropped += 1;
        return [];
      }
      const clauses = validClauses(output.clauses, standards);
      const distribution = (Array.isArray(output.distribution) ? output.distribution.map(String) : []).filter((role) => isRole(role) && role !== 'PLATFORM_ADMIN');
      counts.dropped += clauses.dropped;
      counts.proposed += 1;
      return [
        proposal(ctx, runId, 'PROCEDURE', `${title}: ${type.toLowerCase().replace('_', ' ')} from ${basedOn}`, {
          type,
          title: str(output.title, 200) || title,
          purpose: str(output.purpose, 4000),
          content,
          standards,
          clauses: clauses.kept,
          distribution: [...new Set(distribution)],
          basedOn,
        }),
      ];
    },
  });
  return finished(runId, counts, result);
}

// =============================================================================
// 2. Clause mapping of a document
// =============================================================================

export async function mapClauses(ctx: EngineContext, input: { documentId: string }): Promise<AgentRun> {
  guard(ctx, 'U');
  const document = documentOf(ctx, input.documentId);
  if (document.status === 'WITHDRAWN') throw new DomainError('IMS_DOCUMENT_WITHDRAWN', `${document.reference} is withdrawn.`, 409);
  const revision = document.revisions.find((entry) => entry.status === 'DRAFT') ?? document.revisions.find((entry) => entry.status === 'EFFECTIVE')!;
  if (!revision.content) throw new DomainError('IMS_AGENT_NO_TEXT', `${document.reference} is held as an attached file only; the agent reads text.`, 409);
  const runId = ulid();
  const counts = { proposed: 0, dropped: 0 };
  const result = await runAI(ctx, {
    engine: ENGINE,
    taskType: 'ims_clause_mapping',
    capability: 'REASONING',
    inputRefs: [{ refType: 'ImsDocument', refId: document.id }],
    requireModel: MODEL_REQUIRED,
    request: {
      task: `${persona} ${SOURCE_MATERIAL_RULE} Say which clauses of its standards this controlled document meets, chosen only from the list given, each with one sentence saying which part of the document meets it. Leave out a clause it only mentions.`,
      payload: { document: { reference: document.reference, title: document.title, text: revision.content.slice(0, 60_000) }, clauses: clauseCatalogue(document.standards), mappedNow: document.clauses },
      responseSchema: { type: 'object', properties: { clauses: { type: 'array', items: { type: 'object', properties: { clauseId: { type: 'string' }, reason: { type: 'string' } }, required: ['clauseId', 'reason'] } } }, required: ['clauses'] },
    },
    toWrites: (output) => {
      const raw = Array.isArray(output.clauses) ? (output.clauses as Array<Record<string, unknown>>) : [];
      const kept = raw.filter((entry) => isClauseId(entry.clauseId) && document.standards.includes(clauseById(String(entry.clauseId))!.standard) && str(entry.reason, 500).length >= 10);
      counts.dropped += raw.length - kept.length;
      if (kept.length === 0) return [];
      counts.proposed += 1;
      const clauses = [...new Set(kept.map((entry) => String(entry.clauseId)))];
      return [
        proposal(ctx, runId, 'CLAUSE_MAPPING', `${document.reference}: ${clauses.length} clause(s) — ${clauses.filter((id) => !document.clauses.includes(id)).length} new`, {
          documentId: document.id,
          clauses,
          reasons: kept.map((entry) => ({ clauseId: String(entry.clauseId), reason: str(entry.reason, 500) })),
        }),
      ];
    },
  });
  return finished(runId, counts, result);
}

// =============================================================================
// 3. An audit checklist
// =============================================================================

export async function draftChecklist(ctx: EngineContext, input: { auditId: string }): Promise<AgentRun> {
  guard(ctx, 'U');
  const audit = auditOf(ctx, input.auditId);
  if (audit.status === 'COMPLETED' || audit.status === 'CANCELLED') throw new DomainError('IMS_AUDIT_STATE', `${audit.reference} is ${audit.status.toLowerCase()}.`, 409);
  const sampled = documents(ctx).filter((document) => audit.documentIds.includes(document.id));
  const runId = ulid();
  const counts = { proposed: 0, dropped: 0 };
  const result = await runAI(ctx, {
    engine: ENGINE,
    taskType: 'ims_audit_checklist',
    capability: 'REASONING',
    inputRefs: [{ refType: 'ImsAudit', refId: audit.id }, ...sampled.map((document) => ({ refType: 'ImsDocument', refId: document.id }))],
    requireModel: MODEL_REQUIRED,
    request: {
      task: `${persona} ${SOURCE_MATERIAL_RULE} Write the checklist an internal auditor works through: for each clause in scope, the questions to ask and the records to see on a construction site and in the office, and for each procedure sampled, whether what it says is done. Each item names the clause it tests, from the list given, and the procedure where it tests one.`,
      payload: {
        audit: { reference: audit.reference, title: audit.title },
        clauses: audit.clauses.map((id) => ({ id, label: clauseLabel(id) })),
        procedures: sampled.map((document) => ({ id: document.id, reference: document.reference, title: document.title, text: (document.revisions.find((entry) => entry.status === 'EFFECTIVE') ?? document.revisions.at(-1)!).content.slice(0, 8000) })),
      },
      responseSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { clauseId: { type: 'string' }, documentId: { type: ['string', 'null'] }, question: { type: 'string' } }, required: ['clauseId', 'question'] } } }, required: ['items'] },
    },
    toWrites: (output) => {
      const raw = Array.isArray(output.items) ? (output.items as Array<Record<string, unknown>>) : [];
      const kept = raw
        .filter((item) => audit.clauses.includes(String(item.clauseId)) && (!item.documentId || audit.documentIds.includes(String(item.documentId))) && str(item.question, 1000).length >= 10)
        .slice(0, 200)
        .map((item) => ({ clauseId: String(item.clauseId), ...(item.documentId ? { documentId: String(item.documentId) } : {}), question: str(item.question, 1000) }));
      counts.dropped += raw.length - kept.length;
      if (kept.length === 0) return [];
      counts.proposed += 1;
      return [proposal(ctx, runId, 'AUDIT_CHECKLIST', `${audit.reference} checklist: ${kept.length} items`, { auditId: audit.id, items: kept })];
    },
  });
  return finished(runId, counts, result);
}

// =============================================================================
// 4. Root cause and actions
// =============================================================================

export async function proposeRootCause(ctx: EngineContext, input: { actionId: string }): Promise<AgentRun> {
  guard(ctx, 'U');
  const action = actionOf(ctx, input.actionId);
  if (action.status !== 'OPEN') throw new DomainError('IMS_ACTION_STATE', `${action.reference} is ${action.status.toLowerCase()}.`, 409);
  const runId = ulid();
  const counts = { proposed: 0, dropped: 0 };
  const result = await runAI(ctx, {
    engine: ENGINE,
    taskType: 'ims_root_cause',
    capability: 'REASONING',
    inputRefs: [{ refType: 'ImsAction', refId: action.id }],
    requireModel: MODEL_REQUIRED,
    request: {
      task: `${persona} Propose the most likely root cause of this problem — why it happened, through the system (training, procedure, supervision, resources, design, communication), not who — and the actions on that cause that would stop it recurring, as a construction quality and safety professional would. Where the record does not say enough to be sure, say what must be checked first.`,
      payload: { reference: action.reference, kind: action.kind, foundAs: action.description, from: action.source.label, correction: action.correction ?? null, standards: action.standards.map((id) => STANDARDS[id].label) },
      responseSchema: { type: 'object', properties: { rootCause: { type: 'string' }, plannedActions: { type: 'string' }, correction: { type: ['string', 'null'] } }, required: ['rootCause', 'plannedActions'] },
    },
    toWrites: (output) => {
      const rootCause = str(output.rootCause, 4000);
      const plannedActions = str(output.plannedActions, 4000);
      if (rootCause.length < 10 || plannedActions.length < 10) {
        counts.dropped += 1;
        return [];
      }
      counts.proposed += 1;
      return [proposal(ctx, runId, 'ROOT_CAUSE', `${action.reference}: ${rootCause.slice(0, 160)}`, { actionId: action.id, rootCause, plannedActions, ...(output.correction && !action.correction ? { correction: str(output.correction, 4000) } : {}) })];
    },
  });
  return finished(runId, counts, result);
}

// =============================================================================
// 5. Management review minutes
// =============================================================================

export async function draftReviewMinutes(ctx: EngineContext, input: { reviewId: string }): Promise<AgentRun> {
  guard(ctx, 'U');
  const review = reviewOf(ctx, input.reviewId);
  if (review.status !== 'DRAFT') throw new DomainError('IMS_REVIEW_APPROVED', `${review.reference} is approved.`, 409);
  // Inputs the records cannot hold are left for the meeting: the agent has nothing to minute them from.
  const fromRecords = review.inputs.filter((entry) => Object.keys(entry.figures).length > 0);
  const runId = ulid();
  const counts = { proposed: 0, dropped: 0 };
  const result = await runAI(ctx, {
    engine: ENGINE,
    taskType: 'ims_review_minutes',
    capability: 'REASONING',
    inputRefs: [{ refType: 'ImsManagementReview', refId: review.id }],
    requireModel: MODEL_REQUIRED,
    request: {
      task: `${persona} Draft the management review minutes for each input below, from its figures only: what the figures show, whether the system is performing, and what top management should consider. Then propose the decisions and actions the review should take (improvement, change to the system, resource need, or decision). Invent no figure; where a figure is zero or missing, say so plainly.`,
      payload: { reference: review.reference, period: `${review.periodFrom} to ${review.periodTo}`, inputs: fromRecords.map((entry) => ({ key: entry.key, title: entry.title, summary: entry.summary, figures: entry.figures })), outputKinds: OUTPUT_KINDS },
      responseSchema: {
        type: 'object',
        properties: {
          minutes: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, text: { type: 'string' } }, required: ['key', 'text'] } },
          outputs: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, text: { type: 'string' } }, required: ['kind', 'text'] } },
        },
        required: ['minutes', 'outputs'],
      },
    },
    toWrites: (output) => {
      const rawMinutes = Array.isArray(output.minutes) ? (output.minutes as Array<Record<string, unknown>>) : [];
      const rawOutputs = Array.isArray(output.outputs) ? (output.outputs as Array<Record<string, unknown>>) : [];
      const minutes = rawMinutes.filter((entry) => fromRecords.some((input_) => input_.key === entry.key) && str(entry.text, 8000).length >= 20);
      const outputs = rawOutputs.filter((entry) => (OUTPUT_KINDS as readonly string[]).includes(String(entry.kind)) && str(entry.text, 4000).length >= 10);
      counts.dropped += rawMinutes.length - minutes.length + rawOutputs.length - outputs.length;
      if (minutes.length === 0 && outputs.length === 0) return [];
      counts.proposed += 1;
      return [
        proposal(ctx, runId, 'REVIEW_MINUTES', `${review.reference}: ${minutes.length} minute(s), ${outputs.length} proposed output(s)`, {
          reviewId: review.id,
          minutes: minutes.map((entry) => ({ key: String(entry.key), text: str(entry.text, 8000) })),
          outputs: outputs.map((entry) => ({ kind: String(entry.kind), text: str(entry.text, 4000) })),
        }),
      ];
    },
  });
  return finished(runId, counts, result);
}

// =============================================================================
// 6. Environmental aspects of the company's activities
// =============================================================================

export async function proposeAspects(ctx: EngineContext, input: { activities: string }): Promise<AgentRun> {
  guard(ctx, 'C');
  const activities = str(input.activities, 8000);
  if (activities.length < 10) throw new DomainError('IMS_AGENT_BRIEF', 'Describe the company’s activities — the trades, the plant, the sites.', 422, [{ field: 'activities', message: 'the activities' }]);
  const existing = aspects(ctx).filter((aspect) => aspect.status === 'ACTIVE');
  const runId = ulid();
  const counts = { proposed: 0, dropped: 0 };
  const result = await runAI(ctx, {
    engine: ENGINE,
    taskType: 'ims_aspects',
    capability: 'REASONING',
    inputRefs: [],
    requireModel: MODEL_REQUIRED,
    request: {
      task: `${expertPersona('HEALTH_AND_SAFETY')} For a UK construction company with these activities, identify the environmental aspects (ISO 14001 6.1.2): for each activity, the aspect, the impact it can have, under which condition (normal, abnormal, emergency), a severity and a likelihood from 1 to 5, whether a legal requirement drives it, and the usual controls. Leave out aspects already in the register.`,
      payload: { activities, alreadyRegistered: existing.map((aspect) => `${aspect.activity}: ${aspect.aspect}`), conditions: CONDITIONS },
      responseSchema: {
        type: 'object',
        properties: { aspects: { type: 'array', items: { type: 'object', properties: { activity: { type: 'string' }, aspect: { type: 'string' }, impact: { type: 'string' }, condition: { type: 'string' }, severity: { type: 'integer' }, likelihood: { type: 'integer' }, legalDriver: { type: 'boolean' }, controls: { type: 'string' } }, required: ['activity', 'aspect', 'impact', 'condition', 'severity', 'likelihood', 'controls'] } } },
        required: ['aspects'],
      },
    },
    toWrites: (output) => {
      const raw = Array.isArray(output.aspects) ? (output.aspects as Array<Record<string, unknown>>) : [];
      const writes = [];
      const seen = new Set(existing.map((aspect) => `${aspect.activity}|${aspect.aspect}`.toLowerCase()));
      for (const entry of raw.slice(0, 60)) {
        const candidate = {
          activity: str(entry.activity, 300),
          aspect: str(entry.aspect, 300),
          impact: str(entry.impact, 500),
          condition: String(entry.condition ?? ''),
          severity: Number(entry.severity),
          likelihood: Number(entry.likelihood),
          legalDriver: entry.legalDriver === true,
          controls: str(entry.controls, 2000),
        };
        const key = `${candidate.activity}|${candidate.aspect}`.toLowerCase();
        const valid =
          candidate.activity.length >= 3 && candidate.aspect.length >= 3 && candidate.impact.length >= 3 && candidate.controls.length >= 5 &&
          (CONDITIONS as readonly string[]).includes(candidate.condition) &&
          [candidate.severity, candidate.likelihood].every((value) => Number.isInteger(value) && value >= 1 && value <= 5) &&
          !seen.has(key);
        if (!valid) {
          counts.dropped += 1;
          continue;
        }
        seen.add(key);
        counts.proposed += 1;
        writes.push(proposal(ctx, runId, 'ASPECT', `${candidate.activity}: ${candidate.aspect} → ${candidate.impact} (${candidate.severity} × ${candidate.likelihood})`, candidate));
      }
      return writes;
    },
  });
  return finished(runId, counts, result);
}

// =============================================================================
// 7. The legal register, from the list only
// =============================================================================

export async function proposeObligations(ctx: EngineContext, input: { activities?: string }): Promise<AgentRun> {
  guard(ctx, 'C');
  const registered = new Set(obligations(ctx).filter((entry) => entry.status === 'ACTIVE').map((entry) => entry.catalogueKey).filter(Boolean));
  const open = LEGISLATION.filter((entry) => !registered.has(entry.key));
  if (open.length === 0) throw new DomainError('IMS_AGENT_NOTHING', 'Every entry of the legislation list is already in the register.', 409);
  const context = str(input.activities, 8000) || aspects(ctx).filter((aspect) => aspect.status === 'ACTIVE').map((aspect) => `${aspect.activity}: ${aspect.aspect}`).join('; ');
  if (context.length < 10) throw new DomainError('IMS_AGENT_BRIEF', 'Describe the company’s activities, or record its environmental aspects first.', 422, [{ field: 'activities', message: 'the activities' }]);
  const runId = ulid();
  const counts = { proposed: 0, dropped: 0 };
  const result = await runAI(ctx, {
    engine: ENGINE,
    taskType: 'ims_obligations',
    capability: 'REASONING',
    inputRefs: [],
    requireModel: MODEL_REQUIRED,
    request: {
      task: `${expertPersona('HEALTH_AND_SAFETY')} From the list given ONLY — use its keys, never name legislation that is not on it — choose the requirements that apply to a UK construction company with these activities. For each, say in your own words what it requires of the company, how it applies to these activities, and how a company like this typically complies; mark anything only the company can confirm "[to be confirmed: …]".`,
      payload: { activities: context, list: open.map((entry) => ({ key: entry.key, title: entry.title, extent: entry.extent, topic: entry.topic })) },
      responseSchema: { type: 'object', properties: { entries: { type: 'array', items: { type: 'object', properties: { catalogueKey: { type: 'string' }, requirement: { type: 'string' }, applicability: { type: 'string' }, howComplied: { type: 'string' } }, required: ['catalogueKey', 'requirement', 'applicability', 'howComplied'] } } }, required: ['entries'] },
    },
    toWrites: (output) => {
      const raw = Array.isArray(output.entries) ? (output.entries as Array<Record<string, unknown>>) : [];
      const writes = [];
      const seen = new Set<string>();
      for (const entry of raw) {
        const key = String(entry.catalogueKey ?? '');
        const listed = legislationByKey(key);
        const fields = { requirement: str(entry.requirement, 2000), applicability: str(entry.applicability, 2000), howComplied: str(entry.howComplied, 2000) };
        if (!listed || registered.has(key) || seen.has(key) || Object.values(fields).some((value) => value.length < 10)) {
          counts.dropped += 1;
          continue;
        }
        seen.add(key);
        counts.proposed += 1;
        writes.push(proposal(ctx, runId, 'OBLIGATION', `${listed.title} (${listed.extent})`, { catalogueKey: key, title: listed.title, standards: listed.standards, ...fields }));
      }
      return writes;
    },
  });
  return finished(runId, counts, result);
}

// =============================================================================
// 8. Objectives from the company position
// =============================================================================

export async function proposeObjectives(ctx: EngineContext, people: readonly Person[]): Promise<AgentRun> {
  guard(ctx, 'C');
  const on = today();
  const position = companyPosition(ctx, people, { from: `${Number(on.slice(0, 4)) - 1}${on.slice(4)}`, to: on });
  const runId = ulid();
  const counts = { proposed: 0, dropped: 0 };
  const result = await runAI(ctx, {
    engine: ENGINE,
    taskType: 'ims_objectives',
    capability: 'REASONING',
    inputRefs: [],
    requireModel: MODEL_REQUIRED,
    request: {
      task: `${persona} From the company's position over the last year, propose measurable quality, environmental and OH&S objectives (6.2) for the year ahead: the objective, how it is measured, the target, the baseline from the figures where there is one, and a date. Base each on a figure given; invent no figure.`,
      payload: { today: on, position: position.inputs.filter((entry) => Object.keys(entry.figures).length > 0).map((entry) => ({ title: entry.title, summary: entry.summary, figures: entry.figures })), standards: Object.keys(STANDARDS) },
      responseSchema: { type: 'object', properties: { objectives: { type: 'array', items: { type: 'object', properties: { standard: { type: 'string' }, objective: { type: 'string' }, measure: { type: 'string' }, target: { type: 'string' }, baseline: { type: ['string', 'null'] }, dueOn: { type: 'string' } }, required: ['standard', 'objective', 'measure', 'target', 'dueOn'] } } }, required: ['objectives'] },
    },
    toWrites: (output) => {
      const raw = Array.isArray(output.objectives) ? (output.objectives as Array<Record<string, unknown>>) : [];
      const writes = [];
      for (const entry of raw.slice(0, 20)) {
        const dueOn = String(entry.dueOn ?? '');
        const candidate = { standard: String(entry.standard ?? ''), objective: str(entry.objective, 1000), measure: str(entry.measure, 500), target: str(entry.target, 200), baseline: str(entry.baseline, 200), dueOn };
        const valid = isStandard(candidate.standard) && candidate.objective.length >= 10 && candidate.measure.length >= 5 && candidate.target.length >= 1 && /^\d{4}-\d{2}-\d{2}$/.test(dueOn) && !Number.isNaN(Date.parse(`${dueOn}T00:00:00Z`)) && dueOn > on;
        if (!valid) {
          counts.dropped += 1;
          continue;
        }
        counts.proposed += 1;
        writes.push(proposal(ctx, runId, 'OBJECTIVE', `${STANDARDS[candidate.standard as Standard].label}: ${candidate.objective}`, candidate));
      }
      return writes;
    },
  });
  return finished(runId, counts, result);
}

// =============================================================================
// Deciding: the ordinary command, as the person accepting it, with their edits
// =============================================================================

/** The fields a person may change on a proposal before accepting it. */
const EDITABLE: Partial<Record<ImsAgentKind, string[]>> = {
  PROCEDURE: ['title', 'purpose', 'content'],
  ROOT_CAUSE: ['rootCause', 'plannedActions', 'correction'],
  ASPECT: ['controls'],
  OBLIGATION: ['requirement', 'applicability', 'howComplied'],
  OBJECTIVE: ['objective', 'measure', 'target', 'baseline', 'dueOn'],
};

export function decideProposal(
  ctx: EngineContext,
  people: readonly Person[],
  id: string,
  input: { decision: string; note?: string; ownerId?: string; edits?: Record<string, string> },
): ImsAgentProposal {
  guard(ctx, 'U');
  const found = stateOf<ImsAgentProposal>(ctx, 'ImsAgentProposal', id);
  if (!found) throw new DomainError('IMS_AGENT_PROPOSAL_NOT_FOUND', 'No such proposal.', 404);
  const { version: _version, ...proposalState } = found;
  if (proposalState.status !== 'PROPOSED') throw new DomainError('IMS_AGENT_PROPOSAL_DECIDED', `That proposal was already ${proposalState.status.toLowerCase()}.`, 409);
  if (input.decision !== 'ACCEPT' && input.decision !== 'REJECT') throw new DomainError('IMS_AGENT_DECISION', 'Accept or reject it.', 422, [{ field: 'decision', message: 'ACCEPT or REJECT' }]);
  const editable = EDITABLE[proposalState.kind] ?? [];
  const unknownEdit = Object.keys(input.edits ?? {}).find((key) => !editable.includes(key));
  if (unknownEdit) throw new DomainError('IMS_AGENT_EDIT', `${unknownEdit} is not changed on this kind of proposal.`, 422, [{ field: `edits.${unknownEdit}`, message: 'not editable' }]);
  const p = { ...proposalState.payload, ...Object.fromEntries(Object.entries(input.edits ?? {}).filter(([, value]) => String(value).trim() !== '')) };
  const ownerId = input.ownerId && activePeople(people).some((person) => person.id === input.ownerId) ? input.ownerId : ctx.auth.actorId;
  let result: ImsAgentProposal['result'];
  if (input.decision === 'ACCEPT') {
    switch (proposalState.kind) {
      case 'PROCEDURE': {
        const document = draftDocument(
          ctx,
          {
            type: String(p.type),
            title: String(p.title),
            purpose: String(p.purpose ?? ''),
            standards: p.standards as string[],
            clauses: p.clauses as string[],
            ownerId,
            distribution: p.distribution as string[],
            content: String(p.content),
            changeSummary: `First issue, drafted by the AI agent from ${String(p.basedOn)} and accepted by a person`,
          },
          { draftedByAgent: true },
        );
        result = { refType: 'ImsDocument', refId: document.id };
        break;
      }
      case 'CLAUSE_MAPPING': {
        redraftDocument(ctx, String(p.documentId), { changeSummary: 'Clause mapping revised from the AI agent’s reading, accepted by a person', clauses: p.clauses as string[] });
        result = { refType: 'ImsDocument', refId: String(p.documentId) };
        break;
      }
      case 'AUDIT_CHECKLIST': {
        setChecklist(ctx, String(p.auditId), { items: p.items as Array<{ clauseId: string; documentId?: string; question: string }> });
        result = { refType: 'ImsAudit', refId: String(p.auditId) };
        break;
      }
      case 'ROOT_CAUSE': {
        updateAction(ctx, String(p.actionId), { rootCause: String(p.rootCause), plannedActions: String(p.plannedActions), ...(p.correction ? { correction: String(p.correction) } : {}) });
        result = { refType: 'ImsAction', refId: String(p.actionId) };
        break;
      }
      case 'REVIEW_MINUTES': {
        const review = reviewOf(ctx, String(p.reviewId));
        // A minute somebody has already written is theirs; the agent's fills only the gaps.
        for (const minute of p.minutes as Array<{ key: string; text: string }>) {
          if (!review.minutes[minute.key]) minuteInput(ctx, review.id, minute);
        }
        for (const output of p.outputs as Array<{ kind: string; text: string }>) addOutput(ctx, review.id, output);
        result = { refType: 'ImsManagementReview', refId: review.id };
        break;
      }
      case 'ASPECT': {
        const aspect = recordAspect(ctx, { activity: String(p.activity), aspect: String(p.aspect), impact: String(p.impact), condition: String(p.condition), severity: Number(p.severity), likelihood: Number(p.likelihood), legalDriver: p.legalDriver === true, controls: String(p.controls) }, { draftedByAgent: true });
        result = { refType: 'ImsAspect', refId: aspect.id };
        break;
      }
      case 'OBLIGATION': {
        const entry = recordObligation(ctx, { catalogueKey: String(p.catalogueKey), requirement: String(p.requirement), applicability: String(p.applicability), howComplied: String(p.howComplied) }, { draftedByAgent: true });
        result = { refType: 'ImsObligation', refId: entry.id };
        break;
      }
      case 'OBJECTIVE': {
        const objective = setObjective(ctx, { standard: String(p.standard), objective: String(p.objective), measure: String(p.measure), target: String(p.target), ...(p.baseline ? { baseline: String(p.baseline) } : {}), ownerId, dueOn: String(p.dueOn) }, { draftedByAgent: true });
        result = { refType: 'ImsObjective', refId: objective.id };
        break;
      }
    }
  }
  const next: ImsAgentProposal = {
    ...proposalState,
    payload: input.decision === 'ACCEPT' ? p : proposalState.payload,
    status: input.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED',
    decidedBy: ctx.auth.actorId,
    decidedAt: new Date().toISOString(),
    ...(input.note?.trim() ? { decisionNote: input.note.trim().slice(0, 1000) } : {}),
    ...(result ? { result } : {}),
  };
  write(ctx, { eventType: 'IMS_AGENT_PROPOSAL_DECIDED', entity: { refType: 'ImsAgentProposal', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${proposalState.summary} — ${next.status.toLowerCase()}` });
  return next;
}

export function agentShare(ctx: EngineContext) {
  guard(ctx, 'R');
  const all = agentProposals(ctx);
  const byKind: Record<string, { proposed: number; accepted: number }> = {};
  for (const entry of all) {
    byKind[entry.kind] ??= { proposed: 0, accepted: 0 };
    byKind[entry.kind]!.proposed += 1;
    if (entry.status === 'ACCEPTED') byKind[entry.kind]!.accepted += 1;
  }
  return {
    proposals: all.sort((a, b) => b.proposedAt.localeCompare(a.proposedAt)),
    share: { proposed: all.length, accepted: all.filter((entry) => entry.status === 'ACCEPTED').length, rejected: all.filter((entry) => entry.status === 'REJECTED').length, pending: all.filter((entry) => entry.status === 'PROPOSED').length, byKind },
    editable: EDITABLE,
  };
}
