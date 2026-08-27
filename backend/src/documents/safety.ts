import type { DocumentBlock } from '../export/exporter.ts';
import { gapBlock, humanValue, narrativeBlocks, people, shown, shownDate, shownTime, type ComposeInput, type DocumentDefinition, type Row } from './engine.ts';

/**
 * The five safety and health documents.
 *
 * Each is composed from records the platform already holds, and each is built
 * to exploit the one thing a paper form cannot do: **cross-reference**.
 *
 * A permit to work on a pad lists its operatives. This one lists each operative
 * beside the qualification that authorises them *and the date that
 * qualification expires*, checked against the permit's own end date — because
 * the platform holds the competency register and the permit at the same time.
 * A ticket that lapses on the Wednesday does not cover a permit that runs to
 * Friday, and that is the failure this document exists to make impossible.
 *
 * A traffic management plan on a drawing shows arrows. This one carries the
 * seven geometric checks the logistics engine runs — crane radius against the
 * boundary, jib against the overhead line, the longest delivery against each
 * route's height and weight limits — each with the numbers that produced it.
 */

const approved = (state: Row) => state.status === 'APPROVED';

// --- Permit to Work ---------------------------------------------------------

function permitBlocks(input: ComposeInput): DocumentBlock[] {
  const permit = input.subject!;
  const who = people(input.ctx);
  const blocks: DocumentBlock[] = [];

  blocks.push({ kind: 'HEADING', level: 2, text: 'The authorisation' });
  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Permit', value: shown(permit.reference) },
      { label: 'Activity', value: humanValue(permit.activity) },
      { label: 'Precise location', value: shown(permit.location) },
      { label: 'Valid from', value: shownTime(permit.validFrom) },
      { label: 'Valid to', value: shownTime(permit.validTo) },
      { label: 'Issued by', value: who(permit.issuedBy) },
      { label: 'Issued at', value: shownTime(permit.issuedAt) },
      { label: 'Status', value: humanValue(permit.status) },
    ],
  });

  blocks.push({
    kind: 'PARAGRAPH',
    text:
      `This permit authorises the activity named above, at the location named above, between the two times named above, and ` +
      `nothing else. It does not authorise the same activity at a different location, a different activity at this location, ` +
      `or this activity outside these times. Work outside any one of the three is unauthorised work.`,
  });

  // The method statement this permit is issued against — by reference and
  // version, and only where it is genuinely approved. An issued permit against
  // a draft RAMS is the thing the engine already refuses; the document says so.
  const rams = (input.sources.get('RAMS') ?? []).find((r) => r.id === permit.ramsId);
  blocks.push({ kind: 'HEADING', level: 2, text: 'The method statement this permit is issued against' });
  if (!rams) {
    blocks.push(
      gapBlock(
        'the approved method statement this permit cites',
        `The permit names RAMS ${shown(permit.ramsId)}, which is not on this project in an approved state. The permit should not be worked to until that is resolved.`,
      ),
    );
  } else {
    blocks.push({
      kind: 'KEY_VALUES',
      rows: [
        { label: 'Method statement', value: shown(rams.activityDescription) },
        { label: 'Version', value: shown(rams.version) },
        { label: 'Location it covers', value: shown(rams.location) },
        { label: 'Approved by', value: who(rams.approvedBy) },
        { label: 'Approved on', value: shownDate(rams.approvedAt) },
        { label: 'Method steps', value: String(((rams.steps as Row[]) ?? []).length) },
      ],
    });

    // The location on the permit and the location the RAMS covers are two
    // separate records, and nobody compares them on paper.
    if (shown(rams.location) !== shown(permit.location)) {
      blocks.push({
        kind: 'PARAGRAPH',
        text:
          `Note: this permit is for ${shown(permit.location)} and the method statement covers ${shown(rams.location)}. ` +
          'The two do not read the same. Confirm the method statement covers the work before the permit is worked to.',
      });
    }
  }

  // The heart of it: every operative against the ticket that authorises them.
  blocks.push({ kind: 'HEADING', level: 2, text: 'Authorised operatives, and what authorises each of them' });
  const operatives = (permit.operativeIds as string[]) ?? [];
  const competencies = input.sources.get('Competency') ?? [];

  if (operatives.length === 0) {
    blocks.push(gapBlock('the operatives this permit authorises', 'A permit authorising nobody authorises nothing.'));
  } else {
    blocks.push({
      kind: 'TABLE',
      caption: 'Each qualification is checked against the permit’s end date, not against today',
      headers: ['Operative', 'Qualification held', 'Expires', 'Covers this permit to ' + shownTime(permit.validTo)],
      rows: operatives.flatMap((operativeId) => {
        const held = competencies.filter((c) => c.operativeId === operativeId || c.userId === operativeId);
        if (held.length === 0) {
          return [[who(operativeId), 'No qualification recorded', '—', 'No']];
        }
        return held.map((competency) => {
          const expires = shown(competency.expiresAt, '');
          const covers = expires !== '' && expires >= String(permit.validTo);
          return [
            who(operativeId),
            shown(competency.qualification),
            expires === '' ? 'Not recorded' : expires.slice(0, 10),
            covers ? 'Yes' : 'No',
          ];
        });
      }),
    });
  }

  blocks.push({ kind: 'HEADING', level: 2, text: 'Precautions in force' });
  // Recorded as one statement rather than a list, so it is split on the lines
  // and semicolons a person actually types rather than presented as a wall.
  const precautions = shown(permit.precautions, '')
    .split(/\n|;/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (precautions.length === 0) {
    blocks.push(gapBlock('the precautions for this permit', 'The permit record carries none.'));
  } else {
    blocks.push({ kind: 'LIST', ordered: true, items: precautions });
  }

  // Hand-back is on the document because a permit nobody closed is a permit
  // still live, and a live permit on a finished job is how the next shift walks
  // into an isolation that was never restored.
  blocks.push({ kind: 'HEADING', level: 2, text: 'Hand-back' });
  blocks.push({
    kind: 'TABLE',
    headers: ['Handed back by', 'Time', 'Area left safe', 'Isolations restored', 'Received by'],
    rows: [['', '', '', '', '']],
  });
  blocks.push({
    kind: 'PARAGRAPH',
    text:
      'This permit remains live until it is handed back and the hand-back is recorded on the platform. A permit nobody closed ' +
      'is a permit still in force, and the next shift has no way of knowing an isolation was never restored.',
  });

  return blocks;
}

export const PERMIT_TO_WORK: DocumentDefinition = {
  code: 'PERMIT_TO_WORK',
  title: 'Permit to Work',
  category: 'SAFETY_AND_HEALTH',
  purpose:
    'Authorises one high-risk activity, at one location, between two times — and records who is authorised to carry it out, ' +
    'under which method statement, and what has to be in place before it starts.',
  scope: 'RECORD',
  subject: 'Permit',
  subjectRecordedBy: 'the Construction screen',
  audience: 'INTERNAL',
  sources: [
    {
      refType: 'RAMS',
      contributes: 'the method statement the permit is worked to',
      recordedBy: 'the Construction screen',
      mandatory: true,
      predicate: approved,
      qualifier: 'approved',
    },
    {
      refType: 'Competency',
      contributes: 'the qualification that authorises each operative, and its expiry',
      recordedBy: 'the Construction screen',
      mandatory: true,
    },
  ],
  narrative: [
    {
      heading: 'Why these controls, for this activity, at this location',
      brief:
        'Reason about the relationship between the activity, the location and the precautions listed. Explain what each ' +
        'precaution is protecting against and what would happen without it. Do not introduce any precaution, hazard, name, ' +
        'date or figure that is not already on the document.',
    },
  ],
  reference: (input) => shown(input.subject?.reference, ''),
  compose: (input) => [
    ...permitBlocks(input),
    ...narrativeBlocks('Why these controls, for this activity, at this location', input.narrative.get('Why these controls, for this activity, at this location')),
  ],
};

// --- Traffic Management Plan ------------------------------------------------

function trafficBlocks(input: ComposeInput): DocumentBlock[] {
  const plan = (input.sources.get('SiteLogisticsPlan') ?? [])[0]!;
  const blocks: DocumentBlock[] = [];

  blocks.push({ kind: 'HEADING', level: 2, text: 'The plan in force' });
  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Version', value: shown(plan.version) },
      { label: 'Set by', value: shown(plan.setBy) },
      { label: 'Set on', value: shownDate(plan.setAt) },
    ],
  });

  const elements = (plan.elements as Row[]) ?? [];
  blocks.push({ kind: 'HEADING', level: 2, text: 'Site elements' });
  blocks.push({
    kind: 'TABLE',
    headers: ['Reference', 'What it is', 'Description'],
    rows: elements.map((element) => [
      shown(element.reference),
      shown(element.type).toLowerCase().replace(/_/g, ' '),
      shown(element.description),
    ]),
  });

  const routes = (plan.routes as Row[]) ?? [];
  blocks.push({ kind: 'HEADING', level: 2, text: 'Vehicle routes and their limits' });
  if (routes.length === 0) {
    blocks.push(
      gapBlock(
        'the vehicle routes',
        'The logistics plan names no route, so nothing on it says how a vehicle reaches the work.',
      ),
    );
  } else {
    blocks.push({
      kind: 'TABLE',
      caption:
        'Every limit here is a physical constraint on the route or a condition of the consent, not a preference. ' +
        '"None stated" means the limit was never recorded, which is not the same as there being none.',
      headers: ['Route', 'Description', 'Max vehicle length', 'Max height', 'Max weight', 'Delivery window'],
      rows: routes.map((route) => {
        const window = route.deliveryWindow as Row | undefined;
        return [
          shown(route.reference),
          shown(route.description),
          shown(route.maxVehicleLengthMetres, 'None stated'),
          shown(route.maxHeightMetres, 'None stated'),
          shown(route.maxWeightTonnes, 'None stated'),
          window ? `${shown(window.from)} to ${shown(window.to)}` : 'Unrestricted',
        ];
      }),
    });
  }

  const delivery = plan.largestDelivery as Row | undefined;
  if (delivery) {
    blocks.push({ kind: 'HEADING', level: 2, text: 'The delivery the routes have to take' });
    blocks.push({
      kind: 'KEY_VALUES',
      rows: [
        { label: 'What it is', value: shown(delivery.description) },
        { label: 'Length', value: shown(delivery.lengthMetres) },
        { label: 'Height', value: shown(delivery.heightMetres) },
        { label: 'Weight', value: shown(delivery.weightTonnes) },
      ],
    });
  }

  const cranes = (plan.cranes as Row[]) ?? [];
  if (cranes.length > 0) {
    blocks.push({ kind: 'HEADING', level: 2, text: 'Lifting, and what the radius reaches' });
    blocks.push({
      kind: 'TABLE',
      caption:
        'The overhead exclusion is the network operator’s own stated figure, not one derived from a voltage — asking the ' +
        'distribution operator is how that number is arrived at.',
      headers: ['Crane', 'Type', 'Radius', 'Tip height', 'To boundary', 'To overhead line', 'Operator exclusion'],
      rows: cranes.map((crane) => {
        const overhead = crane.overhead as Row | undefined;
        return [
          shown(crane.reference),
          shown(crane.type).toLowerCase(),
          shown(crane.radiusMetres),
          shown(crane.tipHeightMetres),
          shown(crane.distanceToBoundaryMetres),
          overhead ? shown(overhead.distanceMetres) : 'No line recorded',
          overhead ? shown(overhead.exclusionMetres) : '—',
        ];
      }),
    });
  }

  // The checks the engine ran when the plan was set — the version of them that
  // was true at the time, not recomputed against a plan that has since moved.
  const warnings = (plan.warnings as Row[]) ?? [];
  blocks.push({ kind: 'HEADING', level: 2, text: 'What the plan does not resolve' });
  if (warnings.length === 0) {
    blocks.push({
      kind: 'PARAGRAPH',
      text: 'Every geometric check the platform runs against this plan is satisfied: no oversail, no reach into an overhead line, no delivery beyond a route limit, welfare and access both present.',
    });
  } else {
    blocks.push({
      kind: 'TABLE',
      caption: 'Recorded when this version of the plan was set',
      headers: ['Severity', 'What', 'Why it matters'],
      rows: warnings.map((warning) => [shown(warning.severity), shown(warning.subject), shown(warning.detail)]),
    });
  }

  return blocks;
}

export const TRAFFIC_MANAGEMENT_PLAN: DocumentDefinition = {
  code: 'TRAFFIC_MANAGEMENT_PLAN',
  title: 'Traffic Management Plan',
  category: 'SAFETY_AND_HEALTH',
  purpose:
    'How vehicles, plant and people move around this site without meeting each other — the routes, their physical limits, ' +
    'the largest delivery those limits have to accommodate, and what the plan does not yet resolve.',
  scope: 'PROJECT',
  audience: 'INTERNAL',
  sources: [
    {
      refType: 'SiteLogisticsPlan',
      contributes: 'the gates, routes, welfare, storage and lifting positions the plan is made of',
      recordedBy: 'the Field Execution screen',
      mandatory: true,
    },
  ],
  narrative: [
    {
      heading: 'Where vehicles and people come closest to each other',
      brief:
        'Reason about the interaction between the routes, the elements and the largest delivery listed. Identify where a ' +
        'pedestrian and a vehicle are brought closest together and what governs that point. Introduce no route, element, ' +
        'dimension or name that is not already on the document.',
    },
  ],
  compose: (input) => [
    ...trafficBlocks(input),
    ...narrativeBlocks('Where vehicles and people come closest to each other', input.narrative.get('Where vehicles and people come closest to each other')),
  ],
};

// --- Construction Phase Plan ------------------------------------------------

function cppBlocks(input: ComposeInput): DocumentBlock[] {
  const documents = input.sources.get('CDMDocument') ?? [];
  const plan = documents.find((d) => String(d.type ?? '').includes('CONSTRUCTION_PHASE')) ?? documents[0]!;
  const who = people(input.ctx);
  const blocks: DocumentBlock[] = [];

  blocks.push({ kind: 'HEADING', level: 2, text: 'The plan' });
  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Reference', value: shown(plan.reference) },
      { label: 'Title', value: shown(plan.title) },
      { label: 'Status', value: humanValue(plan.status) },
      { label: 'Drafted by', value: plan.draftedByAgent ? `${shown(plan.draftedByAgent)} (agent draft)` : who(plan.draftedBy) },
      { label: 'Requires approval by', value: shown(plan.requiredApprover) },
      { label: 'Approved by', value: plan.approvedBy ? who(plan.approvedBy) : 'Not yet approved' },
    ],
  });

  if (plan.status !== 'APPROVED') {
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        `This construction phase plan is ${shown(plan.status).toLowerCase()} and has not been approved by the ` +
        `${shown(plan.requiredApprover)}. Under CDM 2015 the construction phase must not begin until a plan is in place. ` +
        'This issue is for review; it is not an authorisation to start.',
    });
  }

  const sections = (plan.sections as Row[]) ?? [];
  for (const section of sections) {
    blocks.push({ kind: 'HEADING', level: 3, text: shown(section.heading) });
    blocks.push({ kind: 'PARAGRAPH', text: shown(section.body) });
  }

  const gaps = (plan.gaps as string[]) ?? [];
  if (gaps.length > 0) {
    blocks.push({ kind: 'HEADING', level: 2, text: 'Sections still to be provided' });
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        `${gaps.length} required section${gaps.length === 1 ? ' is' : 's are'} not yet written. They are listed rather than ` +
        'filled, because a section written to complete a form reads exactly like one written from knowledge of the site.',
    });
    blocks.push({ kind: 'LIST', ordered: false, items: gaps });
  }

  // The RAMS and permits in force sit inside the plan's scope and are what it
  // actually governs — a CPP that does not list them is a policy document.
  const rams = input.sources.get('RAMS') ?? [];
  if (rams.length > 0) {
    blocks.push({ kind: 'HEADING', level: 2, text: 'Method statements this plan governs' });
    blocks.push({
      kind: 'TABLE',
      headers: ['Activity', 'Location', 'Version', 'Status', 'Approved'],
      rows: rams.map((r) => [
        shown(r.activityDescription),
        shown(r.location),
        shown(r.version),
        humanValue(r.status),
        shownDate(r.approvedAt, '—'),
      ]),
    });
  }

  return blocks;
}

export const CONSTRUCTION_PHASE_PLAN: DocumentDefinition = {
  code: 'CONSTRUCTION_PHASE_PLAN',
  title: 'Construction Phase Plan',
  category: 'SAFETY_AND_HEALTH',
  purpose:
    'The health and safety arrangements for the construction phase of this project, as required by CDM 2015 regulation 12 — ' +
    'and, listed against them, the method statements those arrangements actually govern.',
  scope: 'PROJECT',
  audience: 'INTERNAL',
  sources: [
    {
      refType: 'CDMDocument',
      contributes: 'the plan’s own sections and the approval it needs',
      recordedBy: 'the Construction screen',
      mandatory: true,
    },
    {
      refType: 'RAMS',
      contributes: 'the method statements the plan governs',
      recordedBy: 'the Construction screen',
      mandatory: false,
    },
  ],
  narrative: [
    {
      heading: 'How the arrangements in this plan fit together',
      brief:
        'Reason about the relationship between the sections above and the method statements listed. Explain how the ' +
        'arrangements interact — where one depends on another, and where a gap in one would undermine another. Introduce no ' +
        'arrangement, name, date or figure that is not already on the document.',
    },
  ],
  compose: (input) => [
    ...cppBlocks(input),
    ...narrativeBlocks('How the arrangements in this plan fit together', input.narrative.get('How the arrangements in this plan fit together')),
  ],
};

// --- RAMS -------------------------------------------------------------------

function ramsBlocks(input: ComposeInput): DocumentBlock[] {
  const rams = input.subject!;
  const who = people(input.ctx);
  const blocks: DocumentBlock[] = [];

  blocks.push({ kind: 'HEADING', level: 2, text: 'The activity' });
  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Activity', value: shown(rams.activityDescription) },
      { label: 'Location', value: shown(rams.location) },
      { label: 'Version', value: shown(rams.version) },
      { label: 'Status', value: humanValue(rams.status) },
      { label: 'Approved by', value: rams.approvedBy ? who(rams.approvedBy) : 'Not yet approved' },
      { label: 'Approved on', value: shownDate(rams.approvedAt, 'Not yet approved') },
    ],
  });

  if (rams.status !== 'APPROVED') {
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        'This method statement has not been approved. It must not be briefed out or worked to in this state, and this issue is ' +
        'for review only.',
    });
  }

  // The resource schedule first, because it is what the site has to have before
  // the first step can start — and reading it after the steps is too late.
  blocks.push({ kind: 'HEADING', level: 2, text: 'What must be on site before this starts' });
  for (const [label, key] of [
    ['Personal protective equipment', 'ppeSchedule'],
    ['Plant and equipment', 'plantSchedule'],
    ['Competencies held', 'competencySchedule'],
  ] as const) {
    const items = (rams[key] as string[]) ?? [];
    blocks.push({ kind: 'HEADING', level: 3, text: label });
    if (items.length === 0) blocks.push(gapBlock(label.toLowerCase(), 'The method statement records none.'));
    else blocks.push({ kind: 'LIST', ordered: false, items });
  }

  blocks.push({ kind: 'HEADING', level: 2, text: 'The method, step by step' });
  const steps = (rams.steps as Row[]) ?? [];
  if (steps.length === 0) {
    blocks.push(gapBlock('the method steps', 'A method statement with no steps states no method.'));
  } else {
    for (const step of steps) {
      blocks.push({ kind: 'HEADING', level: 3, text: `Step ${shown(step.sequence)} — ${shown(step.description)}` });
      // Hazard beside its control, on the same row. A hazard register and a
      // control register on separate pages is how a control gets dropped in a
      // revision and nobody notices which hazard it belonged to.
      const hazards = (step.hazards as string[]) ?? [];
      const controls = (step.controls as string[]) ?? [];
      blocks.push({
        kind: 'TABLE',
        headers: ['Hazard', 'Control in place'],
        rows: hazards.map((hazard, index) => [hazard, controls[index] ?? controls.join('; ') ?? 'Not recorded']),
      });
      const ppe = (step.ppe as string[]) ?? [];
      if (ppe.length > 0) blocks.push({ kind: 'PARAGRAPH', text: `PPE for this step: ${ppe.join(', ')}.` });
    }
  }

  const acknowledgements = (rams.acknowledgements as string[]) ?? [];
  blocks.push({ kind: 'HEADING', level: 2, text: 'Briefing record' });
  if (acknowledgements.length === 0) {
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        'Nobody has been briefed on this method statement yet. Work must not start until the briefing is recorded — an ' +
        'unbriefed operative working to a method statement they have not seen is working to their own.',
    });
  } else {
    blocks.push({
      kind: 'TABLE',
      caption: `Last briefed ${shownDate(rams.lastBriefedAt)}`,
      headers: ['Operative', 'Acknowledged the briefing'],
      rows: acknowledgements.map((operativeId) => [who(operativeId), 'Yes']),
    });
  }

  return blocks;
}

export const RAMS_DOCUMENT: DocumentDefinition = {
  code: 'RAMS',
  title: 'Risk Assessment and Method Statement',
  category: 'SAFETY_AND_HEALTH',
  purpose:
    'The hazards this activity presents, the control in place against each of them, and the sequence of work that keeps those ' +
    'controls effective — together with what must be on site before the first step begins.',
  scope: 'RECORD',
  subject: 'RAMS',
  subjectRecordedBy: 'the Construction screen',
  audience: 'INTERNAL',
  sources: [],
  narrative: [
    {
      heading: 'Where this method is most sensitive to being worked out of sequence',
      brief:
        'Reason about the ordering of the steps above and the controls attached to each. Identify which step depends most on ' +
        'the one before it, and what is exposed if the sequence is broken. Introduce no step, hazard, control or name that is ' +
        'not already on the document.',
    },
  ],
  reference: (input) => undefined,
  compose: (input) => [
    ...ramsBlocks(input),
    ...narrativeBlocks(
      'Where this method is most sensitive to being worked out of sequence',
      input.narrative.get('Where this method is most sensitive to being worked out of sequence'),
    ),
  ],
};

// --- Induction Register -----------------------------------------------------

function inductionBlocks(input: ComposeInput): DocumentBlock[] {
  const inductions = input.sources.get('Induction') ?? [];
  const who = people(input.ctx);
  const blocks: DocumentBlock[] = [];

  blocks.push({ kind: 'HEADING', level: 2, text: 'Who has been inducted onto this site' });
  blocks.push({
    kind: 'TABLE',
    caption: `${inductions.length} induction${inductions.length === 1 ? '' : 's'} recorded`,
    headers: ['Person', 'Employer', 'Inducted on', 'Inducted by', 'Competencies checked', 'Valid until'],
    rows: inductions.map((induction) => [
      shown(induction.personName),
      shown(induction.employer),
      shownDate(induction.recordedAt),
      who(induction.inductedBy),
      ((induction.competenciesChecked as string[]) ?? []).join(', ') || 'None recorded',
      shownDate(induction.validUntil),
    ]),
  });

  // The register's value is the negative space: who is on site and has not been
  // inducted. That cross-check is only possible because the platform holds both.
  const competencies = input.sources.get('Competency') ?? [];
  const inducted = new Set(inductions.map((induction) => shown(induction.personId)));
  const onSiteNotInducted = [
    ...new Set(
      competencies
        .map((competency) => shown(competency.operativeId ?? competency.userId))
        .filter((who) => who !== 'Not recorded' && !inducted.has(who)),
    ),
  ];

  const lapsed = inductions.filter((induction) => shownDate(induction.validUntil, '') !== '' && shownDate(induction.validUntil, '') < input.today);
  if (lapsed.length > 0) {
    blocks.push({ kind: 'HEADING', level: 2, text: 'Inductions that have lapsed' });
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        `${lapsed.length} induction${lapsed.length === 1 ? ' has' : 's have'} passed the date they were valid until. A lapsed ` +
        'induction is a different fact from an absent one — the person was inducted, and the briefing they received is now out ' +
        'of date against a site that has changed.',
    });
    blocks.push({
      kind: 'TABLE',
      headers: ['Person', 'Employer', 'Inducted on', 'Valid until'],
      rows: lapsed.map((induction) => [
        shown(induction.personName),
        shown(induction.employer),
        shownDate(induction.recordedAt),
        shownDate(induction.validUntil),
      ]),
    });
  }

  blocks.push({ kind: 'HEADING', level: 2, text: 'People the platform knows about who have no induction' });
  if (onSiteNotInducted.length === 0) {
    blocks.push({
      kind: 'PARAGRAPH',
      text: 'Everybody with a competency record on this project has an induction record against them.',
    });
  } else {
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        `${onSiteNotInducted.length} ${onSiteNotInducted.length === 1 ? 'person holds' : 'people hold'} a competency record on ` +
        'this project with no induction recorded against them. That is not proof they are on site — but it is the list to ' +
        'check before the next shift, and it is only visible because both registers are held together.',
    });
    blocks.push({ kind: 'LIST', ordered: false, items: onSiteNotInducted.map((person) => who(person)) });
  }

  return blocks;
}

export const INDUCTION_REGISTER: DocumentDefinition = {
  code: 'INDUCTION_REGISTER',
  title: 'Site Induction Register',
  category: 'SAFETY_AND_HEALTH',
  purpose:
    'Proof that each person working on this site received the site rules before starting — and, beside it, the people the ' +
    'platform knows about who have no induction recorded.',
  scope: 'PROJECT',
  audience: 'INTERNAL',
  sources: [
    {
      refType: 'Induction',
      contributes: 'the induction records themselves',
      recordedBy: 'the Construction screen',
      mandatory: true,
    },
    {
      refType: 'Competency',
      contributes: 'the people known to this project, so those without an induction can be named',
      recordedBy: 'the Construction screen',
      mandatory: false,
    },
  ],
  narrative: [
    {
      heading: 'What the people with no induction against them have in common',
      brief:
        'Reason about the negative space in this register: which employers, trades or dates the people with no induction ' +
        'recorded fall under, and what that pattern suggests about how people are reaching this site. Do not state any ' +
        'name, employer, date or figure that is not already on the document.',
    },
  ],
  // The register was the one document type that asked the reasoning engine for
  // nothing. Its facts are a table, but the question a safety manager actually
  // has of it — what the people missing from it have in common — is exactly the
  // kind of pattern reasoning belongs to, and the same question the site diary
  // already asks of forty entries.
  compose: (input) => [
    ...inductionBlocks(input),
    ...narrativeBlocks(
      'What the people with no induction against them have in common',
      input.narrative.get('What the people with no induction against them have in common'),
    ),
  ],
};

export const SAFETY_DOCUMENTS = [
  PERMIT_TO_WORK,
  TRAFFIC_MANAGEMENT_PLAN,
  CONSTRUCTION_PHASE_PLAN,
  RAMS_DOCUMENT,
  INDUCTION_REGISTER,
];
