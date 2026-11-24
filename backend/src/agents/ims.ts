import type { EngineContext } from '../engines/context.ts';
import type { AgentDefinition, AgentOutput, Finding } from './types.ts';

/**
 * The management system watch.
 *
 * Observes and never acts. It reads the company's management system — held on
 * the tenancy's governance record — and says where it is not being kept: a
 * document past its review date, a draft left unapproved, a revision in force
 * that people it is issued to have not acknowledged. Every finding is a
 * comparison of recorded dates and counts, and names the record it read.
 */

const DRAFT_STALE_DAYS = 30;

type Row = Record<string, unknown>;

export function imsFindings(ctx: EngineContext, on: string): Finding[] {
  const register = `${ctx.tenantId}-governance`;
  const list = (type: string) => ctx.ledger.list(register, type).filter((record) => record.tenantId === ctx.tenantId);
  const findings: Finding[] = [];

  const acks = list('ImsAcknowledgement').map((record) => record.state as Row);
  for (const record of list('ImsDocument')) {
    const document = record.state as Row & { revisions: Row[] };
    const reference = String(document.reference);
    if (document.status === 'EFFECTIVE' && typeof document.reviewDueOn === 'string' && document.reviewDueOn < on) {
      findings.push({
        key: `ims:review-overdue:${record.refId}`,
        severity: 'ATTENTION',
        summary: `${reference} ${String(document.title)} was due for review on ${document.reviewDueOn}.`,
        consequence: 'A controlled document past its review is the first thing a certification auditor samples; it may no longer describe how the work is done.',
        evidence: [{ refType: 'ImsDocument', refId: record.refId, note: `Review due ${document.reviewDueOn}` }],
      });
    }
    const draft = document.revisions.find((revision) => revision.status === 'DRAFT');
    if (draft && typeof draft.draftedAt === 'string') {
      const age = Math.floor((Date.parse(`${on}T00:00:00Z`) - Date.parse(draft.draftedAt)) / 86_400_000);
      if (age > DRAFT_STALE_DAYS) {
        findings.push({
          key: `ims:draft-waiting:${record.refId}:${String(draft.revision)}`,
          severity: 'INFO',
          summary: `${reference} revision ${String(draft.revision)} has waited ${age} days for approval.`,
          consequence: document.status === 'EFFECTIVE' ? 'The revision in force is the old one until the draft is approved or returned.' : 'Nothing is in force for this document until a draft is approved.',
          evidence: [{ refType: 'ImsDocument', refId: record.refId, note: `Drafted ${String(draft.draftedAt).slice(0, 10)}` }],
        });
      }
    }
    if (document.status === 'EFFECTIVE' && Array.isArray(document.distribution) && document.distribution.length > 0) {
      const done = acks.filter((ack) => ack.documentId === record.refId && ack.revision === document.effectiveRevision).length;
      const approvedAt = String(document.revisions.find((revision) => revision.status === 'EFFECTIVE')?.approvedAt ?? '');
      const age = approvedAt ? Math.floor((Date.parse(`${on}T00:00:00Z`) - Date.parse(approvedAt)) / 86_400_000) : 0;
      if (done === 0 && age > 14) {
        findings.push({
          key: `ims:unacknowledged:${record.refId}:${String(document.effectiveRevision)}`,
          severity: 'ATTENTION',
          summary: `Nobody has acknowledged ${reference} revision ${String(document.effectiveRevision)}, in force for ${age} days.`,
          consequence: 'A procedure nobody has read is not a working procedure; awareness (clause 7.3) cannot be shown.',
          evidence: [{ refType: 'ImsDocument', refId: record.refId, note: `Issued to ${(document.distribution as string[]).join(', ')}` }],
        });
      }
    }
  }

  for (const record of list('ImsAction')) {
    const action = record.state as Row;
    if (action.status === 'OPEN' && typeof action.dueOn === 'string' && action.dueOn < on) {
      findings.push({
        key: `ims:action-overdue:${record.refId}`,
        severity: (action.source as Row | undefined)?.kind === 'AUDIT_FINDING' || action.kind === 'CORRECTIVE' ? 'ATTENTION' : 'INFO',
        summary: `${String(action.reference)} was due on ${action.dueOn} and is still open: ${String(action.description).slice(0, 120)}`,
        consequence: 'An open corrective action past its date is a nonconformity left uncorrected — an auditor reads it as the system not working.',
        evidence: [{ refType: 'ImsAction', refId: record.refId, note: `Due ${action.dueOn}` }],
      });
    }
  }
  for (const record of list('ImsAudit')) {
    const audit = record.state as Row;
    if (audit.status === 'PLANNED' && typeof audit.plannedOn === 'string' && audit.plannedOn < on) {
      findings.push({
        key: `ims:audit-overdue:${record.refId}`,
        severity: 'ATTENTION',
        summary: `${String(audit.reference)} ${String(audit.title)} was planned for ${audit.plannedOn} and has not started.`,
        consequence: 'The audit programme is not being kept; the clauses it covers go unaudited.',
        evidence: [{ refType: 'ImsAudit', refId: record.refId, note: `Planned ${audit.plannedOn}` }],
      });
    }
  }
  return findings;
}

export const imsWatchAgent: AgentDefinition = {
  name: 'management system watch',
  agentId: 'AGT-IMS-WATCH',
  module: 'IMS',
  division: 'COMPLIANCE',
  purpose:
    'Watches the company’s management system and says where it is not being kept: documents past review, drafts left ' +
    'unapproved and procedures nobody has acknowledged.',
  activeIn: 'ANY',
  triggers: [
    { kind: 'SCHEDULE', at: '06:30' },
    { kind: 'EVENT', eventType: 'IMS_DOCUMENT_APPROVED' },
    { kind: 'EVENT', eventType: 'IMS_DOCUMENT_DRAFTED' },
    { kind: 'EVENT', eventType: 'IMS_ACTION_RAISED' },
    { kind: 'EVENT', eventType: 'IMS_AUDIT_PLANNED' },
  ],
  inputs: ['Controlled documents and their revisions', 'Read-and-understood acknowledgements', 'Corrective and improvement actions', 'The audit programme'],
  outputs: ['Documents past their review date', 'Drafts waiting for approval', 'Revisions in force that nobody has acknowledged', 'Actions past their due date', 'Audits not started on their planned date'],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.9,
  acuTier: 'LOW',
  memory: { reads: ['PROJECT'], writes: [] },
  mandate: {
    reads: ['MANAGEMENT_SYSTEM'],
    proposes: [],
    approvers: ['OWNER'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx: EngineContext): AgentOutput {
    return { findings: imsFindings(ctx, new Date().toISOString().slice(0, 10)), proposals: [] };
  },
};

export const IMS_AGENTS: AgentDefinition[] = [imsWatchAgent];
