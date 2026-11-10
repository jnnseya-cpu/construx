/**
 * Trend Intelligence AI — the Growth Brief v1 contract (spec §6, Appendix A).
 *
 * The brief is the one shared, versioned object every agent resolves at run time: it
 * changes their priorities, audiences, offers and approved claims without rewriting their
 * prompts. It is a **closed** object — unknown fields are rejected, every scope is
 * enumerated, lengths are bounded — because a brief is read by agents as authority, and an
 * agent that honoured an unvalidated extra field would be honouring whatever put it there.
 *
 * This module is the schema and its validator only: pure, provider-free, persisting
 * nothing. `IDs resolve server-side` (spec §6) — this checks shape and bounds, not that a
 * claim or CTA exists; that is the resolver's job in a later slice.
 */

import { DomainError } from '../../core/errors.ts';

/** The channels a brief may permit (spec §7). A closed set — an unknown channel is refused. */
export const BRIEF_CHANNELS = ['seo', 'organic_social', 'paid_search', 'paid_social', 'lifecycle_crm', 'landing_page'] as const;
export type BriefChannel = (typeof BRIEF_CHANNELS)[number];

export const GROWTH_BRIEF_SCHEMA_VERSION = 1 as const;

/** The Growth Brief v1 payload, exactly the closed object agents treat as authority. */
export type GrowthBriefV1 = {
  schema_version: 1;
  brief_id: string;
  brief_version: number;
  tenant_id: string;
  platform_id: string;
  /** ISO alpha-2 market, or ZZ for an explicitly global, non-country-targeted brief. */
  market: string;
  locale: string;
  topic_id: string;
  opportunity_score: number;
  confidence: number;
  valid_from: string;
  expires_at: string;
  evidence_ids: string[];
  audience: string;
  intent: string;
  approved_claim_ids: string[];
  cta_id: string;
  allowed_channels: BriefChannel[];
  prohibited_claims: string[];
  objective: string;
  policy_version: number;
  /** The experiment frozen at approval, where one has been (spec §10). Absent on a draft. */
  experiment_id?: string;
};

const MARKET_RE = /^[A-Z]{2}$/;
const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const REQUIRED_KEYS = [
  'schema_version', 'brief_id', 'brief_version', 'tenant_id', 'platform_id', 'market', 'locale',
  'topic_id', 'opportunity_score', 'confidence', 'valid_from', 'expires_at', 'evidence_ids',
  'audience', 'intent', 'approved_claim_ids', 'cta_id', 'allowed_channels', 'prohibited_claims',
  'objective', 'policy_version',
] as const;
const OPTIONAL_KEYS = ['experiment_id'] as const;
const ALLOWED_KEYS = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);

type FieldError = { field: string; message: string };

function reject(errors: FieldError[]): never {
  throw new DomainError('BRIEF_INVALID', `The Growth Brief failed validation: ${errors.map((e) => e.field).join(', ')}`, 422, errors);
}

function isStr(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}
function strArray(v: unknown, maxItems: number, maxLen: number): v is string[] {
  return Array.isArray(v) && v.length <= maxItems && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= maxLen);
}

/**
 * Validate an untrusted object as a Growth Brief v1, or refuse with per-field errors.
 *
 * Closed by construction: any key not in the schema is an error, not ignored — the whole
 * point of a closed agent contract is that nothing unrecognised rides along. Scores are
 * range-checked, the window must end after it starts, and every channel must be one of the
 * enumerated set.
 */
export function validateGrowthBrief(input: unknown): GrowthBriefV1 {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    reject([{ field: '(root)', message: 'A Growth Brief is a JSON object' }]);
  }
  const o = input as Record<string, unknown>;
  const errors: FieldError[] = [];

  for (const key of Object.keys(o)) {
    if (!ALLOWED_KEYS.has(key)) errors.push({ field: key, message: 'Unknown field; the brief is a closed object' });
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in o)) errors.push({ field: key, message: 'Required' });
  }

  if (o.schema_version !== GROWTH_BRIEF_SCHEMA_VERSION) errors.push({ field: 'schema_version', message: `Must be ${GROWTH_BRIEF_SCHEMA_VERSION}` });
  for (const key of ['brief_id', 'tenant_id', 'platform_id', 'topic_id', 'cta_id'] as const) {
    if (o[key] !== undefined && !(typeof o[key] === 'string' && ID_RE.test(o[key] as string))) {
      errors.push({ field: key, message: 'Must be a short id of letters, digits, or . _ : -' });
    }
  }
  if (o.brief_version !== undefined && !(Number.isInteger(o.brief_version) && (o.brief_version as number) >= 1)) {
    errors.push({ field: 'brief_version', message: 'Must be an integer ≥ 1' });
  }
  if (o.policy_version !== undefined && !(Number.isInteger(o.policy_version) && (o.policy_version as number) >= 1)) {
    errors.push({ field: 'policy_version', message: 'Must be an integer ≥ 1' });
  }
  if (o.market !== undefined && !(typeof o.market === 'string' && MARKET_RE.test(o.market))) {
    errors.push({ field: 'market', message: 'ISO alpha-2 (e.g. CA) or ZZ for global' });
  }
  if (o.locale !== undefined && !(typeof o.locale === 'string' && LOCALE_RE.test(o.locale))) {
    errors.push({ field: 'locale', message: 'A locale such as en or en-CA' });
  }
  for (const key of ['opportunity_score', 'confidence'] as const) {
    const v = o[key];
    if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100)) {
      errors.push({ field: key, message: 'A number in [0, 100]' });
    }
  }
  const from = typeof o.valid_from === 'string' ? Date.parse(o.valid_from) : NaN;
  const until = typeof o.expires_at === 'string' ? Date.parse(o.expires_at) : NaN;
  if (o.valid_from !== undefined && Number.isNaN(from)) errors.push({ field: 'valid_from', message: 'An RFC 3339 timestamp' });
  if (o.expires_at !== undefined && Number.isNaN(until)) errors.push({ field: 'expires_at', message: 'An RFC 3339 timestamp' });
  if (!Number.isNaN(from) && !Number.isNaN(until) && until <= from) {
    errors.push({ field: 'expires_at', message: 'Must be after valid_from' });
  }
  for (const key of ['audience', 'intent', 'objective'] as const) {
    if (o[key] !== undefined && !isStr(o[key], 500)) errors.push({ field: key, message: 'A non-empty string up to 500 characters' });
  }
  if (o.evidence_ids !== undefined && !strArray(o.evidence_ids, 64, 128)) errors.push({ field: 'evidence_ids', message: 'Up to 64 evidence ids' });
  if (o.approved_claim_ids !== undefined && !strArray(o.approved_claim_ids, 64, 128)) errors.push({ field: 'approved_claim_ids', message: 'Up to 64 claim ids' });
  if (o.prohibited_claims !== undefined && !strArray(o.prohibited_claims, 64, 300)) errors.push({ field: 'prohibited_claims', message: 'Up to 64 prohibited-claim strings' });
  if (o.allowed_channels !== undefined) {
    const ch = o.allowed_channels;
    if (!Array.isArray(ch) || ch.length === 0 || ch.length > BRIEF_CHANNELS.length) {
      errors.push({ field: 'allowed_channels', message: 'At least one channel' });
    } else if (!ch.every((c) => (BRIEF_CHANNELS as readonly string[]).includes(c as string))) {
      errors.push({ field: 'allowed_channels', message: `Each must be one of ${BRIEF_CHANNELS.join(', ')}` });
    } else if (new Set(ch as string[]).size !== ch.length) {
      errors.push({ field: 'allowed_channels', message: 'No duplicate channels' });
    }
  }
  if (o.experiment_id !== undefined && !(typeof o.experiment_id === 'string' && ID_RE.test(o.experiment_id))) {
    errors.push({ field: 'experiment_id', message: 'Must be a short id of letters, digits, or . _ : -' });
  }

  if (errors.length > 0) reject(errors);

  return {
    schema_version: GROWTH_BRIEF_SCHEMA_VERSION,
    brief_id: o.brief_id as string,
    brief_version: o.brief_version as number,
    tenant_id: o.tenant_id as string,
    platform_id: o.platform_id as string,
    market: o.market as string,
    locale: o.locale as string,
    topic_id: o.topic_id as string,
    opportunity_score: o.opportunity_score as number,
    confidence: o.confidence as number,
    valid_from: new Date(from).toISOString(),
    expires_at: new Date(until).toISOString(),
    evidence_ids: [...(o.evidence_ids as string[])],
    audience: o.audience as string,
    intent: o.intent as string,
    approved_claim_ids: [...(o.approved_claim_ids as string[])],
    cta_id: o.cta_id as string,
    allowed_channels: [...(o.allowed_channels as BriefChannel[])],
    prohibited_claims: [...(o.prohibited_claims as string[])],
    objective: o.objective as string,
    policy_version: o.policy_version as number,
    ...(o.experiment_id !== undefined ? { experiment_id: o.experiment_id as string } : {}),
  };
}

/** Whether a brief is still in force at `now` (spec §6: expiry is checked on every lookup and write). */
export function briefInForce(brief: Pick<GrowthBriefV1, 'valid_from' | 'expires_at'>, now = new Date().toISOString()): boolean {
  return brief.valid_from <= now && now < brief.expires_at;
}
