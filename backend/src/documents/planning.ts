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
 * The five project management and planning documents.
 *
 * The safety five are built around **cross-reference** — a permit checked
 * against the competency register it never sees on paper. These five are built
 * around something different: **the arithmetic nobody does by hand**.
 *
 * A master programme printed from planning software is a picture of activities.
 * This one carries the critical path the platform computed, each activity's
 * float, and — for every activity on that path — the constraints and RFIs that
 * are currently blocking it. That join does not exist in a Gantt chart, and it
 * is the only thing on the page that tells a reader which line to worry about.
 *
 * A bill of quantities is a list of items and rates. This one re-evaluates
 * every dimension formula against the quantity it produced, in the document, and
 * says where the two disagree — because a formula and a quantity that no longer
 * agree is the commonest error in a bill and the least visible one.
 *
 * A site diary is a page a day. This one is a period, with labour hours, plant
 * idle time and delay events totalled across it, and every day the platform did
 * *not* receive named — because a diary with three days missing is a diary that
 * proves nothing about those three days, and on a delay claim that is the whole
 * argument.
 */

const currencyOf = (input: ComposeInput) => String(input.project.currency ?? 'GBP');

/** Sorts references the way a person expects: A9 before A10. */
const byReference = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

// --- Master Programme -------------------------------------------------------

function programmeBlocks(input: ComposeInput): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];

  const tasks = input.sources.get('Task') ?? [];
  const dependencies = input.sources.get('Dependency') ?? [];
  const constraints = input.sources.get('Constraint') ?? [];
  const rfis = input.sources.get('RFI') ?? [];

  // The live baseline, not the first one recorded. A programme document issued
  // against a superseded baseline is the document that starts the argument.
  const baselines = input.sources.get('ProgrammeBaseline') ?? [];
  const baseline =
    baselines.find((row) => row.status === 'LIVE') ??
    [...baselines].sort((a, b) => shown(b.calculatedAt, '').localeCompare(shown(a.calculatedAt, '')))[0]!;

  blocks.push({ kind: 'HEADING', level: 2, text: 'The baseline this programme is measured against' });
  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Baseline', value: humanValue(baseline.type ?? baseline.status) },
      { label: 'Calculated', value: shownTime(baseline.calculatedAt) },
      { label: 'Activities', value: shown(baseline.activityCount) },
      { label: 'Duration at this baseline', value: `${shown(baseline.projectDurationDays)} days` },
      {
        // The P80 is the figure that should be committed to, and it is almost
        // never the figure on the bar chart. Printing the deterministic
        // duration alone is how a programme with no float gets signed.
        label: 'Duration at 80% confidence',
        value: baseline.p80DurationDays === undefined ? 'Not modelled' : `${shown(baseline.p80DurationDays)} days`,
      },
      {
        label: 'Probability of completing to this duration',
        value:
          typeof baseline.probabilityOnTime === 'number'
            ? `${Math.round(baseline.probabilityOnTime * 100)}%`
            : 'Not modelled',
      },
    ],
  });

  const criticalIds = new Set((baseline.criticalPathTaskIds as string[]) ?? []);

  blocks.push({ kind: 'HEADING', level: 2, text: 'The critical path' });
  if (criticalIds.size === 0) {
    blocks.push(
      gapBlock(
        'the critical path',
        'The baseline holds no critical path, which means the network has not been calculated since the activities last ' +
          'changed. Recalculate the baseline before this programme is relied on.',
      ),
    );
  } else {
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        `${criticalIds.size} of the ${tasks.length} activities on this project are on the critical path. A day lost on any ` +
        'one of them is a day lost on the project, and the last column of the table below is why that day would be lost.',
    });

    blocks.push({
      kind: 'TABLE',
      caption: 'Critical activities, and what is currently in front of each of them',
      headers: ['Activity', 'Code', 'Duration', 'Complete', 'Status', 'Currently blocked by'],
      rows: tasks
        .filter((task) => criticalIds.has(String(task.id)))
        .sort((a, b) => byReference(shown(a.activityCode, ''), shown(b.activityCode, '')))
        .map((task) => [
          shown(task.name),
          shown(task.activityCode),
          `${shown(task.durationDays)} days`,
          `${shown(task.percentComplete, '0')}%`,
          humanValue(task.status),
          blockersFor(task, constraints, rfis),
        ]),
    });
  }

  blocks.push({ kind: 'HEADING', level: 2, text: 'Every activity, and where it stands' });
  blocks.push({
    kind: 'TABLE',
    headers: ['Code', 'Activity', 'Duration', 'Complete', 'Status', 'Slippage', 'On the critical path'],
    rows: [...tasks]
      .sort((a, b) => byReference(shown(a.activityCode, ''), shown(b.activityCode, '')))
      .map((task) => [
        shown(task.activityCode),
        shown(task.name),
        `${shown(task.durationDays)} days`,
        `${shown(task.percentComplete, '0')}%`,
        humanValue(task.status),
        // Slippage in days, signed as a person reads it. Zero shows as zero
        // rather than as a blank, because a blank reads as "not measured".
        typeof task.slippageDays === 'number' ? `${task.slippageDays > 0 ? '+' : ''}${task.slippageDays} days` : 'Not measured',
        criticalIds.has(String(task.id)) ? 'Yes' : 'No',
      ]),
  });

  // The logic, stated. A programme without its dependencies is a list of
  // durations, and a reader cannot tell a genuinely parallel activity from one
  // somebody forgot to link.
  blocks.push({ kind: 'HEADING', level: 2, text: 'The logic between the activities' });
  if (dependencies.length === 0) {
    blocks.push(
      gapBlock(
        'the dependencies between activities',
        'No links are recorded, so every activity in the table above is unconstrained by every other one. A programme with ' +
          'no logic is a list of durations.',
      ),
    );
  } else {
    const nameOf = new Map(tasks.map((task) => [String(task.id), shown(task.name)]));
    blocks.push({
      kind: 'TABLE',
      headers: ['Predecessor', 'Relationship', 'Lag', 'Successor'],
      rows: dependencies.map((link) => [
        nameOf.get(String(link.predecessorId)) ?? shown(link.predecessorId),
        relationshipName(link.type),
        `${shown(link.lag, '0')} days`,
        nameOf.get(String(link.successorId)) ?? shown(link.successorId),
      ]),
    });
  }

  // Activities with no logic at either end. Not a warning invented for the
  // document — it is derivable from the two record sets on the page above, and
  // it is the check a planner runs by eye and misses.
  const linked = new Set<string>();
  for (const link of dependencies) {
    linked.add(String(link.predecessorId));
    linked.add(String(link.successorId));
  }
  const orphans = tasks.filter((task) => !linked.has(String(task.id)));
  if (orphans.length > 0) {
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        `${orphans.length} activity${orphans.length === 1 ? '' : 'ies'} in the table above — ` +
        `${orphans.map((task) => shown(task.name)).join(', ')} — ` +
        'has no predecessor and no successor. An unlinked activity floats freely in the calculation and can never appear on ' +
        'the critical path, whatever it actually depends on.',
    });
  }

  return blocks;
}

/**
 * What is currently in front of one activity.
 *
 * Composed from two record sets neither of which knows about the other: the
 * constraints log and the RFI register. Nobody makes this join on paper, and it
 * is the only column on the programme that says why a date will move.
 */
function blockersFor(task: Row, constraints: Row[], rfis: Row[]): string {
  const held = constraints
    .filter((constraint) => constraint.taskId === task.id && constraint.status !== 'CLOSED')
    .map((constraint) => `${shown(constraint.reference, 'Constraint')}: ${shown(constraint.description)}`);

  const asked = rfis
    .filter((rfi) => rfi.linkedTaskId === task.id && rfi.status !== 'ANSWERED' && rfi.status !== 'CLOSED')
    .map((rfi) => `${shown(rfi.reference, 'RFI')} unanswered`);

  const both = [...held, ...asked];
  return both.length === 0 ? 'Nothing recorded' : both.join('; ');
}

function relationshipName(type: unknown): string {
  switch (shown(type, '')) {
    case 'FS':
      return 'Finish to start';
    case 'SS':
      return 'Start to start';
    case 'FF':
      return 'Finish to finish';
    case 'SF':
      return 'Start to finish';
    default:
      return humanValue(type);
  }
}

const MASTER_PROGRAMME: DocumentDefinition = {
  code: 'MASTER_PROGRAMME',
  title: 'Master Programme',
  category: 'PROJECT_MANAGEMENT',
  purpose:
    'Sets out every activity, the logic between them, the critical path through them, and — for each critical activity — ' +
    'what is currently in front of it. It is the document the project is measured against, so it states the baseline it ' +
    'was calculated from and the confidence attached to that duration.',
  scope: 'PROJECT',
  audience: 'CLIENT',
  sources: [
    {
      refType: 'ProgrammeBaseline',
      contributes: 'the baseline duration, the critical path and the confidence attached to the date',
      recordedBy: 'the Programme screen',
      mandatory: true,
    },
    {
      refType: 'Task',
      contributes: 'the activities, their durations and how far each has got',
      recordedBy: 'the Programme screen',
      mandatory: true,
    },
    {
      refType: 'Dependency',
      contributes: 'the logic between the activities',
      recordedBy: 'the Programme screen',
      mandatory: false,
    },
    {
      refType: 'Constraint',
      contributes: 'what is currently holding a critical activity up',
      recordedBy: 'the Field Execution screen',
      mandatory: false,
    },
    {
      refType: 'RFI',
      contributes: 'the unanswered questions blocking a critical activity',
      recordedBy: 'the Design & BIM screen',
      mandatory: false,
    },
  ],
  narrative: [
    {
      heading: 'What the critical path is actually telling you',
      brief:
        'Reason about the relationship between the critical activities, the constraints and RFIs blocking them, and the ' +
        'confidence figure on the baseline. Say which blockers matter most and why, and what would have to change for the ' +
        'date to hold. Do not state any activity, date, duration or figure that is not already on the document.',
    },
  ],
  compose: (input) => [
    ...programmeBlocks(input),
    ...narrativeBlocks(
      'What the critical path is actually telling you',
      input.narrative.get('What the critical path is actually telling you'),
    ),
  ],
};

// --- Bill of Quantities -----------------------------------------------------

function boqBlocks(input: ComposeInput): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  const currency = currencyOf(input);

  // A frozen schedule where there is one, because a bill issued off an open
  // schedule is a bill whose quantities can change after it is sent.
  const schedules = input.sources.get('MeasurementSchedule') ?? [];
  const schedule = schedules.find((row) => row.status === 'FROZEN') ?? schedules[0]!;
  const items = (schedule.items as Row[]) ?? [];
  const rates = (schedule.rates as Row[]) ?? [];
  const rateFor = new Map(rates.map((rate) => [String(rate.reference), rate]));

  blocks.push({ kind: 'HEADING', level: 2, text: 'The schedule this bill is taken from' });
  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Schedule', value: shown(schedule.reference ?? schedule.title ?? schedule.id) },
      { label: 'Measurement rule', value: shown(schedule.measurementRule, 'Recorded per item') },
      { label: 'Status', value: humanValue(schedule.status) },
      { label: 'Items measured', value: String(items.length) },
      { label: 'Items priced', value: String(rates.length) },
    ],
  });

  if (schedule.status !== 'FROZEN') {
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        'This bill is taken from a schedule that is still open. The quantities below can change after this document is ' +
        'issued, and a recipient pricing against them is pricing against a moving target. Freeze the schedule before this ' +
        'is sent out.',
    });
  }

  blocks.push({ kind: 'HEADING', level: 2, text: 'The bill' });

  let total = 0;
  const rows = [...items]
    .sort((a, b) => byReference(shown(a.reference, ''), shown(b.reference, '')))
    .map((item) => {
      const rate = rateFor.get(String(item.reference));
      const quantity = Number(item.quantity ?? 0);
      const rateMinor = rate ? Number(rate.rateMinor ?? 0) : undefined;
      const lineMinor = rateMinor === undefined ? undefined : Math.round(rateMinor * quantity);
      if (lineMinor !== undefined) total += lineMinor;
      return [
        shown(item.reference),
        shown(item.description),
        shown(item.unit),
        quantity.toLocaleString('en-GB'),
        humanValue(item.basis),
        rateMinor === undefined ? 'Not priced' : formatMoney(rateMinor, currency),
        lineMinor === undefined ? '—' : formatMoney(lineMinor, currency),
      ];
    });

  blocks.push({
    kind: 'TABLE',
    caption: 'Rates are direct cost per unit. Preliminaries, risk, overhead and profit are not in them',
    headers: ['Item', 'Description', 'Unit', 'Quantity', 'Basis', 'Rate', 'Amount'],
    rows,
  });

  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Total of priced items, direct cost', value: formatMoney(total, currency) },
      { label: 'Items with no rate against them', value: String(items.length - rates.length) },
    ],
  });

  // The check nobody does. The formula and the quantity are two separate
  // fields, entered at different times, and when they stop agreeing the bill
  // still looks perfectly reasonable.
  blocks.push({ kind: 'HEADING', level: 2, text: 'Where a dimension and its quantity no longer agree' });
  const disagreements: string[][] = [];
  const unparseable: string[][] = [];
  let checked = 0;

  for (const item of items) {
    const formula = shown(item.formula, '');
    if (formula.length === 0) continue;
    const computed = evaluateArithmetic(formula);
    if (computed === undefined) {
      // Named rather than skipped. A dimension the platform could not evaluate
      // is a dimension nobody has checked, and quietly counting it as fine is
      // how a check reports full coverage it never had.
      unparseable.push([shown(item.reference), shown(item.description), formula, shown(item.quantity)]);
      continue;
    }
    checked += 1;
    const quantity = Number(item.quantity ?? 0);
    if (Math.abs(computed - quantity) > 0.001) {
      disagreements.push([
        shown(item.reference),
        shown(item.description),
        formula,
        computed.toString(),
        quantity.toString(),
      ]);
    }
  }

  const withoutFormula = items.length - checked - unparseable.length;
  blocks.push({
    kind: 'PARAGRAPH',
    text:
      `${checked} of the ${items.length} items in this bill carry a dimension formula that could be re-evaluated, and each ` +
      `was re-evaluated when this document was composed rather than taken on trust. ${
        withoutFormula === 0
          ? 'Every item carries one.'
          : `${withoutFormula} carr${withoutFormula === 1 ? 'ies' : 'y'} no formula, so ${
              withoutFormula === 1 ? 'its quantity has' : 'those quantities have'
            } nothing to check against.`
      }`,
  });

  if (disagreements.length === 0) {
    blocks.push({
      kind: 'PARAGRAPH',
      text: 'Every formula that could be evaluated produced the quantity billed against it.',
    });
  } else {
    blocks.push({
      kind: 'TABLE',
      caption: 'Each formula below was re-evaluated when this document was composed and did not produce the quantity billed',
      headers: ['Item', 'Description', 'Dimensions as recorded', 'What they evaluate to', 'Quantity billed'],
      rows: disagreements,
    });
  }

  if (unparseable.length > 0) {
    blocks.push({
      kind: 'TABLE',
      caption:
        'The dimensions recorded against these items are not arithmetic this platform can evaluate, so the quantity beside ' +
        'each is unchecked rather than confirmed',
      headers: ['Item', 'Description', 'Dimensions as recorded', 'Quantity billed'],
      rows: unparseable,
    });
  }

  // Quantities that are not firm, and what that means to somebody pricing them.
  const provisional = items.filter((item) => item.basis !== undefined && item.basis !== 'FIRM');
  blocks.push({ kind: 'HEADING', level: 2, text: 'Quantities that are not firm' });
  if (provisional.length === 0) {
    blocks.push({ kind: 'PARAGRAPH', text: 'Every quantity in this bill is measured firm.' });
  } else {
    blocks.push({
      kind: 'TABLE',
      caption:
        `${provisional.length} of the ${items.length} items in this bill carr${
          provisional.length === 1 ? 'ies' : 'y'
        } a quantity that is not firm. What that means for the price depends on the contract, and the basis is stated here ` +
        'so nobody has to assume it',
      headers: ['Item', 'Description', 'Unit', 'Quantity', 'Basis', 'Where the quantity came from'],
      rows: provisional
        .sort((a, b) => byReference(shown(a.reference, ''), shown(b.reference, '')))
        .map((item) => [
          shown(item.reference),
          shown(item.description),
          shown(item.unit),
          Number(item.quantity ?? 0).toLocaleString('en-GB'),
          humanValue(item.basis),
          humanValue(item.source),
        ]),
    });
  }

  // Anything the platform knows has to be measured again.
  const remeasure = ((schedule.remeasure as Row[]) ?? []).filter((flag) => flag.status === 'OPEN');
  if (remeasure.length > 0) {
    blocks.push({ kind: 'HEADING', level: 2, text: 'Items awaiting remeasurement' });
    blocks.push({
      kind: 'TABLE',
      caption: 'The drawing these were measured from has been superseded and the quantity has not been confirmed since',
      headers: ['Item', 'Drawing', 'Measured from', 'Now at', 'Flagged'],
      rows: remeasure.map((flag) => [
        shown(flag.reference),
        shown(flag.drawing),
        shown(flag.fromRevision),
        shown(flag.toRevision),
        shownDate(flag.raisedAt),
      ]),
    });
  }

  return blocks;
}

/**
 * The same arithmetic the measurement engine evaluates, for the check on the
 * page.
 *
 * Deliberately not imported from `domain/measurement.ts`: that module's
 * evaluator is internal to the schedule's own validation, and a document that
 * reached into a domain module's private parser would couple the two so that a
 * change to one silently changed what the other printed. This is a small,
 * total, non-`eval` recursive descent over numbers, `+ - * /` and parentheses —
 * nothing else parses, and anything it cannot parse is reported as unchecked
 * rather than as wrong.
 */
function evaluateArithmetic(text: string): number | undefined {
  let at = 0;
  const source = text.replace(/\s+/g, '');

  const number = (): number | undefined => {
    if (source[at] === '(') {
      at += 1;
      const inner = expression();
      if (inner === undefined || source[at] !== ')') return undefined;
      at += 1;
      return inner;
    }
    const start = at;
    while (at < source.length && /[0-9.]/.test(source[at]!)) at += 1;
    if (at === start) return undefined;
    const value = Number(source.slice(start, at));
    return Number.isFinite(value) ? value : undefined;
  };

  const term = (): number | undefined => {
    let left = number();
    if (left === undefined) return undefined;
    while (source[at] === '*' || source[at] === '/') {
      const operator = source[at];
      at += 1;
      const right = number();
      if (right === undefined) return undefined;
      if (operator === '/' && right === 0) return undefined;
      left = operator === '*' ? left * right : left / right;
    }
    return left;
  };

  const expression = (): number | undefined => {
    let left = term();
    if (left === undefined) return undefined;
    while (source[at] === '+' || source[at] === '-') {
      const operator = source[at];
      at += 1;
      const right = term();
      if (right === undefined) return undefined;
      left = operator === '+' ? left + right : left - right;
    }
    return left;
  };

  const value = expression();
  return at === source.length ? value : undefined;
}

const BILL_OF_QUANTITIES: DocumentDefinition = {
  code: 'BILL_OF_QUANTITIES',
  title: 'Bill of Quantities',
  category: 'PROJECT_MANAGEMENT',
  purpose:
    'Sets out every measured item, its unit, its quantity, the basis that quantity was measured on and the rate built ' +
    'against it. Every dimension formula recorded against an item is re-evaluated when this document is composed, and any ' +
    'that no longer produces the quantity billed is named.',
  scope: 'PROJECT',
  audience: 'CLIENT',
  sources: [
    {
      refType: 'MeasurementSchedule',
      contributes: 'the measured items, their quantities and the rates built against them',
      recordedBy: 'the Tender & Procurement screen',
      mandatory: true,
    },
  ],
  narrative: [
    {
      heading: 'Where the commercial risk in this bill actually sits',
      brief:
        'Reason about the relationship between the provisional quantities, the unpriced items, the items awaiting ' +
        'remeasurement and any formula that no longer agrees with its quantity. Say which of them exposes the party pricing ' +
        'this bill and why. Do not state any item, quantity, rate or figure that is not already on the document.',
    },
  ],
  compose: (input) => [
    ...boqBlocks(input),
    ...narrativeBlocks(
      'Where the commercial risk in this bill actually sits',
      input.narrative.get('Where the commercial risk in this bill actually sits'),
    ),
  ],
};

// --- Site Diary -------------------------------------------------------------

function diaryBlocks(input: ComposeInput): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  const who = people(input.ctx);

  const entries = [...(input.sources.get('SiteDiary') ?? [])].sort((a, b) =>
    shown(a.diaryDate, '').localeCompare(shown(b.diaryDate, '')),
  );

  const first = shown(entries[0]!.diaryDate, '');
  const last = shown(entries[entries.length - 1]!.diaryDate, '');

  blocks.push({ kind: 'HEADING', level: 2, text: 'The period this record covers' });
  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'First entry', value: first },
      { label: 'Last entry', value: last },
      { label: 'Entries recorded', value: String(entries.length) },
      {
        // The single most important fact about a diary in a dispute. An entry
        // written on the day carries weight; one written six weeks later, from
        // memory, carries very little, and a document that did not distinguish
        // them would be misrepresenting its own evidential value.
        label: 'Recorded on the day',
        value: `${entries.filter((entry) => entry.contemporaneous === true).length} of ${entries.length}`,
      },
    ],
  });

  // The days with no entry at all. Computed by walking the calendar between the
  // first and last entry rather than by trusting a count, because a diary with
  // three days missing proves nothing about those three days — and on a delay
  // claim that silence is the entire argument.
  const held = new Set(entries.map((entry) => shown(entry.diaryDate, '')));
  const missing: string[] = [];
  for (let day = Date.parse(first); day <= Date.parse(last); day += 86_400_000) {
    const date = new Date(day).toISOString().slice(0, 10);
    if (!held.has(date)) missing.push(date);
  }

  blocks.push({ kind: 'HEADING', level: 2, text: 'Days in this period with no entry' });
  if (missing.length === 0) {
    blocks.push({
      kind: 'PARAGRAPH',
      text: `Every calendar day between ${first} and ${last} carries an entry. There are no gaps in this record.`,
    });
  } else {
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        `${missing.length} calendar day${missing.length === 1 ? '' : 's'} between ${first} and ${last} carr${
          missing.length === 1 ? 'ies' : 'y'
        } no entry: ${missing.join(', ')}. ` +
        'These days are named rather than omitted. A diary that skips a day silently reads as a diary of a project that had ' +
        'nothing happen on it, and on a delay claim the silence is what the argument turns on.',
    });
  }

  // The totals. Nobody adds forty diary entries by hand, and the pattern across
  // them is the only thing the individual pages cannot show.
  const labourHours = entries.reduce((sum, entry) => sum + Number(entry.labourHours ?? 0), 0);
  const idleHours = entries.reduce((sum, entry) => sum + Number(entry.plantIdleHours ?? 0), 0);
  const stopped = entries.filter((entry) => (entry.weather as Row | undefined)?.workingStopped === true);
  const blocked = entries.filter((entry) => ((entry.blockers as unknown[]) ?? []).length > 0);
  const safety = entries.flatMap((entry) => (entry.safetyEvents as unknown[]) ?? []);

  blocks.push({ kind: 'HEADING', level: 2, text: 'The period totalled' });
  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Labour hours', value: labourHours.toLocaleString('en-GB') },
      { label: 'Plant idle hours', value: idleHours.toLocaleString('en-GB') },
      {
        label: 'Idle plant as a share of labour effort',
        value: labourHours === 0 ? 'Not calculable' : `${((100 * idleHours) / labourHours).toFixed(1)}%`,
      },
      { label: 'Days on which weather stopped work', value: String(stopped.length) },
      { label: 'Days with a blocker recorded', value: String(blocked.length) },
      { label: 'Safety events recorded', value: String(safety.length) },
    ],
  });

  if (stopped.length > 0) {
    blocks.push({
      kind: 'TABLE',
      caption: 'Days on which the record says weather stopped work — the evidence behind any weather claim',
      headers: ['Date', 'Conditions', 'Temperature', 'Recorded by', 'On the day'],
      rows: stopped.map((entry) => {
        const weather = (entry.weather as Row | undefined) ?? {};
        return [
          shown(entry.diaryDate),
          shown(weather.conditions),
          weather.temperatureC === undefined ? 'Not recorded' : `${shown(weather.temperatureC)} °C`,
          who(entry.recordedBy),
          entry.contemporaneous === true ? 'Yes' : 'No',
        ];
      }),
    });
  }

  blocks.push({ kind: 'HEADING', level: 2, text: 'Each day' });
  for (const entry of entries) {
    blocks.push({ kind: 'HEADING', level: 3, text: shown(entry.diaryDate) });

    const weather = (entry.weather as Row | undefined) ?? {};
    blocks.push({
      kind: 'KEY_VALUES',
      rows: [
        { label: 'Weather', value: shown(weather.conditions) },
        { label: 'Temperature', value: weather.temperatureC === undefined ? 'Not recorded' : `${shown(weather.temperatureC)} °C` },
        { label: 'Working stopped by weather', value: weather.workingStopped === true ? 'Yes' : 'No' },
        { label: 'Recorded by', value: who(entry.recordedBy) },
        { label: 'Recorded at', value: shownTime(entry.recordedAt) },
        {
          label: 'Recorded on the day',
          value:
            entry.contemporaneous === true
              ? 'Yes'
              : `No — ${shown(entry.daysLate, 'an unrecorded number of')} day(s) after the fact`,
        },
      ],
    });

    blocks.push({ kind: 'PARAGRAPH', text: shown(entry.progressNarrative, 'No narrative was recorded for this day.') });

    const labour = (entry.labour as Row[]) ?? [];
    if (labour.length > 0) {
      blocks.push({
        kind: 'TABLE',
        caption: 'Labour on site',
        headers: ['Trade', 'Headcount', 'Hours each', 'Trade hours'],
        rows: labour.map((line) => [
          shown(line.trade),
          shown(line.headcount),
          shown(line.hours),
          String(Number(line.headcount ?? 0) * Number(line.hours ?? 0)),
        ]),
      });
    }

    const plant = (entry.plant as Row[]) ?? [];
    if (plant.length > 0) {
      blocks.push({
        kind: 'TABLE',
        caption: 'Plant on site — idle hours are recorded because standing plant is a cost somebody carries',
        headers: ['Plant', 'Hours worked', 'Hours idle'],
        rows: plant.map((line) => [shown(line.description), shown(line.hoursWorked), shown(line.hoursIdle, '0')]),
      });
    }

    for (const [heading, list] of [
      ['Deliveries', (entry.deliveries as string[]) ?? []],
      ['Visitors', (entry.visitors as string[]) ?? []],
      ['Blockers', (entry.blockers as string[]) ?? []],
      ['Safety events', (entry.safetyEvents as string[]) ?? []],
    ] as const) {
      if (list.length > 0) {
        blocks.push({ kind: 'PARAGRAPH', text: `${heading}:` });
        blocks.push({ kind: 'LIST', ordered: false, items: list.map((line) => String(line)) });
      }
    }
  }

  return blocks;
}

const SITE_DIARY = {
  code: 'SITE_DIARY',
  title: 'Site Diary',
  category: 'PROJECT_MANAGEMENT' as const,
  purpose:
    'The contemporaneous record of what happened on site: labour, plant, weather, deliveries, visitors, blockers and ' +
    'safety events, day by day. It names every day in the period that carries no entry, and states for every entry whether ' +
    'it was written on the day or afterwards — both of which determine what this record is worth as evidence.',
  scope: 'PROJECT' as const,
  audience: 'INTERNAL' as const,
  sources: [
    {
      refType: 'SiteDiary',
      contributes: 'every day of the record — labour, plant, weather, deliveries and blockers',
      recordedBy: 'the Field Execution screen',
      mandatory: true,
    },
  ],
  narrative: [
    {
      heading: 'What the pattern across these entries says',
      brief:
        'Reason about the pattern across the whole period rather than about any one day: idle plant against labour hours, ' +
        'weather stoppages against the days recorded, blockers that recur, and the gaps in the record. Say what the pattern ' +
        'would support and what it would not. Do not state any date, figure or event that is not already on the document.',
    },
  ],
  compose: (input: ComposeInput) => [
    ...diaryBlocks(input),
    ...narrativeBlocks(
      'What the pattern across these entries says',
      input.narrative.get('What the pattern across these entries says'),
    ),
  ],
} satisfies DocumentDefinition;

// --- Meeting Minutes --------------------------------------------------------

function minutesBlocks(input: ComposeInput): DocumentBlock[] {
  const meeting = input.subject!;
  const blocks: DocumentBlock[] = [];
  const who = people(input.ctx);

  blocks.push({ kind: 'HEADING', level: 2, text: 'The meeting' });
  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Reference', value: shown(meeting.reference) },
      { label: 'Type', value: humanValue(meeting.type) },
      { label: 'Subject', value: shown(meeting.title) },
      { label: 'Held', value: shownTime(meeting.heldAt) },
      { label: 'Location', value: shown(meeting.location) },
      { label: 'Chaired by', value: shown(meeting.chair) },
      { label: 'Minutes status', value: humanValue(meeting.status) },
      { label: 'Issued', value: meeting.issuedAt ? shownTime(meeting.issuedAt) : 'Not yet issued' },
      { label: 'Issued by', value: meeting.issuedBy ? who(meeting.issuedBy) : 'Not yet issued' },
    ],
  });

  if (meeting.status !== 'ISSUED') {
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        'These minutes have not been issued. They are still editable, so this document is a draft of a record rather than ' +
        'the record itself, and it should not be circulated as what was agreed.',
    });
  }

  // Attendance with apologies shown, not filtered out. A decision taken in the
  // absence of the person it binds is a different decision from one taken in
  // front of them, and this table is the only place that distinction survives.
  const attendees = (meeting.attendees as Row[]) ?? [];
  blocks.push({ kind: 'HEADING', level: 2, text: 'Who was there, and who was not' });
  blocks.push({
    kind: 'TABLE',
    headers: ['Name', 'Organisation', 'Role', 'Present'],
    rows: attendees.map((attendee) => [
      shown(attendee.name),
      shown(attendee.organisation),
      shown(attendee.role),
      attendee.attended === true ? 'Present' : 'Apologies',
    ]),
  });

  const apologies = attendees.filter((attendee) => attendee.attended !== true);
  if (apologies.length > 0) {
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        `${apologies.map((attendee) => `${shown(attendee.name)} (${shown(attendee.organisation)})`).join(', ')} ` +
        `${apologies.length === 1 ? 'was' : 'were'} not present. Anything below that binds ` +
        `${apologies.length === 1 ? 'that party' : 'those parties'} was agreed in their absence.`,
    });
  }

  blocks.push({ kind: 'HEADING', level: 2, text: 'What was discussed' });
  const agenda = (meeting.agenda as Row[]) ?? [];
  for (const item of agenda) {
    blocks.push({ kind: 'HEADING', level: 3, text: `${shown(item.reference)} — ${shown(item.subject)}` });
    blocks.push({ kind: 'PARAGRAPH', text: shown(item.discussion) });
  }

  // The actions. This is what minutes are for; everything above is context.
  const actions = (meeting.actions as Row[]) ?? [];
  blocks.push({ kind: 'HEADING', level: 2, text: 'Actions' });
  if (actions.length === 0) {
    blocks.push(
      gapBlock(
        'the actions out of this meeting',
        'Nothing was recorded as agreed to be done by anybody. A meeting that produced no action is a meeting that produced ' +
          'a discussion, and the minutes say so rather than implying otherwise.',
      ),
    );
  } else {
    blocks.push({
      kind: 'TABLE',
      caption:
        'An action carried from an earlier meeting keeps the date it was originally given. The overdue column is measured ' +
        'against that date, not against the date it was last restated',
      headers: ['Ref', 'Action', 'Owner', 'Organisation', 'By', 'Originally due', 'Status', 'Overdue at this meeting'],
      rows: actions.map((action) => {
        const due = shown(action.originallyDue, '') || shown(action.by, '');
        const heldAt = shown(meeting.heldAt, '');
        const overdue =
          due && heldAt ? Math.max(0, Math.floor((Date.parse(heldAt) - Date.parse(due)) / 86_400_000)) : 0;
        return [
          shown(action.reference),
          shown(action.what),
          shown(action.owner),
          shown(action.ownerOrganisation),
          shownDate(action.by),
          action.originallyDue ? `${shownDate(action.originallyDue)} (${shown(action.raisedAtMeeting, 'earlier meeting')})` : 'Raised here',
          humanValue(action.status),
          // The number, whether or not the action has since been closed. An
          // action that was eighty-two days overdue on the day of the meeting
          // was eighty-two days overdue on the day of the meeting, and
          // replacing that with "Closed" hides the delay behind its remedy.
          overdue > 0 ? `${overdue} days` : 'Not yet due',
        ];
      }),
    });

    const closed = actions.filter((action) => action.status === 'CLOSED');
    if (closed.length > 0) {
      blocks.push({ kind: 'HEADING', level: 3, text: 'Actions closed, and what closed them' });
      blocks.push({
        kind: 'TABLE',
        headers: ['Ref', 'Action', 'Closed', 'What was done'],
        rows: closed.map((action) => [
          shown(action.reference),
          shown(action.what),
          shownDate(action.closedAt),
          shown(action.closureNote),
        ]),
      });
    }
  }

  // Corrections beside the text, never applied to it.
  const corrections = (meeting.corrections as Row[]) ?? [];
  if (corrections.length > 0) {
    blocks.push({ kind: 'HEADING', level: 2, text: 'Corrections raised against these minutes' });
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        'The following corrections were raised after these minutes were issued. They are recorded beside the minutes and ' +
        'have not been applied to the text above: somebody disagreeing with what the minutes say is itself a fact about the ' +
        'meeting, and rewriting the record would destroy the only thing minutes are for.',
    });
    blocks.push({
      kind: 'TABLE',
      headers: ['Raised by', 'Raised', 'What is said to be wrong'],
      rows: corrections.map((correction) => [
        shown(correction.raisedBy),
        shownTime(correction.at),
        shown(correction.what),
      ]),
    });
  }

  return blocks;
}

const MEETING_MINUTES: DocumentDefinition = {
  code: 'MEETING_MINUTES',
  title: 'Meeting Minutes',
  category: 'PROJECT_MANAGEMENT',
  purpose:
    'The record of one meeting: who was there, who sent apologies, what was discussed, and — the part that matters — who ' +
    'agreed to do what by when. Actions carried from earlier meetings keep the date they were originally given, so an ' +
    'action raised months ago reads as months overdue rather than as due next week.',
  scope: 'RECORD',
  subject: 'SiteMeeting',
  subjectRecordedBy: 'the Project Control screen',
  audience: 'CLIENT',
  sources: [],
  narrative: [
    {
      heading: 'What is actually outstanding out of this meeting',
      brief:
        'Reason about the actions: which are genuinely blocking, which have been carried and how long for, and what the ' +
        'pattern of ownership across the organisations present suggests. Do not state any action, name, date or figure that ' +
        'is not already on the document.',
    },
  ],
  reference: (input) => shown(input.subject?.reference, ''),
  compose: (input) => [
    ...minutesBlocks(input),
    ...narrativeBlocks(
      'What is actually outstanding out of this meeting',
      input.narrative.get('What is actually outstanding out of this meeting'),
    ),
  ],
};

// --- Request for Information ------------------------------------------------

function rfiBlocks(input: ComposeInput): DocumentBlock[] {
  const rfi = input.subject!;
  const blocks: DocumentBlock[] = [];

  blocks.push({ kind: 'HEADING', level: 2, text: 'The request' });
  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Reference', value: shown(rfi.reference) },
      { label: 'Discipline', value: humanValue(rfi.discipline) },
      { label: 'Raised by', value: shown(rfi.raisedBy) },
      { label: 'Raised', value: shownTime(rfi.raisedAt) },
      { label: 'Answer required by', value: shownDate(rfi.dueDate) },
      { label: 'Status', value: humanValue(rfi.status) },
    ],
  });

  blocks.push({ kind: 'HEADING', level: 3, text: 'The question' });
  blocks.push({ kind: 'PARAGRAPH', text: shown(rfi.question) });

  // The drawing and revision the question was asked against. Without the
  // revision the answer is unmoored: an answer given against P03 does not
  // necessarily hold against P05, and this is where that is visible.
  blocks.push({ kind: 'HEADING', level: 2, text: 'What this question was asked against' });
  const drawings = input.sources.get('Drawing') ?? [];
  const drawing = drawings.find((row) => row.id === rfi.linkedDrawingId);

  if (!drawing) {
    blocks.push(
      gapBlock(
        'the drawing this question was raised against',
        rfi.linkedDrawingId
          ? `The request cites drawing ${shown(rfi.linkedDrawingId)}, which is not on this project's register. An answer ` +
              'given against a drawing nobody can produce is an answer nobody can rely on.'
          : 'No drawing is cited. The answer below cannot be tied to a revision, so it cannot be shown to hold against the ' +
              'drawing currently issued for construction.',
      ),
    );
  } else {
    const askedAgainst = shown(rfi.linkedDrawingRevision, '');
    const nowAt = shown(drawing.revision, '');
    blocks.push({
      kind: 'KEY_VALUES',
      rows: [
        { label: 'Drawing', value: `${shown(drawing.drawingNumber)} — ${shown(drawing.title)}` },
        { label: 'Discipline', value: humanValue(drawing.discipline) },
        { label: 'Revision the question was asked against', value: askedAgainst || 'Not recorded' },
        { label: 'Revision currently on the register', value: nowAt || 'Not recorded' },
        { label: 'Drawing status', value: humanValue(drawing.status) },
        { label: 'Drawing file hash', value: shown(drawing.fileHash) },
      ],
    });

    // The check that makes this document worth generating rather than
    // photocopying. Two fields on two records, never compared on paper.
    if (askedAgainst && nowAt && askedAgainst !== nowAt) {
      blocks.push({
        kind: 'PARAGRAPH',
        text:
          `This request was raised against revision ${askedAgainst}. The register now holds revision ${nowAt}. Any answer ` +
          'below was given against the earlier revision and does not automatically carry forward — confirm it still holds ' +
          'before building to it.',
      });
    }
  }

  blocks.push({ kind: 'HEADING', level: 2, text: 'The answer' });
  if (!rfi.answer) {
    const due = shown(rfi.dueDate, '');
    const overdue = due && due < input.today;
    blocks.push(
      gapBlock(
        'the answer',
        overdue
          ? `This request is unanswered and the date it was required by — ${due} — has passed. An unanswered request for ` +
              'information is a programme risk with a name and a date on it.'
          : 'This request has not yet been answered.',
      ),
    );
  } else {
    blocks.push({ kind: 'PARAGRAPH', text: shown(rfi.answer) });
    blocks.push({
      kind: 'KEY_VALUES',
      rows: [
        { label: 'Answered by', value: shown(rfi.answeredBy) },
        { label: 'Answered', value: shownTime(rfi.answeredAt) },
        { label: 'Answered against revision', value: shown(rfi.answeredAgainstRevision) },
        { label: 'Days the request was open', value: shown(rfi.daysOpen) },
        { label: 'Answered after the date required', value: rfi.answeredLate === true ? 'Yes' : 'No' },
        {
          // A design change arriving as an RFI answer is the commonest way a
          // variation enters a project without anybody pricing it.
          label: 'The answer changes the design',
          value:
            rfi.changesDesign === true
              ? 'Yes — this answer is a design change and should be assessed as one before it is built to'
              : 'No',
        },
      ],
    });
  }

  return blocks;
}

const RFI_DOCUMENT: DocumentDefinition = {
  code: 'RFI',
  title: 'Request for Information',
  category: 'PROJECT_MANAGEMENT',
  purpose:
    'One question, the drawing and revision it was asked against, and the answer given. It states whether the revision the ' +
    'question was asked against is still the one on the register, because an answer given against a superseded drawing does ' +
    'not carry forward on its own.',
  scope: 'RECORD',
  subject: 'RFI',
  subjectRecordedBy: 'the Design & BIM screen, by converting a drawing markup',
  audience: 'CLIENT',
  sources: [
    {
      refType: 'Drawing',
      contributes: 'the drawing and revision the question was asked against',
      recordedBy: 'the Design & BIM screen',
      mandatory: false,
    },
  ],
  narrative: [
    {
      heading: 'What this answer commits the project to',
      brief:
        'Reason about the consequence of the answer given: what it obliges, whether it constitutes a change, and what would ' +
        'have to be checked before work proceeds on it. Do not state any drawing, revision, date, name or figure that is not ' +
        'already on the document.',
    },
  ],
  reference: (input) => shown(input.subject?.reference, ''),
  compose: (input) => [
    ...rfiBlocks(input),
    ...narrativeBlocks(
      'What this answer commits the project to',
      input.narrative.get('What this answer commits the project to'),
    ),
  ],
};

export const PLANNING_DOCUMENTS: DocumentDefinition[] = [
  MASTER_PROGRAMME,
  BILL_OF_QUANTITIES,
  SITE_DIARY,
  MEETING_MINUTES,
  RFI_DOCUMENT,
];
