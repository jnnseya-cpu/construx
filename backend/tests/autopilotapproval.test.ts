import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import * as agents from '../src/agents/runtime.ts';
import { createGateway } from '../src/api/gateway.ts';
import { ROUTES } from '../src/api/routes.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Approving an agent proposal, from the queue on the autopilot screen.
 *
 * Two things had to hold and one of them did not.
 *
 * **Every command the fleet raises must be runnable on approval.** The approve
 * route dispatches `proposal.command.command` through a hand-written table, and
 * two commands the fleet actually proposes — `cdm:draftToolboxTalk` and
 * `tenderintake:extractRequirements` — were missing from it. Approving one
 * wrote the approval to the ledger and then threw `No dispatcher` as a 500: the
 * proposal left APPROVED and never run, and the approver was shown a server
 * error for pressing a button the platform had offered them. That is exactly
 * the dead-end a client with no engineer beside them cannot get past, so it is
 * pinned here against the project phase that actually raises the proposal.
 *
 * **An approval that reaches an AI provider must disclose its cost and what it
 * sends, before it commits.** Four of the dispatchable commands call a provider
 * and spend from the wallet; the route that carries each is itself the AI route,
 * so the same `/v1/ai/quote` the console calls before a manual run prices the
 * approval and carries the §16.1 data-transmission disclosure. The autopilot
 * screen's map from command to engine path is what makes that possible, so each
 * entry is checked to be a real AI route and each route is quoted over HTTP to
 * prove the disclosure reaches the screen.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;
/** The seed's CONSTRUCTION-phase working project, where the field fleet runs. */
let projectId: string;

function tokenFor(who: string): string {
  const user = platform.user(seed.users[who]!.id);
  return issueTokens({
    actorId: user.id,
    tenantId: user.tenantId,
    partyId: user.partyId,
    roles: user.roles,
    mfaSatisfied: true,
  }).accessToken;
}

async function call(method: string, path: string, who: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokenFor(who)}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as any };
}

const ctx = (who: string) => platform.context(seed.users[who]!.auth, projectId);

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  const construction = seed.workingProjects.find((p) => p.phase === 'CONSTRUCTION');
  assert.ok(construction, 'the seed produced no CONSTRUCTION-phase project for the field fleet to run in');
  projectId = construction.projectId;

  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // Raise the queue. The field fleet is active in CONSTRUCTION, so this is where
  // `cdm:draftToolboxTalk` is proposed against the approved-but-unbriefed RAMS.
  await agents.runAgents(ctx('pm'));
});

after(() => server.close());

function proposalWithCommand(command: string): any {
  const found = agents.pendingProposals(ctx('pm')).find((p) => p.command?.command === command && p.status === 'OPEN');
  assert.ok(found, `the fleet raised no open ${command} proposal to approve`);
  return found;
}

describe('every command the fleet raises can be approved without a 500', () => {
  it('runs cdm:draftToolboxTalk on approval, where it used to reach No dispatcher', async () => {
    const proposal = proposalWithCommand('cdm:draftToolboxTalk');
    const ramsId = String(proposal.command.input.ramsId);
    const talksBefore = platform.ledger.list(projectId, 'ToolboxTalk').length;

    // The gate still has to hold. A QA/QC lead can read the RAMS but is not a
    // nominated approver for the field agent, so the answer is a clean 403 — and
    // crucially not a 500, and the refusal leaves the proposal open to decide.
    const denied = await call('POST', `/v1/projects/${projectId}/proposals/${proposal.id}/approve`, 'qaqc', {});
    assert.notEqual(denied.status, 500);
    assert.equal(denied.status, 403);

    // SAFETY is a nominated approver for this agent and holds SAFETY_RAMS:C,
    // which is the pair the approval gate requires.
    const approved = await call('POST', `/v1/projects/${projectId}/proposals/${proposal.id}/approve`, 'safety', {});

    assert.notEqual(approved.status, 500, `approval 500'd: ${JSON.stringify(approved.body).slice(0, 300)}`);
    assert.equal(approved.status, 201);
    assert.equal(approved.body.executed, true, 'the approval was recorded but the command never ran');
    assert.ok(approved.body.result?.talkId, 'the draft produced no toolbox talk');

    const talksAfter = platform.ledger.list(projectId, 'ToolboxTalk');
    assert.equal(talksAfter.length, talksBefore + 1, 'approval did not write the drafted talk');
    assert.equal(String(talksAfter.at(-1)!.state.ramsId), ramsId, 'the talk was drafted against the wrong method statement');
    assert.equal(talksAfter.at(-1)!.state.status, 'DRAFTED', 'a draft must not read as a talk that was given');
  });
});

// --- the §16.1 disclosure the autopilot screen shows before an AI approval ---

/**
 * The command→engine-path map the autopilot screen uses, read out of the page
 * source so the test fails if the two drift apart. Each value is the AI route
 * the approval would run, with `${projectId}` normalised to the `:projectId`
 * the route catalogue declares.
 */
function autopilotAiPaths(): Map<string, string> {
  const source = readFileSync(fileURLToPath(new URL('../../frontend/pages/autopilot.js', import.meta.url)), 'utf8');
  const block = source.match(/const AI_COMMAND_PATHS = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'AI_COMMAND_PATHS was not found in autopilot.js — the map moved or was removed');
  const map = new Map<string, string>();
  const entry = /'([^']+)':\s*\(projectId\)\s*=>\s*`([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = entry.exec(block[1]!)) !== null) {
    map.set(match[1]!, match[2]!.replace('${projectId}', ':projectId'));
  }
  assert.ok(map.size > 0, 'the map parsed to nothing');
  return map;
}

describe('an AI approval is priced and disclosed before it commits', () => {
  it('names only real AI routes, so the cost screen never meets NOT_AN_AI_ACTION', () => {
    for (const [command, pattern] of autopilotAiPaths()) {
      const route = ROUTES.find((r) => r.method === 'POST' && r.pattern === pattern);
      assert.ok(route, `${command} maps to ${pattern}, which is not a POST route`);
      assert.ok(route.ai, `${command} maps to ${pattern}, which does not reach an AI provider — quoting it would refuse`);
    }
  });

  it('covers the AI-reaching commands the approve route can dispatch', () => {
    // The dispatchable commands that call a provider. `safety:assessContingency`
    // is dispatchable but runs synchronously with no provider call, so it is not
    // here and must not be — there is nothing to quote and nothing transmitted.
    const expected = ['planning:forecastDelay', 'cost:publishCVR', 'claims:assessDelayClaim', 'handover:forecastMaintenance'];
    const keys = [...autopilotAiPaths().keys()].sort();
    assert.deepEqual(keys, [...expected].sort(), 'the screen quotes a different set of commands than it can approve to AI');
  });

  it('quotes each mapped path over HTTP and carries the §16.1 disclosure', async () => {
    for (const [command, pattern] of autopilotAiPaths()) {
      const path = pattern.replace(':projectId', projectId);
      const quote = await call('POST', '/v1/ai/quote', 'pm', { method: 'POST', path });

      assert.equal(quote.status, 200, `${command}: quote failed ${JSON.stringify(quote.body).slice(0, 200)}`);
      assert.ok(quote.body.estimatedChargeMinor > 0, `${command}: a run with no price`);
      assert.ok(quote.body.disclosure, `${command}: no disclosure for the approver to read`);
      assert.equal(typeof quote.body.disclosure.statement, 'string', `${command}: the disclosure says nothing`);
      assert.equal(typeof quote.body.disclosure.leavesPlatform, 'boolean', `${command}: silent on whether data leaves`);
    }
  });

  it('spends nothing by quoting — the price is shown, not charged', async () => {
    const before = platform.wallet(seed.tenantId).snapshot();
    for (const [, pattern] of autopilotAiPaths()) {
      await call('POST', '/v1/ai/quote', 'pm', { method: 'POST', path: pattern.replace(':projectId', projectId) });
    }
    const afterSnap = platform.wallet(seed.tenantId).snapshot();
    assert.equal(afterSnap.balanceMinor, before.balanceMinor, 'a quote moved the balance');
    assert.equal(afterSnap.heldMinor, before.heldMinor, 'a quote held funds');
  });
});
