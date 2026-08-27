import { formatMoney } from '../domain/locale.ts';
import type { DocumentBlock } from '../export/exporter.ts';
import {
  gapBlock,
  humanValue,
  narrativeBlocks,
  people,
  shown,
  shownDate,
  shownTime,
  type ComposeInput,
  type DocumentDefinition,
  type Row,
} from './engine.ts';

/**
 * The five quality and compliance documents.
 *
 * These are the documents that are read years after the job finishes, usually
 * by somebody who was not there. That changes what they have to carry.
 *
 * An inspection and test plan on paper is a list of stages with a tick box. This
 * one puts the *inspection that actually happened* against each stage, in the
 * same table, and names the stages where a hold point was passed without a
 * recorded release — which is the one failure an ITP exists to prevent and the
 * one a paper ITP cannot show.
 *
 * A non-conformance report closed with "rectified" is a closed report. This one
 * carries the disposition — rework, repair, use as is, reject — and where the
 * disposition is *use as is*, states plainly that a departure from the
 * specification has been accepted into the permanent works, with the name of the
 * person who accepted it. That is the record the building owner needs and the
 * one nobody wants to write.
 *
 * An as-built register lists drawings. This one lists them beside their file
 * hashes and names every drawing still at a preliminary revision, because a
 * register that presents a P-revision drawing as as-built is describing
 * something that was never built.
 *
 * An O&M manual is usually a box of PDFs. This one is the asset register, its
 * warranties with their expiry dates, the commissioning results that proved the
 * plant works, and the defects still open against it — cross-referenced, so a
 * facilities manager can see that the defect they are looking at sits under a
 * warranty that expires in four months.
 */

const currencyOf = (input: ComposeInput) => String(input.project.currency ?? 'GBP');

const byReference = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

// --- Inspection and Test Plan -----------------------------------------------

function itpBlocks(input: ComposeInput): DocumentBlock[] {
  const plan = input.subject!;
  const blocks: DocumentBlock[] = [];
  const who = people(input.ctx);

  const stages = (plan.stages as Row[]) ?? [];
  const inspections = (input.sources.get('QualityInspection') ?? []).filter(
    (inspection) => inspection.planId === plan.id,
  );
  const ncrs = input.sources.get('NCR') ?? [];

  blocks.push({ kind: 'HEADING', level: 2, text: 'The plan' });
  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Reference', value: shown(plan.reference) },
      { label: 'Title', value: shown(plan.title) },
      { label: 'Discipline', value: humanValue(plan.discipline) },
      { label: 'Specification section', value: shown(plan.specificationRef) },
      { label: 'Status', value: humanValue(plan.status) },
      { label: 'Created by', value: who(plan.createdBy) },
      { label: 'Created', value: shownTime(plan.createdAt) },
      { label: 'Stages', value: String(stages.length) },
      { label: 'Hold points', value: String(stages.filter((stage) => stage.type === 'HOLD').length) },
    ],
  });

  blocks.push({
    kind: 'PARAGRAPH',
    text:
      'A hold point stops the work. A witness point does not stop the work but must be attended. A review point is checked ' +
      'against the record afterwards. The difference decides whether a missed step is a defect or a paperwork gap, and it is ' +
      'stated against every stage below rather than left to the reader.',
  });

  // The join. Two record sets — the plan and the inspections carried out
  // against it — put in one table. On paper these are two documents and nobody
  // reconciles them until an auditor does.
  blocks.push({ kind: 'HEADING', level: 2, text: 'Each stage, and the inspection actually carried out against it' });
  blocks.push({
    kind: 'TABLE',
    headers: ['Stage', 'What is inspected', 'Type', 'Acceptance criteria', 'Responsible', 'Inspected', 'Outcome', 'By'],
    rows: [...stages]
      .sort((a, b) => byReference(shown(a.reference, ''), shown(b.reference, '')))
      .map((stage) => {
        const done = inspections.filter((inspection) => inspection.stageReference === stage.reference);
        const latest = done.sort((a, b) => shown(b.inspectedAt, '').localeCompare(shown(a.inspectedAt, '')))[0];
        return [
          shown(stage.reference),
          shown(stage.description),
          humanValue(stage.type),
          shown(stage.acceptanceCriteria),
          shown(stage.responsible),
          latest ? shownDate(latest.inspectedAt) : 'Not carried out',
          latest ? humanValue(latest.outcome) : humanValue(stage.status, 'Pending'),
          latest ? shown(latest.inspectedBy) : '—',
        ];
      }),
  });

  // The failure this document exists to prevent, stated by name.
  const uninspectedHolds = stages.filter(
    (stage) =>
      stage.type === 'HOLD' && !inspections.some((inspection) => inspection.stageReference === stage.reference),
  );

  blocks.push({ kind: 'HEADING', level: 2, text: 'Hold points with no recorded release' });
  if (uninspectedHolds.length === 0) {
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        'Every hold point in this plan has an inspection recorded against it. This was checked stage by stage when this ' +
        'document was composed, against the inspection records themselves.',
    });
  } else {
    blocks.push({
      kind: 'TABLE',
      caption:
        'Work should not have proceeded past any of these without a release. If it has, that is a non-conformance whether ' +
        'or not one has been raised',
      headers: ['Stage', 'What should have been inspected', 'Acceptance criteria', 'Who should have released it'],
      rows: uninspectedHolds.map((stage) => [
        shown(stage.reference),
        shown(stage.description),
        shown(stage.acceptanceCriteria),
        shown(stage.responsible),
      ]),
    });
  }

  // Failures, and what became of them.
  const failures = inspections.filter((inspection) => inspection.outcome === 'FAIL');
  if (failures.length > 0) {
    blocks.push({ kind: 'HEADING', level: 2, text: 'Inspections that failed, and the non-conformance each raised' });
    blocks.push({
      kind: 'TABLE',
      headers: ['Stage', 'Inspected', 'By', 'Comments', 'Non-conformance', 'Its status'],
      rows: failures.map((inspection) => {
        const raised = ncrs.find((ncr) => ncr.inspectionId === inspection.id);
        return [
          shown(inspection.stageReference),
          shownDate(inspection.inspectedAt),
          shown(inspection.inspectedBy),
          shown(inspection.comments),
          raised ? shown(raised.reference) : 'None raised',
          raised ? `${humanValue(raised.status)}${raised.disposition ? ` — ${humanValue(raised.disposition)}` : ''}` : '—',
        ];
      }),
    });
  }

  return blocks;
}

const INSPECTION_TEST_PLAN: DocumentDefinition = {
  code: 'INSPECTION_TEST_PLAN',
  title: 'Inspection and Test Plan',
  category: 'QUALITY_AND_COMPLIANCE',
  purpose:
    'Sets out each stage at which the work is inspected, tested or held, the criterion it is accepted against, and who is ' +
    'responsible for it — alongside the inspection actually recorded against each stage. Hold points with no recorded ' +
    'release are named, because that is the one failure this document exists to prevent.',
  scope: 'RECORD',
  subject: 'InspectionPlan',
  subjectRecordedBy: 'the All commands screen — there is no curated quality panel yet',
  audience: 'CLIENT',
  sources: [
    {
      refType: 'QualityInspection',
      contributes: 'the inspection actually carried out against each stage, and its outcome',
      recordedBy: 'the All commands screen',
      mandatory: false,
    },
    {
      refType: 'NCR',
      contributes: 'the non-conformance raised by any inspection that failed',
      recordedBy: 'the All commands screen',
      mandatory: false,
    },
  ],
  narrative: [
    {
      heading: 'Where this plan is exposed',
      brief:
        'Reason about the relationship between the hold points, the inspections recorded against them and any failures. Say ' +
        'which gaps matter and what would have to be done to close them. Do not state any stage, date, name or criterion ' +
        'that is not already on the document.',
    },
  ],
  reference: (input) => shown(input.subject?.reference, ''),
  compose: (input) => [
    ...itpBlocks(input),
    ...narrativeBlocks('Where this plan is exposed', input.narrative.get('Where this plan is exposed')),
  ],
};

// --- Material Approval Submittal --------------------------------------------

function submittalBlocks(input: ComposeInput): DocumentBlock[] {
  const submittal = input.subject!;
  const blocks: DocumentBlock[] = [];
  const who = people(input.ctx);

  blocks.push({ kind: 'HEADING', level: 2, text: 'What is being submitted' });
  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Reference', value: shown(submittal.reference) },
      { label: 'Revision', value: shown(submittal.revision) },
      { label: 'Kind', value: humanValue(submittal.kind) },
      { label: 'Title', value: shown(submittal.title) },
      { label: 'Manufacturer', value: shown(submittal.manufacturer) },
      { label: 'Product reference', value: shown(submittal.productReference) },
      { label: 'Status', value: humanValue(submittal.status) },
      { label: 'Submission cycles to date', value: shown(submittal.cycles, '0') },
    ],
  });

  // What it answers. A submittal with no clause behind it is a product data
  // sheet, and the platform refuses to create one — so this section always has
  // content, and says exactly what is being demonstrated.
  blocks.push({ kind: 'HEADING', level: 2, text: 'The specification clause this answers' });
  const clause = (input.sources.get('SpecClause') ?? []).find((row) => row.id === submittal.clauseId);
  if (!clause) {
    blocks.push(
      gapBlock(
        'the specification clause this submittal answers',
        `The submittal cites clause ${shown(submittal.clauseId)}, which is no longer on this project's register. The ` +
          'submittal was created against a clause that existed at the time; confirm what happened to it before relying on ' +
          'this approval.',
      ),
    );
  } else {
    blocks.push({
      kind: 'KEY_VALUES',
      rows: [
        { label: 'Section', value: shown(clause.specificationRef) },
        { label: 'Clause', value: shown(clause.clauseRef) },
        { label: 'Kind of requirement', value: humanValue(clause.kind) },
        {
          label: 'Mandatory or advisory',
          value:
            clause.mandatory === true
              ? 'Mandatory — the clause says shall or must, so a departure is a non-conformance'
              : 'Advisory — the clause says should, so a departure is a conversation',
        },
        { label: 'Standards cited', value: ((clause.standards as string[]) ?? []).join(', ') || 'None cited' },
      ],
    });
    blocks.push({ kind: 'PARAGRAPH', text: shown(clause.text) });
  }

  // The comparison, both sides. This is what the reviewer is being asked to
  // agree to, and it is the difference between a submittal and a brochure.
  const claims = (submittal.claims as Row[]) ?? [];
  blocks.push({ kind: 'HEADING', level: 2, text: 'What is specified, and what is offered' });
  blocks.push({
    kind: 'TABLE',
    caption: 'Both sides of every comparison. A claim with only one side of it is not recorded by this platform',
    headers: ['Requirement', 'Specified', 'Offered', 'Complies', 'If not, why it is offered anyway'],
    rows: claims.map((claim) => [
      shown(claim.requirement),
      shown(claim.specified),
      shown(claim.offered),
      claim.compliant === true ? 'Yes' : 'No',
      claim.compliant === true ? '—' : shown(claim.justification),
    ]),
  });

  const departures = claims.filter((claim) => claim.compliant !== true);
  if (departures.length > 0) {
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        `${departures.length} of the ${claims.length} requirements above ${
          departures.length === 1 ? 'is' : 'are'
        } offered as not complying with the specification. Approving this submittal approves ${
          departures.length === 1 ? 'that departure' : 'those departures'
        }. ${
          departures.length === 1 ? 'It is set out above with the reason given' : 'They are set out above with the reason given for each'
        }, and a reviewer signing this is signing for ${departures.length === 1 ? 'it' : 'them'}.`,
    });
  }

  const substitution = submittal.substitution as Row | undefined;
  if (substitution) {
    blocks.push({ kind: 'HEADING', level: 2, text: 'This is offered as a substitution' });
    blocks.push({
      kind: 'KEY_VALUES',
      rows: [
        { label: 'It is offered instead of', value: shown(substitution.differsFrom) },
        { label: 'Why', value: shown(substitution.whyProposed) },
      ],
    });
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        'Approving this submittal accepts a product other than the one specified. That is a change, and it is stated here ' +
        'so that nobody can later say the reviewer approved a product and was not told they were approving a change.',
    });
  }

  // The programme arithmetic. The number nobody computes on a submittal cover
  // sheet, and the only one that costs money.
  blocks.push({ kind: 'HEADING', level: 2, text: 'When this decision is actually needed' });
  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Required on site by', value: shownDate(submittal.requiredOnSiteBy) },
      { label: 'Procurement lead time', value: `${shown(submittal.procurementLeadTimeDays)} days` },
      {
        label: 'Therefore approval is needed by',
        value: `${shownDate(submittal.approvalNeededBy)} — derived from the two figures above, not typed`,
      },
      { label: 'Contractual review period', value: `${shown(submittal.reviewPeriodDays)} days` },
      { label: 'Submitted for review', value: submittal.submittedAt ? shownTime(submittal.submittedAt) : 'Not yet submitted' },
      { label: 'First submitted', value: submittal.firstSubmittedAt ? shownTime(submittal.firstSubmittedAt) : '—' },
      { label: 'Review due by', value: submittal.reviewDueBy ? shownDate(submittal.reviewDueBy) : 'Not yet submitted' },
    ],
  });

  const neededBy = shown(submittal.approvalNeededBy, '');
  const dueBy = shown(submittal.reviewDueBy, '');
  if (neededBy && dueBy && dueBy > neededBy) {
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        `The contractual review period runs to ${dueBy}. Approval is needed by ${neededBy}. A reviewer answering entirely ` +
        'within the period the contract allows would still answer too late for the material to arrive when it is needed. ' +
        'That is a programme exposure that exists whether or not anybody is in breach.',
    });
  }

  blocks.push({ kind: 'HEADING', level: 2, text: 'The decision' });
  if (!submittal.reviewedAt) {
    blocks.push(
      gapBlock(
        'the reviewer’s decision',
        submittal.status === 'UNDER_REVIEW'
          ? 'This submittal is with the reviewer and has not been decided.'
          : 'This submittal has not been submitted for review.',
      ),
    );
  } else {
    blocks.push({
      kind: 'KEY_VALUES',
      rows: [
        { label: 'Outcome', value: humanValue(submittal.status) },
        { label: 'Decided by', value: who(submittal.reviewedBy) },
        { label: 'Decided', value: shownTime(submittal.reviewedAt) },
        {
          label: 'May the material be ordered',
          value:
            submittal.status === 'APPROVED' || submittal.status === 'APPROVED_WITH_COMMENTS'
              ? 'Yes'
              : 'No — this submittal has not been approved',
        },
      ],
    });
    blocks.push({ kind: 'PARAGRAPH', text: shown(submittal.reviewComments, 'No comments were recorded.') });
  }

  const ordered = submittal.ordered as Row | undefined;
  if (ordered) {
    blocks.push({ kind: 'HEADING', level: 2, text: 'The order' });
    blocks.push({
      kind: 'KEY_VALUES',
      rows: [
        { label: 'Order reference', value: shown(ordered.orderReference) },
        { label: 'Placed', value: shownTime(ordered.at) },
        { label: 'Placed by', value: who(ordered.by) },
        {
          label: 'Placed at risk',
          value:
            ordered.atRisk === true
              ? 'Yes — this material was ordered before the submittal was approved'
              : 'No — the submittal was approved before the order was placed',
        },
      ],
    });
    if (ordered.atRisk === true) {
      blocks.push({ kind: 'PARAGRAPH', text: `Reason the risk was accepted: ${shown(ordered.justification)}` });
    }
  }

  return blocks;
}

const MATERIAL_SUBMITTAL: DocumentDefinition = {
  code: 'MATERIAL_SUBMITTAL',
  title: 'Material Approval Submittal',
  category: 'QUALITY_AND_COMPLIANCE',
  purpose:
    'Proposes one product against one specification clause, setting out what the specification demands and what the ' +
    'product achieves, requirement by requirement. It states the date approval is actually needed — derived from the ' +
    'procurement lead time, not typed — and, where the material was ordered before approval, that it was ordered at risk.',
  scope: 'RECORD',
  subject: 'MaterialSubmittal',
  subjectRecordedBy: 'the Design & BIM screen',
  audience: 'CLIENT',
  sources: [
    {
      refType: 'SpecClause',
      contributes: 'the clause this submittal answers, and whether it is mandatory or advisory',
      recordedBy: 'the Design & BIM screen',
      mandatory: true,
    },
  ],
  narrative: [
    {
      heading: 'What approving this commits the project to',
      brief:
        'Reason about the departures, any substitution, and the relationship between the review period and the date ' +
        'approval is needed. Say what a reviewer is actually accepting and what the consequence of a delay would be. Do not ' +
        'state any product, value, date or figure that is not already on the document.',
    },
  ],
  reference: (input) => shown(input.subject?.reference, ''),
  compose: (input) => [
    ...submittalBlocks(input),
    ...narrativeBlocks(
      'What approving this commits the project to',
      input.narrative.get('What approving this commits the project to'),
    ),
  ],
};

// --- Non-Conformance Report -------------------------------------------------

function ncrBlocks(input: ComposeInput): DocumentBlock[] {
  const ncr = input.subject!;
  const blocks: DocumentBlock[] = [];
  const who = people(input.ctx);

  blocks.push({ kind: 'HEADING', level: 2, text: 'The non-conformance' });
  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Reference', value: shown(ncr.reference) },
      { label: 'Severity', value: humanValue(ncr.severity) },
      { label: 'Raised by', value: who(ncr.raisedBy) },
      { label: 'Raised', value: shownTime(ncr.raisedAt) },
      { label: 'Status', value: humanValue(ncr.status) },
    ],
  });

  blocks.push({ kind: 'HEADING', level: 3, text: 'What does not conform' });
  blocks.push({ kind: 'PARAGRAPH', text: shown(ncr.description) });

  blocks.push({ kind: 'HEADING', level: 3, text: 'What was proposed to put it right' });
  blocks.push({ kind: 'PARAGRAPH', text: shown(ncr.proposedAction) });

  // Where it came from. An NCR raised off a failed inspection carries the
  // acceptance criterion the work failed against, and that criterion is the
  // thing an auditor asks for first.
  blocks.push({ kind: 'HEADING', level: 2, text: 'What found it' });
  const inspection = (input.sources.get('QualityInspection') ?? []).find((row) => row.id === ncr.inspectionId);
  if (!inspection) {
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        ncr.inspectionId
          ? `This non-conformance cites inspection ${shown(ncr.inspectionId)}, which is not on this project's register.`
          : 'This non-conformance was raised directly rather than by a recorded inspection, so there is no acceptance ' +
            'criterion on the platform that the work was formally measured against. That does not make it less real; it ' +
            'means the criterion has to come from the specification rather than from this record.',
    });
  } else {
    blocks.push({
      kind: 'KEY_VALUES',
      rows: [
        { label: 'Inspection', value: shown(inspection.reference) },
        { label: 'Plan', value: shown(inspection.planReference) },
        { label: 'Stage', value: shown(inspection.stageReference) },
        { label: 'Stage type', value: humanValue(inspection.stageType) },
        { label: 'Acceptance criterion it failed against', value: shown(inspection.acceptanceCriteria) },
        { label: 'Inspected by', value: shown(inspection.inspectedBy) },
        { label: 'Inspected', value: shownTime(inspection.inspectedAt) },
      ],
    });
    if (inspection.stageType === 'HOLD') {
      blocks.push({
        kind: 'PARAGRAPH',
        text:
          'This failure was found at a hold point. Work should not have proceeded past it, so the extent of any work built ' +
          'on top of the non-conformance needs establishing before this report is closed.',
      });
    }
  }

  blocks.push({ kind: 'HEADING', level: 2, text: 'The disposition' });
  if (ncr.status !== 'CLOSED') {
    blocks.push(
      gapBlock(
        'the disposition',
        'This non-conformance is still open. Until it is dispositioned, the work it describes has neither been put right ' +
          'nor formally accepted as it stands.',
      ),
    );
  } else {
    blocks.push({
      kind: 'KEY_VALUES',
      rows: [
        { label: 'Disposition', value: humanValue(ncr.disposition) },
        { label: 'Closed by', value: who(ncr.closedBy) },
        { label: 'Closed', value: shownTime(ncr.closedAt) },
      ],
    });
    blocks.push({ kind: 'PARAGRAPH', text: shown(ncr.justification, 'No justification was recorded.') });

    // The paragraph nobody wants to write, on the one disposition that changes
    // what was built. It names the person, because "the project accepted it" is
    // how an accepted departure becomes nobody's decision.
    if (ncr.disposition === 'USE_AS_IS') {
      blocks.push({
        kind: 'PARAGRAPH',
        text:
          `This non-conformance was closed as use-as-is. The work described above does not meet the specification and has ` +
          `been accepted into the permanent works as it stands, by ${who(ncr.closedBy)} on ` +
          `${shownDate(ncr.closedAt)}, for the reason set out above. Anybody relying on this project meeting its ` +
          'specification in this respect should read that reason.',
      });
    }
    if (ncr.disposition === 'REJECT') {
      blocks.push({
        kind: 'PARAGRAPH',
        text:
          'This non-conformance was closed as rejected. The work described above was not accepted and is to be removed. ' +
          'Confirm the removal and the replacement are recorded before this is treated as resolved.',
      });
    }
  }

  return blocks;
}

const NON_CONFORMANCE_REPORT: DocumentDefinition = {
  code: 'NON_CONFORMANCE_REPORT',
  title: 'Non-Conformance Report',
  category: 'QUALITY_AND_COMPLIANCE',
  purpose:
    'Records work that does not meet the specification, what found it, the criterion it failed against, and how it was ' +
    'dispositioned. Where the disposition is use-as-is, it states plainly that a departure has been accepted into the ' +
    'permanent works and names the person who accepted it.',
  scope: 'RECORD',
  subject: 'NCR',
  subjectRecordedBy: 'a failed inspection raises one automatically; otherwise the All commands screen',
  audience: 'CLIENT',
  sources: [
    {
      refType: 'QualityInspection',
      contributes: 'the inspection that found it and the acceptance criterion it failed against',
      recordedBy: 'the All commands screen',
      mandatory: false,
    },
  ],
  narrative: [
    {
      heading: 'What this non-conformance leaves behind',
      brief:
        'Reason about the consequence of the disposition recorded: what remains true about the works, what a later reader ' +
        'would need to know, and what should be checked before it is treated as resolved. Do not state any date, name, ' +
        'criterion or figure that is not already on the document.',
    },
  ],
  reference: (input) => shown(input.subject?.reference, ''),
  compose: (input) => [
    ...ncrBlocks(input),
    ...narrativeBlocks(
      'What this non-conformance leaves behind',
      input.narrative.get('What this non-conformance leaves behind'),
    ),
  ],
};

// --- As-Built Drawing Register ----------------------------------------------

function asBuiltBlocks(input: ComposeInput): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];

  const drawings = input.sources.get('Drawing') ?? [];
  const models = input.sources.get('Model') ?? [];

  blocks.push({ kind: 'HEADING', level: 2, text: 'The register' });
  blocks.push({
    kind: 'PARAGRAPH',
    text:
      'Each drawing below is listed with the hash of the file this platform holds. The hash is what makes this register an ' +
      'as-built record rather than a list of titles: a reader can confirm that the file they have been given is the file ' +
      'this register describes, which a drawing number alone can never do.',
  });

  blocks.push({
    kind: 'TABLE',
    headers: ['Drawing', 'Title', 'Discipline', 'Revision', 'Status', 'Issued', 'File hash'],
    rows: [...drawings]
      .sort((a, b) => byReference(shown(a.drawingNumber, ''), shown(b.drawingNumber, '')))
      .map((drawing) => [
        shown(drawing.drawingNumber),
        shown(drawing.title),
        humanValue(drawing.discipline),
        shown(drawing.revision),
        humanValue(drawing.status),
        shownDate(drawing.issueDate),
        shown(drawing.fileHash),
      ]),
  });

  // The check that decides whether this register is an as-built record at all.
  // A P-revision drawing is a preliminary issue: it describes an intention, not
  // a thing that was built.
  blocks.push({ kind: 'HEADING', level: 2, text: 'Drawings still at a preliminary revision' });
  const preliminary = drawings.filter((drawing) => /^P/i.test(shown(drawing.revision, '')));
  if (preliminary.length === 0) {
    blocks.push({
      kind: 'PARAGRAPH',
      text: 'No drawing in this register is at a preliminary revision. Every revision listed above is a construction issue.',
    });
  } else {
    blocks.push({
      kind: 'TABLE',
      caption:
        'A preliminary revision describes an intention, not a thing that was built. Any drawing below is not an as-built ' +
        'record and must not be relied on as one',
      headers: ['Drawing', 'Title', 'Revision', 'Status'],
      rows: preliminary.map((drawing) => [
        shown(drawing.drawingNumber),
        shown(drawing.title),
        shown(drawing.revision),
        humanValue(drawing.status),
      ]),
    });
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        (drawings.length === 1
          ? 'The only drawing in this register is'
          : preliminary.length === drawings.length
            ? `Every one of the ${drawings.length} drawings in this register is`
            : `${preliminary.length} of the ${drawings.length} drawings in this register ${
                preliminary.length === 1 ? 'is' : 'are'
              }`) +
        ' still at a preliminary revision. This register is therefore not a complete as-built record, and states that ' +
        'rather than presenting itself as one.',
    });
  }

  const superseded = drawings.filter((drawing) => drawing.status === 'SUPERSEDED');
  if (superseded.length > 0) {
    blocks.push({ kind: 'HEADING', level: 2, text: 'Superseded issues, retained' });
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        'These issues are no longer current and are listed because the record of what was superseded, and when, is part of ' +
        'the as-built history. A register that deleted them could not answer what somebody was building to in March.',
    });
    blocks.push({
      kind: 'TABLE',
      headers: ['Drawing', 'Title', 'Revision', 'Issued', 'File hash'],
      rows: superseded.map((drawing) => [
        shown(drawing.drawingNumber),
        shown(drawing.title),
        shown(drawing.revision),
        shownDate(drawing.issueDate),
        shown(drawing.fileHash),
      ]),
    });
  }

  if (models.length > 0) {
    const asBuiltModels = models.filter((model) => shown(model.status, '').toUpperCase().replace(/[\s_]/g, '') === 'ASBUILT');
    blocks.push({ kind: 'HEADING', level: 2, text: 'Models held against this project' });
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        asBuiltModels.length === 0
          ? `${models.length} model${models.length === 1 ? ' is' : 's are'} held against this project and none of them is ` +
            'recorded as an as-built model. They are listed because they are part of the information record, but nothing ' +
            'below evidences what was actually built.'
          : `${asBuiltModels.length} of the ${models.length} models held against this project ${
              asBuiltModels.length === 1 ? 'is' : 'are'
            } recorded as as-built. The rest are earlier issues, listed because what was modelled before construction is ` +
            'part of the record, and marked in the status column so nobody mistakes one for the other.',
    });
    // Identified by discipline, format, level of detail and hash. A model
    // record on this platform carries no title, and inventing a column for one
    // produced a table of "Not recorded" — which reads as a missing field
    // rather than as a record that never had one.
    blocks.push({
      kind: 'TABLE',
      caption: 'A model is identified by its hash. Two models of the same discipline at the same LOD are not the same model',
      headers: ['Discipline', 'Format', 'Level of detail', 'Elements', 'Status', 'Ingested', 'Hash'],
      rows: [...models]
        .sort((a, b) => shown(a.discipline, '').localeCompare(shown(b.discipline, '')) || Number(a.lod ?? 0) - Number(b.lod ?? 0))
        .map((model) => [
          humanValue(model.discipline),
          shown(model.format),
          shown(model.lod),
          Number(model.elementCount ?? 0).toLocaleString('en-GB'),
          humanValue(model.status),
          shownDate(model.ingestedAt),
          shown(model.fileHash),
        ]),
    });
  }

  return blocks;
}

const AS_BUILT_REGISTER: DocumentDefinition = {
  code: 'AS_BUILT_REGISTER',
  title: 'As-Built Drawing Register',
  category: 'QUALITY_AND_COMPLIANCE',
  purpose:
    'Lists every drawing and model forming the as-built record, each with the hash of the file this platform holds, so a ' +
    'reader can confirm the file they have is the file this register describes. Drawings still at a preliminary revision ' +
    'are named, because a preliminary drawing describes an intention rather than a thing that was built.',
  scope: 'PROJECT',
  audience: 'CLIENT',
  sources: [
    {
      refType: 'Drawing',
      contributes: 'the drawings, their revisions and the hash of each file held',
      recordedBy: 'the Design & BIM screen',
      mandatory: true,
    },
    {
      refType: 'Model',
      contributes: 'the models forming part of the as-built record',
      recordedBy: 'the Design & BIM screen',
      mandatory: false,
    },
  ],
  narrative: [
    {
      heading: 'What this register does and does not evidence',
      brief:
        'Reason about the completeness of the register: what the preliminary revisions mean for anybody relying on it, what ' +
        'the superseded issues establish, and what would have to change for this to be a complete as-built record. Do not ' +
        'state any drawing, revision, hash or date that is not already on the document.',
    },
  ],
  compose: (input) => [
    ...asBuiltBlocks(input),
    ...narrativeBlocks(
      'What this register does and does not evidence',
      input.narrative.get('What this register does and does not evidence'),
    ),
  ],
};

// --- Operation and Maintenance Manual ---------------------------------------

function omBlocks(input: ComposeInput): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  const currency = currencyOf(input);

  const assets = input.sources.get('AssetRegisterItem') ?? [];
  const warranties = input.sources.get('Warranty') ?? [];
  const tests = input.sources.get('CommissioningTest') ?? [];
  const defects = input.sources.get('Defect') ?? [];
  const manuals = input.sources.get('OMManual') ?? [];

  blocks.push({ kind: 'HEADING', level: 2, text: 'What this manual covers' });
  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Assets in the register', value: String(assets.length) },
      { label: 'Assets under warranty', value: String(new Set(warranties.map((w) => String(w.assetId))).size) },
      { label: 'Commissioning tests recorded', value: String(tests.length) },
      { label: 'Defects still open', value: String(defects.filter((defect) => defect.status !== 'CLOSED').length) },
    ],
  });

  blocks.push({ kind: 'HEADING', level: 2, text: 'The asset register' });
  blocks.push({
    kind: 'TABLE',
    headers: ['Tag', 'Description', 'Class', 'Location', 'Manufacturer', 'Model', 'Serial', 'Installed', 'Status'],
    rows: [...assets]
      .sort((a, b) => byReference(shown(a.assetTag, ''), shown(b.assetTag, '')))
      .map((asset) => [
        shown(asset.assetTag),
        shown(asset.description),
        humanValue(asset.assetClass),
        shown(asset.location),
        shown(asset.manufacturer),
        shown(asset.modelNumber),
        shown(asset.serialNumber),
        shownDate(asset.installedAt),
        humanValue(asset.status),
      ]),
  });

  blocks.push({ kind: 'HEADING', level: 2, text: 'Expected life and replacement' });
  blocks.push({
    kind: 'PARAGRAPH',
    text:
      'The replacement cost against each asset is what the platform holds for planning purposes, not a quotation. It is ' +
      'stated so that a facilities manager building a sinking fund starts from a recorded figure rather than an estimate ' +
      'made years later without the equipment in front of them.',
  });
  blocks.push({
    kind: 'TABLE',
    headers: ['Tag', 'Description', 'Expected life', 'Expected replacement', 'Replacement cost held'],
    rows: [...assets]
      .sort((a, b) => byReference(shown(a.assetTag, ''), shown(b.assetTag, '')))
      .map((asset) => [
        shown(asset.assetTag),
        shown(asset.description),
        asset.expectedLifeYears === undefined ? 'Not recorded' : `${shown(asset.expectedLifeYears)} years`,
        shownDate(asset.expectedReplacementDate),
        asset.replacementCostMinor === undefined
          ? 'Not recorded'
          : formatMoney(Number(asset.replacementCostMinor), currency),
      ]),
  });

  // The cross-reference that makes this worth generating. A warranty and a
  // defect are two records nobody puts side by side, and the question "is this
  // still covered" is the one a facilities manager asks first.
  blocks.push({ kind: 'HEADING', level: 2, text: 'Warranties, and what is still open against each asset' });
  if (warranties.length === 0) {
    blocks.push(
      gapBlock(
        'the warranties',
        'No warranty is recorded against any asset. Anybody operating this plant is doing so with no recorded cover.',
      ),
    );
  } else {
    const tagOf = new Map(assets.map((asset) => [String(asset.id), shown(asset.assetTag)]));
    blocks.push({
      kind: 'TABLE',
      caption: 'The expiry column is measured against the date this document was issued',
      headers: ['Asset', 'Provider', 'Coverage', 'Starts', 'Expires', 'Still in force', 'Open defects against it'],
      rows: warranties.map((warranty) => {
        const expiry = shown(warranty.expiryDate, '');
        const starts = shownDate(warranty.startDate, '');
        const open = defects.filter(
          (defect) => defect.assetId === warranty.assetId && defect.status !== 'CLOSED',
        );
        // Both ends of the period, not just the far one. A warranty that runs
        // from practical completion has not commenced while the plant is still
        // being built, and answering "yes, in force" on the strength of an
        // expiry date two years out is the wrong answer to the only question
        // this column is asked.
        const inForce =
          !expiry ? 'Not determinable' : expiry < input.today ? 'No — expired' : starts && starts > input.today ? `No — does not commence until ${starts}` : 'Yes';
        return [
          tagOf.get(String(warranty.assetId)) ?? shown(warranty.assetId),
          shown(warranty.provider),
          shown(warranty.coverage),
          shownDate(warranty.startDate),
          expiry || 'Not recorded',
          inForce,
          open.length === 0 ? 'None' : open.map((defect) => shown(defect.reference)).join(', '),
        ];
      }),
    });

    // The warning worth its own paragraph: an open defect under a warranty
    // running out. That is a claim somebody is about to lose by not making it.
    const expiring = warranties.filter((warranty) => {
      const expiry = shown(warranty.expiryDate, '');
      const starts = shownDate(warranty.startDate, '');
      if (!expiry || expiry < input.today) return false;
      // Not yet commenced is not running out.
      if (starts && starts > input.today) return false;
      const daysLeft = Math.floor((Date.parse(expiry) - Date.parse(input.today)) / 86_400_000);
      const open = defects.some((defect) => defect.assetId === warranty.assetId && defect.status !== 'CLOSED');
      return open && daysLeft <= 180;
    });
    if (expiring.length > 0) {
      blocks.push({
        kind: 'PARAGRAPH',
        text:
          `${expiring.length} warrant${expiring.length === 1 ? 'y has' : 'ies have'} an open defect against the asset and ` +
          'expire within six months of the date on this document. A defect not claimed before the warranty runs out ' +
          'becomes an operating cost, and the two records this is derived from sit in different registers.',
      });
    }
  }

  blocks.push({ kind: 'HEADING', level: 2, text: 'Defects open at issue' });
  const open = defects.filter((defect) => defect.status !== 'CLOSED');
  if (open.length === 0) {
    blocks.push({ kind: 'PARAGRAPH', text: 'No defect is open against any asset in this register.' });
  } else {
    blocks.push({
      kind: 'TABLE',
      headers: ['Reference', 'Description', 'Location', 'Severity', 'Reported', 'Target close', 'Under warranty', 'Provider'],
      rows: open.map((defect) => [
        shown(defect.reference),
        shown(defect.description),
        shown(defect.location),
        humanValue(defect.severity),
        shownDate(defect.reportedAt),
        shownDate(defect.targetCloseDate),
        defect.warrantyCovered === true ? 'Yes' : 'No',
        shown(defect.warrantyProvider, '—'),
      ]),
    });
  }

  blocks.push({ kind: 'HEADING', level: 2, text: 'Commissioning — what was proved, and against what' });
  if (tests.length === 0) {
    blocks.push(
      gapBlock(
        'the commissioning results',
        'No commissioning test is recorded. Nothing in this manual establishes that the plant described above was ever ' +
          'demonstrated to work.',
      ),
    );
  } else {
    for (const test of tests) {
      blocks.push({ kind: 'HEADING', level: 3, text: `${shown(test.systemName)} — ${shown(test.testType)}` });
      blocks.push({
        kind: 'KEY_VALUES',
        rows: [
          { label: 'System', value: shown(test.systemId) },
          { label: 'Test standard', value: shown(test.testStandard) },
          { label: 'Result', value: humanValue(test.result) },
          { label: 'Tested', value: shownTime(test.testedAt) },
          { label: 'Witnessed by', value: shown(test.witnessedBy) },
          { label: 'Accepted by', value: shown(test.acceptedBy, 'Not yet accepted') },
          { label: 'Accepted', value: test.acceptedAt ? shownTime(test.acceptedAt) : 'Not yet accepted' },
          { label: 'Readings outside tolerance', value: shown(test.outOfToleranceCount, '0') },
        ],
      });
      const readings = (test.readings as Row[]) ?? [];
      if (readings.length > 0) {
        blocks.push({
          kind: 'TABLE',
          caption: 'The readings themselves, not a pass mark',
          headers: ['Parameter', 'Expected', 'Measured', 'Within tolerance'],
          rows: readings.map((reading) => [
            shown(reading.parameter),
            shown(reading.expected),
            shown(reading.actual),
            reading.withinTolerance === true ? 'Yes' : 'No',
          ]),
        });
      }
    }
  }

  // The maintenance regime, marked for what it is. The platform extracted this
  // from manufacturer documentation with a stated confidence, and printing it
  // as though a person wrote it would be exactly the misrepresentation the whole
  // document engine exists to prevent.
  if (manuals.length > 0) {
    blocks.push({ kind: 'HEADING', level: 2, text: 'Maintenance regime, as extracted from the manufacturer documentation' });
    for (const manual of manuals) {
      blocks.push({
        kind: 'KEY_VALUES',
        rows: [
          { label: 'System', value: shown(manual.systemName) },
          { label: 'Source documents read', value: shown(manual.sourceDocumentCount) },
          {
            label: 'Extraction confidence',
            value:
              typeof manual.extractionConfidence === 'number'
                ? `${Math.round(manual.extractionConfidence * 100)}% — this regime was read from the supplied documentation by the platform, not transcribed by a person`
                : 'Not stated',
          },
          { label: 'Published', value: shownTime(manual.publishedAt) },
        ],
      });
      blocks.push({ kind: 'PARAGRAPH', text: shown(manual.maintenanceNarrative) });
    }
  }

  return blocks;
}

const OM_MANUAL: DocumentDefinition = {
  code: 'OM_MANUAL',
  title: 'Operation and Maintenance Manual',
  category: 'QUALITY_AND_COMPLIANCE',
  purpose:
    'The record the building owner operates from: every asset with its make, model and serial number, the warranties ' +
    'against them with their expiry dates, the commissioning readings that proved the plant works, and the defects still ' +
    'open. Warranties are cross-referenced against open defects, so an unclaimed defect under an expiring warranty is ' +
    'visible before the cover runs out.',
  scope: 'PROJECT',
  audience: 'CLIENT',
  sources: [
    {
      refType: 'AssetRegisterItem',
      contributes: 'the assets, their make, model, serial number and expected life',
      recordedBy: 'the Handover & O&M screen',
      mandatory: true,
    },
    {
      refType: 'Warranty',
      contributes: 'the cover against each asset and when it runs out',
      recordedBy: 'the Handover & O&M screen',
      mandatory: false,
    },
    {
      refType: 'CommissioningTest',
      contributes: 'the readings that demonstrated the plant works',
      recordedBy: 'the Handover & O&M screen',
      mandatory: false,
    },
    {
      refType: 'Defect',
      contributes: 'what is still open against each asset at handover',
      recordedBy: 'the Handover & O&M screen',
      mandatory: false,
    },
    {
      refType: 'OMManual',
      contributes: 'the maintenance regime extracted from the manufacturer documentation',
      recordedBy: 'the Handover & O&M screen',
      mandatory: false,
    },
  ],
  narrative: [
    {
      heading: 'What the operator should attend to first',
      brief:
        'Reason about the relationship between the open defects, the warranty expiry dates and the commissioning results. ' +
        'Say what should be claimed before cover runs out and what should be watched. Do not state any asset, date, figure ' +
        'or reading that is not already on the document.',
    },
  ],
  compose: (input) => [
    ...omBlocks(input),
    ...narrativeBlocks(
      'What the operator should attend to first',
      input.narrative.get('What the operator should attend to first'),
    ),
  ],
};

export const QUALITY_DOCUMENTS: DocumentDefinition[] = [
  INSPECTION_TEST_PLAN,
  MATERIAL_SUBMITTAL,
  NON_CONFORMANCE_REPORT,
  AS_BUILT_REGISTER,
  OM_MANUAL,
];
