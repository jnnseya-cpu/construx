import type { AIProvider } from '../../goldenthread/types.ts';

/**
 * Provider abstraction. Engines never import a vendor SDK; they ask the
 * orchestrator for a capability. Swapping or adding a provider is a config
 * change, not a rewrite — this is the no-vendor-lock-in requirement made real.
 */

export type ProviderCapability = 'REASONING' | 'PERCEPTION';

export type ProviderRequest = {
  /** What the engine wants done, in structured form. Never raw user prose. */
  task: string;
  /** Structured, already-authorised inputs. Providers see no unfiltered records. */
  payload: Record<string, unknown>;
  /** JSON Schema the response must satisfy — free text is never trusted as state. */
  responseSchema?: Record<string, unknown>;
  modelClass?: string;
  /**
   * A file the model is to look at or listen to, rather than read about.
   *
   * Separate from `payload` because it is not a payload field: an adapter has
   * to place it where its own API expects media — an `inline_data` part for
   * Gemini, an `input_image` content block for OpenAI — and a base64 string
   * stringified into the text prompt is not a multimodal call. It is the same
   * bytes charged at text rates, read by nothing.
   */
  media?: ProviderMedia;
  /**
   * Records the answer may cite, where the task is held to the AI Output
   * Standard.
   *
   * Read only by the local stand-in adapter, which has no model to ask and has
   * to answer in the standard's shape without inventing anything. The three
   * remote adapters send a vendor `task`, `payload`, `responseSchema` and
   * `media` and nothing else, so this never leaves the platform.
   */
  standardSources?: Array<{ refType: string; refId: string }>;
};

/** Bytes for a multimodal call, addressed by the hash they are stored under. */
export type ProviderMedia = {
  contentType: string;
  base64: string;
  /** The content hash, so the request the provider saw is traceable to a record. */
  hash: string;
};

export type ProviderResponse = {
  provider: AIProvider;
  modelClass: string;
  /** Structured output only. The orchestrator refuses anything unparseable. */
  output: Record<string, unknown>;
  /** Raw third-party cost in minor units — the sole input to ACU billing. */
  rawCostMinor: number;
  latencyMs: number;
  /** Model's own confidence, where the provider exposes one. */
  confidence?: number;
  /**
   * True where no model was called and the output is a deterministic stand-in.
   *
   * Declared by the adapter rather than inferred from `config.ai.mode`, because
   * a test injecting a real-shaped adapter runs with the mode still set to
   * local — and because the honest answer is a property of who answered, not of
   * how the platform was configured.
   *
   * Callers that put an output in front of a person must not present a
   * synthetic one as reasoning. `documents/generate.ts` drops it and the
   * section states its own absence, which is what actually happened.
   */
  synthetic?: boolean;
  /**
   * What the model took as given, in its own words.
   *
   * Present so the record can answer "under what assumptions" rather than
   * leave it to whoever reads the output later. An **empty array is an
   * answer** — "none declared" — and is not the same as the field being
   * absent, which is why `runAI` writes `[]` rather than omitting it when a
   * provider returns nothing.
   *
   * A provider populates this from its own structured output where the
   * response schema asks for it. The deterministic stand-in states the one
   * assumption that is always true of it: no model was called.
   */
  assumptions?: string[];
  /**
   * What the answer needed and did not have.
   *
   * The other half of an assumption, and the one that reads differently at a
   * gate: a decision resting on assumptions is one somebody can check, and a
   * decision resting on gaps is one somebody has to close. An empty array is
   * an answer — "none declared" — on the same terms as `assumptions`.
   */
  knownGaps?: string[];
  /**
   * What else was on the table, and why it was not taken.
   *
   * An option nobody wrote down is one nobody can reopen. In a dispute the
   * question is rarely "was this reasonable" but "what else was considered",
   * and an output listing one course of action reads as though there was only
   * ever one.
   */
  alternativesConsidered?: string[];
};

export interface AIProviderAdapter {
  readonly name: AIProvider;
  readonly capability: ProviderCapability;
  /**
   * Whether this adapter can be handed the bytes of a file at all.
   *
   * Declared rather than assumed, because the honest answer decides whether a
   * perception command runs or is refused. The local adapter is deterministic
   * arithmetic over a hash of its inputs — it cannot look at a drawing, and a
   * pipeline that let it try would return an invented title block that the
   * register would then carry as a governed record.
   */
  readonly multimodal: boolean;
  /**
   * Whether using this adapter puts project data outside this process.
   *
   * Declared rather than inferred from the provider name, because the name is
   * the *vendor* and this is a question about the *transport*. The deterministic
   * adapter answers from a hash of its inputs and opens no socket, so no
   * disclosure can occur however sensitive the material is — and a clearance
   * rule that refused it would be protecting data from a journey it never takes.
   *
   * A remote adapter transmits, and is therefore subject to whatever the
   * contract with that vendor permits.
   */
  readonly transmits: boolean;
  /** Estimated cost before execution, used to size the ACU hold. */
  estimateCostMinor(request: ProviderRequest): number;
  execute(request: ProviderRequest): Promise<ProviderResponse>;
  healthy(): boolean;
}
