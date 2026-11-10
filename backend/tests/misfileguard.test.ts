import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EngineContext } from '../src/engines/context.ts';
import { assertInvitationPlacement, assertProjectPlacement, assessAgainstBuyer } from '../src/domain/misfileguard.ts';

/**
 * The project misfile guard stops a tender document being recorded against the
 * wrong project — the North-Lincolnshire-ITT-into-a-Telford-project trap. The pure
 * `assessAgainstBuyer` carries the decision; the integration cases prove the ctx
 * wrapper reads the project's buyer and siblings and refuses a clear misfile.
 */

describe('assessAgainstBuyer (the decision)', () => {
  it('CONFLICT when the stated buyer shares no word with the project buyer', () => {
    const a = assessAgainstBuyer({ projectClient: 'Telford and Wrekin Council', statedClient: 'North Lincolnshire Council', text: 'Highways framework ITT' });
    assert.equal(a.verdict, 'CONFLICT', a.reason);
    assert.equal(a.likelyBelongsTo?.client, 'North Lincolnshire Council');
  });

  it('OK when the stated buyer is the project buyer (shared distinctive word)', () => {
    assert.equal(assessAgainstBuyer({ projectClient: 'Telford and Wrekin Council', statedClient: 'Telford & Wrekin Council', text: 'x' }).verdict, 'OK');
  });

  it('does not conflict on a generic word alone (both are councils)', () => {
    // "City of A Council" vs "B Council" share only the dropped generic "council" →
    // disjoint distinctive words → CONFLICT is correct; the generic word is not a match.
    const a = assessAgainstBuyer({ projectClient: 'Manchester City Council', statedClient: 'Leeds City Council', text: 'y' });
    assert.equal(a.verdict, 'CONFLICT');
  });

  it('CONFLICT by content cross-match when the project has no stated buyer', () => {
    const a = assessAgainstBuyer({
      statedClient: undefined,
      text: 'North Lincolnshire Council Doncaster Scunthorpe rail feasibility, a substantial document body repeated to pass the length threshold for assessment so the content signal is actually considered rather than skipped as too short.',
      siblings: [{ reference: 'P-NL', client: 'North Lincolnshire Council', location: 'Scunthorpe' }, { client: 'Telford and Wrekin Council' }],
    });
    assert.equal(a.verdict, 'CONFLICT', a.reason);
  });

  it('OK when there is nothing to compare against', () => {
    assert.equal(assessAgainstBuyer({ statedClient: 'Anyone', text: 'short' }).verdict, 'OK');
  });
});

// A minimal stub ledger so the wrapper's reads and refusal are exercised deterministically.
function ctxWith(projects: Array<{ id: string; client?: string; name?: string; status?: string }>, opportunities: Array<{ projectId?: string; clientName?: string; title?: string }> = []): EngineContext {
  const projectRecords = projects.map((p) => ({ tenantId: 'T1', state: { ...p } }));
  return {
    projectId: 'P1',
    tenantId: 'T1',
    ledger: {
      get: ({ refId }: { refType: string; refId: string }) => projectRecords.find((r) => r.state.id === refId),
      listByTenant: (_t: string, type: string) =>
        type === 'Project' ? projectRecords : type === 'Opportunity' ? opportunities.map((o) => ({ tenantId: 'T1', state: o })) : [],
    },
  } as unknown as EngineContext;
}

describe('assertProjectPlacement (the guard)', () => {
  const projects = [
    { id: 'P1', client: 'Telford and Wrekin Council', name: 'Telford and Wrekin Council', status: 'TENDER' },
    { id: 'P2', client: 'North Lincolnshire Council', name: 'North Lincolnshire Council : Highways Framework', status: 'TENDER' },
  ];

  it('refuses an ITT whose buyer belongs to another project', () => {
    assert.throws(
      () => assertProjectPlacement(ctxWith(projects), { statedClient: 'North Lincolnshire Council', text: 'Highways framework pricing schedule' }),
      (e) => (e as { code?: string }).code === 'MISFILED_DOCUMENT',
    );
  });

  it('allows it with an explicit confirmPlacement override', () => {
    const a = assertProjectPlacement(ctxWith(projects), { statedClient: 'North Lincolnshire Council', text: 'Highways framework', confirmPlacement: true });
    assert.equal(a.verdict, 'CONFLICT');
  });

  it('allows an ITT whose buyer is this project', () => {
    assert.equal(assertProjectPlacement(ctxWith(projects), { statedClient: 'Telford and Wrekin Council', text: 'x' }).verdict, 'OK');
  });

  it('no-ops when the project has no established buyer and nothing matches', () => {
    const ctx = ctxWith([{ id: 'P1', name: 'Untitled', status: 'TENDER' }]);
    assert.equal(assertProjectPlacement(ctx, { statedClient: 'Someone Council', text: 'short note' }).verdict, 'OK');
  });

  it('reads the buyer from a linked opportunity when the project has no client field', () => {
    const ctx = ctxWith(
      [{ id: 'P1', name: 'Q4 pursuit', status: 'TENDER' }, { id: 'P2', client: 'North Lincolnshire Council', name: 'NL Highways' }],
      [{ projectId: 'P1', clientName: 'Telford and Wrekin Council', title: 'Telford pursuit' }],
    );
    assert.throws(
      () => assertProjectPlacement(ctx, { statedClient: 'North Lincolnshire Council', text: 'Highways framework' }),
      (e) => (e as { code?: string }).code === 'MISFILED_DOCUMENT',
    );
  });
});

// Stub ledger for the invitation-scoped guard.
function invCtx(invitations: Array<{ id: string; reference?: string; clientName?: string }>, opportunities: Array<{ title?: string; clientName?: string }> = []): EngineContext {
  const invRecords = invitations.map((i) => ({ tenantId: 'T1', state: { ...i } }));
  return {
    projectId: 'P1',
    tenantId: 'T1',
    ledger: {
      get: ({ refType, refId }: { refType: string; refId: string }) =>
        refType === 'TenderInvitation' ? invRecords.find((r) => r.state.id === refId) : undefined,
      listByTenant: (_t: string, type: string) =>
        type === 'TenderInvitation' ? invRecords : type === 'Opportunity' ? opportunities.map((o) => ({ tenantId: 'T1', state: o })) : [],
    },
  } as unknown as EngineContext;
}

describe('assertInvitationPlacement (the pipeline tender guard)', () => {
  const invitations = [
    { id: 'I1', reference: 'HF1', clientName: 'Telford and Wrekin Council' },
    { id: 'I2', reference: 'ITT-900', clientName: 'North Lincolnshire Council' },
  ];

  it('refuses an ITT whose buyer belongs to another tender', () => {
    assert.throws(
      () => assertInvitationPlacement(invCtx(invitations), 'I1', { statedClient: 'North Lincolnshire Council', text: 'Highways framework pricing schedule' }),
      (e) => (e as { code?: string }).code === 'MISFILED_DOCUMENT',
    );
  });

  it('allows it with confirmPlacement', () => {
    assert.equal(assertInvitationPlacement(invCtx(invitations), 'I1', { statedClient: 'North Lincolnshire Council', text: 'x', confirmPlacement: true }).verdict, 'CONFLICT');
  });

  it('allows an ITT whose buyer is this tender', () => {
    assert.equal(assertInvitationPlacement(invCtx(invitations), 'I1', { statedClient: 'Telford and Wrekin Council', text: 'x' }).verdict, 'OK');
  });

  it('no-ops for a missing/cross-tenant invitation so the downstream raises NOT_FOUND', () => {
    assert.equal(assertInvitationPlacement(invCtx(invitations), 'I-unknown', { statedClient: 'Anyone Council', text: 'short' }).verdict, 'OK');
  });
});
