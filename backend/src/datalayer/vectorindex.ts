import { DomainError } from '../core/errors.ts';

/**
 * Semantic retrieval over the record, and the discipline that decides whether
 * it may answer at all.
 *
 * ## The failure this file exists to refuse
 *
 * A vector index is the standard way to make a corpus searchable by meaning,
 * and in this domain it is also the standard way to produce a confident wrong
 * answer. Somebody asks "what did we agree about the inlet works ground
 * conditions", four passages come back ranked by cosine similarity, a model
 * writes a paragraph from them, and the paragraph reads exactly as well whether
 * the passages were relevant or merely the least irrelevant of what was
 * indexed. Nearest-neighbour search **always returns neighbours**. There is no
 * such thing as an empty result unless something refuses to produce one.
 *
 * So the refusal is the design:
 *
 * - **No embeddings, no retrieval.** Where the orchestrator cannot obtain an
 *   embedding — no healthy provider, an empty wallet — this returns a stated
 *   refusal. It never falls back to keyword matching dressed as semantic
 *   search, and it never fabricates a vector. A cheaper answer that looks like
 *   the expensive one is the worst outcome available.
 * - **Below a floor of similarity, nothing is returned.** `MINIMUM_SIMILARITY`
 *   is what turns "here are the four closest things in the corpus" into "there
 *   is nothing here about that", which is a true and useful answer that an
 *   unfiltered index can never give.
 * - **Every passage keeps its record.** A result is a pointer into the ledger,
 *   never a floating quotation. A retrieved sentence with no `refType`/`refId`
 *   is unverifiable, and unverifiable text is exactly what this platform exists
 *   not to produce.
 * - **Retrieval is not an answer.** This returns passages and their scores. It
 *   does not summarise them, because a summary of retrieved passages is a new
 *   claim with nobody's name on it.
 *
 * ## Why the index is in-process and derived
 *
 * Same argument as the graph: a vector store is a second copy of text the
 * ledger already holds, and it goes stale the moment a record is corrected. The
 * index here is built from the log on demand and holds no authority of its own.
 * Where this deployment later gains a real vector database, it replaces the
 * `EmbeddingProvider` below and nothing else — the refusal discipline is in
 * this file, not in the store.
 */

/** Below this cosine similarity, a passage is not a match. */
export const MINIMUM_SIMILARITY = 0.62;

/** Never return more than this, however many clear the floor. */
export const MAX_RESULTS = 10;

export type Passage = {
  ref: { refType: string; refId: string };
  projectId: string;
  /** The text as it stands in the record. Never rewritten. */
  text: string;
  /** Which state field it came from, so a reader can go and look. */
  field: string;
};

export type EmbeddedPassage = Passage & { vector: number[] };

/**
 * What produces a vector.
 *
 * Supplied rather than imported, so this file stays free of the AI control
 * plane and can be tested without one — and so that the orchestrator remains
 * the single place that decides whether a model may be called at all.
 */
export type EmbeddingProvider = {
  /** The model that produced these vectors, named on every result. */
  readonly model: string;
  /** Resolves to vectors, or throws. A throw is a refusal, never a fallback. */
  embed(texts: readonly string[]): Promise<number[][]>;
};

export type RetrievalHit = {
  ref: { refType: string; refId: string };
  projectId: string;
  text: string;
  field: string;
  similarity: number;
};

export type RetrievalRefusal = {
  answered: false;
  reason: 'NO_EMBEDDING_PROVIDER' | 'PROVIDER_REFUSED' | 'NOTHING_INDEXED' | 'NOTHING_RELEVANT';
  finding: string;
  /** Never absent. A refusal with no next step is a dead end. */
  action: string;
};

export type RetrievalAnswer = {
  answered: true;
  model: string;
  hits: RetrievalHit[];
  /** How many passages were searched, so a thin result can be read correctly. */
  searched: number;
  /** Cleared the floor but fell outside `MAX_RESULTS`. */
  omitted: number;
  caveats: string[];
};

export type RetrievalResult = RetrievalAnswer | RetrievalRefusal;

/** Cosine similarity. Refuses mismatched dimensions rather than comparing nonsense. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new DomainError(
      'VECTOR_DIMENSION_MISMATCH',
      `Cannot compare a ${a.length}-dimension vector with a ${b.length}-dimension one. This usually means the index ` +
        'was built with one embedding model and queried with another, which produces similarity scores that look ' +
        'ordinary and mean nothing.',
    );
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * b[index]!;
    normA += a[index]! * a[index]!;
    normB += b[index]! * b[index]!;
  }
  // A zero vector has no direction, so it has no similarity to anything. Zero
  // is the honest answer; dividing would produce NaN and NaN sorts unpredictably.
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** The state fields worth indexing. Ids, hashes and timestamps are not prose. */
const TEXT_FIELDS = new Set([
  'title',
  'description',
  'narrative',
  'summary',
  'finding',
  'reason',
  'question',
  'answer',
  'scope',
  'notes',
  'comment',
  'justification',
  'instruction',
  'basis',
]);

/** The shortest passage worth indexing. Below it there is no meaning to embed. */
export const MINIMUM_PASSAGE = 24;

/**
 * Pull indexable prose out of a record's state.
 *
 * A whitelist rather than "every string": indexing ids, hashes and enum values
 * fills the index with tokens that match everything weakly and nothing well,
 * which is how a floor stops working.
 */
export function passagesFrom(
  ref: { refType: string; refId: string },
  projectId: string,
  state: Record<string, unknown>,
): Passage[] {
  const passages: Passage[] = [];
  for (const [field, value] of Object.entries(state)) {
    if (!TEXT_FIELDS.has(field)) continue;
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text.length < MINIMUM_PASSAGE) continue;
    passages.push({ ref, projectId, text, field });
  }
  return passages;
}

/**
 * Retrieve, or refuse.
 *
 * The provider is optional on purpose: `undefined` is the ordinary state of a
 * deployment with no embedding model configured, and it produces a refusal that
 * says so rather than a silent fallback to something weaker.
 */
export async function retrieve(input: {
  query: string;
  passages: readonly Passage[];
  provider?: EmbeddingProvider;
  minimumSimilarity?: number;
  limit?: number;
}): Promise<RetrievalResult> {
  const floor = input.minimumSimilarity ?? MINIMUM_SIMILARITY;
  const limit = Math.min(MAX_RESULTS, Math.max(1, Math.floor(input.limit ?? MAX_RESULTS)));

  if (!input.provider) {
    return {
      answered: false,
      reason: 'NO_EMBEDDING_PROVIDER',
      finding:
        'No embedding model is available, so this cannot search by meaning. It will not fall back to keyword ' +
        'matching and present it as semantic search — a cheaper answer wearing the expensive one’s clothes is worse ' +
        'than no answer, because nobody can tell which they got.',
      action: 'Use the ordinary record search, or configure an embedding provider.',
    };
  }

  if (input.passages.length === 0) {
    return {
      answered: false,
      reason: 'NOTHING_INDEXED',
      finding: 'There is no indexable prose in scope — no descriptions, narratives or findings long enough to carry meaning.',
      action: 'Nothing to do. This is a statement about the records, not a failure.',
    };
  }

  let vectors: number[][];
  let queryVector: number[];
  try {
    const embedded = await input.provider.embed([input.query, ...input.passages.map((passage) => passage.text)]);
    queryVector = embedded[0]!;
    vectors = embedded.slice(1);
  } catch (error) {
    // A refusal from the orchestrator — no healthy provider, an empty wallet —
    // is passed through as a refusal. Catching it and degrading is how a
    // platform starts answering questions it has not paid to answer.
    return {
      answered: false,
      reason: 'PROVIDER_REFUSED',
      finding: `The embedding provider refused: ${error instanceof Error ? error.message : String(error)}`,
      action: 'This is a refusal, not a failure to retry around. Resolve what the provider said before asking again.',
    };
  }

  if (vectors.length !== input.passages.length || !queryVector) {
    return {
      answered: false,
      reason: 'PROVIDER_REFUSED',
      finding:
        `The provider returned ${vectors.length} vectors for ${input.passages.length} passages. Scoring passages ` +
        'against vectors that may belong to different text would produce plausible rankings from nothing.',
      action: 'Report this — it is a provider fault, not a query problem.',
    };
  }

  const scored = input.passages
    .map((passage, index) => ({ passage, similarity: cosine(queryVector, vectors[index]!) }))
    .filter((entry) => entry.similarity >= floor)
    .sort((a, b) => b.similarity - a.similarity);

  if (scored.length === 0) {
    // The answer an unfiltered index can never give, and usually the true one.
    return {
      answered: false,
      reason: 'NOTHING_RELEVANT',
      finding:
        `Nothing in the ${input.passages.length} passages searched is close enough to this question to be a genuine ` +
        'match. Nearest-neighbour search always returns neighbours, so returning the closest few would have produced ' +
        'an answer with the same confidence and none of the relevance.',
      action: 'Ask differently, or accept that the record does not address this.',
    };
  }

  return {
    answered: true,
    model: input.provider.model,
    hits: scored.slice(0, limit).map((entry) => ({
      ref: entry.passage.ref,
      projectId: entry.passage.projectId,
      text: entry.passage.text,
      field: entry.passage.field,
      similarity: entry.similarity,
    })),
    searched: input.passages.length,
    omitted: Math.max(0, scored.length - limit),
    caveats: [
      'These are passages from the record, returned as they stand. Nothing here has been summarised — a summary of ' +
        'retrieved passages is a new claim with nobody’s name on it.',
      'Similarity is closeness of meaning, not correctness. A passage can be the closest thing in the record to your ' +
        'question and still be the wrong answer to it.',
      `Every passage carries the record it came from. Go and read it before relying on it.`,
    ],
  };
}
