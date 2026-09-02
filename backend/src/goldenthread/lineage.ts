import { config } from '../config.ts';
import { ENTITY_ACCESS } from '../identity/entityAccess.ts';
import { evaluateAccess } from '../identity/abac.ts';
import type { AuthContext } from '../identity/auth.ts';
import type { GoldenThreadLedger } from './ledger.ts';
import type { EntityRef, GoldenThreadEvent } from './types.ts';

/**
 * Lineage: what caused this, and what did this cause.
 *
 * The ledger has always held the answer and there has never been a way to ask
 * it. Every question that gets escalated in a real dispute is a lineage
 * question — *why is this variation valued at this figure*, *what did the model
 * read before it produced that forecast*, *which drawing revision was the site
 * working to when this was built* — and answering one by hand means reading a
 * few hundred events and holding the joins in your head.
 *
 * No graph store. A graph store would be a second copy of a relationship the
 * ledger already records, and the two would disagree the first time one of them
 * was rebuilt. This walks the ledger.
 *
 * **Edges are labelled by how they were established**, because they are not
 * equally strong and presenting them as though they were would be the whole
 * problem with a knowledge graph nobody can audit:
 *
 * - `EVIDENCE` — an event declared this record as its evidence. Strongest:
 *   somebody committed to it at the time, and the hash is on the record.
 * - `AI_INPUT` — the model was given this record before it produced an output.
 *   Equally declared, and the one that answers "what did it actually read".
 * - `SAME_COMMAND` — one command produced both, sharing a correlation id. A
 *   causal fact about the request rather than about the domain, and the one
 *   that needs a limit: a take-off creating forty bill items makes all forty
 *   siblings of each other, which is true and useless. Above
 *   `MAX_COMMAND_GROUP` records a command is treated as a batch rather than a
 *   relationship, and the graph says how many it set aside.
 * - `REFERENCE` — one record's state names the other's id. Derived by reading
 *   the state rather than declared, so it is real but weaker: a field called
 *   `supersedes` and a field called `contractId` both produce this edge and
 *   they do not mean the same thing. The field name is carried so the reader
 *   can tell.
 *
 * **Access is applied per node, not at the entry point.** A lineage walk
 * crosses capability areas by its nature — a safety observation leads to a task
 * leads to a variation leads to a payment application — so authorising the
 * starting record and then walking freely would turn this into the widest hole
 * in the platform. Every node is classified and evaluated, and one the caller
 * cannot read is returned as a shell: its type and the edge that reached it,
 * with no state and no label. That is deliberate rather than dropping it — a
 * chain with a hole in it that says "something you cannot see sits here" is
 * honest, and a chain silently reconnected around the hole is not.
 */

/**
 * `labelOf`, `buildIdIndex` and `referencesIn` are exported for
 * `datalayer/graph.ts`, which projects the whole project's graph rather than
 * walking outward from one record. They are the same derivation, and a second
 * copy of it would disagree with this one the first time either was changed —
 * which on a graph means two answers to "what caused this".
 *
 * Nothing else should use them: they are the mechanics of edge derivation, not
 * an API for reading relationships. `lineage()` and `projectGraph()` are.
 */

export type LineageEdgeKind = 'EVIDENCE' | 'AI_INPUT' | 'SAME_COMMAND' | 'REFERENCE';

export type LineageEdge = {
  from: EntityRef;
  to: EntityRef;
  kind: LineageEdgeKind;
  /** For a REFERENCE edge, the state field that named it. */
  via?: string;
  /** The event that established the edge, where one did. */
  eventId?: string;
  eventType?: string;
  timestamp?: string;
};

export type LineageNode = {
  ref: EntityRef;
  /** Absent where the caller may not read this type. */
  label?: string;
  version?: number;
  lastEventType?: string;
  lastEventAt?: string;
  /** Distance from the starting record, in edges. */
  depth: number;
  direction: 'ORIGIN' | 'UPSTREAM' | 'DOWNSTREAM';
  readable: boolean;
  /** Why it is not readable, where it is not. */
  withheldReason?: string;
};

export type LineageGraph = {
  origin: EntityRef;
  nodes: LineageNode[];
  edges: LineageEdge[];
  /** True where the walk stopped at the depth limit rather than at the end. */
  truncated: boolean;
  maxDepth: number;
  withheldCount: number;
  /**
   * Commands that touched too many records to be treated as a relationship.
   * Reported rather than dropped quietly — a bulk import is a real thing that
   * happened, and a graph that silently omitted it would look complete.
   */
  batchedCommands: number;
  summary: string;
};

/**
 * How many records one command may touch before it stops being a lineage fact.
 *
 * A command that writes a variation and the change request behind it has told
 * you something. A command that creates forty bill items has told you it was a
 * bulk import, and joining all forty to everything they touch turns a graph
 * somebody can read into one nobody can.
 */
export const MAX_COMMAND_GROUP = 8;

/** Fields that hold a foreign id but say nothing useful about lineage. */
const IGNORED_FIELDS = new Set(['id', 'projectId', 'tenantId', 'correlationId']);

/**
 * A human label for a record, chosen from whichever naming field it has.
 *
 * Entity types name themselves differently and there is no common field. The
 * order matters: a reference is what a person would quote, a title is what they
 * would recognise, and an id is the fallback that means the record has neither.
 */
export function labelOf(state: Record<string, unknown>): string | undefined {
  for (const field of ['reference', 'drawingNumber', 'activityCode', 'wbsCode', 'title', 'name', 'description']) {
    const value = state[field];
    if (typeof value === 'string' && value.trim().length > 0) return value.length > 90 ? `${value.slice(0, 90)}…` : value;
  }
  return undefined;
}

/** Every entity id in a project, so a state field naming one can be recognised. */
export function buildIdIndex(ledger: GoldenThreadLedger, projectId: string): Map<string, EntityRef> {
  const index = new Map<string, EntityRef>();
  for (const event of ledger.events({ projectId })) {
    index.set(event.entity.refId, event.entity);
  }
  return index;
}

/** Ids named anywhere in a record's state, with the field that named them. */
export function referencesIn(state: Record<string, unknown>, index: Map<string, EntityRef>): Array<{ ref: EntityRef; via: string }> {
  const found: Array<{ ref: EntityRef; via: string }> = [];

  const walk = (value: unknown, path: string, depth: number): void => {
    // Bounded because a state object is arbitrary JSON and a deep one would
    // otherwise be walked to exhaustion for no gain — ids do not live at the
    // bottom of a nested structure in this domain.
    if (depth > 4) return;

    if (typeof value === 'string') {
      const target = index.get(value);
      if (target) found.push({ ref: target, via: path });
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, path, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (IGNORED_FIELDS.has(key)) continue;
        walk(nested, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  };

  for (const [key, value] of Object.entries(state)) {
    if (IGNORED_FIELDS.has(key)) continue;
    walk(value, key, 0);
  }
  return found;
}

const key = (ref: EntityRef): string => `${ref.refType}:${ref.refId}`;

/**
 * Walk the ledger outward from one record.
 *
 * Both directions at once, because a lineage question is almost never one or
 * the other: somebody asking why a figure is what it is also needs to know what
 * has been built on top of it before they change anything.
 */
export function lineage(
  ledger: GoldenThreadLedger,
  auth: AuthContext,
  projectId: string,
  origin: EntityRef,
  options: { maxDepth?: number; authzOptions?: Parameters<typeof evaluateAccess>[4] } = {},
): LineageGraph {
  const maxDepth = Math.max(1, Math.min(options.maxDepth ?? 3, 6));
  const events = ledger.events({ projectId });
  const index = buildIdIndex(ledger, projectId);

  // Events grouped by the entity they touched, and by the command that caused
  // them. Both are needed in both directions, so they are built once.
  const byEntity = new Map<string, GoldenThreadEvent[]>();
  const byCorrelation = new Map<string, GoldenThreadEvent[]>();
  for (const event of events) {
    const entityKey = key(event.entity);
    (byEntity.get(entityKey) ?? byEntity.set(entityKey, []).get(entityKey)!).push(event);
    (byCorrelation.get(event.correlationId) ?? byCorrelation.set(event.correlationId, []).get(event.correlationId)!).push(event);
  }

  const edges: LineageEdge[] = [];
  const batchedCommands = new Set<string>();
  /** Which readable records name a given record. Built once, on first use. */
  let reverseRefs: Map<string, Array<{ from: EntityRef; via: string }>> | undefined;
  const seen = new Map<string, LineageNode>();
  const readableCache = new Map<string, { readable: boolean; reason?: string }>();

  function readable(ref: EntityRef): { readable: boolean; reason?: string } {
    const cached = readableCache.get(ref.refType);
    if (cached) return cached;

    const classification = ENTITY_ACCESS[ref.refType];
    if (!classification) {
      // An unmapped type is not readable, the same rule the generic entity read
      // runs on. A new entity type declares where it belongs before it is served.
      const verdict = { readable: false, reason: `${ref.refType} is not classified for access` };
      readableCache.set(ref.refType, verdict);
      return verdict;
    }

    const decision = evaluateAccess(
      auth,
      classification.area,
      'R',
      { tenantId: auth.tenantId, projectId, dataSensitivity: classification.sensitivity },
      options.authzOptions ?? {
        rbacEnabled: config.authz.rbac,
        scopesEnabled: config.authz.scopes,
        abacEnabled: config.authz.abac,
      },
    );
    const verdict =
      decision.decision === 'ALLOW'
        ? { readable: true }
        : { readable: false, reason: decision.reason ?? `Not permitted to read ${ref.refType}` };
    readableCache.set(ref.refType, verdict);
    return verdict;
  }

  /**
   * Who names this record.
   *
   * The forward direction falls out of reading one record's state. The reverse
   * does not, and it is the half that answers "what did this cause" — from a
   * drawing, the markups and RFIs raised against it. Built once over the
   * project, and only from records the caller may read: an edge derived from
   * state they are barred from would leak that state through the shape of the
   * graph.
   */
  function referencesTo(ref: EntityRef): Array<{ from: EntityRef; via: string }> {
    if (!reverseRefs) {
      reverseRefs = new Map();
      for (const target of index.values()) {
        if (!readable(target).readable) continue;
        const record = ledger.get(target);
        if (!record) continue;
        for (const reference of referencesIn(record.state, index)) {
          const targetKey = key(reference.ref);
          if (targetKey === key(target)) continue;
          const list = reverseRefs.get(targetKey) ?? reverseRefs.set(targetKey, []).get(targetKey)!;
          list.push({ from: target, via: reference.via });
        }
      }
    }
    return reverseRefs.get(key(ref)) ?? [];
  }

  function visit(ref: EntityRef, depth: number, direction: LineageNode['direction']): void {
    const nodeKey = key(ref);
    const existing = seen.get(nodeKey);
    if (existing) {
      // Keep the shortest path to a record, and mark it as reached from both
      // sides where it is — a record that is both cause and consequence is a
      // real and interesting shape, not a bug to be tidied away.
      if (depth < existing.depth) existing.depth = depth;
      if (existing.direction !== direction && existing.direction !== 'ORIGIN') existing.direction = 'ORIGIN';
      return;
    }

    const verdict = readable(ref);
    const record = verdict.readable ? ledger.get(ref) : undefined;
    const entityEvents = byEntity.get(nodeKey) ?? [];
    const last = entityEvents.at(-1);

    seen.set(nodeKey, {
      ref,
      label: record ? labelOf(record.state) : undefined,
      version: record?.version,
      lastEventType: verdict.readable ? last?.eventType : undefined,
      lastEventAt: verdict.readable ? last?.timestamp : undefined,
      depth,
      direction,
      readable: verdict.readable,
      withheldReason: verdict.readable ? undefined : verdict.reason,
    });
  }

  visit(origin, 0, 'ORIGIN');

  /**
   * Everything one step from a set of records, recording the edge that reached
   * it. Called once per ring, and once more at the ceiling to establish whether
   * there was anything beyond it — a walk that says it was truncated when it in
   * fact finished sends people looking for records that are not there.
   */
  function neighboursOf(frontier: EntityRef[], recordEdges: boolean): EntityRef[] {
    const next: EntityRef[] = [];

    for (const ref of frontier) {
      const nodeKey = key(ref);
      const entityEvents = byEntity.get(nodeKey) ?? [];

      // --- Upstream: what this record stood on -----------------------------
      for (const event of entityEvents) {
        for (const evidence of event.evidenceRefs ?? []) {
          if (recordEdges) {
            edges.push({ from: evidence, to: ref, kind: 'EVIDENCE', eventId: event.eventId, eventType: event.eventType, timestamp: event.timestamp });
          }
          next.push(evidence);
        }
        for (const input of event.ai?.inputRefs ?? []) {
          if (recordEdges) {
            edges.push({ from: input, to: ref, kind: 'AI_INPUT', eventId: event.eventId, eventType: event.eventType, timestamp: event.timestamp });
          }
          next.push(input);
        }
        // Records touched by the same command. The command is the causal unit
        // — up to the point where it is plainly a batch rather than a chain.
        const group = byCorrelation.get(event.correlationId) ?? [];
        if (group.length > MAX_COMMAND_GROUP) {
          batchedCommands.add(event.correlationId);
          continue;
        }
        for (const sibling of group) {
          if (key(sibling.entity) === nodeKey) continue;
          if (recordEdges) {
            edges.push({
              from: sibling.entity,
              to: ref,
              kind: 'SAME_COMMAND',
              eventId: sibling.eventId,
              eventType: sibling.eventType,
              timestamp: sibling.timestamp,
            });
          }
          next.push(sibling.entity);
        }
      }

      // Ids this record's state names. Only where it can be read — deriving
      // edges from state the caller may not see would leak the state.
      if (readable(ref).readable) {
        const record = ledger.get(ref);
        if (record) {
          for (const reference of referencesIn(record.state, index)) {
            if (key(reference.ref) === nodeKey) continue;
            if (recordEdges) edges.push({ from: ref, to: reference.ref, kind: 'REFERENCE', via: reference.via });
            next.push(reference.ref);
          }
        }
      }

      // --- Downstream: what was built on this ------------------------------
      for (const source of referencesTo(ref)) {
        if (key(source.from) === nodeKey) continue;
        if (recordEdges) edges.push({ from: source.from, to: ref, kind: 'REFERENCE', via: source.via });
        next.push(source.from);
      }

      for (const event of events) {
        if (key(event.entity) === nodeKey) continue;

        if ((event.evidenceRefs ?? []).some((e) => key(e) === nodeKey)) {
          if (recordEdges) {
            edges.push({ from: ref, to: event.entity, kind: 'EVIDENCE', eventId: event.eventId, eventType: event.eventType, timestamp: event.timestamp });
          }
          next.push(event.entity);
        }
        if ((event.ai?.inputRefs ?? []).some((e) => key(e) === nodeKey)) {
          if (recordEdges) {
            edges.push({ from: ref, to: event.entity, kind: 'AI_INPUT', eventId: event.eventId, eventType: event.eventType, timestamp: event.timestamp });
          }
          next.push(event.entity);
        }
      }
    }

    return next;
  }

  let frontier: EntityRef[] = [origin];
  let truncated = false;

  for (let depth = 1; depth <= maxDepth; depth++) {
    const unseen = neighboursOf(frontier, true).filter((candidate) => !seen.has(key(candidate)));
    if (unseen.length === 0) break;

    for (const candidate of unseen) visit(candidate, depth, 'UPSTREAM');
    frontier = unseen;

    if (depth === maxDepth) {
      // Establish whether anything actually lies beyond the ceiling rather than
      // assuming it. Saying a walk was truncated when it in fact finished sends
      // people looking for records that are not there.
      truncated = neighboursOf(frontier, false).some((candidate) => !seen.has(key(candidate)));
    }
  }

  // Deduplicate edges. The same relationship is reachable from both ends of the
  // walk, and a graph that lists it twice reads as two facts.
  const uniqueEdges = [...new Map(edges.map((e) => [`${key(e.from)}>${key(e.to)}:${e.kind}:${e.via ?? ''}`, e])).values()];

  // Edges to records the walk never admitted as nodes are dropped rather than
  // left dangling — an edge to nothing is not a fact about anything.
  const withinGraph = uniqueEdges.filter((e) => seen.has(key(e.from)) && seen.has(key(e.to)));

  const nodes = [...seen.values()].sort((a, b) => a.depth - b.depth);
  const withheldCount = nodes.filter((n) => !n.readable).length;

  const summary =
    nodes.length === 1
      ? 'Nothing else in the project record refers to this, and it refers to nothing else.'
      : `${nodes.length - 1} related record${nodes.length === 2 ? '' : 's'} across ${withinGraph.length} link${withinGraph.length === 1 ? '' : 's'}` +
        (withheldCount > 0 ? `, ${withheldCount} withheld from your role` : '') +
        (truncated ? `. The walk stopped at ${maxDepth} steps and there is more beyond it` : '') +
        (batchedCommands.size > 0
          ? `. ${batchedCommands.size} bulk command${batchedCommands.size === 1 ? '' : 's'} touched more than ${MAX_COMMAND_GROUP} records each and ${batchedCommands.size === 1 ? 'was' : 'were'} not treated as a chain.`
          : '.');

  return { origin, nodes, edges: withinGraph, truncated, maxDepth, withheldCount, batchedCommands: batchedCommands.size, summary };
}
