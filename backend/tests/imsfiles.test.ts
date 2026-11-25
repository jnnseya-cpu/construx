import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import { config } from '../src/config.ts';
import * as agents from '../src/domain/ims/agents.ts';
import * as docs from '../src/domain/ims/documents.ts';
import { LEGISLATION, REGIONS, regionsOf } from '../src/domain/ims/legislation.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { ingestFile, packDocuments } from '../src/evidence/pipeline.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { docxOf, paragraph } from './fixtures/zip.ts';

/**
 * The management-system agents read a document kept as an attached file — the
 * text the platform read out of it on arrival — and the legal register covers
 * the four nations, offering a company only what binds where it works.
 */

let platform: Platform;
let seed: SeedResult;
let store: EvidenceStore;
let directory: string;
let previousClearance: (typeof config.ai.providerClearance)[string] | undefined;
const requests: ProviderRequest[] = [];
const company = (who: string): EngineContext => platform.context(seed.users[who]!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
const refused = async (fn: () => unknown, code: string) => assert.rejects(async () => fn(), (error: { code?: string }) => error.code === code, `expected ${code}`);

const FILE_LINES = [
  'Procedure QP-07: control of documented information.',
  'Every controlled document is approved by somebody other than its author before issue.',
  'The register lists the revision in force; superseded revisions are withdrawn from site the day a new one is issued.',
];

function answer(request: ProviderRequest): Record<string, unknown> {
  const properties = Object.keys(((request.responseSchema ?? {}) as { properties?: Record<string, unknown> }).properties ?? {});
  if (properties.length === 1 && properties[0] === 'clauses') return { clauses: [{ clauseId: 'ISO9001:7.5', reason: 'Approval before issue and withdrawal of superseded revisions' }] };
  if (properties.includes('entries')) {
    return {
      entries: [
        { catalogueKey: 'NI_CDM_2016', requirement: 'Principal contractor duties on a Northern Ireland site', applicability: 'Every NI project with more than one contractor', howComplied: 'Construction phase plan per project' },
        { catalogueKey: 'CDM_2015', requirement: 'GB CDM, which does not apply in Northern Ireland', applicability: 'Not where the company works', howComplied: 'Not applicable' },
      ],
    };
  }
  throw new Error(`The stub was asked something it does not answer: ${properties.join(', ')}`);
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

before(async () => {
  // The text read out of an upload is classified LEGAL_L4, so it goes to a
  // provider only once a deployment clears it that far.
  previousClearance = config.ai.providerClearance.OPENAI;
  config.ai.providerClearance.OPENAI = 'LEGAL_L4';
  directory = mkdtempSync(join(tmpdir(), 'construx-ims-files-'));
  store = new EvidenceStore(directory);
  platform = new Platform(new AIOrchestrator({ reasoning: stub }), store);
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({ moduleId: 'IMS', tenantId: seed.tenantId, status: 'ACTIVE', reason: 'IMS files test', decidedBy: seed.users.operator!.id });
});

after(() => {
  if (previousClearance === undefined) delete config.ai.providerClearance.OPENAI;
  else config.ai.providerClearance.OPENAI = previousClearance;
  rmSync(directory, { recursive: true, force: true });
});

describe('a controlled document kept as an attached file', () => {
  let documentId: string;
  let hash: string;
  let bytes: Buffer;

  it('is reported as not yet read until its file has arrived, never read as an empty document', async () => {
    bytes = docxOf(FILE_LINES.map((line) => paragraph(line)).join(''));
    hash = hashBytes(bytes);
    const document = docs.draftDocument(company('qaqc'), { type: 'PROCEDURE', title: 'Control of documented information', standards: ['ISO9001'], ownerId: seed.users.qaqc!.id, file: { hash, filename: 'QP-07 Document control.docx' } });
    documentId = document.id;
    const filing = platform.ledger.listByTenant(seed.tenantId, 'EvidenceItem').find((record) => record.state.hash === hash)!;
    assert.equal(filing.state.type, 'IMS_DOCUMENT');
    assert.equal(filing.state.description, 'IMS document: QP-07 Document control.docx', 'named so the arrival hook reads it under its own filename');
    await refused(() => agents.mapClauses(company('qaqc'), { documentId }), 'IMS_AGENT_NO_TEXT');
    assert.equal(requests.length, 0, 'nothing sent to a model');
  });

  it('is read by the agent from the text the platform read out of it, citing the file', async () => {
    await store.put(seed.tenantId, hash, bytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    await ingestFile(company('pm'), store, { hash, filename: 'QP-07 Document control.docx' });
    // The file's text carries its reading's classification: a provider not
    // cleared for it is not sent it, and the local stand-in cannot do the work.
    delete config.ai.providerClearance.OPENAI;
    const sentBefore = requests.length;
    await refused(() => agents.mapClauses(company('qaqc'), { documentId }), 'IMS_AGENT_NEEDS_A_MODEL');
    assert.equal(requests.length, sentBefore, 'nothing sent to an uncleared provider');
    config.ai.providerClearance.OPENAI = 'LEGAL_L4';
    const run = await agents.mapClauses(company('qaqc'), { documentId });
    assert.equal(run.proposed, 1);
    const request = requests.at(-1)!;
    assert.match(String((request.payload as { document: { text: string } }).document.text), /superseded revisions are withdrawn/);
    const proposal = agents.agentProposals(company('pm')).find((entry) => entry.runId === run.runId)!;
    assert.deepEqual(proposal.payload.clauses, ['ISO9001:7.5']);
  });

  it('is kept out of a tender pack and read only as a management-system document', () => {
    const governance = company('pm');
    assert.ok(packDocuments(governance, { purpose: 'IMS' }).some((entry) => entry.hash === hash));
    assert.ok(!packDocuments(governance).some((entry) => entry.hash === hash), 'not part of a tender pack');
    assert.ok(!packDocuments(governance, { purpose: 'PLANNING' }).some((entry) => entry.hash === hash));
  });
});

describe('legislation across the four nations', () => {
  it('names every instrument once, with an extent the regions understand', () => {
    const keys = LEGISLATION.map((entry) => entry.key);
    assert.equal(new Set(keys).size, keys.length, 'no key repeated');
    for (const entry of LEGISLATION) assert.ok(regionsOf(entry.extent).length > 0, `${entry.key}: ${entry.extent}`);
    for (const region of REGIONS) assert.ok(LEGISLATION.some((entry) => regionsOf(entry.extent).includes(region)), region);
    assert.deepEqual(regionsOf('Great Britain'), ['ENGLAND', 'WALES', 'SCOTLAND']);
    assert.ok(LEGISLATION.some((entry) => entry.key === 'NI_RIDDOR_1997' && entry.extent === 'Northern Ireland'));
    assert.ok(LEGISLATION.some((entry) => entry.key === 'SC_EASR_2018' && entry.extent === 'Scotland'));
  });

  it('offers a Northern Ireland contractor only what binds there, and drops an Act that does not', async () => {
    await refused(() => agents.proposeObligations(company('safety'), { regions: ['MARS'] }), 'IMS_REGIONS');
    const run = await agents.proposeObligations(company('safety'), { regions: ['NORTHERN_IRELAND'], activities: 'Groundworks and civil engineering in County Antrim' });
    const sent = (requests.at(-1)!.payload as { list: Array<{ key: string; extent: string }>; worksIn: string[] });
    assert.deepEqual(sent.worksIn, ['NORTHERN_IRELAND']);
    assert.ok(sent.list.length > 0);
    for (const entry of sent.list) assert.ok(entry.extent === 'Northern Ireland' || entry.extent === 'United Kingdom', `${entry.key} (${entry.extent}) does not bind in Northern Ireland`);
    assert.ok(!sent.list.some((entry) => entry.key === 'CDM_2015'));
    assert.equal(run.proposed, 1);
    assert.equal(run.dropped, 1, 'GB CDM was not offered, so it is dropped');
    const proposal = agents.agentProposals(company('pm')).find((entry) => entry.runId === run.runId)!;
    assert.equal(proposal.payload.catalogueKey, 'NI_CDM_2016');
  });
});
