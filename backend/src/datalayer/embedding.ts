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
 * ## What wiring one up would take, and what is now in the way
 *
 * The **capability** exists: `ai/providers/embedding.ts` is a real adapter with
 * its own vendor endpoints, its own per-input-token pricing and its own chain
 * with no cross-capability fallback, and `AI_EMBEDDING_PROVIDER` turns it on.
 * `domain/bidon/engine.ts` uses it through `runAI`, so Bid-On's retrieval is
 * semantic where an operator has configured a vendor.
 *
 * What is still missing here is **not configuration**. The one caller of this
 * function is the `semantic-search` route, and this signature has no
 * `EngineContext` in it: an `embed` built from the adapter directly would open a
 * socket and bill a vendor with no hold, no wallet check and no `AIExecution`
 * record — against the settled rule that nothing is charged without a ledger
 * write. Closing it means giving semantic search the same shape Bid-On's
 * retrieval has: a command with a context, quoted before it runs, rather than a
 * provider handed to a read.
 *
 * So this still returns `undefined`, deliberately, and the route still returns
 * the refusal `vectorindex.ts` is built to return. `docs/STATE.md` records the
 * remaining work. The refusal discipline in `vectorindex.ts` does not move
 * either way: a passage below the similarity floor is not a match, and
 * retrieved passages are never summarised.
 */
export function embeddingProvider(): EmbeddingProvider | undefined {
  // Not a configuration gap any more — see above. Metering is what is missing,
  // and it cannot be added through a signature with no context in it.
  void config;
  return undefined;
}
