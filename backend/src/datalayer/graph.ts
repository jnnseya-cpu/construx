import { config } from '../config.ts';
import { ENTITY_ACCESS } from '../identity/entityAccess.ts';
import { evaluateAccess } from '../identity/abac.ts';
import type { AuthContext } from '../identity/auth.ts';
import type { GoldenThreadLedger } from '../goldenthread/ledger.ts';
import {
  buildIdIndex,
  labelOf,
  MAX_COMMAND_GROUP,
  referencesIn,
  type LineageEdgeKind,
} from '../goldenthread/lineage.ts';
import type { EntityRef } from '../goldenthread/types.ts';

/**
 * The knowledge graph, projected across a whole project rather than walked out
 * from one record.
 *
 * ## Why this is not a second graph
 *
 * `goldenthread/lineage.ts` answers "what caused this record, and what did it
 * cause" — a walk from a root, which is the right shape for the question a
 * person asks in a dispute. It cannot answer the questions that are about the
 * *shape* of the record: which records everything hangs off, which are floating
 * unconnected, whether the evidence in this project is declared or merely
 * inferred.
 *
 * So this projects the same edges over the whole project. **The same edges** —
 * `buildIdIndex`, `referencesIn` and `labelOf` are imported from lineage rather
 * than reimplemented, because two derivations of "what caused this" would
 * disagree the first time either was touched, and on a graph that means the
 * platform giving two answers to the same question.
 *
 * ## Still no graph store
 *
 * For lineage's reason, restated because it applies harder here: a stored graph
 * is a second copy of a relationship the ledger already holds, and the two
 * diverge the first time one is rebuilt. This is computed on demand from the
 * log, which is slower and is always right.
 *
 * ## Edges are not equal and the projection says so
 *
 * A `REFERENCE` edge is derived by noticing that one record's state contains
 * another's id. That is real and it is weak — a field called `supersedes` and a
 * field called `contractId` both produce one. An `EVIDENCE` edge was declared
 * by somebody at the time. A graph that presented the two as the same line is
 * the thing that makes knowledge graphs untrustworthy, so the counts are kept
 * separate and the **declared share** is reported as its own figure.
 */

export type GraphNode = {
  ref: EntityRef;
  label?: string;
  /** Edges touching this record, in each direction. */
  inbound: number;
  outbound: number;
  readable: boolean;
};

export type GraphEdge = {
  from: EntityRef;
  to: EntityRef;
  kind: LineageEdgeKind;
  via?: string;
};

export type ProjectGraph = {
  projectId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  counts: {
    nodes: number;
    edges: number;
    byKind: Array<{ kind: LineageEdgeKind; edges: number }>;
    /** Records with no edge at all. */
    orphans: number;
    /** Records this caller may not read. Counted; never described. */
    withheld: number;
    /** Commands that touched more records than a relationship can mean. */
    batchedCommands: number;
  };
  /**
   * The share of edges that somebody declared — evidence or an AI input —
   * rather than the platform inferring from a field.
   *
   * The one number that says how much of this graph is worth relying on. A
   * project sitting at 5% declared has a graph mostly assembled by pattern
   * matching, and reading a dispute out of it would be a mistake.
   */
  declaredShare: number;
  /** Records the most is hung off. Where an error would propagate furthest. */
  hubs: Array<{ ref: EntityRef; label?: string; edges: number }>;
  findings: string[];
};

const key = (ref: EntityRef): string => `${ref.refType}:${ref.refId}`;

export function projectGraph(
  ledger: GoldenThreadLedger,
  auth: AuthContext,
  projectId: string,
  options: { authzOptions?: Parameters<typeof evaluateAccess>[4]; hubs?: number } = {},
): ProjectGraph {
  const events = ledger.events({ projectId, tenantId: auth.tenantId });
  const index = buildIdIndex(ledger, projectId);

  const authz = options.authzOptions ?? {
    rbacEnabled: config.authz.rbac,
    scopesEnabled: config.authz.scopes,
    abacEnabled: config.authz.abac,
  };

  /** Whether this caller may read a record of this type on this project. */
  const readable = (ref: EntityRef): boolean => {
    const classification = ENTITY_ACCESS[ref.refType];
    if (!classification) return true;
    return (
      evaluateAccess(
        auth,
        classification.area,
        'R',
        { tenantId: auth.tenantId, projectId, dataSensitivity: classification.sensitivity },
        authz,
      ).decision === 'ALLOW'
    );
  };

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();
  let withheld = 0;

  const node = (ref: EntityRef): GraphNode | undefined => {
    const id = key(ref);
    const held = nodes.get(id);
    if (held) return held;
    if (!readable(ref)) {
      withheld += 1;
      // Not added at all. In a lineage *chain* a hole that says "something you
      // cannot see sits here" is honest; in a whole-project projection it would
      // be thousands of shells nobody can act on, and the count is the honest
      // form of the same fact.
      return undefined;
    }
    const created: GraphNode = { ref, inbound: 0, outbound: 0, readable: true };
    nodes.set(id, created);
    return created;
  };

  const link = (from: EntityRef, to: EntityRef, kind: LineageEdgeKind, via?: string): void => {
    if (key(from) === key(to)) return;
    const source = node(from);
    const target = node(to);
    if (!source || !target) return;
    const id = `${key(from)}>${key(to)}:${kind}:${via ?? ''}`;
    if (seenEdge.has(id)) return;
    seenEdge.add(id);
    edges.push({ from, to, kind, ...(via ? { via } : {}) });
    source.outbound += 1;
    target.inbound += 1;
  };

  // Group by correlation id first, so a batch can be recognised before any of
  // its members is joined to the rest.
  const byCommand = new Map<string, EntityRef[]>();
  for (const event of events) {
    const group = byCommand.get(event.correlationId) ?? [];
    if (!group.some((ref) => key(ref) === key(event.entity))) group.push(event.entity);
    byCommand.set(event.correlationId, group);
  }

  let batchedCommands = 0;
  for (const group of byCommand.values()) {
    if (group.length < 2) continue;
    if (group.length > MAX_COMMAND_GROUP) {
      batchedCommands += 1;
      continue;
    }
    for (let a = 0; a < group.length; a += 1) {
      for (let b = a + 1; b < group.length; b += 1) link(group[a]!, group[b]!, 'SAME_COMMAND');
    }
  }

  for (const event of events) {
    // Seed the node even where it has no edges, or an unconnected record is
    // invisible and `orphans` under-reports.
    node(event.entity);

    for (const evidence of event.evidenceRefs ?? []) link(event.entity, evidence, 'EVIDENCE');
    for (const input of event.ai?.inputRefs ?? []) link(event.entity, input, 'AI_INPUT');
  }

  // References come off current state rather than off the diff: a field that
  // named a record and was later changed is not a relationship that still
  // holds, and reporting it as one would age the graph into fiction.
  for (const [id, held] of nodes) {
    const record = ledger.get(held.ref);
    if (!record) continue;
    for (const { ref, via } of referencesIn(record.state as Record<string, unknown>, index)) {
      link(held.ref, ref, 'REFERENCE', via);
    }
    const label = labelOf(record.state as Record<string, unknown>);
    if (label) nodes.get(id)!.label = label;
  }

  const byKind = (['EVIDENCE', 'AI_INPUT', 'SAME_COMMAND', 'REFERENCE'] as const).map((kind) => ({
    kind: kind as LineageEdgeKind,
    edges: edges.filter((edge) => edge.kind === kind).length,
  }));

  const declared = edges.filter((edge) => edge.kind === 'EVIDENCE' || edge.kind === 'AI_INPUT').length;
  const declaredShare = edges.length > 0 ? declared / edges.length : 0;

  const ranked = [...nodes.values()]
    .map((held) => ({ ref: held.ref, ...(held.label ? { label: held.label } : {}), edges: held.inbound + held.outbound }))
    .filter((entry) => entry.edges > 0)
    .sort((a, b) => b.edges - a.edges)
    .slice(0, Math.max(1, options.hubs ?? 10));

  const orphans = [...nodes.values()].filter((held) => held.inbound + held.outbound === 0).length;

  const findings: string[] = [];
  if (edges.length === 0) {
    findings.push('Nothing in this project is connected to anything else yet.');
  } else if (declaredShare < 0.2) {
    findings.push(
      `Only ${Math.round(declaredShare * 100)}% of these connections were declared — the rest were inferred by ` +
        'noticing one record’s id inside another. That is real but weak, and a dispute should not be argued from it.',
    );
  }
  if (orphans > 0) {
    findings.push(
      `${orphans} record${orphans === 1 ? '' : 's'} connect to nothing. Each is either genuinely standalone or ` +
        'evidence somebody never linked.',
    );
  }
  if (batchedCommands > 0) {
    findings.push(
      `${batchedCommands} command${batchedCommands === 1 ? '' : 's'} touched more than ${MAX_COMMAND_GROUP} records ` +
        'and were treated as bulk work rather than as relationships. They happened; they are not joins.',
    );
  }
  if (withheld > 0) {
    findings.push(`${withheld} records in this project are not readable by this identity and are absent from the graph.`);
  }

  return {
    projectId,
    nodes: [...nodes.values()],
    edges,
    counts: { nodes: nodes.size, edges: edges.length, byKind, orphans, withheld, batchedCommands },
    declaredShare,
    hubs: ranked,
    findings,
  };
}
