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
  /**
   * False, and load-bearing. This adapter derives its answers from a hash of
   * its inputs; it cannot read a drawing or hear a voice note. Saying so is
   * what lets the perception pipeline refuse rather than return a confident
   * fabrication that the drawing register would then carry as fact.
   */
  readonly multimodal = false;
  /** Nothing leaves the process: the answer is derived from a hash of the inputs. */
  readonly transmits = false;
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
      // The assumptions this output was produced under, and they are true
      // rather than decorative: the stand-in reasons about nothing, sees only
      // the structured payload the engine assembled, and is deterministic —
      // which is precisely what somebody reading the record two years later
      // needs to know before relying on it.
      assumptions: [
        'No external model was called; the output is a deterministic stand-in derived from the structured payload.',
        'Only the inputs the engine assembled were considered. No document, drawing or record outside them was read.',
        'Figures are computed by the engine, not judged by a model. The narrative is advisory and is never hashed as state.',
      ],
      // What this output did not have. True of the stand-in by construction,
      // and the honest answer to "what would change this" — which is the
      // question a gate is really asking when it reads a known gap.
      knownGaps: [
        'No market rate feed, weather record or ground investigation was available to this call.',
        'Nothing outside the platform’s own ledger was consulted, so anything held only in a document or an inbox is absent.',
      ],
      // What else was on the table. Stated plainly rather than dressed up: the
      // stand-in weighs nothing, so the alternative it names is the real one —
      // asking a model — and the reason it was not taken is the configuration.
      alternativesConsidered: [
        'Calling a configured provider, which was not done because this deployment is running the local engines.',
        'Returning no judgement at all and leaving the field blank, which was not done because the engine’s own ' +
          'arithmetic still needs somewhere to be narrated.',
      ],
      // Said out loud. Nothing here reasoned about anything, and a caller
      // putting this in front of a person needs to know that from the response
      // rather than by inspecting the model name or the platform's config.
      synthetic: true,
    };
  }
}

/**
 * How the local stand-in narrative opens.
 *
 * A reader asking whether stored prose came from a model asks the record, not
 * the sentence: `runAI` stamps `aiProvenance` on everything it writes and
 * `wasSynthetic` in `engines/context.ts` answers from it. This constant exists
 * so the wording lives in one place, and it is deliberately not a predicate —
 * matching on prose was the brittle version of that question and there are
 * seven engines phrasing it differently.
 */
export const LOCAL_STAND_IN = 'Deterministic local analysis';

/**
 * Produce the judgement-shaped half of an engine's answer. Everything here is a
 * deterministic function of the request, so a local run is fully reproducible.
 */
function synthesise(request: ProviderRequest, seed: number, capability: ProviderCapability): Record<string, unknown> {
  const unit = (i: number): number => seededUnit(seed, i);

  if (request.standardSources) return standardStandIn(request);

  return {
    task: request.task,
    capability,
    /** Weight applied by the engine where a spec permits a model-derived weighting. */
    judgement: Number((0.35 + unit(3) * 0.3).toFixed(4)),
    /** Classification bucket, stable for identical inputs. */
    classification: ['LOW', 'MEDIUM', 'HIGH'][Math.floor(unit(4) * 3)] ?? 'MEDIUM',
    /** Narrative is advisory only — it is never hashed as state. */
    narrative: `${LOCAL_STAND_IN} for "${request.task}". No external provider was called; figures are computed by the engine.`,
    signals: [
      { name: 'input_completeness', value: Number((0.6 + unit(5) * 0.4).toFixed(3)) },
      { name: 'evidence_density', value: Number((0.4 + unit(6) * 0.6).toFixed(3)) },
    ],
  };
}


/**
 * The stand-in's answer where the task is held to the AI Output Standard.
 *
 * The standard's ten fields describe a judgement, and this adapter makes none:
 * it has no model, and its other fields are a hash of the inputs. So the one
 * honest answer in this shape is the one that says so — every quantity null,
 * every statement stating plainly that nothing was assessed, and the lowest
 * confidence the scale has.
 *
 * That is deliberately not a refusal. A refusal would make every advisory task
 * unreachable on a deployment with no provider configured, which is every
 * deployment before somebody enters a key. This answer is usable, correct, and
 * marked `synthetic` all the way to the screen — `wasSynthetic` and the
 * `aiProvenance` stamp are what stop it being presented as reasoning.
 *
 * What it will not do is invent a source. The references are the records the
 * engine declared it was reading; if the engine declared none, the answer
 * fails validation, which is the right outcome — a finding nobody can trace is
 * one the platform should not store.
 */
function standardStandIn(request: ProviderRequest): Record<string, unknown> {
  const notAssessed = 'No model was called. This was produced by the platform\u2019s deterministic stand-in, which does not assess impact.';
  return {
    summary: `No AI assessment was made of "${request.task}".`,
    evidence: `${LOCAL_STAND_IN}: the platform has no reasoning provider configured, so the records below were read and not interpreted.`,
    riskLevel: 'LOW',
    commercialImpact: { amountMinor: null, statement: notAssessed },
    programmeImpact: { days: null, statement: notAssessed },
    contractImpact: { clause: null, statement: notAssessed },
    recommendedAction: 'Configure a reasoning provider, or make this assessment yourself against the records cited.',
    confidence: 0,
    sourceReferences: (request.standardSources ?? []).map((reference) => ({
      ...reference,
      note: 'Declared as an input to this task.',
    })),
    approvalRequired: false,
  };
}

export const mockReasoning = new MockAdapter('OPENAI', 'REASONING');
export const mockPerception = new MockAdapter('GEMINI', 'PERCEPTION');
