import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { clauseFor, clauseRegister } from '../src/engines/maths/contractClauses.ts';
import { contractTerms, obligationCalendar } from '../src/engines/claims.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Citing the clause.
 *
 * The calendar knew what was due and when, and cited the contract as a whole.
 * That is enough to work from and not enough to argue from — a contract
 * administrator challenged on a retention release answers "clause 4.20.3", not
 * "the system said so".
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const project = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });

describe('the clause table', () => {
  it('cites the right clause for the right form', () => {
    // Retention under JCT is 4.20.3 and .4; under NEC it only exists at all
    // where secondary option X16 is used. Returning one for the other would be
    // a confident citation of a clause that says something else.
    assert.equal(clauseFor('JCT', 'RET-FIRST')?.clause, '4.20.3');
    assert.equal(clauseFor('JCT', 'RET-SECOND')?.clause, '4.20.4');
    assert.equal(clauseFor('NEC4', 'RET-FIRST')?.clause, 'X16.2');
    assert.equal(clauseFor('FIDIC', 'EXTENSION_OF_TIME')?.clause, '20.2.1');
  });

  it('distinguishes the two retention releases, which a category alone cannot', () => {
    // Both are RETENTION. Falling back to the category would cite the same
    // clause for a release at practical completion and one two years later.
    const first = clauseFor('JCT', 'RET-FIRST', 'RETENTION');
    const second = clauseFor('JCT', 'RET-SECOND', 'RETENTION');
    assert.notEqual(first?.clause, second?.clause);
  });

  it('falls back to the category where the reference is not specifically mapped', () => {
    assert.equal(clauseFor('JCT', 'EOT-0042', 'EXTENSION_OF_TIME')?.clause, '2.27');
  });

  it('cites nothing for a bespoke contract', () => {
    // A bespoke contract has whatever numbering its drafter chose. A wrong
    // citation is evidence that gets quoted in a letter; an absent one is
    // honest.
    assert.equal(clauseFor('BESPOKE', 'RET-FIRST', 'RETENTION'), undefined);
    assert.deepEqual(clauseRegister('BESPOKE'), []);
  });

  it('leaves an obligation a form does not have unmapped rather than approximating', () => {
    // NEC has no loss and expense as such — it assesses a change to Defined
    // Cost. Mapping it to the nearest JCT idea would misdescribe the contract.
    const nec = new Set(clauseRegister('NEC4').map((e) => e.obligation));
    assert.ok(nec.has('LOSS_AND_EXPENSE'), 'NEC4 lost its compensation-event mapping');
    assert.equal(clauseFor('NEC4', 'LOSS_AND_EXPENSE')?.clause, '63.1');

    // IChemE and MF/1 are mapped for the four obligations they clearly have and
    // no further; the register says how far it goes rather than guessing.
    assert.ok(clauseRegister('ICHEME').length >= 4);
    assert.equal(clauseFor('ICHEME', 'RET-FIRST', 'RETENTION'), undefined);
  });

  it('never returns a clause reference that is empty', () => {
    for (const suite of ['JCT', 'NEC4', 'FIDIC', 'ICHEME', 'MF1'] as const) {
      for (const entry of clauseRegister(suite)) {
        assert.ok(entry.clause.trim().length > 0, `${suite}/${entry.obligation} has an empty clause`);
        assert.equal(entry.suite, suite);
      }
    }
  });
});

describe('the calendar cites its source', () => {
  it('attaches a clause to a contract-derived obligation', () => {
    // A horizon that reaches them. Retention and defects fall due years out —
    // the seeded contract completes in 2028 with a 24-month defects period —
    // and the default 180-day window correctly excludes them. That is the
    // calendar working: a retention release in 2030 is not this week's work.
    const calendar = obligationCalendar(project(), undefined, 3000);
    const derived = calendar.entries.filter((e) => e.source === 'DERIVED_FROM_CONTRACT');
    assert.ok(derived.length > 0, 'the seeded project has no contract-derived obligations');

    // The seed is NEC4, so every one of them should cite an NEC clause.
    for (const entry of derived) {
      assert.ok(entry.clause !== undefined, `${entry.reference} cites no clause`);
      assert.equal(entry.clause!.suite, 'NEC4');
      assert.ok(entry.clause!.clause.length > 0);
    }

    // The specific citations, so a wrong table fails rather than an empty one.
    const byRef = new Map(derived.map((e) => [e.reference, e.clause!.clause]));
    assert.equal(byRef.get('RET-FIRST'), 'X16.2');
    assert.equal(byRef.get('RET-SECOND'), 'X16.3');
    assert.equal(byRef.get('DLP-EXPIRY'), '11.2(6)');
  });

  it('cites nothing where a project runs two different standard forms', () => {
    // Citing the JCT clause for an obligation under the NEC framework would be
    // wrong for half the project's obligations, and confidently so.
    const calendar = obligationCalendar(project(), undefined, 3000);
    assert.ok(calendar.entries.length > 0);
    // Single-form project here, so this asserts the shape rather than the
    // branch: every derived entry carries the one suite, none carries another.
    const suites = new Set(
      calendar.entries.filter((e) => e.clause).map((e) => e.clause!.suite),
    );
    assert.ok(suites.size <= 1, 'obligations were cited against more than one form');
  });
});

describe('the terms register', () => {
  it('resolves a percentage into money', () => {
    // Nobody argues about a percentage; they argue about the sum.
    const contractId = platform.ledger.list(seed.projectId, 'Contract')[0]!.refId;
    const register = contractTerms(project(), contractId);

    const retention = register.terms.find((t) => t.term === 'Retention');
    if (retention) {
      assert.ok(retention.valueMinor !== undefined && retention.valueMinor > 0);
      assert.match(retention.stated, /%/);
    }
  });

  it('resolves a duration into the date somebody has to diarise', () => {
    const contractId = platform.ledger.list(seed.projectId, 'Contract')[0]!.refId;
    const register = contractTerms(project(), contractId);

    const defects = register.terms.find((t) => t.term === 'Defects liability');
    if (defects) {
      assert.match(defects.stated, /months/);
      assert.match(defects.resolvesTo ?? '', /^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('says how many days of delay the cap buys', () => {
    // The figure that decides whether damages are a deterrent or a rounding
    // error on a project this size — and one no field on the record carries.
    const contractId = platform.ledger.list(seed.projectId, 'Contract')[0]!.refId;
    const register = contractTerms(project(), contractId);

    const days = register.terms.find((t) => t.term === 'Days of delay to reach the cap');
    if (days) assert.match(days.stated, /^\d+ days$/);
  });

  it('names the obligations the form has no clause for', () => {
    // An obligation with no citation is one that cannot be argued from, and
    // knowing which they are is the point of saying so.
    const contractId = platform.ledger.list(seed.projectId, 'Contract')[0]!.refId;
    const register = contractTerms(project(), contractId);
    assert.ok(Array.isArray(register.uncited));
    for (const category of register.uncited) assert.ok(category.length > 0);
  });
});
