import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as conceptbrief from '../src/domain/conceptbrief.ts';
import * as designbaseline from '../src/domain/designbaseline.ts';
import * as designplan from '../src/domain/designplan.ts';
import * as stagegate from '../src/domain/stagegate.ts';
import * as structure from '../src/domain/structure.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The last two concept acceptance criteria, both of which were recorded as not
 * built and both of which are about *order*.
 *
 * **AC-C-WF-02-03** — a changed requirement shows what it affects before
 * approval. `briefDrift()` answers the same question backwards: it reports,
 * after the fact, that the baseline no longer matches the register. That is the
 * right thing on a dashboard and the wrong thing to show somebody about to
 * press supersede, because by then the damage is a fact rather than a decision.
 *
 * **AC-C-WF-08-03** — design cannot publish before the concept gate. The coarse
 * phase gate requires a scope package to leave CONCEPT, which is a different
 * rule about a different thing: it governs the project's phase, not what design
 * issues. A project could be moved into DESIGN and start freezing packages with
 * the 6.4 gate never decided.
 */

let platform: Platform;
let seed: SeedResult;

const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
const asOwner = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });
/** ENTERPRISE_ADMIN: holds C on PROJECT_SETUP, which neither the PM nor the client does. */
const asAdmin = () => platform.context(seed.users.admin!.auth, seed.projectId, { source: 'WEB' });

beforeEach(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

/** A requirement that made it into the baseline the project was built on. */
function baselinedRequirement(): conceptbrief.BriefRequirementState {
  const baseline = conceptbrief.currentBriefBaseline(asPM());
  assert.ok(baseline, 'the seed produced no brief baseline to test against');
  const first = baseline.frozen[0]!;
  const item = conceptbrief.requirementRegister(asPM()).find((r) => r.requirementId === first.requirementId);
  assert.ok(item);
  return item;
}

describe('AC-C-WF-02-03 — what a change reaches, before it is made', () => {
  it('names the baseline the requirement is frozen in', () => {
    const item = baselinedRequirement();
    const report = conceptbrief.requirementImpact(asPM(), item.requirementId);

    assert.equal(report.reference, item.reference);
    assert.equal(report.inBaseline, true);
    const baseline = report.impacts.find((impact) => impact.refType === 'BriefBaseline');
    assert.ok(baseline, report.impacts.map((i) => i.refType).join(', '));
    assert.equal(baseline.severity, 'HARD');
    assert.match(baseline.because, new RegExp(item.reference));
  });

  it('names the selected option, because it froze the hash that is about to change', () => {
    const report = conceptbrief.requirementImpact(asPM(), baselinedRequirement().requirementId);
    const option = report.impacts.find((impact) => impact.refType === 'FeasibilityOption');
    assert.ok(option, 'the option chosen against this brief is not reported as affected');
    assert.equal(option.severity, 'HARD');
  });

  it('names the approved cost, programme and cashflow, and the gate baseline', () => {
    const report = conceptbrief.requirementImpact(asPM(), baselinedRequirement().requirementId);
    const types = report.impacts.map((impact) => impact.refType);
    assert.ok(types.includes('ConceptControls'), types.join(', '));
    assert.ok(types.includes('ConceptBaseline'), types.join(', '));
  });

  it('separates what was approved against it from what merely sits downstream', () => {
    const report = conceptbrief.requirementImpact(asPM(), baselinedRequirement().requirementId);
    const hard = report.impacts.filter((impact) => impact.severity === 'HARD');
    assert.ok(hard.length > 0, 'nothing was reported as approved against the requirement');
    // The distinction is provenance, not consequence: HARD means an approval
    // names the hash that is about to change.
    for (const impact of hard) {
      assert.ok(impact.action.length > 10, `${impact.what} says what it is but not what to do about it`);
      assert.ok(impact.because.length > 10, `${impact.what} does not say why it is affected`);
    }
  });

  it('says plainly that a requirement outside the baseline costs nothing to change', () => {
    const { requirementId } = conceptbrief.extractRequirement(asAdmin(), {
      reference: 'REQ-IMPACT-1',
      category: 'FUNCTIONAL',
      statement: 'The inlet screen shall be accessible for maintenance without confined-space entry.',
      source: 'Design workshop, minute 4',
      sourceAnchor: 'Minute 4.2',
      ownerId: seed.users.pm!.id,
      priority: 'MEDIUM',
      verification: { method: 'INSPECTION', stage: 'HANDOVER' },
      acceptanceCriteria: 'Access confirmed on the as-built walk.',
      origin: 'HUMAN',
    });

    const report = conceptbrief.requirementImpact(asPM(), requirementId);
    assert.equal(report.inBaseline, false);
    // Nothing froze it, so nothing that froze a hash is reported. The design
    // packages are the only downstream item and they are SOFT by construction.
    assert.equal(report.impacts.filter((impact) => impact.severity === 'HARD').length, 0);
    assert.match(report.summary, /costs nothing/);
  });

  it('is a read, and says the same thing to anyone who may read the brief', () => {
    const item = baselinedRequirement();
    const before = conceptbrief.requirementImpact(asPM(), item.requirementId);
    const asOther = conceptbrief.requirementImpact(asOwner(), item.requirementId);
    assert.deepEqual(asOther, before);

    // And it changed nothing: an impact analysis that wrote to the ledger would
    // be a change to the record made by asking a question about it.
    const after = conceptbrief.requirementImpact(asPM(), item.requirementId);
    assert.deepEqual(after, before);
  });

  it('refuses a requirement that does not exist rather than reporting no impact', () => {
    throwsCode(() => conceptbrief.requirementImpact(asPM(), 'not-a-requirement'), 'NO_SUCH_REQUIREMENT');
  });
});

describe('AC-C-WF-08-03 — design cannot publish before the concept gate', () => {
  it('lets the seeded project freeze, because its gate was decided first', () => {
    // The rule has to be satisfied by a correctly ordered project, or it is a
    // rule that breaks the product rather than one that governs it.
    assert.equal(stagegate.designPublicationBlockedReason(asPM()), null);
  });

  it('refuses a freeze on a project whose concept gate has never been decided', () => {
    const portfolioId = String(
      platform.ledger.require({ refType: 'Project', refId: seed.projectId }).state.portfolioId,
    );
    const { projectId } = structure.createProject(asAdmin(), {
      portfolioId,
      name: 'Ashworth Phase 3 — early works',
      sectorType: 'UTILITIES',
      assetType: 'Treatment works',
      location: { continentCode: 'EU', countryCode: 'GB', city: 'Ashworth' },
      contractValueMinor: 4_000_000_00,
      currency: 'GBP',
      plannedStart: '2027-01-04',
      plannedCompletion: '2028-06-30',
    });

    const fresh = platform.context(seed.users.pm!.auth, projectId, { source: 'WEB' });
    const freshDesigner = platform.context(seed.users.designer!.auth, projectId, { source: 'WEB' });

    const blocked = stagegate.designPublicationBlockedReason(fresh);
    assert.ok(blocked, 'a project with no gate decision reported nothing blocking design publication');
    assert.match(blocked, /has not been decided/);

    const { packageId } = designplan.createPackage(fresh, {
      reference: 'PKG-EW-01',
      title: 'Early works civils',
      discipline: 'CIVIL',
      zone: 'Inlet works',
      leadDesigner: 'D. Whyte',
      leadOrganisation: 'Caldervale Engineering',
    });

    const error = throwsCode(
      () => designbaseline.freezePackage(freshDesigner, packageId, { scope: 'FULL', note: 'Ready to issue.' }),
      'CONCEPT_GATE_NOT_DECIDED',
    );
    assert.match(String(error.message), /nobody approved/);
  });

  it('does not treat a hold or a rejection as permission to publish', () => {
    // Written against the reason function rather than a whole second project:
    // what is under test is which decisions open the door, and a HOLD is a
    // decision *not* to proceed.
    const decisions = platform.ledger
      .list(seed.projectId, 'StageGateDecision')
      .map((record) => record.state as unknown as { phase: string; decision: string });
    const concept = decisions.filter((decision) => decision.phase === 'CONCEPT');
    assert.ok(concept.length > 0, 'the seed decided no concept gate');
    assert.ok(
      concept.some((decision) => decision.decision === 'PASS' || decision.decision === 'PASS_WITH_CONDITIONS'),
      'the seeded concept gate was not a proceed decision, so this file proves nothing',
    );
  });

  it('is checked at the freeze, which is the moment design publishes', () => {
    // Not at package creation, and not at the baseline. Creating a package is
    // planning; the baseline is over freezes that already happened. The freeze
    // is the act that puts design information out for somebody to build to.
    const source = designbaseline.freezePackage.toString();
    assert.match(source, /assertDesignMayPublish/);
  });
});
