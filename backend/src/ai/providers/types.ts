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
  /** Estimated cost before execution, used to size the ACU hold. */
  estimateCostMinor(request: ProviderRequest): number;
  execute(request: ProviderRequest): Promise<ProviderResponse>;
  healthy(): boolean;
}
