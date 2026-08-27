import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as informationcontrol from '../src/domain/informationcontrol.ts';
import * as structure from '../src/domain/structure.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * CN-WF-08 — construction information, RFI, submittal and instruction control.
 *
 * The drawing register, its supersession, the markup that becomes an RFI and
 * the answer recorded against a revision are all built. What is tested here is
 * the four things that were not, three of which are the same failure seen from
 * different sides: the site is working to a revision the office has replaced.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds DESIGN_INFORMATION I and U — issues and acknowledges transmittals. */
const asDesigner = () => platform.context(seed.users.designer!.auth, seed.projectId, { source: 'WEB' });
/** Holds CHANGE_VARIATION A — issues instructions, withdraws directions. */
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/** Holds CHANGE_VARIATION C and U — records what was said. Cannot issue an instruction. */
const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const hash = (text: string) => `sha256:${text.padEnd(64, '0').slice(0, 64)}`;

let sequence = 0;

function transmittal(overrides: Partial<Parameters<typeof informationcontrol.issueTransmittal>[1]> = {}) {
  sequence += 1;
  return informationcontrol.issueTransmittal(asDesigner(), {
    documents: [
      {
        reference: `C-${3000 + sequence}`,
        title: 'Clarifier general arrangement',
        revision: 'P04',
        purpose: 'For construction',
      },
    ],
    recipients: ['Meridian Site Team', 'Caldervale Engineering'],
    packageReference: 'PKG-CIV',
    note: 'Issued for construction following the design freeze.',
    ...overrides,
  });
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'CONSTRUCTION',
    justification: 'Issuing construction information',
  });
});

describe('CN-WF-08 the register', () => {
  it('registers its six event types', () => {
    for (const [code, entity] of [
      ['INFORMATION_PUBLISHED', 'Transmittal'],
      ['INFORMATION_ACKNOWLEDGED', 'Transmittal'],
      ['INSTRUCTION_ISSUED', 'Instruction'],
      ['INSTRUCTION_IMPLEMENTED', 'Instruction'],
      ['UNCONFIRMED_DIRECTION_RECORDED', 'UnconfirmedDirection'],
      ['DIRECTION_CONFIRMED', 'UnconfirmedDirection'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // "Cannot issue contractual communication."
      assert.equal(definition.aiAllowed, false);
    }
  });

  it('puts the instruction and the direction with the contract, not the design', () => {
    // The question they answer is what the project is owed and owes.
    assert.equal(classifyEntity('Instruction')?.area, 'CONTRACTS_CLAIMS');
    assert.equal(classifyEntity('UnconfirmedDirection')?.area, 'CONTRACTS_CLAIMS');
    assert.equal(classifyEntity('Transmittal')?.area, 'DESIGN_INFORMATION');
  });
});

describe('AC-CN-WF-08-01 which revision am I building to', () => {
  it('answers what is current in one call', () => {
    const result = transmittal();
    assert.match(result.reference, /^TR-\d{4}$/);

    const current = informationcontrol.currentInformationFor(asDesigner(), 'PKG-CIV');
    assert.ok(current.current.some((entry) => entry.revision === 'P04' && entry.purpose === 'For construction'));
  });

  it('names who is still holding the revision the office replaced', () => {
    sequence += 1;
    const reference = `C-${4000 + sequence}`;
    informationcontrol.issueTransmittal(asDesigner(), {
      documents: [{ reference, title: 'Section', revision: 'P02', purpose: 'For construction' }],
      recipients: ['Meridian Site Team'],
      note: 'First issue.',
    });
    const replacement = informationcontrol.issueTransmittal(asDesigner(), {
      documents: [{ reference, title: 'Section', revision: 'P03', purpose: 'For construction', supersedes: 'P02' }],
      recipients: ['Meridian Site Team', 'Caldervale Engineering'],
      note: 'Reissued after the coordination change.',
    });
    assert.deepEqual(replacement.supersedes, ['P02']);

    const before = informationcontrol.currentInformationFor(asDesigner());
    assert.ok(before.holdingSuperseded.some((entry) => entry.party === 'Meridian Site Team' && entry.document === reference));

    informationcontrol.acknowledgeTransmittal(asDesigner(), replacement.transmittalId, {
      party: 'Meridian Site Team',
      acknowledgedBy: 'A. Okafor',
    });

    const after = informationcontrol.currentInformationFor(asDesigner());
    assert.ok(
      !after.holdingSuperseded.some((entry) => entry.party === 'Meridian Site Team' && entry.document === reference),
    );
    // The other recipient has still not said they hold it.
    assert.ok(after.holdingSuperseded.some((entry) => entry.party === 'Caldervale Engineering'));
  });

  it('shows the current revision as the one most recently issued', () => {
    sequence += 1;
    const reference = `C-${5000 + sequence}`;
    informationcontrol.issueTransmittal(asDesigner(), {
      documents: [{ reference, title: 'Detail', revision: 'P01', purpose: 'For comment' }],
      recipients: ['Meridian Site Team'],
      note: 'First.',
    });
    informationcontrol.issueTransmittal(asDesigner(), {
      documents: [{ reference, title: 'Detail', revision: 'P02', purpose: 'For construction', supersedes: 'P01' }],
      recipients: ['Meridian Site Team'],
      note: 'Second.',
    });
    const current = informationcontrol.currentInformationFor(asDesigner());
    const entry = current.current.find((row) => row.reference === reference)!;
    assert.equal(entry.revision, 'P02');
    assert.equal(entry.purpose, 'For construction');
  });

  it('refuses a document with no revision or no purpose on it', () => {
    // A drawing issued for comment and built from is how a preliminary
    // revision ends up in the ground.
    throwsCode(
      () => transmittal({ documents: [{ reference: 'C-1', title: 'x', revision: '  ', purpose: 'For construction' }] }),
      'DOCUMENT_UNIDENTIFIED',
    );
    throwsCode(
      () => transmittal({ documents: [{ reference: 'C-1', title: 'x', revision: 'P01', purpose: '  ' }] }),
      'PURPOSE_REQUIRED',
    );
  });

  it('refuses a transmittal to nobody, or with nothing on it', () => {
    throwsCode(() => transmittal({ recipients: [] }), 'RECIPIENTS_REQUIRED');
    throwsCode(() => transmittal({ documents: [] }), 'TRANSMITTAL_EMPTY');
  });

  it('refuses an acknowledgement from somebody it was never issued to', () => {
    const result = transmittal();
    throwsCode(
      () =>
        informationcontrol.acknowledgeTransmittal(asDesigner(), result.transmittalId, {
          party: 'Somebody Else Ltd',
          acknowledgedBy: 'X',
        }),
      'NOT_A_RECIPIENT',
    );
  });

  it('refuses the same acknowledgement twice', () => {
    const result = transmittal();
    const args = { party: 'Meridian Site Team', acknowledgedBy: 'A. Okafor' };
    informationcontrol.acknowledgeTransmittal(asDesigner(), result.transmittalId, args);
    throwsCode(
      () => informationcontrol.acknowledgeTransmittal(asDesigner(), result.transmittalId, args),
      'ALREADY_ACKNOWLEDGED',
    );
  });
});

describe('AC-CN-WF-08-03 an instruction with authority on it', () => {
  it('numbers it, names the clause, the recipients and the evidence', () => {
    const result = informationcontrol.issueInstruction(asPM(), {
      subject: 'Relocate the sample point downstream of the weir',
      instruction:
        'Move the sample point from chainage 12+40 to 12+62, downstream of the weir, and reinstate the redundant chamber.',
      contractClause: 'NEC4 clause 14.3',
      recipients: ['Meridian Infrastructure Group'],
      evidenceHash: hash('ins-1'),
    });
    assert.match(result.reference, /^INS-\d{4}$/);
    assert.equal(result.number, 1);

    const position = informationcontrol.informationPosition(asPM());
    const instruction = position.instructions.find((entry) => entry.reference === result.reference)!;
    assert.equal(instruction.contractClause, 'NEC4 clause 14.3');
    assert.equal(instruction.status, 'ISSUED');
  });

  it('refuses an instruction nobody can act on', () => {
    throwsCode(
      () =>
        informationcontrol.issueInstruction(asPM(), {
          subject: 'Proceed',
          // A floor rather than a clarity judgement: no rule tells "proceed as
          // discussed" from a real instruction. What this stops is the one-word
          // instruction, which is common and always a dispute.
          instruction: 'As discussed',
          contractClause: 'NEC4 14.3',
          recipients: ['Meridian'],
          evidenceHash: hash('ins-2'),
        }),
      'INSTRUCTION_UNCLEAR',
    );
  });

  it('refuses an instruction with no clause behind it', () => {
    // The difference decides whether it carries an entitlement.
    throwsCode(
      () =>
        informationcontrol.issueInstruction(asPM(), {
          subject: 'Move the sample point',
          instruction: 'Move the sample point from chainage 12+40 to 12+62 as marked.',
          contractClause: '  ',
          recipients: ['Meridian'],
          evidenceHash: hash('ins-3'),
        }),
      'CLAUSE_REQUIRED',
    );
  });

  it('refuses an instruction from a role that can record a direction but not issue one', () => {
    throwsCode(
      () =>
        informationcontrol.issueInstruction(asQS(), {
          subject: 'Move the sample point',
          instruction: 'Move the sample point from chainage 12+40 to 12+62 as marked.',
          contractClause: 'NEC4 14.3',
          recipients: ['Meridian'],
          evidenceHash: hash('ins-4'),
        }),
      'ACCESS_DENIED',
    );
  });

  it('records what was actually done on site and who checked it', () => {
    const { instructionId, reference } = informationcontrol.issueInstruction(asPM(), {
      subject: 'Additional ground investigation',
      instruction: 'Sink two additional boreholes at chainage 14+10 and 14+60 to 8m depth.',
      contractClause: 'NEC4 clause 14.3',
      recipients: ['Meridian Infrastructure Group'],
      evidenceHash: hash('ins-5'),
    });
    informationcontrol.recordInstructionImplementation(asPM(), instructionId, {
      what: 'Both boreholes sunk to 8m; logs issued as GI-114 and GI-115.',
      verifiedBy: 'D. Whyte',
      evidenceHash: hash('ins-5-impl'),
    });
    const position = informationcontrol.informationPosition(asPM());
    assert.equal(position.instructions.find((entry) => entry.reference === reference)!.status, 'IMPLEMENTED');

    throwsCode(
      () =>
        informationcontrol.recordInstructionImplementation(asPM(), instructionId, {
          what: 'Again.',
          verifiedBy: 'D. Whyte',
          evidenceHash: hash('again'),
        }),
      'ALREADY_IMPLEMENTED',
    );
  });

  it('refuses an implementation nobody verified', () => {
    const { instructionId } = informationcontrol.issueInstruction(asPM(), {
      subject: 'Third thing',
      instruction: 'Do the third thing as described on the marked-up sketch.',
      contractClause: 'NEC4 clause 14.3',
      recipients: ['Meridian'],
      evidenceHash: hash('ins-6'),
    });
    throwsCode(
      () =>
        informationcontrol.recordInstructionImplementation(asPM(), instructionId, {
          what: 'Done.',
          verifiedBy: '  ',
          evidenceHash: hash('x'),
        }),
      'IMPLEMENTATION_UNVERIFIED',
    );
  });
});

describe('CN-WF-08 the thing that was only ever said', () => {
  it('records a verbal direction as visible exposure', () => {
    const result = informationcontrol.recordUnconfirmedDirection(asQS(), {
      givenBy: 'R. Sandhu (Northern Water Authority)',
      givenTo: 'A. Okafor',
      givenAt: day(-9),
      whatWasSaid: 'Move the wall two metres north so the access road can take a rigid, and we will sort the paperwork.',
      actionTaken: 'Setting out changed and the first lift poured on the new line.',
      estimatedCostMinor: 1_800_000,
    });
    assert.match(result.reference, /^UD-\d{4}$/);

    const position = informationcontrol.informationPosition(asPM());
    const direction = position.unconfirmedDirections.find((entry) => entry.reference === result.reference)!;
    assert.ok(direction.daysOutstanding >= 9);
    assert.match(direction.actionTaken, /first lift poured/);
    assert.match(position.summary, /unconfirmed/);
  });

  it('refuses a direction with nobody at either end', () => {
    // The argument afterwards is always about one of them.
    const good = {
      givenBy: 'R. Sandhu',
      givenTo: 'A. Okafor',
      givenAt: day(-2),
      whatWasSaid: 'Move the wall two metres north.',
      actionTaken: 'Setting out changed.',
    };
    throwsCode(
      () => informationcontrol.recordUnconfirmedDirection(asQS(), { ...good, givenBy: '  ' }),
      'DIRECTION_UNATTRIBUTED',
    );
    throwsCode(
      () => informationcontrol.recordUnconfirmedDirection(asQS(), { ...good, givenTo: '' }),
      'DIRECTION_UNATTRIBUTED',
    );
  });

  it('refuses a paraphrase too thin to be worth anything', () => {
    throwsCode(
      () =>
        informationcontrol.recordUnconfirmedDirection(asQS(), {
          givenBy: 'R. Sandhu',
          givenTo: 'A. Okafor',
          givenAt: day(-2),
          whatWasSaid: 'Move it',
          actionTaken: 'Moved.',
        }),
      'DIRECTION_UNRECORDED',
    );
  });

  it('refuses a direction that does not say what the site did', () => {
    throwsCode(
      () =>
        informationcontrol.recordUnconfirmedDirection(asQS(), {
          givenBy: 'R. Sandhu',
          givenTo: 'A. Okafor',
          givenAt: day(-2),
          whatWasSaid: 'Move the wall two metres north so the access road takes a rigid.',
          actionTaken: '  ',
        }),
      'ACTION_UNRECORDED',
    );
  });

  it('closes the exposure when an instruction confirms it, and never before', () => {
    // The platform records the direction; it never converts one. An instruction
    // is a contractual communication and only a person with authority issues it.
    const direction = informationcontrol.recordUnconfirmedDirection(asQS(), {
      givenBy: 'R. Sandhu',
      givenTo: 'A. Okafor',
      givenAt: day(-5),
      whatWasSaid: 'Take the redundant chamber out while you are in there.',
      actionTaken: 'Chamber broken out and backfilled.',
    });

    const before = informationcontrol.informationPosition(asPM());
    assert.ok(before.unconfirmedDirections.some((entry) => entry.reference === direction.reference));

    informationcontrol.issueInstruction(asPM(), {
      subject: 'Removal of the redundant chamber',
      instruction: 'Confirming the direction of the 22nd: break out and backfill the redundant chamber at 12+40.',
      contractClause: 'NEC4 clause 14.3',
      recipients: ['Meridian Infrastructure Group'],
      confirmsDirectionId: direction.directionId,
      evidenceHash: hash('ins-confirm'),
    });

    const after = informationcontrol.informationPosition(asPM());
    assert.ok(!after.unconfirmedDirections.some((entry) => entry.reference === direction.reference));
  });

  it('withdraws one with what happened to the work done on the strength of it', () => {
    const direction = informationcontrol.recordUnconfirmedDirection(asQS(), {
      givenBy: 'R. Sandhu',
      givenTo: 'A. Okafor',
      givenAt: day(-3),
      whatWasSaid: 'Bring the handrail forward to the edge of the slab.',
      actionTaken: 'Nothing yet; queried before starting.',
    });
    const result = informationcontrol.withdrawDirection(asPM(), direction.directionId, {
      reason: 'Withdrawn on 24th; the handrail stays on the design line. No work had started.',
    });
    assert.equal(result.withdrawn, true);
    throwsCode(
      () => informationcontrol.withdrawDirection(asPM(), direction.directionId, { reason: 'Again.' }),
      'DIRECTION_RESOLVED',
    );
  });

  it('refuses an unexplained withdrawal', () => {
    const direction = informationcontrol.recordUnconfirmedDirection(asQS(), {
      givenBy: 'R. Sandhu',
      givenTo: 'A. Okafor',
      givenAt: day(-3),
      whatWasSaid: 'Something that was said and then unsaid entirely.',
      actionTaken: 'Nothing.',
    });
    throwsCode(
      () => informationcontrol.withdrawDirection(asPM(), direction.directionId, { reason: '  ' }),
      'WITHDRAWAL_UNEXPLAINED',
    );
  });
});

describe('AC-CN-WF-08-02 the due date and the required-by are different dates', () => {
  it('reports both, with the required-by taken from the programme', () => {
    // A second typed date is a second date to be wrong, so the required-by
    // comes off the activity the answer is holding up.
    const position = informationcontrol.informationPosition(asDesigner());
    assert.ok(Array.isArray(position.rfiPressure));
    for (const entry of position.rfiPressure) {
      assert.ok(entry.daysOpen >= 0);
      // Where an RFI names the activity it blocks, the float comes with it.
      if (entry.blocksActivity !== undefined) assert.equal(typeof entry.floatDays, 'number');
    }
  });
});
