import { createHash } from 'node:crypto';
import { canonicalize } from '../../core/canonical.ts';
import type { AIProvider } from '../../goldenthread/types.ts';
import type { AIProviderAdapter, ProviderCapability, ProviderRequest, ProviderResponse } from './types.ts';

/**
 * Deterministic local adapters used when AI_MODE=local.
 *
 * These are not stubs that return canned text. Each engine passes structured
 * inputs and the deterministic maths in the engine itself does the work; the
 * adapter supplies the judgement-shaped fields (weightings, classifications,
 * narrative) derived deterministically from a hash of the input. That keeps
 * local runs reproducible, free, and honest about which numbers are computed
 * versus which came from a model.
 */

function seedOf(request: ProviderRequest): number {
  const digest = createHash('sha256').update(`${request.task}|${canonicalize(request.payload)}`).digest();
  return digest.readUInt32BE(0);
}

/** Deterministic pseudo-random in [0,1) derived from the seed and an index. */
function seededUnit(seed: number, index: number): number {
  const x = Math.sin(seed + index * 9973) * 10000;
  return x - Math.floor(x);
}

class MockAdapter implements AIProviderAdapter {
  readonly name: AIProvider;
  readonly capability: ProviderCapability;
  #healthy = true;

  constructor(name: AIProvider, capability: ProviderCapability) {
    this.name = name;
    this.capability = capability;
  }

  setHealthy(value: boolean): void {
    this.#healthy = value;
  }

  healthy(): boolean {
    return this.#healthy;
  }

  estimateCostMinor(request: ProviderRequest): number {
    // Cost scales with payload size, as real token billing does. Perception work
    // carries a higher floor because images and models are large inputs.
    const size = canonicalize(request.payload).length;
    const base = this.capability === 'PERCEPTION' ? 12 : 6;
    return base + Math.ceil(size / 400);
  }

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    const started = Date.now();
    const seed = seedOf(request);
    const output = synthesise(request, seed, this.capability);
    return {
      provider: this.name,
      modelClass: this.capability === 'PERCEPTION' ? 'mock-perception-v1' : 'mock-reasoning-v1',
      output,
      // Actual cost lands within ±20% of the estimate, as a real call would.
      rawCostMinor: Math.max(1, Math.round(this.estimateCostMinor(request) * (0.8 + seededUnit(seed, 1) * 0.4))),
      latencyMs: Date.now() - started,
      confidence: Number((0.72 + seededUnit(seed, 2) * 0.24).toFixed(3)),
    };
  }
}

/**
 * Produce the judgement-shaped half of an engine's answer. Everything here is a
 * deterministic function of the request, so a local run is fully reproducible.
 */
function synthesise(request: ProviderRequest, seed: number, capability: ProviderCapability): Record<string, unknown> {
  const unit = (i: number): number => seededUnit(seed, i);

  return {
    task: request.task,
    capability,
    /** Weight applied by the engine where a spec permits a model-derived weighting. */
    judgement: Number((0.35 + unit(3) * 0.3).toFixed(4)),
    /** Classification bucket, stable for identical inputs. */
    classification: ['LOW', 'MEDIUM', 'HIGH'][Math.floor(unit(4) * 3)] ?? 'MEDIUM',
    /** Narrative is advisory only — it is never hashed as state. */
    narrative: `Deterministic local analysis for "${request.task}". No external provider was called; figures are computed by the engine.`,
    signals: [
      { name: 'input_completeness', value: Number((0.6 + unit(5) * 0.4).toFixed(3)) },
      { name: 'evidence_density', value: Number((0.4 + unit(6) * 0.6).toFixed(3)) },
    ],
  };
}

export const mockReasoning = new MockAdapter('OPENAI', 'REASONING');
export const mockPerception = new MockAdapter('GEMINI', 'PERCEPTION');
