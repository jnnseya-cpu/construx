import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { pendingProposals } from '../src/agents/runtime.ts';
import { AGENTS } from '../src/agents/registry.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Whose decision is it?
 *
 * The queue was every open proposal, every role, one list. That is four command
 * centres sharing a panel that answers "what needs action today" with somebody
 * else's work, and a QS scrolling past four design proposals to reach the
 * variation is a QS who stops opening the panel.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const asRole = (role: string) =>
  platform.context({ ...seed.users.pm!.auth, roles: [role] as never }, seed.projectId, { source: 'WEB' });

describe('ownership on the queue', () => {
  it('marks an item mine only where a role I hold may approve it', () => {
    // Read from the raising agent's own mandate. Nothing new is asserted and no
    // capability is granted — approval is still checked at approval.
    for (const proposal of pendingProposals(asRole('QS'))) {
      const mandate = AGENTS.find((a) => a.name === proposal.agent)?.mandate;
      assert.equal(
        proposal.mine,
        (mandate?.approvers ?? []).includes('QS' as never),
        `${proposal.agent} ownership disagrees with its mandate`,
      );
    }
  });

  it('names who decides an item that is not mine', () => {
    // "Not yours" with no name is as unactionable as no marking at all.
    for (const proposal of pendingProposals(asRole('QS'))) {
      if (!proposal.mine) assert.ok(proposal.approvers.length > 0, 'an item nobody is named for');
    }
  });

  it('puts my items first, ahead of somebody else’s urgent one', () => {
    // Severity ahead of ownership is the ordering that made the panel unusable:
    // another role's URGENT item sat above the reader's own overdue one.
    const queue = pendingProposals(asRole('QS'));
    let seenTheirs = false;
    for (const proposal of queue) {
      if (!proposal.mine) seenTheirs = true;
      else assert.ok(!seenTheirs, 'an item of mine appears after one that is not');
    }
  });

  it('still orders by severity inside each half', () => {
    const order = { URGENT: 0, ATTENTION: 1, INFO: 2 } as const;
    const queue = pendingProposals(asRole('PM'));
    for (const half of [queue.filter((p) => p.mine), queue.filter((p) => !p.mine)]) {
      for (let i = 1; i < half.length; i += 1) {
        assert.ok(
          order[half[i - 1]!.finding.severity] <= order[half[i]!.finding.severity],
          'severity ordering was lost inside a half',
        );
      }
    }
  });

  it('hides nothing — the same items, differently ordered, for every role', () => {
    // A queue that filtered would make a stalled item invisible to everyone
    // except the person already not acting on it.
    const asQs = new Set(pendingProposals(asRole('QS')).map((p) => p.id));
    const asPm = new Set(pendingProposals(asRole('PM')).map((p) => p.id));
    assert.deepEqual([...asQs].sort(), [...asPm].sort(), 'the queue was filtered by role rather than ordered');
  });

  it('marks nothing as mine for a role no agent names as an approver', () => {
    const supervisor = pendingProposals(asRole('SUPERVISOR'));
    for (const proposal of supervisor) {
      if (proposal.mine) {
        const mandate = AGENTS.find((a) => a.name === proposal.agent)?.mandate;
        assert.ok(
          (mandate?.approvers ?? []).includes('SUPERVISOR' as never),
          'an item was marked as a supervisor’s where no mandate names them',
        );
      }
    }
  });
});
