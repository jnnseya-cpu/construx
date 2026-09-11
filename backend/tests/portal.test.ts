import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as award from '../src/domain/award.ts';
import * as itt from '../src/domain/itt.ts';
import * as portal from '../src/domain/portal.ts';
import * as structure from '../src/domain/structure.ts';
import * as tender from '../src/engines/tender.ts';
import { ROUTES } from '../src/api/routes.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The tender portal port — §4.8.1, §14, `L7.7`.
 *
 * **A port is an interface plus its adapters, and this one ships the adapter
 * that is real.** A person works the buyer's portal; the platform gates the
 * start, records what was checked first, and binds the receipt to the pack's
 * hash. No portal-specific adapter exists and the register says so, because a
 * screen offering an upload that silently does nothing is worse than one that
 * says a person has to do it.
 *
 * These tests are about the three things that needed no portal and were missing
 * anyway.
 *
 * **The rule set.** A submission rejected on a filename is rejected as
 * completely as one rejected on price, and nothing recorded what the buyer said
 * about filenames.
 *
 * **A readiness score that will not round up.** A hard rule the record cannot
 * check is reported as uncheckable and blocks. A check that could not run is not
 * a check that passed.
 *
 * **The four-hour buffer.** Starting an upload twenty minutes before the
 * deadline is how a portal timeout becomes a lost bid. Refused without a named
 * director, and the authorisation is recorded with its reason.
 */

let platform: Platform;
let seed: SeedResult;
let analysisId: string;
let packId: string;

/** Holds ESTIMATE_TENDER C/R — records the rule set and reads readiness. */
const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });
/** Holds PROCUREMENT_AWARD I — starts the upload and records the receipt. */
const asOwner = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });

/** Comfortably outside the buffer, and inside it, against one fixed deadline. */
const RETURN_BY = '2027-03-01T12:00:00.000Z';
const EARLY = '2027-02-28T09:00:00.000Z';
const LATE = '2027-03-01T09:30:00.000Z';

const RULES: portal.SubmissionRule[] = [
  {
    kind: 'REQUIRED_DOCUMENT',
    stated: 'A completed form of tender must be submitted with the return.',
    hard: true,
    documentName: 'Form of tender',
  },
  {
    kind: 'FORMAT',
    stated: 'All documents shall be submitted in PDF format.',
    hard: true,
    formats: ['pdf'],
  },
  {
    kind: 'PAGE_LIMIT',
    stated: 'The method statement shall not exceed four sides of A4.',
    hard: true,
    maxPages: 4,
  },
  {
    kind: 'FILENAME',
    stated: 'Each file shall be named with the tender reference as a prefix.',
    hard: false,
    pattern: '^ITT-',
  },
];

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  structure.transitionPhase(platform.context(seed.users.admin!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'TENDER',
    justification: 'Reopened to take a submission out through the port',
  });

  analysisId = itt.analyseITT(asQS(), {
    reference: 'ITT-PORTAL-01',
    clientName: 'Calderdale Metropolitan Borough Council',
    returnBy: '2027-03-01',
    estimatedValueMinor: 480_000_000,
    durationWeeks: 96,
    requirements: [
      {
        reference: 'R-01',
        category: 'TECHNICAL',
        requirement: 'Describe your methodology for deep drainage beneath a live carriageway',
        mandatory: true,
        evidenceRequired: 'Method statement',
      },
    ],
    terms: { contractForm: 'NEC4 Option A' },
  }).analysisId;

  const estimate = tender.buildEstimate(asQS(), {
    packageId: 'PKG-PORTAL',
    durationWeeks: 96,
    lines: [{ description: 'Deep drainage', unit: 'm', quantity: 400, labourRateMinor: 12_000 }],
    margin: { overheadPercent: 5, profitPercent: 8 },
    basisOfEstimate: 'For the portal test',
    assumptions: [],
  });
  tender.freezeEstimate(asQS(), estimate.estimateId, 'Priced for the Calderdale return');

  packId = tender.compileBidPack(asOwner(), {
    rfqId: 'ITT-PORTAL-01',
    estimateId: estimate.estimateId,
    submissionLetter: 'We are pleased to submit our tender for the Calderdale drainage works.',
    qualifications: [],
    exclusions: [],
    prelimsNarrative: 'Preliminaries are priced on a 96-week programme.',
    attachments: [
      { name: 'ITT-PORTAL-01 Form of tender.pdf', ref: { refType: 'Estimate', refId: estimate.estimateId } },
      { name: 'ITT-PORTAL-01 Pricing schedule.pdf', ref: { refType: 'Estimate', refId: estimate.estimateId } },
    ],
  }).packId;
});

describe('the port, and what it says it cannot do', () => {
  it('is reachable, and the three reads are declared read-only', () => {
    for (const [method, pattern] of [
      ['GET', '/v1/portal/adapters'],
      ['GET', '/v1/projects/:projectId/tender/:analysisId/submission-readiness'],
      ['GET', '/v1/projects/:projectId/submissions'],
      ['POST', '/v1/projects/:projectId/tender/:analysisId/submission-rules'],
      ['POST', '/v1/projects/:projectId/bid-packs/:packId/submission-start'],
    ] as const) {
      const route = ROUTES.find((candidate) => candidate.method === method && candidate.pattern === pattern);
      assert.ok(route, `${method} ${pattern} has no route`);
      if (method === 'GET') assert.equal(route.readOnly, true, `${pattern} must be read-only`);
    }
  });

  it('keeps both acts out of an agent’s reach', () => {
    // The rule set decides whether a submission is rejected on a filename, and
    // §4.8.1 is explicit that a human starts the upload.
    assert.notEqual(lookupEventType('SUBMISSION_RULESET_RECORDED')?.aiAllowed, true);
    assert.notEqual(lookupEventType('SUBMISSION_STARTED')?.aiAllowed, true);
    assert.equal(classifyEntity('SubmissionRuleSet')?.area, 'ESTIMATE_TENDER');
    assert.equal(classifyEntity('SubmissionStart')?.area, 'PROCUREMENT_AWARD');
  });

  it('publishes one adapter and names what is not built', () => {
    const register = portal.portalAdapters();
    assert.equal(register.adapters.length, 1);

    const manual = register.adapters[0]!;
    assert.equal(manual.id, 'MANUAL');
    assert.equal(manual.live, true);
    // Every operation is answered, and each says how rather than implying more.
    for (const operation of portal.PORTAL_OPERATION) {
      assert.ok(manual.operations[operation], `${operation} is unanswered`);
      assert.equal(manual.operations[operation].support, 'RECORDED');
      assert.ok(manual.operations[operation].note.length > 20);
    }

    // A list of six portals with five inert is a list of things that do not work.
    assert.ok(register.limits.some((limit) => limit.includes('No portal-specific adapter is built')));
    assert.ok(register.limits.some((limit) => limit.includes('configuration entry')));
  });

  it('refuses an adapter the deployment does not have, and names what it has', () => {
    const error = throwsCode(
      () =>
        portal.beginSubmission(asOwner(), {
          packId,
          analysisId,
          adapterId: 'PROACTIS',
          returnBy: RETURN_BY,
          now: EARLY,
        }),
      'PORTAL_ADAPTER_UNKNOWN',
    );
    assert.match(String(error.message), /MANUAL/);
    assert.match(String(error.message), /none is built/);
  });
});

describe('what the buyer said about the shape of it', () => {
  it('will not claim readiness before anybody has read the invitation', () => {
    const readiness = portal.submissionReadiness(asQS(), { analysisId, packId });
    assert.equal(readiness.ready, false);
    assert.equal(readiness.checks.length, 0);
    // Silence is not the same as compliance, and the summary says which it is.
    assert.match(readiness.summary, /nothing to check and readiness cannot be claimed/);
  });

  it('wants the buyer’s own words on every rule', () => {
    throwsCode(
      () => portal.recordRuleSet(asQS(), { analysisId, rules: [] }),
      'RULES_REQUIRED',
    );
    throwsCode(
      () =>
        portal.recordRuleSet(asQS(), {
          analysisId,
          rules: [{ kind: 'REQUIRED_DOCUMENT', stated: 'PDF', hard: true, documentName: 'Form of tender' }],
        }),
      'RULE_STATEMENT_REQUIRED',
    );
  });

  it('refuses a pattern that would throw on every check afterwards', () => {
    const error = throwsCode(
      () =>
        portal.recordRuleSet(asQS(), {
          analysisId,
          rules: [{ kind: 'FILENAME', stated: 'Files shall be named sensibly.', hard: true, pattern: '^ITT-[' }],
        }),
      'RULE_PATTERN_INVALID',
    );
    assert.match(String(error.message), /record the requirement as a required document instead/);
  });

  it('records the rule set against the invitation it came from', () => {
    const ruleSet = portal.recordRuleSet(asQS(), { analysisId, rules: RULES });
    assert.match(ruleSet.reference, /^SRS-\d{4}$/);
    assert.equal(ruleSet.revision, 1);
    assert.equal(ruleSet.rules.length, 4);
    assert.equal(ruleSet.recordedBy, seed.users.qs!.auth.actorId);
  });

  it('lets the invitation be re-read after an addendum, and says it was', () => {
    // An addendum moves a page limit or adds a format, and a rule set that
    // could only be written once would leave the submission checked against
    // wording the buyer has replaced. The revision is its own event so "the
    // rules changed" is visible rather than overwritten.
    const revised = portal.recordRuleSet(asQS(), {
      analysisId,
      rules: [...RULES, { kind: 'FORMAT', stated: 'Addendum 2 permits XLSX for the pricing schedule.', hard: true, formats: ['pdf', 'xlsx'] }],
    });
    assert.equal(revised.revision, 2);
    assert.equal(revised.rules.length, 5);
    // The reference is stable across revisions: it is the same rule set, read
    // again, and a new number would make the second reading look like a second
    // set of rules.
    assert.match(revised.reference, /^SRS-\d{4}$/);

    const events = platform.ledger.eventsForEntity({ refType: 'SubmissionRuleSet', refId: analysisId });
    assert.deepEqual(events.map((event) => event.eventType), [
      'SUBMISSION_RULESET_RECORDED',
      'SUBMISSION_RULESET_REVISED',
    ]);
    assert.match(String(events[1]!.reason), /Revision 2/);

    // Put it back, so the checks below run against the four rules they describe.
    portal.recordRuleSet(asQS(), { analysisId, rules: RULES });
  });

  it('refuses a rule set against an invitation that is not ours', () => {
    throwsCode(
      () => portal.recordRuleSet(asQS(), { analysisId: 'not-an-analysis', rules: RULES }),
      'ITT_ANALYSIS_NOT_FOUND',
    );
  });
});

describe('a check that could not run is not a check that passed', () => {
  it('passes what it can check and blocks on what it cannot', () => {
    const readiness = portal.submissionReadiness(asQS(), { analysisId, packId });

    const required = readiness.checks.find((check) => check.kind === 'REQUIRED_DOCUMENT')!;
    assert.equal(required.verdict, 'PASS');
    const format = readiness.checks.find((check) => check.kind === 'FORMAT')!;
    assert.equal(format.verdict, 'PASS');

    // The page limit is hard and the record holds no page count. Reporting it
    // as passing because nothing looked is the failure this exists to prevent.
    const pages = readiness.checks.find((check) => check.kind === 'PAGE_LIMIT')!;
    assert.equal(pages.verdict, 'CANNOT_CHECK');
    assert.match(pages.detail, /Somebody has to open the file/);

    assert.equal(readiness.hardFailures, 0);
    assert.equal(readiness.uncheckableHard, 1);
    // Every hard rule it could check passes, and it still is not ready.
    assert.equal(readiness.scorePercent, 100);
    assert.equal(readiness.ready, false);
    assert.match(readiness.summary, /the record cannot check/);
  });

  it('refuses to start while a hard rule is unresolved, and says which', () => {
    const error = throwsCode(
      () => portal.beginSubmission(asOwner(), { packId, analysisId, adapterId: 'MANUAL', returnBy: RETURN_BY, now: EARLY }),
      'SUBMISSION_NOT_READY',
    );
    assert.match(String(error.message), /not a hard rule that passed/);
    assert.match(String(error.message), /rejected on a filename is rejected as completely/);
  });

  it('catches a wrong format and a missing document, pure', () => {
    const checks = portal.checkAgainstRules(RULES, [
      { name: 'ITT-PORTAL-01 Pricing schedule.xlsx' },
      { name: 'Method statement.pdf' },
    ]);

    const format = checks.find((check) => check.kind === 'FORMAT')!;
    assert.equal(format.verdict, 'FAIL');
    assert.match(format.detail, /xlsx/);

    const required = checks.find((check) => check.kind === 'REQUIRED_DOCUMENT')!;
    assert.equal(required.verdict, 'FAIL');

    // The naming rule is soft, so it is reported and does not block.
    const filename = checks.find((check) => check.kind === 'FILENAME')!;
    assert.equal(filename.verdict, 'FAIL');
    assert.equal(filename.hard, false);
    assert.match(filename.detail, /Method statement\.pdf/);
  });

  it('counts words where the record holds them, and says so where it does not', () => {
    const rule: portal.SubmissionRule = {
      kind: 'WORD_LIMIT',
      stated: 'The response shall not exceed 500 words.',
      hard: true,
      maxWords: 500,
    };
    const over = portal.checkAgainstRules([rule], [{ name: 'R-01', words: 900 }]);
    assert.equal(over[0]!.verdict, 'FAIL');
    assert.match(over[0]!.detail, /900 words against a limit of 500/);

    const nothing = portal.checkAgainstRules([rule], [{ name: 'R-01' }]);
    assert.equal(nothing[0]!.verdict, 'CANNOT_CHECK');
  });
});

describe('the four-hour buffer', () => {
  before(() => {
    // Resolve the page limit by hand, which is exactly what the check told
    // somebody to do: open the file, confirm it, and record the rule as met.
    portal.recordRuleSet(asQS(), {
      analysisId,
      rules: RULES.filter((rule) => rule.kind !== 'PAGE_LIMIT').concat([
        {
          kind: 'PAGE_LIMIT',
          stated: 'The method statement shall not exceed four sides of A4. Checked by hand: three sides.',
          hard: false,
          maxPages: 4,
        },
      ]),
    });
  });

  it('reads the clock the buyer set, not the one we pressed send on', () => {
    const early = portal.submissionWindow(RETURN_BY, EARLY);
    assert.equal(early.bufferHours, 4);
    assert.equal(early.insideBuffer, false);
    assert.equal(early.passed, false);
    assert.match(early.reading, /outside the 4-hour buffer/);

    const late = portal.submissionWindow(RETURN_BY, LATE);
    assert.equal(late.hoursRemaining, 2.5);
    assert.equal(late.insideBuffer, true);
    assert.match(late.reading, /a portal timeout becomes a lost bid/);

    const gone = portal.submissionWindow(RETURN_BY, '2027-03-01T13:00:00.000Z');
    assert.equal(gone.passed, true);
  });

  it('refuses inside the buffer, and names what would clear it', () => {
    const error = throwsCode(
      () => portal.beginSubmission(asOwner(), { packId, analysisId, adapterId: 'MANUAL', returnBy: RETURN_BY, now: LATE }),
      'INSIDE_SUBMISSION_BUFFER',
    );
    assert.match(String(error.message), /A director can authorise it/);
    assert.match(String(error.message), /never whether somebody was in a hurry/);
  });

  it('wants a reason with the override, not just a name', () => {
    throwsCode(
      () =>
        portal.beginSubmission(asOwner(), {
          packId,
          analysisId,
          adapterId: 'MANUAL',
          returnBy: RETURN_BY,
          now: LATE,
          override: { authorisedBy: 'R Whitaker', reason: 'Late' },
        }),
      'OVERRIDE_REASON_REQUIRED',
    );
  });

  it('refuses a start after the deadline has gone', () => {
    const error = throwsCode(
      () =>
        portal.beginSubmission(asOwner(), {
          packId,
          analysisId,
          adapterId: 'MANUAL',
          returnBy: RETURN_BY,
          now: '2027-03-01T13:00:00.000Z',
          override: { authorisedBy: 'R Whitaker', reason: 'We are going to try it anyway and see what happens' },
        }),
      'RETURN_DEADLINE_PASSED',
    );
    assert.match(String(error.message), /contradicts the buyer’s own clock/);
  });

  it('starts it outside the buffer, recording what was checked and how long was left', () => {
    const start = portal.beginSubmission(asOwner(), {
      packId,
      analysisId,
      adapterId: 'MANUAL',
      returnBy: RETURN_BY,
      now: EARLY,
    });

    assert.match(start.reference, /^SUB-\d{4}$/);
    assert.equal(start.startedBy, seed.users.owner!.auth.actorId);
    assert.equal(start.override, undefined);
    assert.equal(start.window.insideBuffer, false);
    // The readiness snapshot is carried onto the start, so what was checked at
    // the moment somebody opened the portal is on the record rather than being
    // recomputed later against a changed rule set.
    assert.equal(start.readiness.ready, true);
    assert.equal(start.readiness.hardFailures, 0);
  });

  it('will not start the same pack twice', () => {
    // The receipt is what closes it, and a second start against a pack that
    // already has one is a second submission of the same bytes.
    award.recordSubmission(asOwner(), packId, {
      reference: 'CALD-2027-0041',
      channel: 'PORTAL',
      receivedAt: '2027-02-28T09:14:00.000Z',
      evidenceHash: `sha256:${'d4'.repeat(32)}`,
    });

    throwsCode(
      () => portal.beginSubmission(asOwner(), { packId, analysisId, adapterId: 'MANUAL', returnBy: RETURN_BY, now: EARLY }),
      'ALREADY_SUBMITTED',
    );
  });

  it('shows the start and its receipt together in the register', () => {
    const register = portal.submissionRegister(asOwner());
    assert.equal(register.starts.length, 1);

    const start = register.starts[0]!;
    assert.equal(start.adapterId, 'MANUAL');
    assert.equal(start.overridden, false);
    // The pair is the point: an upload started with no receipt behind it is the
    // row somebody has to chase.
    assert.equal(start.receipted, true);
    assert.match(register.summary, /0 with no receipt recorded yet/);
  });
});
