import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import {
  GATES,
  approveGate,
  attestEvidence,
  declareProgress,
  deriveEvidence,
  evidenceFor,
  mobilisationPosition,
  withdrawEvidence,
  type GateId,
} from '../src/domain/etablix/mobilisation.ts';
import { acceptInterface, assignInterface, composeSystem } from '../src/domain/etablix/composer.ts';
import { recordFact } from '../src/domain/etablix/brief.ts';
import { setAppointment } from '../src/domain/etablix/appointment.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { authOf, seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { Role } from '../src/identity/roles.ts';

/**
 * §8 — the Mobilisation Control Tower.
 *
 * **"Mobilisation is a dependency network, not a percentage complete."**
 *
 * Every mobilisation tracker in the industry is a spreadsheet of percentages
 * supplied by the people being measured, and it reads 94% until the week it
 * reads 41% — because a percentage cannot be wrong, only revised.
 *
 * Four properties, and the first is the specification's own hard stop:
 *
 * 1. **A supplier reporting 100% moves nothing.** Readiness is calculated from
 *    prerequisite evidence and interface tests. The declaration is recorded,
 *    because the difference between what was declared and what the evidence
 *    showed is the entire mobilisation dispute.
 * 2. **Evidence is a reference, not a tick** — and expired evidence is not
 *    evidence. Everything is in place once.
 * 3. **Derived items cannot be attested away.** An interface matrix with three
 *    open interfaces is not closed because somebody typed a certificate number.
 * 4. **Only the named role passes a gate.** Holding the capability is not
 *    enough: a planner may not release an area or accept a safe energisation.
 */

let platform: Platform;
let seed: SeedResult;

function as(who: string): EngineContext {
  return platform.context(seed.users[who]!.auth, seed.projectId);
}

const WINDOW = { fromDate: '2026-11-01', toDate: '2027-09-01', leadDays: 30 };

/** A composed welfare system with its interfaces closed, ready to mobilise. */
function composedWelfare(closeInterfaces = true): string {
  const ctx = as('pm');
  setAppointment(ctx, {
    model: 'PRINCIPAL_SERVICE_CONTRACTOR',
    contractingEntity: 'Meridian Infrastructure Group Ltd',
    fundingSource: 'Client capital programme',
    basis: 'Single-point accountability across all seven families',
  });
  for (const [itemId, value] of [
    ['peakWorkforce', 164],
    ['shiftOverlapPersons', 120],
    ['visitorsPerDay', 22],
    ['accommodatedWorkers', 120],
  ] as [string, number][]) {
    recordFact(ctx, { itemId, value, source: 'Programme rev D' });
  }
  const { system, interfaces } = composeSystem(ctx, {
    family: 'WELFARE_ACCOMMODATION',
    zone: 'Main compound',
    ...WINDOW,
  });
  if (closeInterfaces) {
    for (const entry of interfaces) {
      assignInterface(ctx, { interfaceId: entry.id, owner: 'Ruth Adeyemi', dueDate: '2026-10-15' });
      acceptInterface(ctx, { interfaceId: entry.id, note: `${entry.name} agreed at the interface meeting` });
    }
  }
  return system.id;
}

/** Attest everything a gate asks for, so the next test can start past it. */
function satisfy(systemId: string, gate: GateId, who = 'pm'): void {
  const ctx = as(who);
  const definition = GATES.find((entry) => entry.id === gate)!;
  for (const item of evidenceFor(definition, 'WELFARE_ACCOMMODATION')) {
    if (item.kind === 'DERIVED') continue;
    attestEvidence(ctx, {
      systemId,
      gate,
      itemId: item.id,
      reference: `REF-${gate}-${item.id}`,
      ...(item.expiryRequired ? { expiresAt: '2099-01-01' } : {}),
    });
  }
}

/** Which role actually holds each gate, for the tests that need to pass one. */
const APPROVER: Record<GateId, string> = {
  G0: 'commercial',
  G1: 'designer',
  G2: 'qaqc',
  G3: 'constructionManager',
  G4: 'qaqc',
  G5: 'safety',
  G6: 'fm',
};

/**
 * Roles the demonstration tenancy does not seed but the gate network names.
 * Created here rather than weakening the gates to whoever happened to exist:
 * G0 is a contract gate and belongs to the commercial line.
 */
const EXTRA_ROLES: [string, Role, string, string][] = [
  ['commercial', 'COMMERCIAL_MANAGER', 'Aisha Rahimi', 'commercial@meridian.example'],
  ['director', 'PROJECT_DIRECTOR', 'Stephen Vale', 'director@meridian.example'],
];

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  for (const [key, role, name, email] of EXTRA_ROLES) {
    const user = platform.createUser({ tenantId: seed.users.pm!.auth.tenantId, name, email, roles: [role] });
    seed.users[key] = { id: user.id, auth: authOf(platform, user.id) };
  }
  platform.setModuleGrant({
    moduleId: 'ETABLIX',
    tenantId: seed.users.pm!.auth.tenantId,
    status: 'ACTIVE',
    reason: 'Appointed as ETABLIX site-services delivery partner',
    decidedBy: seed.users.operator!.id,
  });
});

beforeEach(() => {
  seed.projectId = `${seed.users.pm!.auth.tenantId}-${Math.random().toString(36).slice(2, 10)}`;
});

describe('the gate network as declared', () => {
  it('is seven gates in order, each with evidence, a condition and named approvers', () => {
    assert.equal(GATES.length, 7);
    assert.deepEqual(
      GATES.map((gate) => gate.id),
      ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6'],
    );
    GATES.forEach((gate, index) => {
      assert.equal(gate.order, index, `${gate.id} is out of order`);
      assert.ok(gate.evidence.length >= 4, `${gate.id} asks for almost nothing`);
      assert.ok(gate.approvalCondition.endsWith('.'), `${gate.id} has no approval condition`);
      assert.ok(gate.approvers.length > 0, `${gate.id} has nobody who may pass it`);
      for (const item of gate.evidence) {
        // Every item says the failure it prevents rather than the box it fills.
        assert.ok(item.matters.length > 30, `${gate.id}/${item.id} does not say why it is asked for`);
      }
    });
  });

  it('makes the energisation gate and the area release safety-critical', () => {
    // §16: AI never substitutes a competent person, and critical hold points
    // fail closed. G3 puts people onto an area; G5 energises it.
    const critical = GATES.filter((gate) => gate.safetyCritical).map((gate) => gate.id);
    assert.deepEqual(critical, ['G3', 'G5']);
    assert.ok(GATES.find((gate) => gate.id === 'G5')!.approvers.includes('SAFETY'));
  });

  it('derives the gate for the family, rather than asking every family everything', () => {
    const g2 = GATES.find((gate) => gate.id === 'G2')!;
    // A factory acceptance test is meaningful for a cabin or a generator and
    // not for a cleaning regime.
    assert.ok(evidenceFor(g2, 'TEMPORARY_MEP').some((item) => item.id === 'fat'));
    assert.ok(!evidenceFor(g2, 'CLEANING_FM').some((item) => item.id === 'fat'));
  });
});

describe('the hard stop', () => {
  it('records what the supplier says and moves nothing', () => {
    // The specification, verbatim: the scheduler cannot mark a package "ready"
    // because the supplier reports 100%.
    const systemId = composedWelfare();
    const before = mobilisationPosition(as('pm')).systems[0]!;

    const declaration = declareProgress(as('pm'), {
      systemId,
      percent: 100,
      note: 'All cabins delivered, connected and handed over — ready for occupation Monday.',
    });
    assert.equal(declaration.percent, 100);
    // The record carries the fact that it moves nothing, so a declaration
    // extracted into a report six months later cannot read as an accepted
    // status.
    assert.match(declaration.moves, /^Nothing\./);

    const after = mobilisationPosition(as('pm')).systems[0]!;
    assert.equal(after.accepted, false);
    assert.equal(after.atGate, before.atGate);
    assert.deepEqual(
      after.gates.map((gate) => gate.status),
      before.gates.map((gate) => gate.status),
      'a supplier declaration moved a gate',
    );
    // And it is on the tower beside the evidence, which is the point.
    assert.equal(after.declarations.length, 1);

    // The figure the tower reports beside the declaration is counted from the
    // evidence, not taken from it. Recomputed here rather than asserted as a
    // constant: what matters is that it is the ratio of what is satisfied to
    // what is asked for, whatever the gate network happens to ask for today.
    const asked = after.gates.reduce((sum, gate) => sum + gate.total, 0);
    const satisfied = after.gates.reduce((sum, gate) => sum + gate.satisfied, 0);
    assert.ok(satisfied < asked, 'nothing was attested, so not everything can be satisfied');
    assert.equal(after.evidencePercent, Math.round((satisfied / asked) * 1000) / 10);
    assert.ok(after.evidencePercent < 100, `the supplier said 100 and the tower agreed at ${after.evidencePercent}`);
  });

  it('refuses a declaration that says nothing', () => {
    const systemId = composedWelfare();
    throwsCode(
      () => declareProgress(as('pm'), { systemId, percent: 100, note: '  ' }),
      'SUPPLIER_DECLARATION_UNEXPLAINED',
    );
    throwsCode(
      () => declareProgress(as('pm'), { systemId, percent: 140, note: 'Ahead of schedule' }),
      'SUPPLIER_DECLARATION_INVALID',
    );
  });
});

describe('evidence', () => {
  it('is a reference, never a tick', () => {
    const systemId = composedWelfare();
    throwsCode(
      () => attestEvidence(as('pm'), { systemId, gate: 'G0', itemId: 'executedContract', reference: '' }),
      'MOBILISATION_EVIDENCE_UNREFERENCED',
    );
  });

  it('carries an expiry where the item expires, and lapses on it', () => {
    const systemId = composedWelfare();
    throwsCode(
      () => attestEvidence(as('pm'), { systemId, gate: 'G0', itemId: 'insurance', reference: 'ZUR-114/2026' }),
      'MOBILISATION_EVIDENCE_UNDATED',
    );

    attestEvidence(as('pm'), {
      systemId,
      gate: 'G0',
      itemId: 'insurance',
      reference: 'ZUR-114/2026',
      expiresAt: '2027-03-31',
    });

    // In date, it satisfies.
    const live = mobilisationPosition(as('pm'), '2027-01-01').systems[0]!.gates.find((gate) => gate.id === 'G0')!;
    assert.equal(live.evidence.find((entry) => entry.itemId === 'insurance')!.satisfied, true);

    // Lapsed, it does not — and it is reported as expired rather than as
    // missing, because "it lapsed" and "it never existed" are different
    // conversations with different people.
    const lapsed = mobilisationPosition(as('pm'), '2027-06-01').systems[0]!.gates.find((gate) => gate.id === 'G0')!;
    const item = lapsed.evidence.find((entry) => entry.itemId === 'insurance')!;
    assert.equal(item.satisfied, false);
    assert.equal(item.expired, true);
    assert.match(item.detail, /expired 2027-03-31/);
  });

  it('warns before it lapses rather than after', () => {
    const systemId = composedWelfare();
    attestEvidence(as('pm'), {
      systemId,
      gate: 'G0',
      itemId: 'insurance',
      reference: 'ZUR-114/2026',
      expiresAt: '2027-03-31',
    });
    const soon = mobilisationPosition(as('pm'), '2027-03-10').expiringSoon;
    assert.equal(soon.length, 1);
    assert.equal(soon[0]!.reference, 'ZUR-114/2026');
    // Not in the window three months out.
    assert.equal(mobilisationPosition(as('pm'), '2026-12-01').expiringSoon.length, 0);
  });

  it('supersedes rather than duplicating when it is renewed', () => {
    const systemId = composedWelfare();
    attestEvidence(as('pm'), {
      systemId,
      gate: 'G0',
      itemId: 'insurance',
      reference: 'ZUR-114/2026',
      expiresAt: '2027-03-31',
    });
    attestEvidence(as('pm'), {
      systemId,
      gate: 'G0',
      itemId: 'insurance',
      reference: 'ZUR-882/2027',
      expiresAt: '2028-03-31',
    });
    const item = mobilisationPosition(as('pm'), '2027-06-01').systems[0]!.gates
      .find((gate) => gate.id === 'G0')!
      .evidence.find((entry) => entry.itemId === 'insurance')!;
    // One answer, and it is the renewed certificate. Two live records would
    // leave "is this satisfied" with two answers.
    assert.equal(item.reference, 'ZUR-882/2027');
    assert.equal(item.satisfied, true);
  });

  it('cannot be attested against a derived item', () => {
    // An interface matrix with three open interfaces is not closed because
    // somebody typed a certificate number against it.
    const systemId = composedWelfare(false);
    const error = throwsCode(
      () => attestEvidence(as('pm'), { systemId, gate: 'G1', itemId: 'interfaceMatrix', reference: 'Confirmed' }),
      'MOBILISATION_EVIDENCE_DERIVED',
    );
    assert.match(String(error.message), /derived from the platform's own records/);
  });

  it('refuses an item the gate does not ask for on this family', () => {
    const systemId = composedWelfare();
    throwsCode(
      () => attestEvidence(as('pm'), { systemId, gate: 'G2', itemId: 'fat', reference: 'FAT-01' }),
      'MOBILISATION_EVIDENCE_UNKNOWN',
    );
  });

  it('reopens the gate it satisfied when it is withdrawn', () => {
    const systemId = composedWelfare();
    satisfy(systemId, 'G0');
    const before = mobilisationPosition(as('pm')).systems[0]!.gates.find((gate) => gate.id === 'G0')!;
    assert.equal(before.status, 'AWAITING_APPROVAL');

    const evidence = platform.ledger
      .list(seed.projectId, 'GateEvidence')
      .map((record) => record.state as unknown as { id: string; itemId: string })
      .find((entry) => entry.itemId === 'executedContract')!;
    withdrawEvidence(as('pm'), { evidenceId: evidence.id, reason: 'Signed by the wrong entity; re-executing' });

    const after = mobilisationPosition(as('pm')).systems[0]!.gates.find((gate) => gate.id === 'G0')!;
    assert.equal(after.status, 'EVIDENCE_OUTSTANDING');
  });

  it('is withdrawn once, however many times it is withdrawn', () => {
    // Withdrawal is an act, and the second call is the same act being repeated
    // — a retried request, a double-clicked button. Writing a second withdrawal
    // would put two reasons on one piece of evidence and leave the register
    // unable to say which one it was actually withdrawn for.
    const systemId = composedWelfare();
    satisfy(systemId, 'G0');
    const evidence = platform.ledger
      .list(seed.projectId, 'GateEvidence')
      .map((record) => record.state as unknown as { id: string; itemId: string })
      .find((entry) => entry.itemId === 'executedContract')!;

    const first = withdrawEvidence(as('pm'), { evidenceId: evidence.id, reason: 'Signed by the wrong entity' });
    const again = withdrawEvidence(as('pm'), { evidenceId: evidence.id, reason: 'Withdrawn again by mistake' });
    assert.equal(again.withdrawnAt, first.withdrawnAt);
    assert.equal(again.withdrawnReason, 'Signed by the wrong entity');

    const withdrawals = platform.ledger
      .events({ projectId: seed.projectId })
      .filter((event) => event.eventType === 'MOBILISATION_EVIDENCE_WITHDRAWN');
    assert.equal(withdrawals.length, 1);
  });
});

describe('what the platform derives rather than asking about', () => {
  it('closes the interface item only when every interface is accepted', () => {
    const open = composedWelfare(false);
    const item = () =>
      mobilisationPosition(as('pm'))
        .systems.find((system) => system.systemId === open)!
        .gates.find((gate) => gate.id === 'G1')!
        .evidence.find((entry) => entry.itemId === 'interfaceMatrix')!;
    assert.equal(item().satisfied, false);
    assert.match(item().detail, /still open/);

    seed.projectId = `${seed.users.pm!.auth.tenantId}-${Math.random().toString(36).slice(2, 10)}`;
    composedWelfare(true);
    const closed = mobilisationPosition(as('pm')).systems[0]!.gates
      .find((gate) => gate.id === 'G1')!
      .evidence.find((entry) => entry.itemId === 'interfaceMatrix')!;
    assert.equal(closed.satisfied, true);
    assert.match(closed.detail, /All \d+ interfaces accepted/);
  });

  it('names the appointment the contracting party comes from', () => {
    const systemId = composedWelfare();
    const item = mobilisationPosition(as('pm'))
      .systems.find((system) => system.systemId === systemId)!
      .gates.find((gate) => gate.id === 'G0')!
      .evidence.find((entry) => entry.itemId === 'contractingParty')!;
    assert.equal(item.satisfied, true);
    assert.match(item.detail, /Meridian Infrastructure Group Ltd/);
    assert.match(item.detail, /ETABLIX may instruct the supplier directly/);
  });

  it('blocks site readiness on utilities that are not composed', () => {
    // A welfare block is not "site ready" because a generator is on order.
    const systemId = composedWelfare();
    const item = mobilisationPosition(as('pm'))
      .systems.find((system) => system.systemId === systemId)!
      .gates.find((gate) => gate.id === 'G3')!
      .evidence.find((entry) => entry.itemId === 'utilities')!;
    assert.equal(item.satisfied, false);
    assert.match(item.detail, /No temporary MEP system is composed for Main compound/);
  });

  it('is not satisfied by a temporary MEP system whose own interfaces are open', () => {
    // The near miss the first version of this got wrong: the generator being
    // *composed* is not the same as the supply being there. A temporary MEP
    // system with an unaccepted ground or consent interface is a plan, and
    // releasing an area to plant on the strength of a plan is the failure the
    // gate exists to prevent.
    const systemId = composedWelfare();
    composeSystem(as('pm'), { family: 'TEMPORARY_MEP', zone: 'Main compound', ...WINDOW });

    const stillOpen = mobilisationPosition(as('pm'))
      .systems.find((system) => system.systemId === systemId)!
      .gates.find((gate) => gate.id === 'G3')!
      .evidence.find((entry) => entry.itemId === 'utilities')!;
    assert.equal(stillOpen.satisfied, false);
    assert.match(stillOpen.detail, /still has \d+ interfaces open/);

    for (const entry of platform.ledger
      .list(seed.projectId, 'ServiceInterface')
      .map((record) => record.state as unknown as { id: string; systemId: string; name: string })
      .filter((entry) => entry.systemId !== systemId)) {
      assignInterface(as('pm'), { interfaceId: entry.id, owner: 'Ruth Adeyemi', dueDate: '2026-10-15' });
      acceptInterface(as('pm'), { interfaceId: entry.id, note: `${entry.name} agreed` });
    }

    const closed = mobilisationPosition(as('pm'))
      .systems.find((system) => system.systemId === systemId)!
      .gates.find((gate) => gate.id === 'G3')!
      .evidence.find((entry) => entry.itemId === 'utilities')!;
    assert.equal(closed.satisfied, true);
    assert.match(closed.detail, /interfaces closed/);
  });

  it('fails closed on a derived item nothing derives', () => {
    // The guard that matters when this file is next edited. A gate item
    // declared `DERIVED` with no rule behind it would otherwise pass silently
    // for ever — which is worse than an attested item nobody filled in,
    // because nothing on any screen would ever say it was missing.
    const systemId = composedWelfare();
    const system = platform.ledger
      .list(seed.projectId, 'ServiceSystem')
      .map((record) => record.state as unknown as Parameters<typeof deriveEvidence>[1])
      .find((entry) => (entry as { id: string }).id === systemId)!;

    const result = deriveEvidence(as('pm'), system, 'somethingNobodyWroteARuleFor');
    assert.equal(result.satisfied, false);
    assert.match(result.detail, /declared derived and nothing derives it/);
  });
});

describe('passing a gate', () => {
  it('refuses while a prior gate has not passed', () => {
    const systemId = composedWelfare();
    satisfy(systemId, 'G1');
    const error = throwsCode(
      () => approveGate(as('designer'), { systemId, gate: 'G1', note: 'Design accepted' }),
      'MOBILISATION_GATE_BLOCKED',
    );
    assert.match(String(error.message), /G0 ha(s|ve) not passed/);
    assert.match(String(error.message), /dependency network, not a percentage/);
  });

  it('refuses while evidence is outstanding, and names what', () => {
    const systemId = composedWelfare();
    attestEvidence(as('pm'), { systemId, gate: 'G0', itemId: 'executedContract', reference: 'PO-4471' });
    const error = throwsCode(
      () => approveGate(as('commercial'), { systemId, gate: 'G0', note: 'Contract in place' }),
      'MOBILISATION_EVIDENCE_OUTSTANDING',
    );
    assert.match(String(error.message), /evidence items outstanding/);
    assert.match(String(error.message), /Insurance in place/);
  });

  it('refuses a role the gate does not name, however senior', () => {
    // The point of the test is that holding the capability is not enough, so
    // the refused user must hold it: the project manager may approve plenty in
    // site services, and may not pass the contract gate.
    const systemId = composedWelfare();
    satisfy(systemId, 'G0');
    assert.ok(seed.users.pm!.auth.scopes.includes('siteservices:write'));
    const error = throwsCode(
      () => approveGate(as('pm'), { systemId, gate: 'G0', note: 'Looks fine' }),
      'MOBILISATION_ROLE_REQUIRED',
    );
    assert.match(String(error.message), /approved by COMMERCIAL_MANAGER, PROJECT_DIRECTOR/);
  });

  it('says a safety-critical gate fails closed, in the refusal', () => {
    // The FM accepts the service into operation at G6. The FM does not energise
    // it — that is a competent person's act, and the refusal says so.
    const systemId = composedWelfare();
    const error = throwsCode(
      () => approveGate(as('fm'), { systemId, gate: 'G5', note: 'Tested' }),
      'MOBILISATION_ROLE_REQUIRED',
    );
    assert.match(String(error.message), /safety-critical hold point and it fails closed/);
    assert.match(String(error.message), /competent person’s act, not a manager’s/);
  });

  it('refuses an approval with nothing behind it', () => {
    const systemId = composedWelfare();
    satisfy(systemId, 'G0');
    throwsCode(
      () => approveGate(as('commercial'), { systemId, gate: 'G0', note: '' }),
      'MOBILISATION_APPROVAL_UNEVIDENCED',
    );
  });

  it('passes when the evidence is there and the role is right, and records who', () => {
    const systemId = composedWelfare();
    satisfy(systemId, 'G0');
    const approval = approveGate(as('commercial'), {
      systemId,
      gate: 'G0',
      note: 'PO-4471 executed by Meridian Infrastructure Group Ltd; insurance and payment route verified',
    });
    assert.equal(approval.gate, 'G0');
    // The roles held at the moment of approval, snapshotted like every other
    // authority on this platform.
    assert.ok(approval.roleAtApproval.includes('COMMERCIAL_MANAGER'));

    const position = mobilisationPosition(as('pm')).systems[0]!;
    assert.equal(position.gates.find((gate) => gate.id === 'G0')!.status, 'PASSED');
    assert.equal(position.atGate, 'G1');
    // And G1 is no longer blocked.
    assert.equal(position.gates.find((gate) => gate.id === 'G1')!.blockedBy.length, 0);
  });

  it('runs the whole network to a Mobilisation Acceptance', () => {
    const systemId = composedWelfare();
    // The temporary MEP for the same zone, so the utilities item can derive.
    composeSystem(as('pm'), { family: 'TEMPORARY_MEP', zone: 'Main compound', ...WINDOW });
    const mep = platform.ledger
      .list(seed.projectId, 'ServiceInterface')
      .map((record) => record.state as unknown as { id: string; systemId: string; name: string })
      .filter((entry) => entry.systemId !== systemId);
    for (const entry of mep) {
      assignInterface(as('pm'), { interfaceId: entry.id, owner: 'Ruth Adeyemi', dueDate: '2026-10-15' });
      acceptInterface(as('pm'), { interfaceId: entry.id, note: `${entry.name} agreed` });
    }

    for (const gate of GATES) {
      satisfy(systemId, gate.id);
      approveGate(as(APPROVER[gate.id]), {
        systemId,
        gate: gate.id,
        note: `${gate.name} verified against the evidence on the record`,
      });
    }

    const position = mobilisationPosition(as('pm')).systems.find((system) => system.systemId === systemId)!;
    assert.equal(position.accepted, true);
    assert.equal(position.evidencePercent, 100);
    // The acceptance has its own event code, because "which packages are
    // accepted" should be a query rather than a filter over approvals.
    const accepted = platform.ledger
      .events({ projectId: seed.projectId })
      .filter((event) => event.eventType === 'MOBILISATION_ACCEPTED');
    assert.equal(accepted.length, 1);
  });

  it('is idempotent on a gate already passed', () => {
    const systemId = composedWelfare();
    satisfy(systemId, 'G0');
    const first = approveGate(as('commercial'), { systemId, gate: 'G0', note: 'Verified' });
    const again = approveGate(as('commercial'), { systemId, gate: 'G0', note: 'Verified again' });
    assert.equal(first.id, again.id);
  });

  it('is refused to a tenancy without the module', () => {
    const systemId = composedWelfare();
    const ungranted = { ...as('pm'), grantedModules: [] };
    throwsCode(() => mobilisationPosition(ungranted), 'MODULE_NOT_GRANTED');
    throwsCode(() => declareProgress(ungranted, { systemId, percent: 50, note: 'Half way' }), 'MODULE_NOT_GRANTED');
  });
});
