import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import { ROUTES } from '../src/api/routes.ts';
import * as tenderprogramme from '../src/domain/tenderprogramme.ts';
import { runTakeoff } from '../src/engines/tender.ts';
import { EVENT_TYPES } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The tender programme, drafted from the bill by the platform itself.
 *
 * A buyer's "Tenderers are to submit a programme with the tender return" used to
 * mean typing every activity onto the Programme screen by hand, or drawing a bar
 * chart in another tool. These pin the vertical: the draft is checked by the
 * platform's own critical-path engine and writes nothing; a person confirms it
 * into the project's one programme; and the export draws a Gantt chart from the
 * live programme.
 */

/** A soil-nailed retaining wall, as a model might return it — with one bad link. */
const PROGRAMME = {
  activities: [
    { ref: 'A00', name: 'Start on site — road closure in force', durationDays: 0, predecessors: [], boqRefs: [], resource: 'Justin Nseya MCIOB', milestone: true },
    { ref: 'A10', name: 'Traffic management and site set-up', durationDays: 3, predecessors: [{ ref: 'A00', type: 'FS' }], boqRefs: ['1.1'], resource: 'TM operative' },
    { ref: 'A20', name: 'Vegetation and site clearance', durationDays: 4, predecessors: [{ ref: 'A10', type: 'FS' }], boqRefs: ['201.1'], resource: 'Groundworks gang' },
    { ref: 'A30', name: 'Soil nail suitability tests', durationDays: 5, predecessors: [{ ref: 'A20', type: 'FS' }], boqRefs: ['601.9'], resource: 'Drilling rig', subcontract: 'Soil nailing' },
    { ref: 'A40', name: 'Production soil nails', durationDays: 15, predecessors: [{ ref: 'A30', type: 'FS' }], boqRefs: ['601.2', '601.3'], resource: 'Drilling rig', subcontract: 'Soil nailing' },
    { ref: 'A45', name: 'Acceptance tests', durationDays: 3, predecessors: [{ ref: 'A40', type: 'SS', lagDays: 5 }, { ref: 'A99', type: 'FS' }], boqRefs: ['601.10'], resource: 'Drilling rig', subcontract: 'Soil nailing' },
    { ref: 'A50', name: 'Reinforced concrete facing', durationDays: 10, predecessors: [{ ref: 'A40', type: 'FS' }], boqRefs: ['1700'], resource: 'Formwork gang' },
    { ref: 'A60', name: 'Stone cladding and parapet', durationDays: 12, predecessors: [{ ref: 'A50', type: 'FS' }], boqRefs: ['491.1', '491.2'], resource: 'Masons', subcontract: 'Stonemasonry' },
    { ref: 'A70', name: 'Risk allowance', durationDays: 5, predecessors: [{ ref: 'A60', type: 'FS' }], boqRefs: [], resource: '—', riskAllowance: true },
    { ref: 'A90', name: 'Completion', durationDays: 0, predecessors: [{ ref: 'A70', type: 'FS' }, { ref: 'A45', type: 'FS' }], boqRefs: [], resource: 'Justin Nseya MCIOB', milestone: true },
  ],
  assumptions: ['Soil nails at about 27 m per rig-day over 400 m.', 'Masonry at about 3 m³ per gang-day.'],
};

let platform: Platform;
let seed: SeedResult;
let tenderProject: string;
let liveProject: string;
let reply: Record<string, unknown> = PROGRAMME;
const asked: Array<Record<string, unknown>> = [];

/** The planner drafts and confirms; the QS measures. A sole owner holds both. */
const asPlanner = (projectId: string) => platform.context(seed.users.planner!.auth, projectId, { source: 'WEB' });
const asQS = (projectId: string) => platform.context(seed.users.qs!.auth, projectId, { source: 'WEB' });
const asPM = (projectId: string) => platform.context(seed.users.pm!.auth, projectId, { source: 'WEB' });

before(async () => {
  const adapter: AIProviderAdapter = {
    name: 'OPENAI',
    capability: 'REASONING',
    multimodal: false,
    transmits: false,
    estimateCostMinor: () => 40,
    healthy: () => true,
    async execute(request: ProviderRequest): Promise<ProviderResponse> {
      asked.push({ task: request.task, ...(request.payload as Record<string, unknown>) });
      return { provider: 'OPENAI', modelClass: 'test', output: reply, rawCostMinor: 40, latencyMs: 5 };
    },
  };
  platform = new Platform(new AIOrchestrator({ reasoning: adapter, perception: adapter }));
  seed = await seedDemoProject(platform);
  platform.wallet(seed.tenantId).topUp(1_000_000, 'Programme top-up');
  tenderProject = seed.workingProjects.find((p) => p.phase === 'TENDER')!.projectId;
  liveProject = seed.workingProjects.find((p) => p.phase === 'CONSTRUCTION')!.projectId;
});

describe('drafting the tender programme from the bill', () => {
  it('refuses with nothing measured, and says what to do first', async () => {
    await assert.rejects(
      () => tenderprogramme.draftTenderProgramme(asPlanner(tenderProject), { startDate: '2027-01-18', periodDays: 84 }),
      (error: Error & { code?: string }) => error.code === 'BILL_NOT_MEASURED',
    );
  });

  it('drafts from the bill, checks it with the engine, and writes nothing to the programme', async () => {
    const pkg = platform.ledger.list(tenderProject, 'ScopePackage')[0]!.refId;
    await runTakeoff(asQS(tenderProject), {
      packageId: pkg,
      sources: [{ discipline: 'BILL_OF_QUANTITIES', sheetId: 'Price List' }],
      items: [
        { description: '601.2 — Boring raking holes not exceeding 10 m', unit: 'm', quantity: 400 },
        { description: '491.1 — Random rubble stone cladding', unit: 'm3', quantity: 15 },
      ],
      costCodePrefix: 'WC',
      measuredBy: 'PERSON',
    });

    const { draft } = await tenderprogramme.draftTenderProgramme(asPlanner(tenderProject), {
      startDate: '2027-01-18',
      periodDays: 84,
      guidance: 'Road closure from 18/01/2027.',
    });

    const sent = asked.at(-1)!;
    assert.equal((sent.bill as unknown[]).length, 2, 'the drafter was not given the bill');
    assert.equal(sent.startDate, '2027-01-18');
    assert.equal(sent.periodCalendarDays, 84);
    assert.equal(sent.estimatorGuidance, 'Road closure from 18/01/2027.');
    assert.match(String(sent.constraint), /risk allowance/);
    assert.match(String(sent.constraint), /Invent no date/);

    assert.equal(draft.status, 'DRAFT');
    assert.equal(draft.activities.length, 10);
    assert.ok(draft.corrections.some((note) => note.includes('A99')), 'a link to nothing was kept or silently dropped');
    assert.ok(!draft.activities.find((a) => a.ref === 'A45')!.predecessors.some((link) => link.ref === 'A99'));
    // Computed by the engine: 3+4+5+15+10+12+5 = 54 working days from Mon 18 Jan 2027, on a five-day week
    // less England and Wales bank holidays — Good Friday 26 March and Easter Monday 29 March fall inside it.
    assert.equal(draft.forecast.finishDate, '2027-04-05');
    assert.equal(draft.forecast.completionBy, '2027-04-11');
    assert.equal(draft.forecast.fits, true);
    assert.ok(draft.forecast.criticalRefs.includes('A40'));
    assert.ok(!draft.forecast.criticalRefs.includes('A45'), 'the acceptance tests have float and are not critical');
    assert.equal(platform.ledger.list(tenderProject, 'Task').length, 0, 'a draft reached the programme');
  });

  it('refuses a draft whose logic loops, and keeps nothing from it', async () => {
    const before_ = tenderprogramme.tenderProgrammeDrafts(asPlanner(tenderProject)).length;
    reply = {
      activities: [
        { ref: 'X1', name: 'One', durationDays: 2, predecessors: [{ ref: 'X2', type: 'FS' }] },
        { ref: 'X2', name: 'Two', durationDays: 2, predecessors: [{ ref: 'X1', type: 'FS' }] },
      ],
    };
    await assert.rejects(
      () => tenderprogramme.draftTenderProgramme(asPlanner(tenderProject), { startDate: '2027-01-18', periodDays: 84 }),
      (error: Error & { code?: string }) => error.code === 'PROGRAMME_DRAFT_CYCLIC',
    );
    reply = PROGRAMME;
    assert.equal(tenderprogramme.tenderProgrammeDrafts(asPlanner(tenderProject)).length, before_);
  });

  it('says plainly when a programme overruns the period', () => {
    const tight = tenderprogramme.normaliseDraft(PROGRAMME, { startDate: '2027-01-18', periodDays: 56 });
    assert.equal(tight.forecast.fits, false);
    assert.equal(tight.forecast.completionBy, '2027-03-14');
  });

  it('refuses a start date or period it cannot read', async () => {
    await assert.rejects(
      () => tenderprogramme.draftTenderProgramme(asPlanner(tenderProject), { startDate: 'next week', periodDays: 84 }),
      (error: Error & { code?: string }) => error.code === 'START_DATE_INVALID',
    );
    await assert.rejects(
      () => tenderprogramme.draftTenderProgramme(asPlanner(tenderProject), { startDate: '2027-01-18', periodDays: 0 }),
      (error: Error & { code?: string }) => error.code === 'PERIOD_INVALID',
    );
  });
});

describe('confirming it into the project programme', () => {
  it('a newer draft replaces a waiting one, which can then no longer be confirmed', async () => {
    const first = tenderprogramme.tenderProgrammeDrafts(asPlanner(tenderProject)).find((d) => d.status === 'DRAFT')!;
    await tenderprogramme.draftTenderProgramme(asPlanner(tenderProject), { startDate: '2027-01-18', periodDays: 84 });
    const drafts = tenderprogramme.tenderProgrammeDrafts(asPlanner(tenderProject));
    assert.equal(drafts.find((d) => d.id === first.id)!.status, 'SUPERSEDED');
    assert.equal(drafts.filter((d) => d.status === 'DRAFT').length, 1);
    throwsCode(() => tenderprogramme.confirmTenderProgramme(asPlanner(tenderProject), { draftId: first.id }), 'PROGRAMME_DRAFT_NOT_OPEN');
  });

  it('writes the activities and logic, and schedules them from the start date', () => {
    const waiting = tenderprogramme.tenderProgrammeDrafts(asPlanner(tenderProject)).find((d) => d.status === 'DRAFT')!;
    const { draft, finishDate } = tenderprogramme.confirmTenderProgramme(asPlanner(tenderProject), { draftId: waiting.id });
    assert.equal(draft.status, 'CONFIRMED');
    assert.equal(finishDate, '2027-04-05', 'the confirmed programme does not finish when the draft said it would');
    assert.equal(platform.ledger.list(tenderProject, 'Task').length, 10);
    // Nine links in the draft, the dropped one gone.
    assert.equal(platform.ledger.list(tenderProject, 'Dependency').length, 10);
    assert.equal(platform.ledger.list(tenderProject, 'ScheduleRun').length, 1);
    throwsCode(() => tenderprogramme.confirmTenderProgramme(asPlanner(tenderProject), { draftId: waiting.id }), 'PROGRAMME_DRAFT_NOT_OPEN');
  });

  it('will not write a second programme beside one that exists', async () => {
    const { draft } = await tenderprogramme.draftTenderProgramme(asPlanner(tenderProject), {
      startDate: '2027-01-18',
      periodDays: 84,
    });
    throwsCode(() => tenderprogramme.confirmTenderProgramme(asPlanner(tenderProject), { draftId: draft.id }), 'PROGRAMME_NOT_EMPTY');
    assert.equal(platform.ledger.list(tenderProject, 'Task').length, 10, 'the refusal wrote something');
  });

  it('checks both permissions before writing, so a role that cannot schedule leaves nothing half written', async () => {
    // The PM may create activities but not run the schedule. Refused up front,
    // the programme is exactly as it was.
    const pkg = platform.ledger.list(tenderProject, 'ScopePackage')[0]!.refId;
    void pkg;
    const tasksBefore = platform.ledger.list(tenderProject, 'Task').length;
    const waiting = tenderprogramme.tenderProgrammeDrafts(asPlanner(tenderProject)).find((d) => d.status === 'DRAFT')!;
    throwsCode(() => tenderprogramme.confirmTenderProgramme(asPM(tenderProject), { draftId: waiting.id }), 'ACCESS_DENIED');
    assert.equal(platform.ledger.list(tenderProject, 'Task').length, tasksBefore);
  });
});

describe('the tender programme document', () => {
  it('draws the live programme as a Gantt chart with its critical path, logic and assumptions', () => {
    const { blocks, projectName } = tenderprogramme.tenderProgrammeBlocks(asPlanner(tenderProject));
    assert.equal(projectName, 'Calderdale Reservoir Renewal');
    const gantt = blocks.find((block) => block.kind === 'GANTT') as Extract<(typeof blocks)[number], { kind: 'GANTT' }>;
    assert.ok(gantt, 'no bar chart in the document');
    assert.equal(gantt.rows.length, 10);
    assert.equal(gantt.from, '2027-01-18');
    assert.ok(gantt.rows.find((row) => row.label.startsWith('A40'))!.critical);
    assert.ok(gantt.rows.find((row) => row.label.startsWith('A90'))!.milestone);
    assert.ok(gantt.rows.find((row) => row.label.startsWith('A70'))!.riskAllowance);
    const table = blocks.find((block) => block.kind === 'TABLE') as Extract<(typeof blocks)[number], { kind: 'TABLE' }>;
    assert.ok(table.rows.some((row) => row[6]!.includes('Specialist subcontractor: Soil nailing')));
    assert.ok(table.rows.find((row) => row[0] === 'A45')![5]!.includes('A40 SS +5d'));
    assert.ok(JSON.stringify(blocks).includes('27 m per rig-day'), 'the assumptions are not on the document');
    assert.ok(JSON.stringify(blocks).includes('for tender purposes'));
  });

  it('renders as a PDF and as a Word file', () => {
    const { blocks, projectName } = tenderprogramme.tenderProgrammeBlocks(asPlanner(tenderProject));
    const document = platform.exports.document(seed.users.planner!.auth, tenderProject, {
      title: 'Tender Programme',
      subtitle: projectName,
      blocks,
      audience: 'CLIENT',
      format: 'PDF',
      correlationId: 'tender-programme-test',
    });
    const pdf = Buffer.from(platform.exports.toPdf(document)).toString('latin1');
    assert.ok(pdf.includes('Production soil nails'), 'the activity is not on the PDF');
    assert.ok(pdf.includes('Critical path'), 'the chart has no key');
    const docx = platform.exports.toDocx({ ...document, format: 'DOCX' });
    assert.ok(docx.byteLength > 2000);
  });

  it('refuses a document when nothing is confirmed', () => {
    throwsCode(() => tenderprogramme.tenderProgrammeBlocks(asPlanner(liveProject)), 'TENDER_PROGRAMME_NOT_CONFIRMED');
  });

  it('is reachable, quotable, and its confirmation is a person’s', () => {
    for (const [method, pattern] of [
      ['GET', '/v1/projects/:projectId/programme/tender-drafts'],
      ['POST', '/v1/projects/:projectId/programme/tender-draft'],
      ['POST', '/v1/projects/:projectId/programme/tender-drafts/:draftId/confirm'],
      ['POST', '/v1/projects/:projectId/programme/tender.pdf'],
    ] as const) {
      assert.ok(ROUTES.some((route) => route.method === method && route.pattern === pattern), `${method} ${pattern}`);
    }
    const catalogue = new Map(EVENT_TYPES.map((entry) => [entry.code, entry]));
    assert.equal(catalogue.get('TENDER_PROGRAMME_DRAFTED')!.aiAllowed, true);
    assert.notEqual(catalogue.get('TENDER_PROGRAMME_CONFIRMED')!.aiAllowed, true);
  });
});

describe('the calendar and the period the programme is held to', () => {
  it('takes the buyer’s completion date as the period, and refuses when given neither', async () => {
    const tenderStart = '2027-01-18';
    const { draft } = await tenderprogramme.draftTenderProgramme(asPlanner(tenderProject), {
      startDate: tenderStart,
      completionDate: '2027-04-09',
    });
    assert.equal(draft.periodDays, 82, '18 Jan to 9 Apr inclusive is 82 days');
    assert.equal(draft.forecast.completionBy, '2027-04-09');
    await assert.rejects(
      () => tenderprogramme.draftTenderProgramme(asPlanner(tenderProject), { startDate: tenderStart }),
      (error: Error & { code?: string }) => error.code === 'PERIOD_REQUIRED',
    );
    await assert.rejects(
      () => tenderprogramme.draftTenderProgramme(asPlanner(tenderProject), { startDate: tenderStart, completionDate: '2027-01-01' }),
      (error: Error & { code?: string }) => error.code === 'COMPLETION_BEFORE_START',
    );
  });

  it('does not schedule work on a UK bank holiday', () => {
    const { calendar, holidays } = tenderprogramme.tenderCalendar({ countryCode: 'GB', city: 'Llangernyw' }, '2027-01-18');
    assert.ok(holidays.includes('2027-03-26'), 'Good Friday 2027 is 26 March');
    assert.ok(holidays.includes('2027-03-29'), 'Easter Monday 2027 is 29 March');
    assert.match(calendar.name, /England and Wales bank holidays/);

    // Ten working days from Mon 22 March 2027 run across Easter.
    const easter = {
      activities: [{ ref: 'B10', name: 'Masonry', durationDays: 10, predecessors: [], boqRefs: [], resource: 'Masons' }],
    };
    const plain = tenderprogramme.normaliseDraft(easter, { startDate: '2027-03-22', periodDays: 30 });
    const real = tenderprogramme.normaliseDraft(easter, { startDate: '2027-03-22', periodDays: 30, calendar });
    assert.equal(plain.forecast.finishDate, '2027-04-02');
    assert.equal(real.forecast.finishDate, '2027-04-06', 'Good Friday and Easter Monday were worked');

    const abroad = tenderprogramme.tenderCalendar({ countryCode: 'FR' }, '2027-01-18');
    assert.deepEqual(abroad.holidays, [], 'holidays were invented for a country the platform holds none for');
  });

  it('confirms onto the same calendar it was checked on', () => {
    const confirmed = tenderprogramme.tenderProgrammeDrafts(asPlanner(tenderProject)).find((d) => d.status === 'CONFIRMED')!;
    assert.equal(confirmed.calendar.id, 'TENDER_5_DAY');
    const task = platform.ledger.list(tenderProject, 'Task')[0]!;
    assert.equal(task.state.calendarId, 'TENDER_5_DAY');
  });
});
