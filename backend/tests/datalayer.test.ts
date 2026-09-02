import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import { createGateway } from '../src/api/gateway.ts';
import { changePage, cursorFor, idempotencyKey, MAX_PAGE, parseCursor } from '../src/datalayer/changefeed.ts';
import { embeddingProvider } from '../src/datalayer/embedding.ts';
import { projectGraph } from '../src/datalayer/graph.ts';
import {
  cosine,
  MINIMUM_PASSAGE,
  MINIMUM_SIMILARITY,
  passagesFrom,
  retrieve,
  type EmbeddingProvider,
  type Passage,
} from '../src/datalayer/vectorindex.ts';
import { authOf } from '../src/seed.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The data layer: the change feed, the projected graph, and semantic retrieval.
 *
 * The retrieval block is written against one failure in particular. A vector
 * index always returns neighbours — there is no such thing as an empty result
 * unless something refuses to produce one — so the tests that matter most are
 * the ones proving it refuses.
 */

describe('the change feed', () => {
  let platform: Platform;
  let seed: SeedResult;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
  });

  const adminAuth = () => authOf(platform, seed.users.admin!.id);

  it('is ordered, and the cursor sorts the same way the ledger does', () => {
    const page = changePage(platform.ledger, adminAuth(), { limit: 50 });
    const cursors = page.entries.map((entry) => entry.cursor);
    assert.deepEqual(cursors, [...cursors].sort());
  });

  it('resumes from a cursor without repeating or skipping an entry', () => {
    const first = changePage(platform.ledger, adminAuth(), { limit: 10 });
    assert.ok(first.entries.length > 0);
    assert.ok(first.more, 'the seeded project should have more than ten events');

    const second = changePage(platform.ledger, adminAuth(), { limit: 10, after: first.nextCursor! });
    const firstIds = new Set(first.entries.map((entry) => entry.eventId));
    for (const entry of second.entries) {
      assert.ok(!firstIds.has(entry.eventId), `${entry.eventId} was delivered twice`);
    }

    // And nothing between them was dropped: reading twenty in one go gives the
    // same sequence as two pages of ten.
    const whole = changePage(platform.ledger, adminAuth(), { limit: 20 });
    assert.deepEqual(
      [...first.entries, ...second.entries].map((entry) => entry.eventId),
      whole.entries.map((entry) => entry.eventId),
    );
  });

  it('reaches the end and says so', () => {
    let cursor: string | null = null;
    let pages = 0;
    let total = 0;
    for (;;) {
      const page: ReturnType<typeof changePage> = changePage(platform.ledger, adminAuth(), {
        limit: MAX_PAGE,
        ...(cursor ? { after: cursor } : {}),
      });
      total += page.entries.length;
      pages += 1;
      if (!page.more) break;
      cursor = page.nextCursor;
      assert.ok(pages < 200, 'the feed did not terminate');
    }
    assert.ok(total > 0);
  });

  it('carries a stable idempotency key that differs by tenancy', () => {
    const page = changePage(platform.ledger, adminAuth(), { limit: 5 });
    const entry = page.entries[0]!;
    // Stable: the same event always keys the same, so a repeated delivery is
    // recognisable as a repeat.
    assert.equal(entry.idempotencyKey, idempotencyKey(adminAuth().tenantId, entry.eventId));
    // And keyed to the tenancy, so one customer's key cannot collide with
    // another's for the same event id.
    assert.notEqual(entry.idempotencyKey, idempotencyKey('another-tenancy', entry.eventId));
  });

  it('ships no entity state, only a pointer to read it', () => {
    const page = changePage(platform.ledger, adminAuth(), { limit: 20 });
    for (const entry of page.entries) {
      assert.ok(!('state' in entry), 'the feed must not carry state');
      assert.match(entry.readAt, /^\/v1\/projects\/.+\/entities\/.+/);
    }
  });

  it('refuses a malformed cursor rather than starting again from the beginning', () => {
    // A consumer silently sent back to the start reprocesses its whole history.
    for (const bad of ['', 'nonsense', 'not-a-date|abc', '|abc', '2026-01-01T00:00:00.000Z|']) {
      assert.throws(() => parseCursor(bad), /CHANGE_CURSOR_INVALID|not a cursor/, bad);
    }
  });

  it('caps the page size a consumer can ask for', () => {
    const page = changePage(platform.ledger, adminAuth(), { limit: 100_000 });
    assert.ok(page.entries.length <= MAX_PAGE);
  });

  it('withholds what a narrow identity may not read, and counts it', () => {
    const wide = changePage(platform.ledger, adminAuth(), { limit: MAX_PAGE });
    const narrow = changePage(platform.ledger, authOf(platform, seed.users.siteManager!.id), { limit: MAX_PAGE });
    assert.ok(narrow.withheld > 0, 'a site manager should not see every entity type in the tenancy');
    assert.ok(narrow.entries.length < wide.entries.length);
  });

  it('advances the cursor past withheld entries, or a narrow identity loops for ever', () => {
    const auth = authOf(platform, seed.users.siteManager!.id);
    const first = changePage(platform.ledger, auth, { limit: 5 });
    if (first.nextCursor) {
      const second = changePage(platform.ledger, auth, { limit: 5, after: first.nextCursor });
      const firstIds = new Set(first.entries.map((entry) => entry.eventId));
      for (const entry of second.entries) assert.ok(!firstIds.has(entry.eventId));
    }
  });

  it('states its contract, including that it is at least once rather than exactly once', () => {
    const page = changePage(platform.ledger, adminAuth(), { limit: 1 });
    assert.ok(page.contract.some((line) => /at least once/i.test(line)));
    assert.ok(!page.contract.some((line) => /exactly once/i.test(line)));
  });

  it('separates events committed in the same millisecond, or a busy commit is silently lost', () => {
    // The ledger sorts by (timestamp, eventId) precisely because a command that
    // writes several events writes them in one millisecond. A cursor that
    // compared timestamps alone would resume past all of them and a consumer
    // would never learn they existed.
    const all = changePage(platform.ledger, adminAuth(), { limit: MAX_PAGE }).entries;
    const shared = new Map<string, number>();
    for (const entry of all) shared.set(entry.occurredAt, (shared.get(entry.occurredAt) ?? 0) + 1);
    const collision = [...shared.entries()].find(([, count]) => count > 1);
    assert.ok(collision, 'the seeded project must contain a same-millisecond commit for this to prove anything');

    const [timestamp] = collision!;
    const sameMillisecond = all.filter((entry) => entry.occurredAt === timestamp);
    // Resuming from the first of them must still deliver the rest.
    const after = changePage(platform.ledger, adminAuth(), {
      limit: MAX_PAGE,
      after: sameMillisecond[0]!.cursor,
    });
    const delivered = new Set(after.entries.map((entry) => entry.eventId));
    for (const entry of sameMillisecond.slice(1)) {
      assert.ok(delivered.has(entry.eventId), `${entry.eventId} was lost by resuming within the same millisecond`);
    }
  });

  it('advances the cursor past a trailing run of withheld entries', () => {
    // Otherwise a consumer whose permissions never widen re-examines the same
    // unreadable tail on every call and never reaches the end.
    const narrow = authOf(platform, seed.users.siteManager!.id);
    let cursor: string | null = null;
    let rounds = 0;
    for (;;) {
      const page: ReturnType<typeof changePage> = changePage(platform.ledger, narrow, {
        limit: 3,
        ...(cursor ? { after: cursor } : {}),
      });
      rounds += 1;
      if (!page.more) break;
      assert.notEqual(page.nextCursor, cursor, 'the cursor did not move — this feed would loop for ever');
      cursor = page.nextCursor;
      assert.ok(rounds < 500, 'the feed did not terminate for a narrow identity');
    }
  });

  it('builds a cursor that round-trips', () => {
    const cursor = cursorFor({ timestamp: '2026-03-01T10:00:00.000Z', eventId: '01ABC' });
    assert.deepEqual(parseCursor(cursor), { timestamp: '2026-03-01T10:00:00.000Z', eventId: '01ABC' });
  });
});

describe('the projected graph', () => {
  let platform: Platform;
  let seed: SeedResult;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
  });

  it('finds nodes and edges across the whole project', () => {
    const graph = projectGraph(platform.ledger, authOf(platform, seed.users.admin!.id), seed.projectId);
    assert.ok(graph.counts.nodes > 0);
    assert.ok(graph.counts.edges > 0);
  });

  it('keeps declared edges apart from inferred ones', () => {
    // The distinction that makes a knowledge graph trustworthy or not. Presenting
    // an inferred reference as though somebody had declared it is the whole
    // problem with graphs nobody can audit.
    const graph = projectGraph(platform.ledger, authOf(platform, seed.users.admin!.id), seed.projectId);
    const kinds = new Map(graph.counts.byKind.map((entry) => [entry.kind, entry.edges]));
    assert.ok(kinds.has('EVIDENCE'));
    assert.ok(kinds.has('REFERENCE'));
    const declared = (kinds.get('EVIDENCE') ?? 0) + (kinds.get('AI_INPUT') ?? 0);
    assert.ok(Math.abs(graph.declaredShare - declared / graph.counts.edges) < 1e-9);
  });

  it('never joins a record to itself', () => {
    const graph = projectGraph(platform.ledger, authOf(platform, seed.users.admin!.id), seed.projectId);
    for (const edge of graph.edges) {
      assert.ok(
        !(edge.from.refType === edge.to.refType && edge.from.refId === edge.to.refId),
        'a record was joined to itself',
      );
    }
  });

  it('ranks hubs by how much hangs off them', () => {
    const graph = projectGraph(platform.ledger, authOf(platform, seed.users.admin!.id), seed.projectId);
    const counts = graph.hubs.map((hub) => hub.edges);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
    assert.ok(graph.hubs.every((hub) => hub.edges > 0), 'a record with no edges is not a hub');
  });

  it('omits records a narrow identity may not read, and counts them', () => {
    const wide = projectGraph(platform.ledger, authOf(platform, seed.users.admin!.id), seed.projectId);
    const narrow = projectGraph(platform.ledger, authOf(platform, seed.users.siteManager!.id), seed.projectId);
    assert.ok(narrow.counts.withheld > 0);
    assert.ok(narrow.counts.nodes < wide.counts.nodes);
    // Not shipped hollow: in a whole-project projection a shell is a row an
    // integrator would try to process.
    for (const node of narrow.nodes) assert.equal(node.readable, true);
  });

  it('treats a command touching many records as bulk work, not as relationships', () => {
    // A command writing a variation and the change request behind it has told
    // you something. A command creating forty bill items has told you it was an
    // import, and joining all forty to each other turns a readable graph into
    // one nobody can use.
    const graph = projectGraph(platform.ledger, authOf(platform, seed.users.admin!.id), seed.projectId);
    assert.ok(
      graph.counts.batchedCommands > 0,
      'the seeded project must contain a bulk command for this to prove anything',
    );
    assert.ok(graph.findings.some((finding) => /bulk work/i.test(finding)), 'a set-aside batch must be reported');
  });

  it('says something about the shape rather than only counting it', () => {
    const graph = projectGraph(platform.ledger, authOf(platform, seed.users.admin!.id), seed.projectId);
    assert.ok(Array.isArray(graph.findings));
  });

  it('is empty and honest about a project that does not exist', () => {
    const graph = projectGraph(platform.ledger, authOf(platform, seed.users.admin!.id), 'no-such-project');
    assert.equal(graph.counts.nodes, 0);
    assert.equal(graph.counts.edges, 0);
    assert.equal(graph.declaredShare, 0, 'a share of nothing must be zero, not NaN');
    assert.ok(graph.findings.some((finding) => /connected to anything/i.test(finding)));
  });
});

describe('semantic retrieval, and what makes it refuse', () => {
  /** A provider whose vectors are declared by the test, so scoring is checkable. */
  const provider = (vectors: number[][], model = 'test-embed'): EmbeddingProvider => ({
    model,
    embed: async () => vectors,
  });

  const passage = (text: string, refId = 'r-1'): Passage => ({
    ref: { refType: 'RFI', refId },
    projectId: 'p-1',
    text,
    field: 'description',
  });

  it('refuses outright where no embedding model is available', async () => {
    // The one that matters most: it must not quietly become keyword matching
    // wearing semantic search's clothes.
    const result = await retrieve({ query: 'ground conditions', passages: [passage('a'.repeat(40))] });
    assert.equal(result.answered, false);
    assert.equal(result.answered === false && result.reason, 'NO_EMBEDDING_PROVIDER');
    assert.ok(result.answered === false && result.action.length > 0, 'a refusal with no next step is a dead end');
  });

  it('passes a provider refusal through rather than degrading around it', async () => {
    const refusing: EmbeddingProvider = {
      model: 'x',
      embed: async () => {
        throw new Error('WALLET_EMPTY: no ACU credit');
      },
    };
    const result = await retrieve({
      query: 'q',
      passages: [passage('a'.repeat(40))],
      provider: refusing,
    });
    assert.equal(result.answered === false && result.reason, 'PROVIDER_REFUSED');
    assert.match(result.answered === false ? result.finding : '', /WALLET_EMPTY/);
  });

  it('returns nothing where nothing clears the similarity floor', async () => {
    // The answer an unfiltered index can never give, and usually the true one.
    const result = await retrieve({
      query: 'q',
      passages: [passage('a'.repeat(40)), passage('b'.repeat(40), 'r-2')],
      provider: provider([
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]),
    });
    assert.equal(result.answered === false && result.reason, 'NOTHING_RELEVANT');
  });

  it('returns only what clears the floor, ranked', async () => {
    const result = await retrieve({
      query: 'q',
      passages: [passage('close'.repeat(10)), passage('far'.repeat(10), 'r-2'), passage('closest'.repeat(10), 'r-3')],
      provider: provider([
        [1, 0],
        [0.8, 0.6],
        [0, 1],
        [0.99, 0.14],
      ]),
    });
    assert.equal(result.answered, true);
    if (result.answered) {
      assert.equal(result.hits.length, 2, 'the orthogonal passage must be excluded');
      assert.ok(result.hits[0]!.similarity >= result.hits[1]!.similarity);
      for (const hit of result.hits) assert.ok(hit.similarity >= MINIMUM_SIMILARITY);
    }
  });

  it('keeps every hit attached to the record it came from', async () => {
    const result = await retrieve({
      query: 'q',
      passages: [passage('x'.repeat(40))],
      provider: provider([
        [1, 0],
        [1, 0],
      ]),
    });
    assert.ok(result.answered);
    if (result.answered) {
      // A retrieved sentence with no record behind it is unverifiable, and
      // unverifiable text is what this platform exists not to produce.
      assert.equal(result.hits[0]!.ref.refType, 'RFI');
      assert.ok(result.hits[0]!.ref.refId.length > 0);
      assert.equal(result.hits[0]!.text, 'x'.repeat(40), 'the passage must be returned as it stands');
    }
  });

  it('never summarises, and says so', async () => {
    const result = await retrieve({
      query: 'q',
      passages: [passage('x'.repeat(40))],
      provider: provider([
        [1, 0],
        [1, 0],
      ]),
    });
    assert.ok(result.answered);
    if (result.answered) {
      assert.ok(!('summary' in result) && !('answer' in result));
      assert.ok(result.caveats.some((line) => /summar/i.test(line)));
    }
  });

  it('names the model that produced the vectors', async () => {
    const result = await retrieve({
      query: 'q',
      passages: [passage('x'.repeat(40))],
      provider: provider(
        [
          [1, 0],
          [1, 0],
        ],
        'named-model-v2',
      ),
    });
    assert.equal(result.answered && result.model, 'named-model-v2');
  });

  it('refuses a provider that returns the wrong number of vectors', async () => {
    // Scoring passages against vectors that may belong to different text
    // produces plausible rankings out of nothing.
    const result = await retrieve({
      query: 'q',
      passages: [passage('a'.repeat(40)), passage('b'.repeat(40), 'r-2')],
      provider: provider([[1, 0]]),
    });
    assert.equal(result.answered === false && result.reason, 'PROVIDER_REFUSED');
  });

  it('says so where there is nothing indexable rather than returning an empty answer', async () => {
    const result = await retrieve({ query: 'q', passages: [], provider: provider([[1, 0]]) });
    assert.equal(result.answered === false && result.reason, 'NOTHING_INDEXED');
  });

  it('refuses to compare vectors of different lengths', () => {
    // Usually means the index was built with one model and queried with
    // another, which yields scores that look ordinary and mean nothing.
    assert.throws(() => cosine([1, 0], [1, 0, 0]), /Cannot compare a 2-dimension vector/);
  });

  it('scores a zero vector as zero rather than NaN', () => {
    assert.equal(cosine([0, 0], [1, 1]), 0);
  });

  it('indexes prose and skips ids, hashes and short values', () => {
    const passages = passagesFrom({ refType: 'RFI', refId: 'r' }, 'p', {
      id: '01ABCDEF',
      contentHash: 'sha256:aaaa',
      status: 'OPEN',
      title: 'short',
      description: 'The ground conditions encountered at the inlet works differ from the ground investigation report.',
    });
    assert.equal(passages.length, 1);
    assert.equal(passages[0]!.field, 'description');
    assert.ok(passages[0]!.text.length >= MINIMUM_PASSAGE);
  });

  it('indexes prose only, never a long identifier that happens to be a string', () => {
    // Length alone is not the filter. A content hash and a correlation id are
    // both long, both strings, and both match everything weakly and nothing
    // well — which is how a similarity floor stops working.
    const passages = passagesFrom({ refType: 'RFI', refId: 'r' }, 'p', {
      id: '01JQXZ8W9K2M4N6P8R0T2V4X6Z8B0D2F',
      contentHash: `sha256:${'a'.repeat(64)}`,
      correlationId: '7f9c2b41-6d8e-4a1f-9c3b-2e5a8d0f4b6c',
      chainHash: 'b'.repeat(64),
      description: 'The ground conditions encountered at the inlet works differ from the ground investigation report.',
    });
    assert.equal(passages.length, 1, 'only the prose field should be indexed');
    assert.equal(passages[0]!.field, 'description');
  });

  it('has no local stand-in, deliberately', () => {
    // Every other stand-in in this codebase is visibly a stand-in on its
    // output. A stand-in embedding is a vector, which nobody can read, and its
    // results rank and score exactly like real ones.
    assert.equal(embeddingProvider(), undefined);
  });
});

describe('over HTTP', () => {
  let platform: Platform;
  let seed: SeedResult;
  let server: Server;
  let base: string;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
    server = createGateway(platform);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(() => server.close());

  function tokenFor(who: keyof SeedResult['users']): string {
    const user = platform.user(seed.users[who]!.id);
    return issueTokens({
      actorId: user.id,
      tenantId: user.tenantId,
      partyId: user.partyId,
      roles: user.roles,
      mfaSatisfied: true,
    }).accessToken;
  }

  async function call(method: string, path: string, who: keyof SeedResult['users'], payload?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tokenFor(who)}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : undefined };
  }

  it('serves the feed to any authenticated identity, scoped per entry', async () => {
    const read = await call('GET', '/v1/changes?limit=5', 'admin');
    assert.equal(read.status, 200);
    assert.ok(read.body!.entries.length > 0);
    assert.ok(read.body!.contract.length > 0);
  });

  it('refuses the feed to an unauthenticated caller', async () => {
    assert.equal((await fetch(`${base}/v1/changes`)).status, 401);
  });

  it('rejects a forged cursor with a stated reason', async () => {
    const read = await call('GET', '/v1/changes?after=nonsense', 'admin');
    // 422 rather than 400: the gateway's mapping for a domain refusal. The
    // request was well-formed and the platform declined it.
    assert.equal(read.status, 422);
    assert.equal(read.body!.title, 'CHANGE_CURSOR_INVALID');
  });

  it('serves the project graph', async () => {
    const read = await call('GET', `/v1/projects/${seed.projectId}/graph`, 'admin');
    assert.equal(read.status, 200);
    assert.ok(read.body!.counts.nodes > 0);
    assert.ok(typeof read.body!.declaredShare === 'number');
  });

  it('answers semantic search with a stated refusal, not an error and not a guess', async () => {
    const read = await call('POST', `/v1/projects/${seed.projectId}/semantic-search`, 'admin', {
      query: 'ground conditions at the inlet works',
    });
    // 200 with `answered: false` — the endpoint worked and declined to answer,
    // which is a different thing from the endpoint failing.
    assert.equal(read.status, 200);
    assert.equal(read.body!.answered, false);
    assert.equal(read.body!.reason, 'NO_EMBEDDING_PROVIDER');
    assert.ok(read.body!.action.length > 0);
  });

  it('refuses semantic search to an unauthenticated caller', async () => {
    const response = await fetch(`${base}/v1/projects/${seed.projectId}/semantic-search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'x' }),
    });
    assert.equal(response.status, 401);
  });
});
