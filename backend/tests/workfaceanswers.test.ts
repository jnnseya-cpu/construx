import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { ask, classifyIntent } from '../src/ai/conversation.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import * as cdm from '../src/domain/cdm.ts';
import type { EngineContext } from '../src/engines/context.ts';
import * as planning from '../src/engines/planning.ts';
import * as safety from '../src/engines/safety.ts';
import { hashBytes } from '../src/evidence/store.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { bareConstructionProject } from './helpers.ts';

/**
 * The copilot at the workface.
 *
 * `AGT-FIELD-ANSWERS` is the specification's "grounded answers from drawings,
 * specs, RAMS, records — with citations and confidence, answered at the
 * workface". It is not a second answerer: `ai/conversation.ts` already answers
 * from materialised state and never from a model's memory of construction
 * generally, and building a parallel one would have been two engines to keep
 * telling the same story.
 *
 * What it was missing was the workface itself. Every intent rule was a question
 * somebody asks sitting down — the estimate, the cash position, the clash list.
 * "Is there a permit open on the chamber" matched nothing at all and came back
 * "try naming what you need", which is the platform telling a site manager to
 * rephrase.
 *
 * Two things are tested here, and the second matters more than the first.
 * The copilot now routes and grounds a workface question. And it withholds what
 * the asker is not allowed to read — which it never did, for any question, and
 * which the field registers made urgent rather than created.
 */

let platform: Platform;
let seed: SeedResult;
let ctx: EngineContext;
let safetyCtx: EngineContext;
let projectId: string;

const isoDaysFromNow = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** The two sources that are the project envelope rather than a register in it. */
const ENVELOPE_SOURCES = ['Project', 'Ledger'];

const fact = (answer: { grounding: Array<{ label: string; source: string; refId?: string; value: string }> }, label: string) =>
  answer.grounding.find((entry) => entry.label === label);

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  const built = await bareConstructionProject(platform, seed, 'Workface Answers Fixture');
  projectId = built.projectId;
  ctx = platform.context(seed.users.pm!.auth, projectId, { correlationId: 'workface-test' });
  safetyCtx = platform.context(seed.users.safety!.auth, projectId, { correlationId: 'workface-test' });

  const { workPackageId } = planning.createWorkPackage(ctx, {
    wbsCode: 'EXC-01',
    title: 'Deep excavation, zone 2',
    indicativeDurationDays: 15,
    scopeNarrative: 'Excavate and support the zone 2 chamber, dispose off site, backfill on completion.',
    responsibleParty: 'SELF',
  });

  const rams = await safety.draftRAMS(safetyCtx, {
    workPackageId,
    activityDescription: 'Excavate and support the zone 2 chamber',
    location: 'Zone 2',
    steps: [{ description: 'Set out and scan for services before breaking ground', activityType: 'EXCAVATION' }],
  });
  safety.approveRAMS(safetyCtx, rams.ramsId, 'Controls are proportionate to the ground conditions.');

  safety.recordCompetency(safetyCtx, {
    operativeId: 'op-1',
    qualification: 'Excavation supervisor',
    issuedAt: isoDaysFromNow(-400),
    expiresAt: isoDaysFromNow(400),
    certificateHash: hashBytes(Buffer.from('ticket-op-1')),
  });
  safety.issuePermit(safetyCtx, {
    activity: 'EXCAVATION',
    location: 'Zone 2 chamber',
    operativeIds: ['op-1'],
    validFrom: isoDaysFromNow(0),
    validTo: isoDaysFromNow(3),
    ramsId: rams.ramsId,
    precautions: 'Support system installed before entry; atmosphere tested before each entry.',
    evidenceHash: hashBytes(Buffer.from('permit-authority')),
  });
  // A permit that ran out last week and was never handed back. It is still
  // ISSUED — which is exactly what `AGT-HSE-FIELD` flags — and it must not be
  // the answer to "is there a permit open", because it authorises nothing
  // today while looking like an answer.
  safety.issuePermit(safetyCtx, {
    activity: 'EXCAVATION',
    location: 'Zone 1 headwall',
    operativeIds: ['op-1'],
    validFrom: isoDaysFromNow(-12),
    validTo: isoDaysFromNow(-5),
    ramsId: rams.ramsId,
    precautions: 'Support system installed before entry; atmosphere tested before each entry.',
    evidenceHash: hashBytes(Buffer.from('permit-authority-expired')),
  });

  cdm.draftToolboxTalk(safetyCtx, { ramsId: rams.ramsId });

  planning.recordSiteDiary(ctx, {
    diaryDate: isoDaysFromNow(-1),
    weather: { conditions: 'Dry, cold', temperatureC: 4, workingStopped: false },
    labour: [{ trade: 'Groundworks', headcount: 6, hours: 9 }],
    plant: [{ description: '13t excavator', hoursWorked: 8, hoursIdle: 0 }],
    progressNarrative: 'Trench excavation continued along the Bacup Road verge to chainage 240.',
    evidenceHash: hashBytes(Buffer.from('diary-yesterday')),
  });
});

describe('a question asked at the workface is routed at all', () => {
  it('matches the three registers a site question lands on', () => {
    // Asserted on the capability area rather than the task type, because the
    // area is what decides the grounding. "Method statement" scores under the
    // older safety rule and "briefed" under the new one; both are SAFETY_RAMS,
    // both read the permit and briefing registers, and pinning the task type
    // would have been pinning which of two correct routes won a tiebreak.
    const cases: Array<[string, string]> = [
      ['Is there a permit open on the chamber?', 'SAFETY_RAMS'],
      // Plural, and the only word in the question that matches anything. Every
      // term in the rules is written singular and the match was exact, so this
      // — which is how most people ask it — scored nothing at all.
      ['Are there any permits open on site?', 'SAFETY_RAMS'],
      ['Has anybody been briefed on the method statement?', 'SAFETY_RAMS'],
      ['Who is inducted on this site?', 'SAFETY_RAMS'],
      ['What did the diary record yesterday?', 'FIELD_EXECUTION'],
      ['How many days of labour and plant have we logged?', 'FIELD_EXECUTION'],
      ['What does the ITP say about this pour?', 'QUALITY_COMMISSIONING'],
      ['Are there any hold points not released?', 'QUALITY_COMMISSIONING'],
    ];
    for (const [question, area] of cases) {
      const [top] = classifyIntent(question, 'CONSTRUCTION');
      assert.ok(top, `"${question}" matched no intent at all`);
      assert.equal(top.capabilityArea, area, `"${question}" routed to ${top.capabilityArea}`);
    }
  });

  /**
   * The state before this existed, kept as the thing being fixed. Without the
   * workface rules these questions scored nothing, and the copilot's own
   * fallback told the asker to name programme, cost, risk, safety, bid, model or
   * handover — none of which is what they asked.
   */
  it('no longer answers a site question by asking it to be rephrased', () => {
    const answer = ask(ctx, 'Is there a permit open on the chamber?');
    assert.ok(answer.intent, 'the question matched nothing');
    assert.doesNotMatch(answer.answer, /could not match/);
    assert.equal(answer.intent.capabilityArea, 'SAFETY_RAMS');
  });
});

describe('the answer is grounded in the register, and citable', () => {
  /**
   * Today, not ever.
   *
   * The project holds two open permits and one of them ran out last week
   * without being handed back. Asked at eight in the morning whether there is a
   * permit on the chamber, an answer that counted both is wrong in the way that
   * gets somebody into a hole they are not authorised to be in.
   */
  it('answers a permit question out of the permits valid today, not every open one', () => {
    assert.equal(
      platform.ledger.list(projectId, 'Permit').filter((record) => record.state.status === 'ISSUED').length,
      2,
      'the fixture no longer holds an expired permit, so this proves nothing',
    );

    const answer = ask(safetyCtx, 'Is there a permit open on the chamber, and who is it for?');
    assert.equal(fact(answer, 'Permits valid today')?.value, '1');
    assert.equal(
      answer.grounding.some((entry) => entry.value.includes('Zone 1 headwall')),
      false,
      'a permit that expired last week was read out as authorising work today',
    );

    // The permit itself, cited by its own record, so the answer opens rather
    // than being believed.
    const cited = answer.grounding.find((entry) => entry.source === 'Permit' && entry.refId);
    assert.ok(cited, 'the permit was counted and not cited');
    assert.match(cited.value, /EXCAVATION at Zone 2 chamber/);
    assert.ok(platform.ledger.get({ refType: 'Permit', refId: cited.refId! }), 'the citation points at no record');
  });

  it('separates a briefing that was given from one that is only drafted', () => {
    const answer = ask(safetyCtx, 'Has anybody been briefed on the method statement?');
    assert.equal(fact(answer, 'Toolbox talks given')?.value, '0');
    const waiting = fact(answer, 'Drafted, not yet given');
    assert.ok(waiting, 'a talk drafted and waiting was not mentioned at all');
    assert.match(waiting.value, /zone 2 chamber/i);
  });

  it('answers a diary question with the day itself, cited', () => {
    const answer = ask(ctx, 'What did the diary record yesterday?');
    const last = fact(answer, 'Last day recorded');
    assert.ok(last, 'the copilot was asked about the diary and did not read one');
    assert.match(last.value, /chainage 240/);
    assert.equal(last.source, 'SiteDiary');
    assert.ok(last.refId, 'the day was quoted and not cited');
  });

  /**
   * A count has no citation, and that is the rule rather than an omission.
   *
   * "Six permits" is read from six records; pointing it at one of them would be
   * a citation that does not support the claim it is attached to. Only a fact
   * that *is* one record carries an id.
   */
  it('cites a record and never cites a count', () => {
    const answer = ask(safetyCtx, 'Is there a permit open on the chamber?');
    for (const entry of answer.grounding) {
      if (!entry.refId) continue;
      assert.ok(
        !/^\d+$/.test(entry.value),
        `"${entry.label}" is a count and carries a citation to one record`,
      );
    }
  });

  /**
   * Every register the copilot cites must be one the classifier knows.
   *
   * This is the other half of withholding. An unclassified refType is denied —
   * the same fail-closed default the audit feed and the device sync use — so a
   * grounding block that cited a register nobody had classified would be
   * *silently* withheld from everybody, and the answer would be quietly thinner
   * with nothing saying why. Checked across every workface question rather than
   * asserted about one, so a new block cannot slip through.
   */
  it('cites only registers the classifier recognises', () => {
    const questions = [
      'Is there a permit open on the chamber?',
      'What did the diary record yesterday?',
      'Are there any hold points not released?',
      'Has anybody been briefed on the method statement?',
    ];
    for (const question of questions) {
      for (const entry of ask(safetyCtx, question).grounding) {
        if (ENVELOPE_SOURCES.includes(entry.source)) continue;
        assert.ok(
          classifyEntity(entry.source),
          `"${entry.label}" is grounded in ${entry.source}, which no classification covers — it would be withheld from everybody`,
        );
      }
    }
  });

  it('reports confidence in the reading of the question, not in the figures', () => {
    const answer = ask(ctx, 'What did the diary record yesterday?');
    assert.equal(typeof answer.confidence, 'number');
    assert.equal(answer.confidence, answer.intent?.match, 'confidence stopped being the intent match');

    const unmatched = ask(ctx, 'zzzz');
    assert.equal(unmatched.confidence, undefined, 'a question that matched nothing was given a confidence anyway');
  });
});

/**
 * The defect the workface registers made urgent.
 *
 * `ask` performs no authorisation, and neither does its route. That was
 * survivable while the grounding read estimates and clash counts; it stopped
 * being survivable the moment it read the SAFETY_L2 register and the quality
 * record, because those are the two the £25 subcontractor seat is scoped away
 * from. The classification applied here is the same one the entity read, the
 * audit feed and the device sync use.
 */
describe('the copilot does not answer out of a register the asker cannot open', () => {
  it('withholds the safety register from a role that holds no capability on it', () => {
    const held = ask(safetyCtx, 'Is there a permit open on the chamber?');
    assert.ok(fact(held, 'Permits valid today'), 'the safety lead cannot see permits, so this test proves nothing');

    // The QS holds no capability at all on safety, quality or field execution —
    // the whole workface is outside their remit by design, and the permission
    // matrix says so. Asked the same question, the copilot must not read the
    // permit out to them.
    const qs = platform.context(seed.users.qs!.auth, projectId, { correlationId: 'workface-test' });
    const answer = ask(qs, 'Is there a permit open on the chamber?');
    assert.equal(
      answer.grounding.some((entry) => entry.source === 'Permit'),
      false,
      'a permit was read out to a role with no safety capability',
    );
    assert.equal(
      answer.grounding.some((entry) => entry.refId !== undefined && entry.source === 'Permit'),
      false,
      'a permit was cited to a role that cannot open it',
    );
  });

  /**
   * Said, not silent.
   *
   * A shorter answer with no explanation reads as a thin project. A shorter
   * answer that names the registers withheld reads as the permission model
   * working — which is the same choice `frontend/lib/command.js` makes about a
   * denial never being shown as a zero.
   */
  it('says which registers it withheld rather than quietly answering less', () => {
    const qs = platform.context(seed.users.qs!.auth, projectId, { correlationId: 'workface-test' });
    const answer = ask(qs, 'Is there a permit open on the chamber?');
    const stated = fact(answer, 'Withheld from your role');
    assert.ok(stated, 'records were withheld and nothing said so');
    assert.match(stated.value, /Permit/);
  });

  it('still answers the same question fully for somebody who holds the capability', () => {
    const answer = ask(safetyCtx, 'Is there a permit open on the chamber?');
    assert.equal(fact(answer, 'Withheld from your role'), undefined, 'the safety lead was told something was withheld');
  });
});
