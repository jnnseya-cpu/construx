import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { ROUTES } from '../src/api/routes.ts';
import * as approvals from '../src/domain/contracts/approvals.ts';
import * as studio from '../src/domain/contracts/drafts.ts';
import { studioOverview } from '../src/domain/contracts/overview.ts';
import * as pack from '../src/domain/contracts/pack.ts';
import { scheduleFor } from '../src/domain/contracts/schedules.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { issueTokens, verifyToken, type AuthContext } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Contracts Studio, stage 3: review against the hash of one revision, by two
 * different people neither of whom put it up; the completion pack, issued only
 * from what was approved and under the identity frozen then; and execution,
 * recorded from the signed instrument into the contract register.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;
let commercial: AuthContext;
const as = (who: string): EngineContext => platform.context(seed.users[who]!.auth, seed.projectId, { source: 'WEB' });
const asCommercial = (): EngineContext => platform.context(commercial, seed.projectId, { source: 'WEB' });
const refused = (fn: () => unknown, code: string) => assert.throws(fn, (error: { code?: string }) => error.code === code, `expected ${code}`);
const names = () => '—';
const brand = () => platform.exports.brandingIfConfigured(seed.tenantId, seed.projectId)?.profileVersion ?? null;

/** Every required particular of a form, completed, with the given ones as stated. */
function complete(ctx: EngineContext, draft: studio.ContractDraft, given: Record<string, string>): studio.ContractDraft {
  const values: Record<string, string> = {};
  for (const field of scheduleFor(draft.formKey).fields.filter((entry) => entry.required)) {
    values[field.key] =
      field.type === 'MONEY' ? '1,000,000' : field.type === 'PERCENT' ? '3' : field.type === 'DURATION' ? '12 months' : field.type === 'DATE' ? (field.key.includes('completion') ? '2028-06-30' : '2027-03-01') : field.type === 'CHOICE' ? field.options![0]!.value : field.type === 'REFERENCE' ? `${field.key.toUpperCase()} rev A` : `Stated ${field.label}`;
  }
  let current = draft;
  for (const [key, value] of Object.entries({ ...values, ...given })) current = studio.setField(ctx, draft.id, { key, value, expectedRevision: current.revision });
  return current;
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({ moduleId: 'CONTRACTS_STUDIO', tenantId: seed.tenantId, status: 'ACTIVE', reason: 'Contracts approvals test', decidedBy: seed.users.operator!.id });
  const manager = platform.createUser({ tenantId: seed.tenantId, name: 'Comfort Adeyemi', email: 'commercial@meridian.example', roles: ['COMMERCIAL_MANAGER'] });
  commercial = verifyToken(issueTokens({ actorId: manager.id, tenantId: seed.tenantId, roles: manager.roles, mfaSatisfied: true }).accessToken);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

describe('review and approval', () => {
  let db: studio.ContractDraft;

  it('goes to review only with nothing blocking, fixed by the hash of that revision', () => {
    db = studio.createDraft(as('qs'), { formKey: 'jct:2024:db', confirmEdition: '2024', title: 'Main contract — depot refurbishment' });
    refused(() => approvals.submitForReview(as('qs'), db.id, { expectedRevision: 1 }), 'CONTRACT_DRAFT_BLOCKED');
    db = complete(as('qs'), db, { sectional_completion: 'NO', contract_sum: '1,250,000', liquidated_damages: '7,000', liquidated_damages_per: 'WEEK', delay_damages_cap_percent: '10', retention_percent: '3', rectification_period: '12 months', employer_legal_name: 'Riverbank District Council', contractor_legal_name: 'Meridian Infrastructure Group Ltd' });
    const submitted = approvals.submitForReview(as('qs'), db.id, { expectedRevision: db.revision });
    assert.equal(submitted.status, 'IN_REVIEW');
    assert.equal(submitted.review!.hash, approvals.revisionHash(submitted));
    assert.equal(submitted.review!.legalRequired, false);
    refused(() => studio.setField(as('qs'), db.id, { key: 'contract_sum', value: '1,300,000', expectedRevision: submitted.revision }), 'CONTRACT_DRAFT_STATE');
    db = submitted;
  });

  it('is approved against the hash shown, by somebody who holds the authority and did not put it up', () => {
    refused(() => approvals.approveDraft(as('qs'), db.id, { scope: 'COMMERCIAL', revisionHash: db.review!.hash, note: 'Checked' }, brand()), 'ACCESS_DENIED');
    refused(() => approvals.approveDraft(as('owner'), db.id, { scope: 'COMMERCIAL', revisionHash: 'sha256:' + '0'.repeat(64), note: 'Checked' }, brand()), 'CONTRACT_APPROVAL_STALE');
    refused(() => approvals.approveDraft(as('owner'), db.id, { scope: 'LEGAL', revisionHash: db.review!.hash, note: 'Checked' }, brand()), 'CONTRACT_LEGAL_NOT_REQUIRED');
    db = approvals.approveDraft(asCommercial(), db.id, { scope: 'COMMERCIAL', revisionHash: db.review!.hash, note: 'Sum, damages and retention checked against the tender' }, brand());
    assert.equal(db.status, 'APPROVED', 'no legal review needed: commercial approval completes it');
    assert.equal(db.review!.brandVersion, brand());
  });

  it('issues the pack only from what was approved, under the identity frozen then', async () => {
    const issued = pack.issuableDraft(as('pm'), db.id, brand());
    const document = pack.packDocument(issued, names);
    const text = JSON.stringify(document.blocks);
    assert.match(text, /Completion report/);
    assert.match(text, /GBP 1,250,000.00/);
    assert.match(text, /Riverbank District Council/);
    assert.match(text, /not the publisher’s form/);
    assert.match(text, new RegExp(db.review!.hash));
    refused(() => pack.issuableDraft(as('pm'), db.id, (brand() ?? 0) + 1), 'CONTRACT_BRAND_CHANGED');
    const owner = platform.users(seed.tenantId).find((user) => user.id === seed.users.owner!.id)!;
    const token = issueTokens({ actorId: owner.id, tenantId: owner.tenantId, partyId: owner.partyId, roles: owner.roles, mfaSatisfied: true }).accessToken;
    const response = await fetch(`${base}/v1/projects/${seed.projectId}/contract-studio/drafts/${db.id}/pack.pdf`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ format: 'PDF' }) });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
  });

  it('is reopened to change, voiding its approvals, and an approval of the old hash is refused', () => {
    const reopened = approvals.reopenDraft(as('qs'), db.id, { reason: 'Client asked for 5% retention' });
    assert.equal(reopened.status, 'DRAFTING');
    assert.equal(reopened.pastReviews!.at(-1)!.ended.how, 'REOPENED');
    refused(() => pack.issuableDraft(as('pm'), db.id, brand()), 'CONTRACT_PACK_NOT_APPROVED');
    const oldHash = db.review!.hash;
    const changed = studio.setField(as('qs'), db.id, { key: 'retention_percent', value: '5', expectedRevision: reopened.revision });
    const resubmitted = approvals.submitForReview(as('qs'), db.id, { expectedRevision: changed.revision });
    assert.notEqual(resubmitted.review!.hash, oldHash);
    refused(() => approvals.approveDraft(asCommercial(), db.id, { scope: 'COMMERCIAL', revisionHash: oldHash, note: 'Approved before' }, brand()), 'CONTRACT_APPROVAL_STALE');
    const returned = approvals.returnDraft(asCommercial(), db.id, { note: 'Retention to be agreed first' });
    assert.equal(returned.status, 'DRAFTING');
    db = approvals.approveDraft(asCommercial(), db.id, { scope: 'COMMERCIAL', revisionHash: approvals.submitForReview(as('qs'), db.id, { expectedRevision: returned.revision }).review!.hash, note: 'Retention at 5% agreed' }, brand());
    assert.equal(db.status, 'APPROVED');
  });

  it('needs a legal approval by a second person where the form is amended', () => {
    let ecc = studio.createDraft(as('qs'), { formKey: 'nec:nec4-jan-2023-revision:ecc', confirmEdition: 'NEC4: Jan 2023 revision', title: 'Trunk main — NEC4 ECC' });
    ecc = complete(as('qs'), ecc, { main_option: 'A', pricing_document_kind: 'ACTIVITY_SCHEDULE', pricing_document_reference: 'Activity schedule rev B', z_clauses_reference: 'Z clauses rev 2', client_legal_name: 'Ashworth Water Authority', contractor_legal_name: 'Meridian Infrastructure Group Ltd', completion_date: '2028-06-30' });
    const submitted = approvals.submitForReview(as('qs'), ecc.id, { expectedRevision: ecc.revision });
    assert.equal(submitted.review!.legalRequired, true);
    assert.match(submitted.review!.legalReasons.join(' '), /Z clauses/);
    const after = approvals.approveDraft(as('owner'), ecc.id, { scope: 'COMMERCIAL', revisionHash: submitted.review!.hash, note: 'Prices and activity schedule checked' }, brand());
    assert.equal(after.status, 'IN_REVIEW', 'still waiting for legal');
    refused(() => approvals.approveDraft(as('owner'), ecc.id, { scope: 'LEGAL', revisionHash: submitted.review!.hash, note: 'Z clauses read' }, brand()), 'CONTRACT_APPROVAL_SAME_PERSON');
    const approved = approvals.approveDraft(asCommercial(), ecc.id, { scope: 'LEGAL', revisionHash: submitted.review!.hash, note: 'Z clauses reviewed against the appetite' }, brand());
    assert.equal(approved.status, 'APPROVED');
    const own = studio.createDraft(as('owner'), { formKey: 'jct:2024:mw', confirmEdition: '2024', title: 'Minor works' });
    const ownDone = complete(as('owner'), own, {});
    const ownReview = approvals.submitForReview(as('owner'), own.id, { expectedRevision: ownDone.revision });
    refused(() => approvals.approveDraft(as('owner'), own.id, { scope: 'COMMERCIAL', revisionHash: ownReview.review!.hash, note: 'Mine' }, brand()), 'CONTRACT_APPROVAL_SAME_PERSON');
  });
});

describe('execution', () => {
  it('records the signed instrument and executes the contract in the register from the approved particulars', () => {
    const db = studio.drafts(as('pm')).find((draft) => draft.formKey === 'jct:2024:db')!;
    refused(() => approvals.recordExecution(asCommercial(), db.id, { signedDocumentHash: 'c'.repeat(64), signatureMethod: 'Deed, wet ink', executedOn: '2026-11-20' }), 'ACCESS_DENIED');
    refused(() => approvals.recordExecution(as('owner'), db.id, { signedDocumentHash: 'c'.repeat(64), signatureMethod: 'Deed, wet ink', executedOn: '2099-01-01' }), 'CONTRACT_EXECUTED_ON');
    refused(() => approvals.recordExecution(as('owner'), db.id, { signedDocumentHash: 'not a hash', signatureMethod: 'Deed, wet ink', executedOn: '2026-11-20' }), 'CONTRACT_SIGNED_DOCUMENT');
    const executed = approvals.recordExecution(as('owner'), db.id, { signedDocumentHash: 'c'.repeat(64), signatureMethod: 'Deed, wet ink', executedOn: '2026-11-20' });
    assert.equal(executed.status, 'EXECUTED');
    const contract = platform.ledger.get({ refType: 'Contract', refId: executed.executed!.contractId })!.state;
    assert.equal(contract.status, 'EXECUTED');
    assert.equal(contract.suite, 'JCT');
    assert.equal(contract.contractSumMinor, 125_000_000);
    assert.equal(contract.liquidatedDamagesPerDayMinor, 100_000, '£7,000 a week is £1,000 a day');
    assert.equal(contract.ldCapPercent, 10);
    assert.equal(contract.retentionPercent, 5);
    assert.equal(contract.defectsLiabilityMonths, 12);
    assert.equal(contract.commencementDate, '2027-03-01');
    refused(() => approvals.recordExecution(as('owner'), db.id, { signedDocumentHash: 'c'.repeat(64), signatureMethod: 'Again', executedOn: '2026-11-20' }), 'CONTRACT_DRAFT_STATE');
    assert.ok(pack.issuableDraft(as('pm'), db.id, brand()), 'an executed draft’s pack can still be issued');
  });

  it('says what the register still needs, rather than inventing it', () => {
    const fidic = studio.createDraft(as('qs'), { formKey: 'fidic:2017-2022-reprint:yellow', confirmEdition: '2017: 2022 reprint', title: 'Substation EPC' });
    const done = complete(as('qs'), fidic, {});
    assert.deepEqual(approvals.contractTerms(done).missing, ['the start, possession or commencement date', 'the completion date']);
    const view = studioOverview(as('pm'), names).drafts.find((draft) => draft.id === fidic.id)!;
    assert.equal(view.handoffMissing.length, 2);
    assert.match(view.legalReasons.join(' '), /FIDIC/);
  });

  it('publishes every route', () => {
    const paths = new Set(ROUTES.map((route) => `${route.method} ${route.pattern}`));
    for (const suffix of ['submit', 'approve', 'return', 'reopen', 'execute', 'pack.pdf']) {
      assert.ok(paths.has(`POST /v1/projects/:projectId/contract-studio/drafts/:draftId/${suffix}`), suffix);
    }
  });
});
