import { config } from '../config.ts';
import type { EmbeddingProvider } from './vectorindex.ts';

/**
 * Where an embedding provider would come from, and why there is not one.
 *
 * This file exists so the absence is **stated in one place** rather than
 * implied by a missing import. `semantic-search` calls `embeddingProvider()`,
 * gets `undefined`, and returns the refusal `vectorindex.ts` is built to
 * return — which is the correct behaviour for a deployment that has not been
 * given a model, and is a different thing from the endpoint being broken.
 *
 * ## Why no local stand-in
 *
 * Everywhere else in this platform a local stand-in exists so a feature works
 * without a provider, and each one is marked as the stand-in on its output. A
 * stand-in cannot work here, and the difference is worth stating precisely.
 *
 * A stand-in narrative is *visibly* a stand-in: somebody reads it and can tell.
 * A stand-in **embedding** is a vector, and a vector is not readable by anybody.
 * Hashed tokens into a fixed-width array produce numbers that rank, sort and
 * score exactly like real ones — the results come back ordered, scored to three
 * decimal places, and mean nothing at all. There is no way for a reader to tell
 * that apart from real semantic search, which makes it the one stand-in in this
 * codebase that could not be labelled honestly enough to be safe.
 *
 * So there is none, and the endpoint refuses instead.
 *
 * ## What wiring one up would take
 *
 * Return an object with a `model` name and an `embed` that routes through the
 * AI orchestrator — so that an embedding call is metered, refused on an empty
 * wallet, and falls back between providers like every other model call. The
 * refusal discipline lives in `vectorindex.ts` and does not move: whatever is
 * returned here, a passage below the similarity floor is still not a match, and
 * retrieved passages are still never summarised.
 */
export function embeddingProvider(): EmbeddingProvider | undefined {
  // Deliberately reads configuration and finds nothing. When an embedding model
  // is configured, this is the one function that changes.
  void config;
  return undefined;
}
