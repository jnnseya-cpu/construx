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
  /** Estimated cost before execution, used to size the ACU hold. */
  estimateCostMinor(request: ProviderRequest): number;
  execute(request: ProviderRequest): Promise<ProviderResponse>;
  healthy(): boolean;
}
