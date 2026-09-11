import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as clauselibrary from '../src/domain/clauselibrary.ts';
import * as claims from '../src/engines/claims.ts';
import * as structure from '../src/domain/structure.ts';
import { ROUTES } from '../src/api/routes.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Contract-native reasoning — `L7.1`, §2.4, §4.5.
 *
 * The property the specification states as a test: *the same site event
 * produces different outputs under NEC4, JCT Design and Build and FIDIC
 * Yellow.* An engine reasoning from generic construction knowledge averages the
 * three and is wrong under all of them, in the direction that costs money.
 *
 * These tests are about four things.
 *
 * **The forms genuinely differ**, and differ where it matters: a hard time bar,
 * a soft notice, and a route that does not exist at all.
 *
 * **The amendment overlay shows its working.** §4.5.1 requires a diff against
 * the standard form for every modified clause, and an amended contract reported
 * as though it were the standard form is the most expensive thing this module
 * could do.
 *
 * **It refuses what it cannot place.** A schedule naming a clause the form does
 * not have means the schedule was written against another edition or the form
 * was identified wrongly, and applying it silently produces a position nobody
 * can defend.
 *
 * **It does not become a second source of truth.** The citation table already
 * maps obligation categories to clause numbers. Two tables describing the same
 * forms is how drift starts, so a test asserts they agree.
 */

let platform: Platform;
let seed: SeedResult;
let contractId: string;

/** Holds CONTRACTS_CLAIMS C/R — loads the form and reads the position. */
const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });

/** A schedule of amendments of the kind that actually arrives with a tender. */
const ONEROUS: clauselibrary.Amendment[] = [
  {
    ref: 'Schedule of Amendments item 14',
    kind: 'MODIFIES',
    clauseRef: '61.3',
    note: 'Employer requires earlier notification.',
    changes: {
      noticeDays: 14,
      timeBar: {
        days: 14,
        consequence: 'Entitlement lost. Fourteen days from awareness, against fifty-six in the standard form.',
      },
      riskWeight: 0.95,
    },
  },
  {
    ref: 'Schedule of Amendments item 22',
    kind: 'DELETES',
    clauseRef: 'X16.2',
    note: 'Retention deleted; a bond is required instead.',
  },
  {
    ref: 'Schedule of Amendments item 31',
    kind: 'INSERTS',
    clauseRef: 'Z3',
    note: 'Bespoke fitness-for-purpose warranty added by the employer.',
    inserted: {
      title: 'Fitness for purpose warranty',
      party: 'CONTRACTOR',
      category: 'DESIGN_RESPONSIBILITY',
      action: 'Warrant that the works will be fit for the purposes set out in the Scope.',
      method: 'CDE',
      approvalRequired: false,
      evidenceRequired: ['The Scope'],
      consequenceOfBreach: 'Strict liability, and normally outside professional indemnity cover.',
      riskWeight: 0.9,
      riskPattern: 'FITNESS_FOR_PURPOSE',
    },
  },
];

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  // Contracts are phase-gated and the seeded project has been delivered.
  structure.transitionPhase(platform.context(seed.users.admin!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'CONSTRUCTION',
    justification: 'Reopened to record the contract position for this test',
  });

  contractId = claims.createContract(asQS(), {
    suite: 'NEC4',
    form: 'NEC4 ECC Option A',
    parties: [{ role: 'EMPLOYER', partyId: 'p-emp', name: 'Calderdale Metropolitan Borough Council' }],
    contractSumMinor: 480_000_000,
    commencementDate: '2027-04-01',
    completionDate: '2029-03-30',
    liquidatedDamagesPerDayMinor: 250_00,
    ldCapPercent: 10,
    retentionPercent: 3,
    defectsLiabilityMonths: 12,
  }).contractId;
});

describe('the doors and the catalogue', () => {
  it('is reachable, and the three reads are declared read-only', () => {
    for (const [method, pattern] of [
      ['GET', '/v1/contract-forms'],
      ['GET', '/v1/contract-forms/:formId/response/:category'],
      ['POST', '/v1/projects/:projectId/contracts/:contractId/form'],
      ['GET', '/v1/projects/:projectId/contracts/:contractId/clauses'],
    ] as const) {
      const route = ROUTES.find((candidate) => candidate.method === method && candidate.pattern === pattern);
      assert.ok(route, `${method} ${pattern} has no route`);
      if (method === 'GET') assert.equal(route.readOnly, true, `${pattern} must be read-only`);
    }
  });

  it('keeps naming the form out of an agent’s reach', () => {
    // Naming the form and its amendments decides what every notice period and
    // time bar on the project is. A model reading a schedule wrongly moves a
    // time bar and nobody finds out until the notice is late.
    assert.notEqual(lookupEventType('CONTRACT_FORM_ADOPTED')?.aiAllowed, true);
    const classification = classifyEntity('ContractClausePosition');
    assert.ok(classification);
    assert.equal(classification.area, 'CONTRACTS_CLAIMS');
    assert.equal(classification.sensitivity, 'LEGAL_L4');
  });

  it('says on every package that the words are not in it', () => {
    const forms = clauselibrary.standardForms();
    assert.ok(forms.length >= 3, 'the library carries fewer than three forms');
    for (const form of forms) {
      // NEC, JCT and FIDIC own their text. What is here is the numbers and the
      // effects, which are facts about the form.
      assert.equal(form.textIncluded, false);
      assert.ok(form.publisher.length > 0, `${form.id} does not name its publisher`);
      assert.match(form.version, /^\d+\.\d+\.\d+$/, `${form.id} has no package version`);
      assert.ok(form.clauses > 0);
    }
  });
});

describe('the same event, three forms, three answers', () => {
  it('treats ground conditions as a compensation event under NEC4, with a hard bar', () => {
    const nec = clauselibrary.responseToEvent('nec4-ecc', 'GROUND_CONDITIONS');
    assert.equal(nec.clauseRef, '60.1(12)');
    // The event itself carries no period; 61.3 is what bites, and the reading
    // says so rather than implying the event is free of a deadline.
    assert.equal(nec.timeBarred, false);
    assert.match(nec.consequence, /61\.3/);

    const notice = clauselibrary.responseToEvent('nec4-ecc', 'EXTENSION_OF_TIME');
    assert.equal(notice.clauseRef, '61.3');
    assert.equal(notice.actWithinDays, 56);
    assert.equal(notice.timeBarred, true);
    assert.match(notice.consequence, /condition precedent/);
  });

  it('gives a different answer under JCT, where the notice is not a bar', () => {
    const jct = clauselibrary.responseToEvent('jct-db-2016', 'EXTENSION_OF_TIME');
    assert.equal(jct.clauseRef, '2.24');
    // The whole of L7.1 in one assertion: same event, different form, and the
    // difference is whether being late ends the entitlement.
    assert.equal(jct.timeBarred, false);
    // "Forthwith" is a period without a number, and the reading says it is not
    // a bar rather than leaving the reader to infer it from a missing figure.
    assert.equal(jct.actWithinDays, undefined);
    assert.match(jct.reading, /procedural rather than a bar/);

    // And ground conditions are not a Relevant Event as standard, so the risk
    // sits in a different place entirely.
    const ground = clauselibrary.responseToEvent('jct-db-2016', 'GROUND_CONDITIONS');
    assert.match(ground.consequence, /risk sits with the Contractor/);
  });

  it('gives a third answer under FIDIC, at twenty-eight days', () => {
    const fidic = clauselibrary.responseToEvent('fidic-yellow-2017', 'EXTENSION_OF_TIME');
    assert.equal(fidic.clauseRef, '20.2.1');
    assert.equal(fidic.actWithinDays, 28);
    assert.equal(fidic.timeBarred, true);

    // Fitness for purpose is the Yellow Book's standard position, not an
    // amendment — which is the fact a bid team most often gets wrong.
    const design = clauselibrary.responseToEvent('fidic-yellow-2017', 'DESIGN_RESPONSIBILITY');
    assert.equal(design.clauseRef, '4.1');
    assert.match(design.consequence, /outside professional indemnity cover/);
  });

  it('says a form has no route for something rather than offering the nearest one', () => {
    // NEC has no clause for termination for the employer's convenience in this
    // package. Returning FIDIC's 15.5 would be a citation of a clause that is
    // not in the contract the parties signed.
    const nec = clauselibrary.responseToEvent('nec4-ecc', 'TERMINATION');
    assert.equal(nec.clauseRef, undefined);
    assert.match(nec.reading, /not a contractual route under this contract/);
  });

  it('refuses a form the library does not carry', () => {
    throwsCode(() => clauselibrary.responseToEvent('bespoke', 'EXTENSION_OF_TIME'), 'STANDARD_FORM_UNKNOWN');
  });
});

describe('the amendment overlay shows its working', () => {
  it('diffs every modified clause against the standard form', () => {
    const form = clauselibrary.formPackage('nec4-ecc')!;
    const effective = clauselibrary.applyAmendments(form, ONEROUS);

    const notice = effective.find((clause) => clause.ref === '61.3')!;
    assert.deepEqual(notice.amendedBy, ['Schedule of Amendments item 14']);
    // §4.5.1's guardrail, field by field rather than as a summary of it.
    const days = notice.changes.find((change) => change.field === 'noticeDays')!;
    assert.equal(days.was, '56');
    assert.equal(days.now, '14');
    const bar = notice.changes.find((change) => change.field === 'timeBar')!;
    assert.match(bar.was, /^56 days/);
    assert.match(bar.now, /^14 days/);
    assert.equal(notice.standardFormRef, 'NEC4 Engineering and Construction Contract 61.3');
  });

  it('keeps a struck-out clause rather than dropping it', () => {
    const form = clauselibrary.formPackage('nec4-ecc')!;
    const effective = clauselibrary.applyAmendments(form, ONEROUS);

    const retention = effective.find((clause) => clause.ref === 'X16.2')!;
    assert.equal(retention.deleted, true);
    // Dropping it would make the position look like a form that never had it,
    // and what the parties rely on instead is the question somebody must ask.
    assert.deepEqual(retention.amendedBy, ['Schedule of Amendments item 22']);
    const response = clauselibrary.responseToEvent('nec4-ecc', 'RET-FIRST', ONEROUS);
    assert.match(response.reading, /Struck out by/);
  });

  it('carries an inserted clause with no standard to compare it against', () => {
    const form = clauselibrary.formPackage('nec4-ecc')!;
    const effective = clauselibrary.applyAmendments(form, ONEROUS);

    const inserted = effective.find((clause) => clause.ref === 'Z3')!;
    assert.equal(inserted.inserted, true);
    assert.equal(inserted.riskPattern, 'FITNESS_FOR_PURPOSE');
    assert.match(inserted.standardFormRef, /\(inserted\)/);
    assert.equal(inserted.changes[0]!.was, 'not in the standard form');
  });

  it('changes the answer the engine gives once the amendments are applied', () => {
    // The standard position and the agreed position are different answers, and
    // an engine reading the standard form would give the wrong one.
    const standard = clauselibrary.responseToEvent('nec4-ecc', 'EXTENSION_OF_TIME');
    const agreed = clauselibrary.responseToEvent('nec4-ecc', 'EXTENSION_OF_TIME', ONEROUS);
    assert.equal(standard.actWithinDays, 56);
    assert.equal(agreed.actWithinDays, 14);
    assert.match(agreed.reading, /Amended by Schedule of Amendments item 14/);
  });

  it('refuses a schedule naming a clause the form does not have', () => {
    const form = clauselibrary.formPackage('nec4-ecc')!;
    const error = throwsCode(
      () =>
        clauselibrary.applyAmendments(form, [
          { ref: 'Item 9', kind: 'MODIFIES', clauseRef: '2.24', note: 'Cut the notice period.' },
        ]),
      'AMENDMENT_CLAUSE_UNKNOWN',
    );
    // 2.24 is JCT's numbering. Either the schedule belongs to another contract
    // or the form was identified wrongly, and both matter.
    assert.match(String(error.message), /different edition or the form has been identified wrongly/);
  });

  it('refuses an insertion that collides, and one with nothing in it', () => {
    const form = clauselibrary.formPackage('nec4-ecc')!;
    throwsCode(
      () =>
        clauselibrary.applyAmendments(form, [
          { ref: 'Item 40', kind: 'INSERTS', clauseRef: '61.3', note: 'Adds a second 61.3.', inserted: ONEROUS[2]!.inserted! },
        ]),
      'AMENDMENT_CLAUSE_EXISTS',
    );
    throwsCode(
      () => clauselibrary.applyAmendments(form, [{ ref: 'Item 41', kind: 'INSERTS', clauseRef: 'Z9', note: 'Adds something.' }]),
      'AMENDMENT_INSERT_EMPTY',
    );
  });
});

describe('the position on a contract', () => {
  it('reads an absent position as an answer rather than a 404', () => {
    // Every contract starts with no form loaded, and a screen reading this on
    // every visit would log a 404 each time — which is how a deployment teaches
    // everybody to scroll past 404s and miss the one that matters. Caught by
    // the live console sweep on launch day, against this very code.
    const read = clauselibrary.contractClausePosition(asQS(), contractId);
    assert.equal(read.position, null);
    assert.equal(read.risk, null);
    assert.deepEqual(read.effective, []);
    assert.match(read.summary, /bespoke contract has none by design/);
  });

  it('refuses a form the library does not carry, and names what it has', () => {
    const error = throwsCode(
      () => clauselibrary.adoptStandardForm(asQS(), { contractId, formId: 'jct-mw-2016' }),
      'STANDARD_FORM_UNKNOWN',
    );
    assert.match(String(error.message), /nec4-ecc/);
    assert.match(String(error.message), /cite clauses that may not exist/);
  });

  it('refuses the schedule before it records anything', () => {
    throwsCode(
      () =>
        clauselibrary.adoptStandardForm(asQS(), {
          contractId,
          formId: 'nec4-ecc',
          amendments: [{ ref: 'Item 9', kind: 'MODIFIES', clauseRef: '2.24', note: 'Not an NEC clause.' }],
        }),
      'AMENDMENT_CLAUSE_UNKNOWN',
    );
    // Nothing was written, so the position is still absent.
    assert.equal(clauselibrary.contractClausePosition(asQS(), contractId).position, null);
  });

  it('loads the form and its schedule, and will not load a second', () => {
    const { position, effective } = clauselibrary.adoptStandardForm(asQS(), {
      contractId,
      formId: 'nec4-ecc',
      amendments: ONEROUS,
    });

    assert.equal(position.formId, 'nec4-ecc');
    assert.equal(position.textIncluded, false);
    assert.equal(position.adoptedBy, seed.users.qs!.auth.actorId);
    assert.ok(effective.some((clause) => clause.ref === 'Z3'));

    throwsCode(
      () => clauselibrary.adoptStandardForm(asQS(), { contractId, formId: 'jct-db-2016' }),
      'FORM_ALREADY_ADOPTED',
    );
  });

  it('flags what sits above the appetite, and attaches the disclaimer', () => {
    const risk = clauselibrary.contractClausePosition(asQS(), contractId).risk!;

    assert.equal(risk.deleted, 1);
    assert.equal(risk.inserted, 1);
    assert.ok(risk.amended >= 1);
    assert.ok(risk.walkAways >= 2, `only ${risk.walkAways} term(s) flagged`);

    const notice = risk.findings.find((finding) => finding.clauseRef === '61.3')!;
    assert.equal(notice.standardWeight, 0.8);
    assert.equal(notice.riskWeight, 0.95);
    assert.equal(notice.walkAway, true);
    assert.match(notice.reading, /moving it from 0\.8 to 0\.95/);

    // §4.5.2 requires it, and it is on the register rather than on a screen.
    assert.match(risk.disclaimer, /not legal advice/);
    assert.match(risk.summary, /need the legal role before this is priced/);
  });

  it('refuses a contract in another tenancy', () => {
    throwsCode(
      () => clauselibrary.adoptStandardForm(asQS(), { contractId: 'not-a-contract', formId: 'nec4-ecc' }),
      'CONTRACT_NOT_FOUND',
    );
  });
});

describe('one source of truth for a clause number', () => {
  it('never disagrees with the citation table the calendar already uses', () => {
    // Two tables describing the same forms is how a second source of truth
    // starts. This is the reconciliation, and it is published so the console
    // can show it rather than either table quietly drifting.
    const rows = clauselibrary.citationAgreement();
    assert.ok(rows.length >= 10, `only ${rows.length} categories overlap, which is too few to be checking anything`);

    // A divergence is permitted only where it is understood and written down.
    // The citation table is keyed by suite and a suite has more than one form,
    // so JCT's numbering is the Standard Building Contract's — right for that
    // book and wrong for Design and Build. An unexplained divergence is drift.
    const unexplained = rows.filter((row) => !row.agrees && row.reason === undefined);
    assert.deepEqual(
      unexplained,
      [],
      `the library and the citation table disagree with no reason recorded:\n  ${unexplained
        .map((row) => `${row.formId} ${row.category}: library ${row.library}, citation ${row.citation}`)
        .join('\n  ')}`,
    );

    const explained = rows.filter((row) => !row.agrees);
    assert.equal(explained.length, 1, 'the known divergence list has drifted from what the tables actually do');
    assert.match(explained[0]!.reason!, /keyed by suite/);
  });
});
