import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { ulid } from '../src/core/ids.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { agentByName } from '../src/agents/registry.ts';
import { actBudget, grantEnvelope, mayActUnattended, projectAutonomousSpend, setActBudget } from '../src/agents/mandate.ts';

/**
 * The per-project cumulative cap on the aggregate value of unattended acts (spec §1 A2,
 * AT-22). The envelope's per-act ceiling already exists; this is the running-total ceiling
 * the per-act one cannot see. Today's ACT-eligible agents carry a declared value of zero
 * (an alert, a re-run), so this is the safety rail for a future value-bearing autonomous
 * act — exactly as the per-act ceiling is — and it is exercised here by seeding the
 * autonomous spend the running total is checked against.
 */

let platform: Platform;
let seed: SeedResult;
const as = (who: string) => platform.context(seed.users[who]!.auth, seed.projectId);
const window_ = () => ({
  from: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
  until: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
});

/** Seed one already-executed unattended act of the given value against an envelope. */
function seedExecutedAct(refId: string, valueMinor: number): void {
  const agentId = agentByName('health')!.agentId;
  const base = {
    tenantId: seed.users.admin!.auth.tenantId,
    projectId: seed.projectId,
    actor: { refType: 'AI' as const, refId: agentId },
    source: 'SYSTEM' as const,
    entity: { refType: 'AgentProposal' as const, refId },
  };
  platform.ledger.commit({ ...base, correlationId: ulid(), eventType: 'AGENT_PROPOSAL_RAISED', nextState: { status: 'OPEN', command: { command: 'ops:alert', valueMinor } } });
  platform.ledger.commit({ ...base, correlationId: ulid(), eventType: 'AGENT_ACT_EXECUTED', nextState: { status: 'EXECUTED', envelopeId: 'env-seed', command: { command: 'ops:alert', valueMinor } } });
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('setting and reading the cumulative act budget', () => {
  it('is governance-authorised, validated, and idempotent to read back', () => {
    assert.equal(actBudget(as('admin')), undefined); // none by default — no aggregate cap, as before
    const set = setActBudget(as('admin'), { cumulativeBudgetMinor: 500, note: 'Cap the aggregate value of unattended acts' });
    assert.equal(set.cumulativeBudgetMinor, 500);
    assert.equal(actBudget(as('admin'))!.cumulativeBudgetMinor, 500);

    assert.throws(() => setActBudget(as('admin'), { cumulativeBudgetMinor: -1, note: 'negative please' }), (e) => (e as { code?: string }).code === 'ACT_BUDGET_INVALID');
    assert.throws(() => setActBudget(as('admin'), { cumulativeBudgetMinor: 100, note: 'short' }), (e) => (e as { code?: string }).code === 'ACT_BUDGET_REASON_REQUIRED');
    // A tenant user without enterprise governance cannot set it.
    assert.throws(() => setActBudget(as('pm'), { cumulativeBudgetMinor: 100, note: 'I would like to cap this' }), (e) => (e as { code?: string }).code === 'ACCESS_DENIED');
  });
});

describe('the running total and the aggregate ceiling', () => {
  it('sums only executed unattended acts, and refuses the act that would pass the budget', () => {
    assert.equal(projectAutonomousSpend(as('admin')), 0);
    seedExecutedAct('p-1', 400);
    seedExecutedAct('p-2', 200);
    assert.equal(projectAutonomousSpend(as('admin')), 600); // 400 + 200

    grantEnvelope(as('admin'), { agent: 'health', commands: ['ops:alert'], ...window_(), note: 'Overnight alerts nobody is awake to approve' });

    // Budget 500, already-committed 600: a further act (even a value-0 one) is over the
    // aggregate ceiling and falls back to a proposal, though the per-act ceiling allows it.
    setActBudget(as('admin'), { cumulativeBudgetMinor: 500, note: 'Aggregate cap below what is already committed' });
    const refused = mayActUnattended(as('admin'), 'health', { command: 'ops:alert', valueMinor: 0 });
    assert.equal(refused.permitted, false);
    assert.match(refused.permitted === false ? refused.because : '', /cumulative budget/);

    // Raise the budget above the committed total and the same act is permitted again.
    setActBudget(as('admin'), { cumulativeBudgetMinor: 700, note: 'Raise the aggregate cap above committed spend' });
    assert.equal(mayActUnattended(as('admin'), 'health', { command: 'ops:alert', valueMinor: 0 }).permitted, true);
  });

  it('with no budget set, the aggregate ceiling does not bite (backward compatible)', async () => {
    const p = new Platform();
    const s = await seedDemoProject(p);
    const ctx = p.context(s.users.admin!.auth, s.projectId);
    p.ledger.commit({ tenantId: s.users.admin!.auth.tenantId, projectId: s.projectId, actor: { refType: 'AI', refId: agentByName('health')!.agentId }, source: 'SYSTEM', correlationId: ulid(), eventType: 'AGENT_PROPOSAL_RAISED', entity: { refType: 'AgentProposal', refId: 'p-x' }, nextState: { status: 'OPEN', command: { command: 'ops:alert', valueMinor: 9_999 } } });
    p.ledger.commit({ tenantId: s.users.admin!.auth.tenantId, projectId: s.projectId, actor: { refType: 'AI', refId: agentByName('health')!.agentId }, source: 'SYSTEM', correlationId: ulid(), eventType: 'AGENT_ACT_EXECUTED', entity: { refType: 'AgentProposal', refId: 'p-x' }, nextState: { status: 'EXECUTED', envelopeId: 'env-seed', command: { command: 'ops:alert', valueMinor: 9_999 } } });
    grantEnvelope(ctx, { agent: 'health', commands: ['ops:alert'], ...window_(), note: 'Overnight alerts nobody is awake to approve' });
    // No budget set → the large committed spend is irrelevant and the act is permitted.
    assert.equal(actBudget(ctx), undefined);
    assert.equal(mayActUnattended(ctx, 'health', { command: 'ops:alert', valueMinor: 0 }).permitted, true);
  });
});
