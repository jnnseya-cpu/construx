import { authorise, type EngineContext } from '../engines/context.ts';
import { bidResponsePosition } from './bidresponse.ts';
import { bidReview, type Recommendation } from './bidreview.ts';
import { contractReviewForProject } from './contractreview.ts';
import { matrixPosition } from './matrixreview.ts';
import { priceCheck } from './pricecheck.ts';
import type { TenderDeliverable } from './tenderintake.ts';
import { projectTender, tenderRegister } from './tenderregister.ts';
import type { ContractObligation } from './tenderreview.ts';
import { scopeReview } from './tenderscope.ts';

/**
 * The executive brief: one page a director reads to decide, and the nine
 * outputs of a bid review, each labelled Ready for Review, In Draft or Blocked
 * with exactly what stands in the way — and the submission manifest and the
 * approvals.
 *
 * Nothing here is new information. Each label is read from the record that
 * output already is — the register, the matrix, the scope, the contract and
 * risks, the questions, the price, the answers, the returns — so the brief
 * cannot say one thing while the screen below it says another. A bid is called
 * Ready for Authorised Submission only when every output is ready, every
 * approval is recorded, and the recommendation is to bid.
 */

export type DeliverableLabel = 'READY_FOR_REVIEW' | 'IN_DRAFT' | 'BLOCKED';

export type DeliverableStatus = {
  id: string;
  title: string;
  label: DeliverableLabel;
  /** What stands in the way, item by item, each with its own ID where it has one. */
  items: string[];
};

export type Approval = { id: string; what: string; status: 'RECORDED' | 'PENDING'; detail: string };

export type ManifestRow = {
  id: string;
  file: string;
  purpose: string;
  /** What produces it on the platform, where something does. */
  producedBy: string;
  version?: string;
  owner?: string;
  /** The buyer's portal location is not something the platform can see. */
  portalLocation: string;
  status: 'VERIFIED' | 'PENDING';
  detail: string;
};

export type TenderBrief = {
  read: boolean;
  recommendation: Recommendation;
  deadlines: Array<{ label: string; when: string; timeZone?: string; kind: string }>;
  drivers: string[];
  approvals: Approval[];
  deliverables: DeliverableStatus[];
  manifest: ManifestRow[];
  readyForAuthorisedSubmission: boolean;
  summary: string;
};

const label = (blocked: string[], draft: string[]): DeliverableLabel => (blocked.length > 0 ? 'BLOCKED' : draft.length > 0 ? 'IN_DRAFT' : 'READY_FOR_REVIEW');

export function tenderBrief(ctx: EngineContext): TenderBrief {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  const review = bidReview(ctx);
  const { invitation, analysisId } = projectTender(ctx);
  if (!review.read || !invitation || !analysisId) {
    return {
      read: false,
      recommendation: review.recommendation,
      deadlines: [],
      drivers: review.factors.map((factor) => factor.finding),
      approvals: [],
      deliverables: [],
      manifest: [],
      readyForAuthorisedSubmission: false,
      summary: review.summary,
    };
  }

  const register = tenderRegister(ctx);
  const position = matrixPosition(ctx, analysisId);
  const scope = scopeReview(ctx);
  const contract = contractReviewForProject(ctx);
  const price = priceCheck(ctx);
  const packs = bidResponsePosition(ctx).packs.filter((pack) => pack.analysisId === analysisId);
  const pack = packs.at(-1);
  const reviews = ctx.ledger.list(ctx.projectId, 'TenderReview').map((record) => record.state);
  const obligations = reviews.flatMap((state) => (state.obligations as ContractObligation[] | undefined) ?? []);
  const unsigned = obligations.filter((obligation) => obligation.status === 'DRAFT');
  const programme = ctx.ledger
    .list(ctx.projectId, 'TenderProgrammeDraft')
    .map((record) => record.state)
    .filter((state) => state.status === 'CONFIRMED')
    .at(-1);
  const clarifications = ctx.ledger
    .list(ctx.projectId, 'Clarification')
    .map((record) => record.state)
    .filter((state) => state.side === 'CLIENT');
  const openQuestions = clarifications.filter((state) => state.status === 'OPEN');
  const registeredRisks = review.risks.filter((risk) => risk.registered).length;

  // --- The nine outputs ---------------------------------------------------------
  const deliverables: DeliverableStatus[] = [];
  {
    const blocked = [
      ...register.rows.filter((row) => row.status === 'UNREADABLE' || row.status === 'QUARANTINED').map((row) => `${row.filename} cannot be read`),
      ...register.listedNotUploaded.map((entry) => `${entry.title} listed but not uploaded`),
      ...register.notSupplied.map((entry) => `${entry.title} referred to but not supplied`),
    ];
    const draft = [...register.rows.filter((row) => row.status === 'NOT_READ').map((row) => `${row.filename} uploaded since the last reading`), ...register.conflicts];
    deliverables.push({ id: 'D1', title: 'Document register and deadline tracker', label: label(blocked, draft), items: [...blocked, ...draft] });
  }
  {
    const blocked = position.gates.cannotMeet.map((reference) => `${reference}: pass/fail and appears not to be obtainable`);
    const draft = position.lines
      .filter((line) => line.status !== 'CONFIRMED' && !line.waived && !position.gates.cannotMeet.includes(line.reference))
      .map((line) => `${line.reference}: ${line.status.toLowerCase().replace('_', ' ')}`);
    deliverables.push({ id: 'D2', title: 'Compliance and evaluation matrix', label: label(blocked, draft), items: [...blocked, ...draft] });
  }
  {
    const blocked = scope.rows.length === 0 ? ['No scope has been read from the pack.'] : [];
    const draft = [
      ...scope.rows.filter((row) => row.pricing === 'NOT_PRICED').map((row) => `${row.reference} ${row.description}: priced nowhere`),
      ...scope.rows
        .filter((row) => [row.design, row.supply, row.install, row.testApprove].includes('NOT_STATED'))
        .map((row) => `${row.reference} ${row.description}: a responsibility not stated`),
      ...scope.discrepancies.filter((row) => row.clarification?.status !== 'ANSWERED').map((row) => `${row.id}: unresolved`),
    ];
    deliverables.push({ id: 'D3', title: 'Scope, design responsibility and interface matrix', label: label(blocked, draft), items: [...blocked, ...draft] });
  }
  {
    const delivery = review.factors.find((factor) => factor.area === 'DELIVERY');
    const blocked = programme ? [] : ['No tender programme has been confirmed.'];
    const draft = delivery && delivery.bearing !== 'CLEAR' ? [delivery.finding] : [];
    deliverables.push({ id: 'D4', title: 'Programme and capacity review', label: label(blocked, draft), items: [...blocked, ...draft] });
  }
  {
    const blocked = contract.rows.length === 0 ? ['No contract clause has been read; the contractual exposure is not known.'] : [];
    const draft = [
      ...(obligations.length === 0 && contract.rows.length > 0 ? ['The clauses have not been sent to the tender review for sign-off.'] : []),
      ...unsigned.map((obligation) => `${obligation.reference}: awaiting legal or commercial sign-off`),
      ...review.risks.filter((risk) => !risk.registered).map((risk) => `${risk.id}: not on the risk register`),
    ];
    deliverables.push({ id: 'D5', title: 'Contract and risk register with bid decision', label: label(blocked, draft), items: [...blocked, ...draft] });
  }
  {
    const draft = openQuestions.map((state) => `${String(state.reference)}: awaiting the buyer`);
    deliverables.push({ id: 'D6', title: 'Clarification log and buyer-ready questions', label: label([], draft), items: draft });
  }
  {
    const blocked = price.priced ? [] : ['The job has not been priced.'];
    const draft = [
      ...price.provisional.map((entry) => entry.reason),
      ...(price.priced && !price.cash ? ['The cash it needs has not been modelled.'] : []),
      ...(price.reconciliation && price.reconciliation.differenceMinor !== 0 ? [price.reconciliation.statement] : []),
    ];
    deliverables.push({ id: 'D7', title: 'Estimate reconciliation, pricing checks and cash flow', label: label(blocked, draft), items: [...blocked, ...draft] });
  }
  {
    const blocked = !pack ? ['No response pack has been planned from the matrix.'] : [];
    const draft = pack
      ? [
          ...pack.completeness.unanswered.map((entry) => `${entry.key}: not yet answered`),
          ...pack.completeness.undated.map((entry) => `A stated deadline has no date: ${entry}`),
        ]
      : [];
    deliverables.push({ id: 'D8', title: 'Draft responses and internal evidence map', label: label(blocked, draft), items: [...blocked, ...draft] });
  }

  // --- Approvals ----------------------------------------------------------------
  const opportunity = ctx.ledger
    .listByTenant(ctx.tenantId, 'Opportunity')
    .map((record) => record.state)
    .find((state) => String(state.id) === String(invitation.opportunityId ?? ''));
  const decision = opportunity?.decision as { bid?: boolean; decidedAt?: string } | undefined;
  const estimateIds = new Set(ctx.ledger.list(ctx.projectId, 'Estimate').map((record) => String(record.state.id)));
  const quotations = ctx.ledger
    .listByTenant(ctx.tenantId, 'Document')
    .map((record) => record.state)
    .filter((state) => state.documentType === 'quotation')
    .filter((state) => {
      const source = state.source as { refType?: string; refId?: string } | null | undefined;
      return source ? source.refId === ctx.projectId || estimateIds.has(String(source.refId)) : false;
    });
  const approvedQuotation = quotations.find((state) => state.status === 'APPROVED' || state.status === 'ISSUED');
  const approvals: Approval[] = [
    {
      id: 'A1',
      what: 'Bid decision',
      status: decision ? 'RECORDED' : 'PENDING',
      detail: decision ? `${decision.bid ? 'Bid' : 'No bid'}, recorded ${String(decision.decidedAt ?? '').slice(0, 10)}.` : 'Not yet decided on the opportunity.',
    },
    {
      id: 'A2',
      what: 'Commercial approval of the price',
      status: approvedQuotation ? 'RECORDED' : 'PENDING',
      detail: approvedQuotation ? `The quotation is ${String(approvedQuotation.status).toLowerCase()}.` : 'No quotation for this job has been approved.',
    },
    {
      id: 'A3',
      what: 'Programme approval',
      status: programme ? 'RECORDED' : 'PENDING',
      detail: programme ? `Tender programme confirmed, starting ${String(programme.startDate ?? '').slice(0, 10)}.` : 'No tender programme has been confirmed.',
    },
    {
      id: 'A4',
      what: 'Contract sign-off',
      status: obligations.length > 0 && unsigned.length === 0 ? 'RECORDED' : 'PENDING',
      detail:
        obligations.length === 0
          ? 'No clause is on the tender review.'
          : unsigned.length === 0
            ? `${obligations.length} clause(s) signed off.`
            : `${unsigned.length} of ${obligations.length} clause(s) awaiting sign-off.`,
    },
    {
      id: 'A5',
      what: 'Signatory approval of the submission',
      status: pack?.status === 'ISSUED' ? 'RECORDED' : 'PENDING',
      detail: pack?.status === 'ISSUED' ? `${pack.reference} issued under its approval authority.` : 'The response pack has not been issued.',
    },
  ];

  // --- The manifest: every return, what produces it, and whether it is ready ----
  const returns = (invitation.deliverables as TenderDeliverable[] | undefined) ?? [];
  const portalRule = register.submission?.namingConvention ? `Name: ${register.submission.namingConvention}` : 'Portal location not verified — the platform cannot see the buyer’s portal';
  const manifest: ManifestRow[] = returns.map((entry): ManifestRow => {
    const title = entry.title;
    const base = {
      id: entry.reference,
      file: title,
      purpose: entry.mandatory ? 'Mandatory return' : 'Optional return',
      ...(entry.owner ? { owner: entry.owner } : {}),
      portalLocation: portalRule,
    };
    if (/quality|questionnaire|method|response|submission/i.test(title)) {
      return {
        ...base,
        producedBy: 'Bid response pack',
        ...(pack ? { version: `${pack.reference}${pack.status === 'ISSUED' ? ' (issued)' : ''}` } : {}),
        status: pack?.status === 'ISSUED' ? 'VERIFIED' : 'PENDING',
        detail: pack ? (pack.status === 'ISSUED' ? 'Issued; download it from the pack.' : `${pack.completeness.unanswered.length} answer(s) outstanding.`) : 'No pack planned.',
      };
    }
    if (/price|pricing|schedule of rates|bill|boq|cost/i.test(title)) {
      return {
        ...base,
        producedBy: 'Pricing schedule from the priced estimate',
        status: price.status === 'READY_FOR_APPROVAL' && approvedQuotation ? 'VERIFIED' : 'PENDING',
        detail: !price.priced ? 'Not priced.' : price.status === 'PROVISIONAL' ? 'The price is provisional.' : approvedQuotation ? 'Price approved.' : 'Awaiting commercial approval.',
      };
    }
    if (/programme/i.test(title)) {
      return {
        ...base,
        producedBy: 'Tender programme',
        status: programme ? 'VERIFIED' : 'PENDING',
        detail: programme ? 'Confirmed; download it from the programme.' : 'Not confirmed.',
      };
    }
    if (/form of tender|offer|quotation/i.test(title)) {
      return {
        ...base,
        producedBy: 'Quotation',
        status: approvedQuotation ? 'VERIFIED' : 'PENDING',
        detail: approvedQuotation ? `Quotation ${String(approvedQuotation.status).toLowerCase()}.` : 'Not approved.',
      };
    }
    return {
      ...base,
      producedBy: 'Prepared outside the platform and uploaded to the portal',
      status: 'PENDING',
      detail:
        `${entry.signatureRequired ? 'Signature required. ' : ''}${entry.format ? `Format ${entry.format}. ` : ''}` +
        'The platform cannot see this file; check it before upload.',
    };
  });

  {
    const blocked = review.recommendation === 'NO_BID' ? ['The recommendation is not to bid.'] : [];
    const draft = [
      ...approvals.filter((approval) => approval.status === 'PENDING').map((approval) => `${approval.id} ${approval.what}: pending`),
      ...manifest.filter((row) => row.status === 'PENDING').map((row) => `${row.id} ${row.file}: ${row.detail}`),
      ...deliverables.filter((entry) => entry.label !== 'READY_FOR_REVIEW').map((entry) => `${entry.id} ${entry.title}: ${entry.label === 'BLOCKED' ? 'blocked' : 'in draft'}`),
      'Portal-only checks (upload, naming, the portal’s own confirmation) are pending until done on the portal.',
    ];
    deliverables.push({ id: 'D9', title: 'Final QA, submission manifest and approvals', label: label(blocked, draft), items: [...blocked, ...draft] });
  }

  const deadlines = register.dates
    .filter((row) => row.kind === 'MANDATORY')
    .map((row) => ({ label: row.label, when: row.when, ...(row.timeZone ? { timeZone: row.timeZone } : {}), kind: row.kind }));
  const drivers = review.factors.filter((factor) => factor.bearing !== 'CLEAR').map((factor) => factor.finding).slice(0, 6);
  const ready =
    review.recommendation === 'BID' &&
    deliverables.slice(0, 8).every((entry) => entry.label === 'READY_FOR_REVIEW') &&
    approvals.every((approval) => approval.status === 'RECORDED') &&
    manifest.every((row) => row.status === 'VERIFIED');

  const counts = {
    ready: deliverables.filter((entry) => entry.label === 'READY_FOR_REVIEW').length,
    blocked: deliverables.filter((entry) => entry.label === 'BLOCKED').length,
  };
  return {
    read: true,
    recommendation: review.recommendation,
    deadlines,
    drivers,
    approvals,
    deliverables,
    manifest,
    readyForAuthorisedSubmission: ready,
    summary:
      `${review.summary} ${counts.ready} of 9 outputs ready for review, ${counts.blocked} blocked; ` +
      `${approvals.filter((approval) => approval.status === 'RECORDED').length} of ${approvals.length} approvals recorded; ` +
      `${openQuestions.length} question(s) with the buyer; ${registeredRisks} of ${review.risks.length} proposed risk(s) registered. ` +
      (ready ? 'Ready for authorised submission.' : 'Not yet ready for authorised submission.'),
  };
}
