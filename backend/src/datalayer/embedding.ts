import { config } from '../config.ts';
import { DomainError } from '../core/errors.ts';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MAX_CHARS,
  configuredEmbeddingAdapter,
} from '../ai/providers/embedding.ts';
import { runAI, type EngineContext } from '../engines/context.ts';
import type { EmbeddingProvider } from './vectorindex.ts';

/**
 * Where an embedding provider comes from, and why it needs a context.
 *
 * ## What this used to say, and why it changed
 *
 * This file existed to state an absence: no embedding capability existed, so
 * `semantic-search` called `embeddingProvider()`, got `undefined`, and returned
 * the refusal `vectorindex.ts` is built to return. That was the honest answer
 * for a deployment that had not been given a model.
 *
 * The capability now exists — `ai/providers/embedding.ts` is a real adapter with
 * its own vendor endpoints and its own per-input-token pricing — so the absence
 * was no longer a statement about configuration. It had become a statement
 * about **metering**: the old signature took no `EngineContext`, and an `embed`
 * built straight from the adapter would open a socket and bill a vendor with no
 * hold, no wallet check, no clearance check and no `AIExecution` record. That is
 * against the settled rule that nothing is charged without a ledger write, and
 * it is a worse failure than refusing to answer.
 *
 * So the signature takes a context, and the provider it returns routes every
 * call through `runAI`. An embedding call is now held, charged, recorded,
 * refused on an empty wallet, refused where no vendor is cleared for the
 * material, and attributed like every other model call.
 *
 * ## Why there is still no local stand-in
 *
 * Unchanged, and it is the one place in this codebase with none. Everywhere
 * else a stand-in exists so a feature works without a provider, and each is
 * marked as the stand-in on its output. A stand-in narrative is *visibly* a
 * stand-in: somebody reads it and can tell. A stand-in **embedding** is a
 * vector, and a vector is not readable by anybody — hashed tokens into a
 * fixed-width array rank, sort and score exactly like real ones, and the
 * results come back ordered and scored to three decimal places meaning nothing
 * at all. There is no way for a reader to tell that apart from real semantic
 * search, which makes it the one stand-in that could not be labelled honestly
 * enough to be safe.
 *
 * `undefined` therefore still means "this deployment has no semantic search",
 * and the endpoint still returns the refusal that names the variable.
 *
 * ## The cost characteristic, stated because it is surprising
 *
 * `vectorindex.ts` builds its index from the log on demand and stores no
 * vectors — deliberately, because a vector store is a second copy of text the
 * ledger already holds and it goes stale the moment a record is corrected. The
 * consequence, now that the call is real, is that **each search embeds the
 * passages in scope again**. Embeddings are priced per input token with no
 * output side at roughly a hundredth of a reasoning call, so this is cheap
 * rather than free — and it is quoted before it runs like anything else. A
 * cache would change it, and there is no measured need for one yet.
 */

/** The class the index is built at, and the one every row has to share. */
const EMBEDDING_CLASS = 'embedding-standard';

/**
 * The total text one search may embed.
 *
 * A ceiling rather than a cache. Without a vector store every search embeds its
 * whole scope, so a project with a very large body of prose would produce one
 * very expensive call — and a provider would refuse the batch anyway. Refusing
 * first, by name, with the figure in the message, is better than a 502 from a
 * vendor or a charge for a call that failed.
 */
export const SEMANTIC_SEARCH_MAX_CHARS = 400_000;

/**
 * A metered embedding provider, or none.
 *
 * Absent is a supported state and the one every deployment starts in. Callers
 * check for it and get `vectorindex.ts`'s stated refusal, rather than falling
 * back to something that is not an embedding.
 */
export function embeddingProvider(ctx: EngineContext): EmbeddingProvider | undefined {
  const adapter = configuredEmbeddingAdapter();
  if (!adapter) {
    // Not a configuration oversight to work around: `AI_EMBEDDING_PROVIDER` is
    // unset, which is a statement that this deployment has no semantic search.
    void config;
    return undefined;
  }

  return {
    model: `${adapter.name}/${EMBEDDING_CLASS}`,
    async embed(texts: readonly string[]): Promise<number[][]> {
      const payload = [...texts];
      const total = payload.reduce((sum, text) => sum + text.length, 0);
      if (total > SEMANTIC_SEARCH_MAX_CHARS) {
        throw new DomainError(
          'SEMANTIC_SEARCH_TOO_LARGE',
          `This search would embed ${total.toLocaleString()} characters and the ceiling is ` +
            `${SEMANTIC_SEARCH_MAX_CHARS.toLocaleString()}. There is no vector cache, so every search embeds its ` +
            'whole scope — narrow the scope, or ask a more specific question of a smaller project.',
          422,
        );
      }
      const oversized = payload.findIndex((text) => text.length > EMBEDDING_MAX_CHARS);
      if (oversized !== -1) {
        throw new DomainError(
          'SEMANTIC_SEARCH_PASSAGE_TOO_LONG',
          `Passage ${oversized + 1} is ${payload[oversized]!.length} characters and a single passage may be at most ` +
            `${EMBEDDING_MAX_CHARS}. Split it before indexing it.`,
          422,
        );
      }

      const result = await runAI(ctx, {
        // Unphased by design, and the only engine besides safety that is. A
        // search spans the whole record, so binding it to a phased engine would
        // make it refuse during CONCEPT or OPERATIONS for no reason anybody
        // could discover from the question they asked.
        engine: 'EXECUTIVE',
        taskType: 'semantic_search',
        capability: 'EMBEDDING',
        inputRefs: [],
        request: {
          // No prompt. An embedding endpoint is handed text, not an
          // instruction, and anything else here is text somebody is billed to
          // embed.
          task: 'semantic_search',
          payload: { passages: payload },
          modelClass: EMBEDDING_CLASS,
        },
        // Retrieval writes nothing. A search is not a finding, and recording
        // every one as an event would fill an append-only ledger with the fact
        // that somebody typed a question. The `AIExecution` the orchestrator
        // writes is the audit trail for the spend, which is the part that needs
        // one.
        toWrites: () => [],
      });

      const vectors = (result.output as { vectors?: number[][] }).vectors ?? [];
      if (vectors.length !== payload.length) {
        // `retrieve` checks this too and refuses. Checked here as well because
        // the two refusals say different things: that one is about scoring
        // against mismatched text, this one is about a provider that did not
        // answer what it was asked.
        throw new DomainError(
          'AI_EMBEDDING_MALFORMED',
          `The provider returned ${vectors.length} vectors for ${payload.length} passages.`,
          502,
        );
      }
      const wrong = vectors.findIndex((vector) => vector.length !== EMBEDDING_DIMENSIONS);
      if (wrong !== -1) {
        throw new DomainError(
          'AI_EMBEDDING_MALFORMED',
          `Vector ${wrong + 1} has ${vectors[wrong]!.length} dimensions; this index is built at ` +
            `${EMBEDDING_DIMENSIONS}.`,
          502,
        );
      }
      return vectors;
    },
  };
}
