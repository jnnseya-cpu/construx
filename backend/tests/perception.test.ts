import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { rejectsCode } from './helpers.ts';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import { ENDPOINTS } from '../src/ai/providers/remote.ts';
import type {
  AIProviderAdapter,
  ProviderRequest,
  ProviderResponse,
} from '../src/ai/providers/types.ts';
import { ingestFile, ingestedFiles, ingestionPosition } from '../src/evidence/pipeline.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import * as perception from '../src/engines/perception.ts';
import { registerDrawing } from '../src/engines/bim.ts';
import type { EngineContext } from '../src/engines/context.ts';
import * as structure from '../src/domain/structure.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Reading a file the platform holds.
 *
 * Drawing take-off, title-block reading and voice capture were treated as three
 * problems and they are one: take a file, ask a model that can actually look at
 * or listen to it, and turn the answer into something a person confirms.
 *
 * The assertions that carry the weight are the refusals, and one of them is the
 * whole reason this file exists. The local adapter derives its answers from a
 * hash of its inputs — it cannot read a drawing, and when asked to it returns a
 * confident, deterministic, entirely fictional title block. `registerDrawing`
 * used to write that into the drawing register as `UNPARSED-… / Untitled / P01 /
 * GENERAL`, a governed record of a drawing that has never existed. A refusal is
 * a true statement about the deployment; that was a false statement about the
 * project.
 */

let directory: string;
let platform: Platform;
let seed: SeedResult;
let store: EvidenceStore;
let projectId: string;
/** What the stubbed provider was last asked. Inspected, not asserted blindly. */
let lastRequest: ProviderRequest | undefined = undefined;

/** A perception provider that can be handed a file, as a real one can. */
function multimodalStub(output: Record<string, unknown>): AIProviderAdapter {
  return {
    name: 'GEMINI',
    capability: 'PERCEPTION',
    multimodal: true,
    transmits: true,
    estimateCostMinor: () => 40,
    healthy: () => true,
    async execute(request: ProviderRequest): Promise<ProviderResponse> {
      lastRequest = request;
      return {
        provider: 'GEMINI',
        modelClass: 'perception-standard',
        output,
        rawCostMinor: 40,
        latencyMs: 8,
        confidence: 0.91,
      };
    },
  };
}

const TITLE_BLOCK = {
  drawingNumber: 'C-1204',
  title: 'Inlet works — general arrangement',
  revision: 'P03',
  discipline: 'CIVIL',
  status: 'FOR CONSTRUCTION',
  issueDate: '2026-03-11',
};

const DRAWING = Buffer.from('PNG-ish bytes standing in for a drawing sheet', 'utf8');
const DRAWING_HASH = hashBytes(DRAWING);

/**
 * A project the design engines are actually allowed to run in.
 *
 * The seeded project is in OPERATIONS, where BIM_TWIN and PLANNING are out of
 * contract — a perception command there is refused by the engine phase gate
 * before it reaches anything this file is about. So the fixture walks a real
 * project through the real gate rather than writing a phase in by hand.
 */
async function buildFixture(perceptionAdapter?: AIProviderAdapter): Promise<void> {
  platform = new Platform(
    perceptionAdapter ? new AIOrchestrator({ perception: perceptionAdapter }) : undefined,
    store,
  );
  seed = await seedDemoProject(platform);

  const admin = seed.users.admin!.auth;
  const portfolioId = platform.ledger.listByTenant(seed.tenantId, 'Portfolio')[0]!.refId;
  const created = structure.createProject(platform.context(admin, `${seed.tenantId}-governance`), {
    portfolioId,
    name: 'Perception fixture',
    sectorType: 'UTILITIES',
    assetType: 'Treatment works',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Leeds' },
    contractValueMinor: 50_000_000,
    currency: 'GBP',
    plannedStart: '2026-01-05',
    plannedCompletion: '2027-01-05',
  });
  projectId = created.projectId;

  structure.createScopePackage(platform.context(seed.users.pm!.auth, projectId), {
    name: 'Inlet works',
    discipline: 'CIVIL',
    scopeOfWorks: 'Construct the inlet works including screens and flow control.',
    inclusions: ['Screens'],
    exclusions: ['Process mechanical'],
    acceptanceCriteria: ['Witnessed flow test'],
    estimatedValueMinor: 20_000_000,
    designResponsibility: 'CONTRACTOR',
  });
  structure.transitionPhase(platform.context(admin, projectId), {
    to: 'DESIGN',
    justification: 'Scope defined; design engines are applicable from here.',
  });
}

function ctxFor(who: string): EngineContext {
  return platform.context(seed.users[who]!.auth, projectId, { correlationId: 'perception-test' });
}

before(() => {
  directory = mkdtempSync(join(tmpdir(), 'construx-perception-'));
  store = new EvidenceStore(directory);
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('a provider that cannot see a file is refused, not asked anyway', () => {
  before(async () => {
    // No override: the local adapter, which is what every developer machine and
    // every AI_MODE=local deployment actually runs.
    await buildFixture();
  });

  it('refuses to read a drawing rather than inventing what it says', async () => {
    const ctx = ctxFor('bim');
    registerEvidenceFor(ctx, DRAWING_HASH, 'DRAWING_FILE');
    store.put(seed.tenantId, DRAWING_HASH, DRAWING, 'image/png');

    await rejectsCode(
      () => perception.extract(ctx, store, { hash: DRAWING_HASH, task: 'TITLE_BLOCK' }),
      'PERCEPTION_PROVIDER_UNAVAILABLE',
    );
  });

  it('spends nothing on a refusal', async () => {
    const before = platform.wallet(seed.tenantId).snapshot();
    const ctx = ctxFor('bim');
    await rejectsCode(
      () => perception.extract(ctx, store, { hash: DRAWING_HASH, task: 'TITLE_BLOCK' }),
      'PERCEPTION_PROVIDER_UNAVAILABLE',
    );
    const after = platform.wallet(seed.tenantId).snapshot();
    assert.equal(after.balanceMinor, before.balanceMinor);
    assert.equal(after.heldMinor, before.heldMinor);
  });

  it('says so on the capability endpoint, so a screen can refuse at the control', () => {
    const capability = perception.perceptionCapability(ctxFor('bim'));
    assert.equal(capability.available, false);
    assert.match(capability.reason ?? '', /cannot be shown a file/);
    // The task list is still published — what this deployment *would* do is a
    // different question from what it can do today. Counted against the
    // registry rather than a number written here, so adding a task cannot leave
    // the console offering one the endpoint never publishes.
    assert.equal(capability.tasks.length, Object.keys(perception.PERCEPTION_TASKS).length);
    assert.deepEqual(
      capability.tasks.map((task) => task.task).sort(),
      Object.keys(perception.PERCEPTION_TASKS).sort(),
    );
  });

  it('no longer writes an invented title block into the drawing register', async () => {
    // The defect this replaces: `String(output.drawingNumber ?? 'UNPARSED-…')`
    // against a provider that returns no drawing number at all. Every local
    // deployment produced a drawing called "Untitled", revision P01, discipline
    // GENERAL — and nothing could ever supersede it, because supersession keys
    // on the number.
    await rejectsCode(
      () =>
        registerDrawing(ctxFor('bim'), {
          fileHash: DRAWING_HASH,
          rawTitleBlockText: 'C-1204 / Inlet works / P03',
        }),
      'TITLE_BLOCK_NOT_READ',
    );

    const drawings = platform.ledger.list(projectId, 'Drawing');
    assert.equal(drawings.length, 0, 'a drawing was registered from an extraction that failed');
  });
});

describe('reading a file the platform holds', () => {
  before(async () => {
    await buildFixture(multimodalStub(TITLE_BLOCK));
    const ctx = ctxFor('bim');
    registerEvidenceFor(ctx, DRAWING_HASH, 'DRAWING_FILE');
    store.put(seed.tenantId, DRAWING_HASH, DRAWING, 'image/png');
  });

  it('refuses a hash no evidence record claims', async () => {
    const orphan = hashBytes(Buffer.from('never registered', 'utf8'));
    await rejectsCode(
      () => perception.extract(ctxFor('bim'), store, { hash: orphan, task: 'TITLE_BLOCK' }),
      'PERCEPTION_EVIDENCE_UNKNOWN',
    );
  });

  it('refuses a hash whose file the platform does not hold', async () => {
    // The distinction the whole feature turns on: the record exists, the file
    // does not, and a model cannot be shown a file nobody has.
    const ctx = ctxFor('bim');
    const hash = hashBytes(Buffer.from('recorded but never uploaded', 'utf8'));
    registerEvidenceFor(ctx, hash, 'DRAWING_FILE');

    await rejectsCode(
      () => perception.extract(ctx, store, { hash, task: 'TITLE_BLOCK' }),
      'PERCEPTION_FILE_NOT_HELD',
    );
  });

  it('refuses the wrong kind of file before it spends anything', async () => {
    // A photograph is not a voice note. Discovering that from a provider's 400
    // costs an ACU hold and tells the user nothing useful.
    // A recording asked to be read as a title block. Deliberately this way
    // round rather than a drawing asked to be transcribed: a voice note's
    // downstream command is phase-gated to CONSTRUCTION, so in a DESIGN-phase
    // project that pairing is refused for a reason that has nothing to do with
    // the media type, and the test would pass while proving nothing.
    const recording = Buffer.from('audio bytes standing in for a voice note', 'utf8');
    const recordingHash = hashBytes(recording);
    registerEvidenceFor(ctxFor('bim'), recordingHash, 'SITE_RECORDING');
    store.put(seed.tenantId, recordingHash, recording, 'audio/mpeg');

    const before = platform.wallet(seed.tenantId).snapshot();
    await rejectsCode(
      () => perception.extract(ctxFor('bim'), store, { hash: recordingHash, task: 'TITLE_BLOCK' }),
      'PERCEPTION_MEDIA_UNSUPPORTED',
    );
    assert.equal(platform.wallet(seed.tenantId).snapshot().heldMinor, before.heldMinor);
  });

  it('sends the file as media, not stringified into the prompt', async () => {
    lastRequest = undefined;
    await perception.extract(ctxFor('bim'), store, { hash: DRAWING_HASH, task: 'TITLE_BLOCK' });

    const seen = lastRequest as ProviderRequest | undefined;
    assert.ok(seen?.media, 'the provider was never handed the file');
    assert.equal(seen.media.hash, DRAWING_HASH);
    assert.equal(seen.media.contentType, 'image/png');
    assert.equal(Buffer.from(seen.media.base64, 'base64').toString('utf8'), DRAWING.toString('utf8'));
    // The bytes must not also be in the payload: that is where a base64 blob
    // would be charged at text rates and read by nothing.
    assert.ok(!JSON.stringify(seen.payload).includes(seen.media.base64.slice(0, 24)));
  });

  it('produces a draft and registers no drawing', async () => {
    const drawingsBefore = platform.ledger.list(projectId, 'Drawing').length;
    const result = await perception.extract(ctxFor('bim'), store, { hash: DRAWING_HASH, task: 'TITLE_BLOCK' });

    assert.equal(result.task, 'TITLE_BLOCK');
    assert.equal(result.extraction.drawingNumber, 'C-1204');
    assert.ok(result.acuConsumed > 0, 'a provider call that was made should be charged for');

    const draft = platform.ledger.get({ refType: 'PerceptionDraft', refId: result.draftId });
    assert.equal(draft?.state.status, 'DRAFT');
    assert.equal(
      platform.ledger.list(projectId, 'Drawing').length,
      drawingsBefore,
      'an extraction reached the register without anybody confirming it',
    );
  });

  it('attributes the draft to an AI actor, never to the person who pressed the button', async () => {
    const result = await perception.extract(ctxFor('bim'), store, { hash: DRAWING_HASH, task: 'TITLE_BLOCK' });
    const event = platform.ledger
      .eventsForEntity({ refType: 'PerceptionDraft', refId: result.draftId })
      .find((e) => e.eventType === 'PERCEPTION_DRAFT_PRODUCED');

    assert.equal(event?.actor.refType, 'AI');
    assert.equal(event?.source, 'AI');
    assert.ok(event?.ai?.provider, 'the draft does not name the provider that produced it');
  });

  it('registers the drawing only when a person confirms, and records their corrections', async () => {
    const { draftId } = await perception.extract(ctxFor('bim'), store, {
      hash: DRAWING_HASH,
      task: 'TITLE_BLOCK',
    });

    const confirmed = await perception.confirm(ctxFor('bim'), {
      draftId,
      // The model read P03; the person on the job knows it was reissued.
      corrections: { revision: 'P04' },
    });

    const drawingId = (confirmed.result as { drawingId: string }).drawingId;
    const drawing = platform.ledger.get({ refType: 'Drawing', refId: drawingId });
    assert.equal(drawing?.state.drawingNumber, 'C-1204');
    assert.equal(drawing?.state.revision, 'P04', 'the correction did not reach the register');

    const draft = platform.ledger.get({ refType: 'PerceptionDraft', refId: draftId });
    assert.equal(draft?.state.status, 'CONFIRMED');
    assert.deepEqual(draft?.state.corrections, { revision: 'P04' });
    assert.equal(draft?.state.confirmedBy, seed.users.bim!.id);

    // The confirmation is a human act with a human's name on it.
    const event = platform.ledger
      .eventsForEntity({ refType: 'PerceptionDraft', refId: draftId })
      .find((e) => e.eventType === 'PERCEPTION_DRAFT_CONFIRMED');
    assert.equal(event?.actor.refType, 'User');
  });

  it('will not confirm the same draft twice', async () => {
    const { draftId } = await perception.extract(ctxFor('bim'), store, {
      hash: DRAWING_HASH,
      task: 'TITLE_BLOCK',
    });
    await perception.confirm(ctxFor('bim'), { draftId });
    await rejectsCode(() => perception.confirm(ctxFor('bim'), { draftId }), 'PERCEPTION_DRAFT_SETTLED');
  });

  it('keeps what the model read when a person rejects it', async () => {
    // "The machine read this and we did not agree" is exactly the question
    // asked three years later, so a discard is a record rather than a deletion.
    const { draftId } = await perception.extract(ctxFor('bim'), store, {
      hash: DRAWING_HASH,
      task: 'TITLE_BLOCK',
    });
    perception.discard(ctxFor('bim'), { draftId, reason: 'Wrong sheet — this is the inlet, not the outlet' });

    const draft = platform.ledger.get({ refType: 'PerceptionDraft', refId: draftId });
    assert.equal(draft?.state.status, 'DISCARDED');
    assert.equal((draft?.state.extraction as Record<string, unknown>).drawingNumber, 'C-1204');
    assert.match(String(draft?.state.discardReason), /Wrong sheet/);
  });
});

describe('an extraction too thin to be worth confirming', () => {
  before(async () => {
    // A provider that answered, and answered with nothing usable.
    await buildFixture(multimodalStub({ drawingNumber: null, title: null, revision: null, discipline: null }));
    const ctx = ctxFor('bim');
    registerEvidenceFor(ctx, DRAWING_HASH, 'DRAWING_FILE');
    store.put(seed.tenantId, DRAWING_HASH, DRAWING, 'image/png');
  });

  it('refuses it, and keeps the draft that says what came back', async () => {
    await rejectsCode(
      () => perception.extract(ctxFor('bim'), store, { hash: DRAWING_HASH, task: 'TITLE_BLOCK' }),
      'PERCEPTION_NOT_LEGIBLE',
    );

    // The call was made and charged for; what a model failed to read is itself
    // worth knowing, so the draft stays. It simply cannot be confirmed.
    const drafts = platform.ledger.list(projectId, 'PerceptionDraft');
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]?.state.status, 'DRAFT');
    assert.equal(platform.ledger.list(projectId, 'Drawing').length, 0);
  });
});

describe('the provider request carries media in each vendor’s own form', () => {
  const request: ProviderRequest = {
    task: 'Read the title block',
    payload: { evidenceHash: DRAWING_HASH },
    media: { contentType: 'image/png', base64: 'QUJD', hash: DRAWING_HASH },
  };

  it('gives Gemini an inline_data part', () => {
    const body = ENDPOINTS.GEMINI.body(request, 'perception-standard') as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    const parts = body.contents[0]!.parts;
    const inline = parts.find((part) => 'inline_data' in part)?.inline_data as Record<string, unknown>;

    assert.ok(inline, 'the file was not attached as media at all');
    assert.equal(inline.mime_type, 'image/png');
    assert.equal(inline.data, 'QUJD');
  });

  it('gives OpenAI an input_image content block', () => {
    const body = ENDPOINTS.OPENAI.body(request, 'perception-standard') as {
      input: Array<{ role: string; content: unknown }>;
    };
    const user = body.input.find((message) => message.role === 'user');
    const content = user?.content as Array<Record<string, unknown>>;

    assert.ok(Array.isArray(content), 'a media request was sent as a plain string');
    assert.equal(content.find((block) => block.type === 'input_image')?.image_url, 'data:image/png;base64,QUJD');
  });

  it('leaves a request with no media exactly as it was', () => {
    // The overwhelming majority of calls are text. None of them should change
    // shape because a media field exists.
    const plain: ProviderRequest = { task: 'Assess delay', payload: { taskId: 'x' } };
    const gemini = ENDPOINTS.GEMINI.body(plain, 'reasoning-standard') as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    assert.equal(gemini.contents[0]!.parts.length, 1);

    const openai = ENDPOINTS.OPENAI.body(plain, 'reasoning-standard') as {
      input: Array<{ role: string; content: unknown }>;
    };
    assert.equal(typeof openai.input.find((m) => m.role === 'user')?.content, 'string');
  });

  it('prices the media rather than ignoring it', async () => {
    // A hold sized from the JSON alone quotes pennies for a large photograph
    // and then charges pounds. The figures here are chosen to clear the
    // one-minor-unit price floor rather than to be representative: at
    // large-context perception rates it takes roughly 6MB of file before the
    // difference is visible in whole pence at all.
    const { RemoteProviderAdapter } = await import('../src/ai/providers/remote.ts');
    const adapter = new RemoteProviderAdapter('GEMINI', 'PERCEPTION');
    const large: ProviderRequest = {
      ...request,
      modelClass: 'perception-large-context',
      media: { contentType: 'image/png', base64: 'A'.repeat(8_000_000), hash: DRAWING_HASH },
    };
    const small: ProviderRequest = { ...request, modelClass: 'perception-large-context' };
    assert.ok(
      adapter.estimateCostMinor(large) > adapter.estimateCostMinor(small),
      'a large file is quoted at the same price as a small one — the media is not being counted',
    );
  });
});

/**
 * A one-page PDF that is nothing but an image: what a scan looks like.
 * Ingestion's own parser finds no text layer in it and says so.
 */
function scanPdf(marker: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> /ID (${marker}) >>`,
    '<< /Length 30 >>\nstream\nq 500 0 0 700 50 50 cm /Im1 Do Q\nendstream',
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x00\nendstream',
  ];
  let out = '%PDF-1.5\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('a scan is transcribed by a model and confirmed into the ingestion record', () => {
  const SCAN = scanPdf('letter');
  const SCAN_HASH = hashBytes(SCAN);
  const STRAY = scanPdf('never-ingested');
  const STRAY_HASH = hashBytes(STRAY);
  const TRANSCRIPT = {
    pages: [{ page: 1, text: 'CLAUSE 12 — PAYMENT\nThe final date for payment is 28 days after the due date.\nRef WTW/PAY/0412' }],
    language: 'en',
    illegiblePassages: 0,
  };
  let draftId = '';

  before(async () => {
    await buildFixture(multimodalStub(TRANSCRIPT));
    const ctx = ctxFor('pm');
    for (const [hash, bytes] of [
      [SCAN_HASH, SCAN],
      [STRAY_HASH, STRAY],
    ] as Array<[string, Buffer]>) {
      registerEvidenceFor(ctx, hash, 'CORRESPONDENCE');
      store.put(seed.tenantId, hash, bytes, 'application/pdf');
    }
  });

  it('ingestion reads the PDF itself, finds no text layer, and says a model that can see is needed', async () => {
    const result = await ingestFile(ctxFor('pm'), store, { hash: SCAN_HASH, filename: 'payment-letter-scan.pdf' });
    assert.equal(result.status, 'INGESTED');
    const file = ingestedFiles(ctxFor('pm')).find((entry) => entry.hash === SCAN_HASH)!;
    assert.equal(file.extraction.method, 'NEEDS_OCR');
    assert.match(file.extraction.reason ?? '', /1 page and no text layer to read — 1 carries only images/);
    const position = await ingestionPosition(ctxFor('pm'), store);
    assert.equal(position.awaitingOcr, 1);
    assert.equal(position.read, 0);
  });

  it('the model transcribes it into a draft, and nothing is indexed until somebody confirms', async () => {
    const produced = await perception.extract(ctxFor('pm'), store, { hash: SCAN_HASH, task: 'DOCUMENT_TEXT' });
    draftId = produced.draftId;
    assert.equal(produced.task, 'DOCUMENT_TEXT');
    assert.equal(lastRequest?.media?.contentType, 'application/pdf', 'the file went to the provider as media');
    const file = ingestedFiles(ctxFor('pm')).find((entry) => entry.hash === SCAN_HASH)!;
    assert.equal(file.extraction.method, 'NEEDS_OCR', 'a draft changes nothing on the ingestion record');
    assert.equal(file.lexicalVector, undefined);
  });

  it('confirming writes the same FILE_EXTRACTED a native read writes, with the provider and the confirmer on it', async () => {
    const confirmed = await perception.confirm(ctxFor('pm'), { draftId });
    assert.equal(confirmed.result.pages, 1);
    assert.equal(confirmed.result.language, 'en');

    const file = ingestedFiles(ctxFor('pm')).find((entry) => entry.hash === SCAN_HASH)!;
    assert.equal(file.extraction.method, 'OCR');
    assert.match(file.extraction.text ?? '', /28 days after the due date/);
    assert.match(file.extraction.note ?? '', /Transcribed by GEMINI and confirmed by /);
    assert.ok(file.lexicalVector && file.lexicalVector.length > 0, 'the transcription is indexed like native text');

    const position = await ingestionPosition(ctxFor('pm'), store);
    assert.equal(position.read, 1);
    assert.equal(position.readByModel, 1);
    assert.equal(position.awaitingOcr, 0);

    const events = platform.ledger.list(projectId, 'IngestedFile');
    assert.equal(events.length, 1, 'one ingestion record, not a second one for the transcription');
  });

  it('refuses a second transcription of a file that already has its text', async () => {
    const again = await perception.extract(ctxFor('pm'), store, { hash: SCAN_HASH, task: 'DOCUMENT_TEXT' });
    await rejectsCode(() => perception.confirm(ctxFor('pm'), { draftId: again.draftId }), 'ALREADY_READ');
  });

  it('refuses to file a transcription against a file ingestion has never looked at', async () => {
    const stray = await perception.extract(ctxFor('pm'), store, { hash: STRAY_HASH, task: 'DOCUMENT_TEXT' });
    await rejectsCode(() => perception.confirm(ctxFor('pm'), { draftId: stray.draftId }), 'NOT_INGESTED');
  });

  it('takes the authority ingestion takes, so a reader cannot ask a model to write the record', async () => {
    await rejectsCode(() => perception.extract(ctxFor('designer'), store, { hash: STRAY_HASH, task: 'DOCUMENT_TEXT' }), 'ACCESS_DENIED');
  });
});

/**
 * Register an evidence hash through the platform's own command.
 *
 * Declared after use on purpose — it is the least interesting thing in the file
 * and reads as noise at the top.
 */
function registerEvidenceFor(ctx: EngineContext, hash: string, type: string): void {
  ctx.ledger.commit({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    actor: { refType: 'User', refId: ctx.auth.actorId },
    source: 'WEB',
    correlationId: ctx.correlationId,
    eventType: 'EVIDENCE_REGISTERED',
    entity: { refType: 'EvidenceItem', refId: `ev-${hash.slice(-12)}` },
    nextState: {
      id: `ev-${hash.slice(-12)}`,
      type,
      hash,
      description: 'Registered by a perception test fixture',
      linkedEntities: [],
      capturedAt: new Date().toISOString(),
      capturedBy: ctx.auth.actorId,
    },
  });
}
