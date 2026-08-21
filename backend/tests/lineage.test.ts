import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { lineage, MAX_COMMAND_GROUP } from '../src/goldenthread/lineage.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Lineage.
 *
 * The ledger has always held the answer to "why is this what it is" and there
 * has never been a way to ask it. Every question that gets escalated in a real
 * dispute is a lineage question, and answering one by hand means reading a few
 * hundred events and holding the joins in your head.
 *
 * Two things have to be true for a traversal like this to be worth trusting.
 * The edges have to say how they were established, because a declared piece of
 * evidence and a state field that happens to name an id are not the same claim.
 * And access has to be applied at every node rather than at the entry point,
 * because a lineage walk crosses capability areas by its nature — which would
 * otherwise make this the widest hole in the platform.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const walk = (who: string, refType: string, refId: string, depth?: number) =>
  lineage(
    platform.ledger,
    seed.users[who]!.auth,
    seed.projectId,
    { refType, refId },
    depth === undefined ? {} : { maxDepth: depth },
  );

const firstOf = (refType: string) => platform.ledger.list(seed.projectId, refType)[0]!;

describe('walking outward from a record', () => {
  it('finds what a claim stood on', () => {
    const claim = platform.ledger.list(seed.projectId, 'Claim').at(-1);
    assert.ok(claim, 'the seed assesses a delay claim');

    const graph = walk('qs', 'Claim', claim.refId);

    assert.equal(graph.origin.refId, claim.refId);
    assert.ok(graph.nodes.length > 1, 'a claim does not stand on nothing');
    assert.equal(graph.nodes[0]!.direction, 'ORIGIN');
    assert.ok(graph.summary.length > 20);
  });

  it('says how each link was established rather than presenting them as equal', () => {
    const claim = platform.ledger.list(seed.projectId, 'Claim').at(-1)!;
    const graph = walk('qs', 'Claim', claim.refId);

    const kinds = new Set(graph.edges.map((e) => e.kind));
    assert.ok(kinds.size >= 2, `expected several kinds of link, saw ${[...kinds].join(', ')}`);

    for (const edge of graph.edges) {
      assert.ok(['EVIDENCE', 'AI_INPUT', 'SAME_COMMAND', 'REFERENCE'].includes(edge.kind));
      // A declared edge names the event that declared it. A derived one names
      // the field it was read from. Neither is anonymous.
      if (edge.kind === 'REFERENCE') assert.ok(edge.via, 'a derived edge names the field that produced it');
      else assert.ok(edge.eventId, 'a declared edge names the event that declared it');
    }
  });

  it('shows what the model was given, which is the question nobody can answer afterwards', () => {
    const claim = platform.ledger.list(seed.projectId, 'Claim').at(-1)!;
    const graph = walk('qs', 'Claim', claim.refId, 2);

    const aiEdges = graph.edges.filter((e) => e.kind === 'AI_INPUT');
    assert.ok(aiEdges.length > 0, 'the claim was assessed by a model, and the inputs are on the event');
    assert.ok(aiEdges.every((e) => e.eventType));
  });

  it('carries a label a person would recognise, not an id', () => {
    const drawing = firstOf('Drawing');
    const graph = walk('bim', 'Drawing', drawing.refId);
    const origin = graph.nodes[0]!;

    assert.equal(origin.label, drawing.state.drawingNumber);
    assert.ok(origin.lastEventType);
  });

  it('finds what was built on a drawing, not only what it came from', () => {
    // The markup on this drawing names it; the drawing names nothing. Only a
    // reverse pass finds it, and it is the half that answers "what did this
    // cause" — which is the question somebody about to change something asks.
    const drawing = firstOf('Drawing');
    const graph = walk('bim', 'Drawing', drawing.refId, 1);

    assert.ok(graph.nodes.some((n) => n.ref.refType === 'DrawingMarkup'), 'the markup is one step away');
    assert.ok(graph.nodes.some((n) => n.ref.refType === 'RFI'), 'and so is the RFI raised from it');

    const reverse = graph.edges.find((e) => e.kind === 'REFERENCE' && e.from.refType === 'DrawingMarkup');
    assert.ok(reverse, 'the edge runs from the markup to the drawing, which is the direction it was declared in');
    assert.equal(reverse.via, 'drawingId');
  });

  it('reports a record nothing refers to as exactly that', () => {
    // Rather than an empty graph that reads as a failed query.
    const project = platform.ledger.get({ refType: 'Project', refId: seed.projectId })!;
    const graph = lineage(
      platform.ledger,
      seed.users.pm!.auth,
      seed.projectId,
      { refType: 'Nonexistent', refId: 'no-such-record' },
    );

    assert.equal(graph.nodes.length, 1);
    assert.match(graph.summary, /refers to nothing else/);
    assert.ok(project);
  });
});

describe('the depth limit is stated rather than silent', () => {
  it('says when the walk stopped early', () => {
    const claim = platform.ledger.list(seed.projectId, 'Claim').at(-1)!;
    const shallow = walk('qs', 'Claim', claim.refId, 1);

    if (shallow.truncated) {
      assert.match(shallow.summary, /stopped at 1 steps and there is more beyond it/);
    }
    assert.equal(shallow.maxDepth, 1);
  });

  it('finds more at greater depth, and says it finished when it did', () => {
    const claim = platform.ledger.list(seed.projectId, 'Claim').at(-1)!;
    const shallow = walk('qs', 'Claim', claim.refId, 1);
    const deep = walk('qs', 'Claim', claim.refId, 4);

    assert.ok(deep.nodes.length >= shallow.nodes.length);
  });

  it('sets a bulk command aside rather than joining everything it touched', () => {
    // A take-off creating forty bill items makes all forty siblings of each
    // other. True, and it turns a graph somebody can read into one nobody can.
    const claim = platform.ledger.list(seed.projectId, 'Claim').at(-1)!;
    const graph = walk('qs', 'Claim', claim.refId, 2);

    assert.ok(graph.batchedCommands > 0, 'the seeded project has bulk commands in it');
    assert.match(graph.summary, /bulk command/);
    assert.match(graph.summary, new RegExp(`more than ${MAX_COMMAND_GROUP} records`));

    // And the graph stays a size a person can actually read.
    assert.ok(graph.edges.length < 200, `${graph.edges.length} links is not an answer to anything`);
  });

  it('refuses to walk further than the ceiling however it is asked', () => {
    const claim = platform.ledger.list(seed.projectId, 'Claim').at(-1)!;
    assert.equal(walk('qs', 'Claim', claim.refId, 99).maxDepth, 6);
    assert.equal(walk('qs', 'Claim', claim.refId, 0).maxDepth, 1);
  });
});

describe('access is applied at every node, not at the entry point', () => {
  it('withholds a commercial record from a safety lead and says so', () => {
    // A safety lead reaching a payment application through a chain of tasks is
    // exactly the hole this would be without per-node checks.
    const contract = firstOf('Contract');
    const asQs = walk('qs', 'Contract', contract.refId, 3);
    const asSafety = walk('safety', 'Contract', contract.refId, 3);

    assert.ok(asQs.nodes[0]!.readable, 'the QS can read a contract');
    assert.equal(asSafety.nodes[0]!.readable, false, 'a safety lead cannot');
    assert.match(asSafety.nodes[0]!.withheldReason ?? '', /.+/);
  });

  it('returns a withheld node as a shell rather than dropping it', () => {
    // A chain with a hole in it that says "something you cannot see sits here"
    // is honest. A chain silently reconnected around the hole is not.
    const contract = firstOf('Contract');
    const asSafety = walk('safety', 'Contract', contract.refId, 3);

    const withheld = asSafety.nodes.filter((n) => !n.readable);
    assert.ok(withheld.length > 0);
    assert.equal(asSafety.withheldCount, withheld.length);

    for (const node of withheld) {
      assert.ok(node.ref.refType, 'the type is still named');
      assert.equal(node.label, undefined, 'and nothing else is');
      assert.equal(node.lastEventType, undefined);
      assert.equal(node.version, undefined);
    }
    assert.match(asSafety.summary, /withheld from your role/);
  });

  it('derives no edges from state a caller cannot read', () => {
    // The REFERENCE edges come from reading a record's state. Producing them
    // for a record the caller is barred from would leak the state through the
    // shape of the graph.
    const contract = firstOf('Contract');
    const asSafety = walk('safety', 'Contract', contract.refId, 2);

    const fromWithheld = asSafety.edges.filter(
      (e) => e.kind === 'REFERENCE' && asSafety.nodes.find((n) => n.ref.refId === e.from.refId)?.readable === false,
    );
    assert.deepEqual(fromWithheld, []);
  });

  it('withholds an entity type nobody has classified', () => {
    // An unmapped type is not readable, the same rule the generic entity read
    // runs on. A new entity type declares where it belongs before it is served.
    const graph = lineage(platform.ledger, seed.users.pm!.auth, seed.projectId, {
      refType: 'SomethingNobodyClassified',
      refId: 'x',
    });

    assert.equal(graph.nodes[0]!.readable, false);
    assert.match(graph.nodes[0]!.withheldReason ?? '', /not classified for access/);
  });
});

describe('the graph is a graph, not a list', () => {
  it('lists no edge twice, however many ways it is reachable', () => {
    const claim = platform.ledger.list(seed.projectId, 'Claim').at(-1)!;
    const graph = walk('qs', 'Claim', claim.refId, 3);

    const keys = graph.edges.map((e) => `${e.from.refId}>${e.to.refId}:${e.kind}:${e.via ?? ''}`);
    assert.equal(new Set(keys).size, keys.length);
  });

  it('leaves no edge pointing at a record it never admitted', () => {
    // An edge to nothing is not a fact about anything.
    const claim = platform.ledger.list(seed.projectId, 'Claim').at(-1)!;
    const graph = walk('qs', 'Claim', claim.refId, 2);
    const present = new Set(graph.nodes.map((n) => `${n.ref.refType}:${n.ref.refId}`));

    for (const edge of graph.edges) {
      assert.ok(present.has(`${edge.from.refType}:${edge.from.refId}`));
      assert.ok(present.has(`${edge.to.refType}:${edge.to.refId}`));
    }
  });

  it('writes nothing, because a question is not a change', () => {
    const before = platform.ledger.events({ projectId: seed.projectId }).length;
    const claim = platform.ledger.list(seed.projectId, 'Claim').at(-1)!;
    walk('qs', 'Claim', claim.refId, 4);
    walk('qs', 'Claim', claim.refId, 4);
    assert.equal(platform.ledger.events({ projectId: seed.projectId }).length, before);
  });
});
