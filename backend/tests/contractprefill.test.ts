import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import { createGateway } from '../src/api/gateway.ts';
import { ROUTES } from '../src/api/routes.ts';
import { config } from '../src/config.ts';
import * as studio from '../src/domain/contracts/drafts.ts';
import { studioOverview } from '../src/domain/contracts/overview.ts';
import * as prefill from '../src/domain/contracts/prefill.ts';
import { registerEvidence, type EngineContext } from '../src/engines/context.ts';
import { ingestFile } from '../src/evidence/pipeline.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { docxOf, paragraph } from './fixtures/zip.ts';

/**
 * Contracts Studio, stage 2: the agent reads the project's own documents and
 * proposes particulars, each with its passage; the code drops what it cannot
 * stand behind, merges what agrees, shows what conflicts, and holds publisher
 * text back from the model. A person chooses every value.
 */

let platform: Platform;
let seed: SeedResult;
let store: EvidenceStore;
let directory: string;
let previousClearance: (typeof config.ai.providerClearance)[string] | undefined;
const requests: ProviderRequest[] = [];
const as = (who: string): EngineContext => platform.context(seed.users[who]!.auth, seed.projectId, { source: 'WEB' });
const refused = (fn: () => unknown, code: string) => assert.throws(fn, (error: { code?: string }) => error.code === code, `expected ${code}`);
const rejects = (fn: () => Promise<unknown>, code: string) => assert.rejects(fn, (error: { code?: string }) => error.code === code, `expected ${code}`);
const names = () => '—';

const ITT = [
  'Invitation to Tender — Depot refurbishment',
  'The Employer is Riverbank District Council, Civic Centre, Riverbank RB1 1AA.',
  'The Contract Sum shall not exceed £1,250,000 and the Date for Completion is 30 June 2028.',
  'Retention shall be at the rate stated in the Contract Particulars.',
];
const AWARD = [
  'Letter of award',
  'We accept your tender in the sum of 1.25m pounds sterling.',
  'The Date for Completion is revised to 30 September 2028.',
];
const FORM_COPY = ['JCT Design and Build Contract 2024 — conditions', '© The Joint Contracts Tribunal Limited 2024. All rights reserved.', 'Clause text the publisher owns.'];

const docs: Record<string, string> = {};

function answer(request: ProviderRequest): Record<string, unknown> {
  const sent = (request.payload as { documents: Array<{ id: string; name: string }> }).documents;
  const itt = sent.find((doc) => doc.name === 'ITT.docx')!.id;
  const award = sent.find((doc) => doc.name === 'Award.docx')!.id;
  return {
    proposals: [
      { fieldKey: 'employer_legal_name', value: 'Riverbank District Council', documentId: itt, locator: 'p.1, para 2', quote: 'The Employer is Riverbank District Council' },
      { fieldKey: 'contract_sum', value: '£1,250,000', documentId: itt, locator: 'p.1, para 3', quote: 'The Contract Sum shall not exceed £1,250,000' },
      { fieldKey: 'contract_sum', value: '1.25m', documentId: award, locator: 'para 2', quote: 'We accept your tender in the sum of 1.25m pounds sterling.' },
      { fieldKey: 'completion_date', value: '2028-06-30', documentId: itt, locator: 'p.1, para 3', quote: 'the Date for Completion is 30 June 2028' },
      { fieldKey: 'completion_date', value: '30/09/2028', documentId: award, locator: 'para 3', quote: 'The Date for Completion is revised to 30 September 2028.' },
      // One of each kind the code must drop:
      { fieldKey: 'employers_agent', value: 'Hollins Surveyors LLP', documentId: itt, locator: 'p.2', quote: 'The Employer’s Agent is Hollins Surveyors LLP' },
      { fieldKey: 'contract_price', value: '£1,250,000', documentId: itt, locator: 'p.1', quote: 'The Contract Sum shall not exceed £1,250,000' },
      { fieldKey: 'works_description', value: 'Depot refurbishment', documentId: 'someone-elses-file', locator: 'p.1', quote: 'Invitation to Tender — Depot refurbishment' },
      { fieldKey: 'retention_percent', value: 'TBC', documentId: itt, locator: 'p.1, para 4', quote: 'Retention shall be at the rate stated in the Contract Particulars.' },
    ],
    questions: ['Confirm whether sectional completion is intended.'],
  };
}

const stub: AIProviderAdapter = {
  name: 'OPENAI',
  capability: 'REASONING',
  multimodal: false,
  transmits: true,
  estimateCostMinor: () => 25,
  healthy: () => true,
  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    requests.push(request);
    return { provider: 'OPENAI', modelClass: 'reasoning-standard', output: answer(request), rawCostMinor: 25, latencyMs: 5, confidence: 0.8 };
  },
};

async function tenderDocument(name: string, lines: string[]): Promise<string> {
  const bytes = docxOf(lines.map((line) => paragraph(line)).join(''));
  const hash = hashBytes(bytes);
  registerEvidence(as('pm'), { type: 'TENDER_DOCUMENT', hash, description: `Tender document: ${name}` });
  await store.put(seed.tenantId, hash, bytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  return (await ingestFile(as('pm'), store, { hash, filename: name })).ingestionId;
}

before(async () => {
  previousClearance = config.ai.providerClearance.OPENAI;
  config.ai.providerClearance.OPENAI = 'LEGAL_L4';
  directory = mkdtempSync(join(tmpdir(), 'construx-contract-prefill-'));
  store = new EvidenceStore(directory);
  platform = new Platform(new AIOrchestrator({ reasoning: stub }), store);
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({ moduleId: 'CONTRACTS_STUDIO', tenantId: seed.tenantId, status: 'ACTIVE', reason: 'Contracts pre-fill test', decidedBy: seed.users.operator!.id });
  docs.itt = await tenderDocument('ITT.docx', ITT);
  docs.award = await tenderDocument('Award.docx', AWARD);
  docs.form = await tenderDocument('JCT DB 2024 conditions.docx', FORM_COPY);
});

after(() => {
  if (previousClearance === undefined) delete config.ai.providerClearance.OPENAI;
  else config.ai.providerClearance.OPENAI = previousClearance;
  rmSync(directory, { recursive: true, force: true });
});

describe('publisher text', () => {
  it('is recognised by its copyright notice, not by a mention of the form', () => {
    assert.equal(prefill.publisherText('© Copyright nec 2023'), 'NEC');
    assert.equal(prefill.publisherText('Copyright © The Joint Contracts Tribunal Limited 2024'), 'JCT');
    assert.equal(prefill.publisherText('© FIDIC 2017. All rights reserved'), 'FIDIC');
    assert.equal(prefill.publisherText('The contract will be the NEC4 ECC, Option C, with Z clauses attached.'), undefined);
  });
});

describe('pre-filling a draft', () => {
  let draft: studio.ContractDraft;
  let prefillId: string;

  it('proposes only what it can quote, merges what agrees, shows what conflicts, and holds publisher text back', async () => {
    draft = studio.createDraft(as('qs'), { formKey: 'jct:2024:db', confirmEdition: '2024', title: 'Main contract — depot refurbishment' });
    const run = await prefill.prefillDraft(as('qs'), draft.id, {});
    prefillId = run.prefillId;
    assert.equal(run.heldBack, 1, 'the copy of the JCT conditions');
    const sent = JSON.stringify(requests.at(-1)!.payload);
    assert.ok(!sent.includes('Clause text the publisher owns'), 'publisher text never reaches the model');
    assert.ok(sent.includes('Riverbank District Council'));
    assert.equal(run.proposed, 4, 'employer, one contract sum from two sources, two completion dates');
    assert.equal(run.conflicts, 1);
    assert.equal(run.dropped, 4, 'an unquoted passage, an unknown particular, a document it was not given, TBC');
    const record = prefill.prefills(as('pm'), draft.id).at(-1)!;
    const sum = record.candidates.find((entry) => entry.fieldKey === 'contract_sum')!;
    assert.equal(sum.value, '1250000.00');
    assert.equal(sum.supports.length, 2, '£1,250,000 and 1.25m are the same amount');
    assert.deepEqual(record.conflicts, ['completion_date']);
    assert.ok(record.questions.some((question) => /Employer’s Agent/.test(question)), 'a required particular nobody found is a question');
    assert.ok(record.questions.includes('Confirm whether sectional completion is intended.'));
    assert.equal(record.heldBack[0]!.filename, 'JCT DB 2024 conditions.docx');
    const event = platform.ledger.eventsForEntity({ refType: 'ContractPrefill', refId: prefillId })[0]!;
    assert.equal(event.actor.refType, 'AI');
    assert.equal(studio.draftOf(as('pm'), draft.id).revision, 1, 'nothing applied');
  });

  it('takes a value into the draft with its source, once a person chooses it', () => {
    const record = prefill.prefills(as('pm'), draft.id).at(-1)!;
    const sum = record.candidates.find((entry) => entry.fieldKey === 'contract_sum')!;
    const updated = prefill.acceptCandidate(as('qs'), draft.id, { prefillId, candidateId: sum.id, expectedRevision: 1 });
    const field = updated.fields.contract_sum!;
    assert.equal(field.value, '1250000.00');
    assert.equal(field.source.kind, 'EVIDENCE');
    assert.equal(field.source.kind === 'EVIDENCE' && field.source.filename, 'ITT.docx');
    assert.equal(field.source.kind === 'EVIDENCE' && field.source.quote, 'The Contract Sum shall not exceed £1,250,000');
    refused(() => studio.setField(as('qs'), draft.id, { key: 'contract_sum', value: '1,300,000', expectedRevision: 2 }), 'CONTRACT_OVERRIDE_REASON');
  });

  it('needs a reason to choose between documents that disagree', () => {
    const record = prefill.prefills(as('pm'), draft.id).at(-1)!;
    const revised = record.candidates.find((entry) => entry.fieldKey === 'completion_date' && entry.value === '2028-09-30')!;
    refused(() => prefill.acceptCandidate(as('qs'), draft.id, { prefillId, candidateId: revised.id, expectedRevision: 2 }), 'CONTRACT_CONFLICT_REASON');
    const updated = prefill.acceptCandidate(as('qs'), draft.id, { prefillId, candidateId: revised.id, note: 'The award letter revises the tender date', expectedRevision: 2 });
    assert.equal(updated.fields.completion_date!.value, '2028-09-30');
    assert.equal(updated.fields.completion_date!.note, 'The award letter revises the tender date');
  });

  it('shows each proposal beside its particular, marking the one in the draft', () => {
    const view = studioOverview(as('pm'), names).drafts.find((entry) => entry.id === draft.id)!;
    const fields = view.groups.flatMap((group) => group.fields) as Array<{ key: string; conflict?: boolean; candidates?: Array<{ display: string; inDraft: boolean }> }>;
    const completion = fields.find((field) => field.key === 'completion_date')!;
    assert.equal(completion.conflict, true);
    assert.equal(completion.candidates!.length, 2);
    assert.equal(completion.candidates!.filter((candidate) => candidate.inDraft).length, 1);
    assert.equal(fields.find((field) => field.key === 'contract_sum')!.candidates![0]!.display, 'GBP 1,250,000.00');
    assert.ok(view.prefill && view.prefill.heldBack.length === 1);
  });

  it('refuses a reader, a document that is not the project’s, and a run with nothing it may send', async () => {
    await rejects(() => prefill.prefillDraft(as('planner'), draft.id, {}), 'ACCESS_DENIED');
    await rejects(() => prefill.prefillDraft(as('qs'), draft.id, { ingestionIds: ['not-a-document'] }), 'CONTRACT_PREFILL_DOCUMENT');
    await rejects(() => prefill.prefillDraft(as('qs'), draft.id, { ingestionIds: [docs.form!] }), 'CONTRACT_PREFILL_NOTHING_SENDABLE');
  });

  it('sends nothing to a provider not cleared for the documents', async () => {
    delete config.ai.providerClearance.OPENAI;
    const before = requests.length;
    try {
      await rejects(() => prefill.prefillDraft(as('qs'), draft.id, { ingestionIds: [docs.itt!] }), 'CONTRACT_PREFILL_NEEDS_A_MODEL');
    } finally {
      config.ai.providerClearance.OPENAI = 'LEGAL_L4';
    }
    assert.equal(requests.length, before);
  });

  it('is quoted as carrying the documents’ classification, before it runs', async () => {
    const server = createGateway(platform);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const user = platform.users(seed.tenantId).find((entry) => entry.id === seed.users.qs!.id)!;
      const token = issueTokens({ actorId: user.id, tenantId: user.tenantId, partyId: user.partyId, roles: user.roles, mfaSatisfied: true }).accessToken;
      const quote = async () => {
        const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/ai/quote`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ method: 'POST', path: `/v1/projects/${seed.projectId}/contract-studio/drafts/${draft.id}/prefill` }),
        });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
      };
      const cleared = await quote();
      assert.equal(cleared.status, 200);
      assert.match(JSON.stringify(cleared.body), /LEGAL_L4/, 'the text read out of uploads is what is sent');
      delete config.ai.providerClearance.OPENAI;
      try {
        const uncleared = await quote();
        assert.doesNotMatch(JSON.stringify(uncleared.body), /"provider":"OPENAI"/, 'an uncleared provider is never the one quoted');
      } finally {
        config.ai.providerClearance.OPENAI = 'LEGAL_L4';
      }
    } finally {
      server.close();
    }
  });

  it('publishes its routes', () => {
    const paths = new Set(ROUTES.map((route) => `${route.method} ${route.pattern}`));
    assert.ok(paths.has('POST /v1/projects/:projectId/contract-studio/drafts/:draftId/prefill'));
    assert.ok(paths.has('POST /v1/projects/:projectId/contract-studio/drafts/:draftId/accept'));
    assert.ok(ROUTES.find((route) => route.pattern === '/v1/projects/:projectId/contract-studio/drafts/:draftId/prefill')!.ai, 'quoted before it runs');
  });
});
