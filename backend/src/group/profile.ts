import { DomainError, NotFoundError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { applyPatch } from '../core/jsonpatch.ts';
import type { AuthContext } from '../identity/auth.ts';
import type { Platform } from '../platform.ts';
import type { ClientBranding } from '../export/exporter.ts';

/**
 * The company profile: who issues a document, and how it is numbered (§8).
 *
 * The issuing company decides what a document says about who issued it —
 * not the person who pressed the button, not the group, not the platform.
 * The brand kit is the tenancy's `ClientBranding`, which every export already
 * carries; what this adds is the registered issuer block for contractual
 * documents, the numbering rules per document type, the signatories, and a
 * version that counts up on every change to any of it. A document pins the
 * version it was built under (§8.3), and the ledger keeps every earlier
 * version as an event, so "what did version 3 say" is a read, not a guess.
 *
 * Numbers are allocated here, one counter per (company, document type,
 * scope), as an event on the chain: this process handles one request at a
 * time, so two allocations cannot interleave, and the counter is the record
 * — no gaps, no duplicates, and a restart continues from the last number.
 */

export type IssuerBlock = {
  registeredName: string;
  tradingName: string;
  registrationNo: string;
  vatNumber: string;
  registeredAddress: { line1: string; line2: string; city: string; postcode: string; country: string };
  contact: { phone: string; email: string; web: string };
  footerLegalText: string;
};

export type NumberingRule = {
  prefix: string;
  /** `{YYYY}`, `{YY}`, `{MM}` and one `{seq:N}` (N digits, zero-padded). */
  pattern: string;
  seqScope: 'year' | 'all';
};

export type Signatory = { userId: string; title: string; documents: string[] };

/**
 * Where the registered issuer details stand (enterprise specification §4,
 * LegalProfileVersion). UNVERIFIED: nothing has been entered beyond the
 * onboarding name. DECLARED: the company entered its own details. VERIFIED:
 * the platform operator checked them against the register. A change to the
 * issuer block after verification is a new declaration — verification is of
 * a version, and the new version has not been checked.
 */
export type LegalVerification = {
  state: 'UNVERIFIED' | 'DECLARED' | 'VERIFIED';
  declaredAt?: string;
  declaredBy?: string;
  verifiedAt?: string;
  verifiedBy?: string;
  /** The profile version the operator verified. */
  verifiedVersion?: number;
  note: string;
};

/** Per document type: whether a generated revision needs an approval before it is issued (§8.2). */
export type DocumentPolicy = { approvalRequired: boolean };

export type IssuerProfile = {
  id: string;
  tenantId: string;
  version: number;
  issuer: IssuerBlock;
  numberingRules: Record<string, NumberingRule>;
  signatories: Signatory[];
  /** Snapshot of the brand kit at this version, so the version history is complete on its own. */
  brand: ClientBranding | null;
  /** Absent on versions written before verification existed; read as UNVERIFIED. */
  legal?: LegalVerification;
  /** Overrides of the default approval policy per document type. Absent means the defaults. */
  documentPolicies?: Record<string, DocumentPolicy>;
  updatedAt: string;
  updatedBy: string;
  /** What changed at this version, in a word: PROFILE, BRAND, COVER or VERIFICATION. */
  change: 'CREATED' | 'PROFILE' | 'BRAND' | 'VERIFICATION';
};

export const DOCUMENT_TYPES = ['quotation', 'invoice', 'report', 'contract', 'certificate', 'notice', 'letter'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/**
 * The published default: what binds a company or states money needs an
 * approval before it goes out; a report, a notice or a letter may go from
 * generated to issued under this policy. A company may override per type on
 * its profile, which is itself a versioned, recorded act.
 */
export const DEFAULT_APPROVAL_REQUIRED: Record<DocumentType, boolean> = {
  quotation: true,
  invoice: true,
  contract: true,
  certificate: true,
  report: false,
  notice: false,
  letter: false,
};

export function approvalRequiredFor(profile: IssuerProfile, documentType: string): boolean {
  const override = profile.documentPolicies?.[documentType];
  if (override) return override.approvalRequired;
  return DEFAULT_APPROVAL_REQUIRED[documentType as DocumentType] ?? true;
}

export function legalVerificationOf(profile: IssuerProfile): LegalVerification {
  return profile.legal ?? { state: 'UNVERIFIED', note: '' };
}

/**
 * Whether the issuer block is complete enough to issue a legal document under
 * (§8.2 "legal-profile readiness"). Not a guess: the fields a contractual
 * document has to carry are named, and what is missing is said.
 */
export function legalReadiness(profile: IssuerProfile): { complete: boolean; missing: string[]; verification: LegalVerification['state'] } {
  const missing: string[] = [];
  const issuer = profile.issuer;
  if (!issuer.registeredName.trim()) missing.push('registeredName');
  if (!issuer.registrationNo.trim()) missing.push('registrationNo');
  if (!issuer.registeredAddress.line1.trim()) missing.push('registeredAddress.line1');
  if (!issuer.registeredAddress.city.trim()) missing.push('registeredAddress.city');
  if (!issuer.registeredAddress.country.trim()) missing.push('registeredAddress.country');
  return { complete: missing.length === 0, missing, verification: legalVerificationOf(profile).state };
}

const governance = (tenantId: string) => `${tenantId}-governance`;

function emptyIssuer(): IssuerBlock {
  return {
    registeredName: '',
    tradingName: '',
    registrationNo: '',
    vatNumber: '',
    registeredAddress: { line1: '', line2: '', city: '', postcode: '', country: '' },
    contact: { phone: '', email: '', web: '' },
    footerLegalText: '',
  };
}

/**
 * The profile as it stands. A company that has never set one has a version
 * 0 profile derived from its onboarding: the legal name as registered name,
 * the branding's legal footer as the footer text, and a report numbering
 * rule made from its document reference prefix — which is what every export
 * carried before profiles existed, so nothing changes until somebody
 * changes it.
 */
export function issuerProfile(platform: Platform, tenantId: string): IssuerProfile {
  const record = platform.ledger.get({ refType: 'IssuerProfile', refId: tenantId });
  if (record) return record.state as unknown as IssuerProfile;
  const tenant = platform.tenant(tenantId);
  const brand = platform.exports.brandingIfConfigured(tenantId) ?? null;
  return {
    id: tenantId,
    tenantId,
    version: 0,
    issuer: {
      ...emptyIssuer(),
      registeredName: tenant.legalName,
      tradingName: tenant.legalName,
      registeredAddress: { line1: '', line2: '', city: '', postcode: '', country: tenant.jurisdiction },
      footerLegalText: brand?.legalFooter ?? '',
    },
    numberingRules: brand ? { report: { prefix: `${brand.documentReferencePrefix}-`, pattern: '{seq:5}', seqScope: 'all' } } : {},
    signatories: [],
    brand,
    legal: { state: 'UNVERIFIED', note: 'Display name from onboarding; registered details not yet entered' },
    documentPolicies: {},
    updatedAt: tenant.createdAt,
    updatedBy: 'platform',
    change: 'CREATED',
  };
}

function assertRule(type: string, rule: NumberingRule): void {
  if (!(DOCUMENT_TYPES as readonly string[]).includes(type)) {
    throw new DomainError('DOCUMENT_TYPE_UNKNOWN', `${type} is not a document type. One of: ${DOCUMENT_TYPES.join(', ')}`);
  }
  if (!/^\{seq:\d\}$|\{seq:\d\}/.test(rule.pattern) || (rule.pattern.match(/\{seq:\d\}/g) ?? []).length !== 1) {
    throw new DomainError('NUMBERING_PATTERN_INVALID', `The ${type} pattern needs exactly one {seq:N} with N from 1 to 9`);
  }
  const leftover = rule.pattern.replace(/\{(YYYY|YY|MM|seq:\d)\}/g, '');
  if (/[{}]/.test(leftover)) throw new DomainError('NUMBERING_PATTERN_INVALID', `The ${type} pattern has a placeholder that is not {YYYY}, {YY}, {MM} or {seq:N}`);
  if (rule.seqScope !== 'year' && rule.seqScope !== 'all') throw new DomainError('NUMBERING_SCOPE_INVALID', 'seqScope is year or all');
  if (rule.prefix.length > 16) throw new DomainError('NUMBERING_PREFIX_TOO_LONG', 'A prefix is at most 16 characters');
}

function commitProfile(platform: Platform, actorId: string, profile: IssuerProfile): void {
  platform.ledger.commit({
    tenantId: profile.tenantId,
    projectId: governance(profile.tenantId),
    actor: { refType: 'User', refId: actorId },
    source: 'WEB',
    correlationId: ulid(),
    eventType: 'ISSUER_PROFILE_UPDATED',
    entity: { refType: 'IssuerProfile', refId: profile.tenantId },
    nextState: { ...profile } as unknown as Record<string, unknown>,
  });
}

/** Set the issuer block, numbering rules and signatories. A new version; issued documents are untouched. */
export function setIssuerProfile(
  platform: Platform,
  actor: AuthContext,
  input: { issuer?: Partial<IssuerBlock>; numberingRules?: Record<string, NumberingRule>; signatories?: Signatory[]; documentPolicies?: Record<string, DocumentPolicy> },
): IssuerProfile {
  const current = issuerProfile(platform, actor.tenantId);
  const issuer: IssuerBlock = {
    ...current.issuer,
    ...(input.issuer ?? {}),
    registeredAddress: { ...current.issuer.registeredAddress, ...(input.issuer?.registeredAddress ?? {}) },
    contact: { ...current.issuer.contact, ...(input.issuer?.contact ?? {}) },
  };
  const issuerChanged = JSON.stringify(issuer) !== JSON.stringify(current.issuer);
  const documentPolicies = input.documentPolicies ?? current.documentPolicies ?? {};
  for (const [type, policy] of Object.entries(documentPolicies)) {
    if (!(DOCUMENT_TYPES as readonly string[]).includes(type)) throw new DomainError('DOCUMENT_TYPE_UNKNOWN', `${type} is not a document type`);
    if (typeof policy?.approvalRequired !== 'boolean') throw new DomainError('DOCUMENT_POLICY_INVALID', `The ${type} policy says whether approval is required, true or false`);
  }
  for (const [key, value] of Object.entries(issuer)) {
    if (typeof value === 'string' && value.length > 300) throw new DomainError('PROFILE_FIELD_TOO_LONG', `${key} is longer than 300 characters`);
  }
  if (!issuer.registeredName.trim()) throw new DomainError('REGISTERED_NAME_REQUIRED', 'The issuer needs a registered name; it is what contractual documents carry');
  const numberingRules = input.numberingRules ?? current.numberingRules;
  for (const [type, rule] of Object.entries(numberingRules)) assertRule(type, rule);
  const signatories = input.signatories ?? current.signatories;
  for (const signatory of signatories) {
    const user = platform.user(signatory.userId);
    if (user.tenantId !== actor.tenantId) throw new DomainError('SIGNATORY_NOT_HERE', `${signatory.userId} is not a person in this company`, 422);
    for (const type of signatory.documents) {
      if (!(DOCUMENT_TYPES as readonly string[]).includes(type)) throw new DomainError('DOCUMENT_TYPE_UNKNOWN', `${type} is not a document type`);
    }
  }
  const now = new Date().toISOString();
  const legal = legalVerificationOf(current);
  const next: IssuerProfile = {
    id: actor.tenantId,
    tenantId: actor.tenantId,
    version: current.version + 1,
    issuer,
    numberingRules,
    signatories,
    brand: platform.exports.brandingIfConfigured(actor.tenantId) ?? null,
    // A changed issuer block is a new declaration; what the operator verified
    // was the previous version. Anything else keeps the verification it had.
    legal: issuerChanged
      ? { state: 'DECLARED', declaredAt: now, declaredBy: actor.actorId, note: legal.state === 'VERIFIED' ? `Re-declared after verification of version ${legal.verifiedVersion ?? current.version}` : 'Declared by the company' }
      : legal,
    documentPolicies,
    updatedAt: now,
    updatedBy: actor.actorId,
    change: 'PROFILE',
  };
  commitProfile(platform, actor.actorId, next);
  return next;
}

/**
 * The platform operator records that the declared issuer details were
 * checked against the register. A new version, on the company's own chain,
 * under the operator's name: verification is an act somebody did, not a flag.
 * Refused while the details are incomplete — there is nothing to verify.
 */
export function verifyIssuerProfile(platform: Platform, operator: AuthContext, tenantId: string, note: string): IssuerProfile {
  const current = issuerProfile(platform, tenantId);
  const readiness = legalReadiness(current);
  if (!readiness.complete) {
    throw new DomainError('LEGAL_PROFILE_INCOMPLETE', `The registered issuer details are incomplete (${readiness.missing.join(', ')}); the company enters them before they can be verified`, 422);
  }
  const now = new Date().toISOString();
  const next: IssuerProfile = {
    ...current,
    id: tenantId,
    version: current.version + 1,
    legal: { ...legalVerificationOf(current), state: 'VERIFIED', verifiedAt: now, verifiedBy: operator.actorId, verifiedVersion: current.version + 1, note: note.trim().slice(0, 500) },
    updatedAt: now,
    updatedBy: operator.actorId,
    change: 'VERIFICATION',
  };
  commitProfile(platform, operator.actorId, next);
  return next;
}

/**
 * The brand kit changed. The profile version counts that too, because a
 * document pins one number and the brand is part of what it pins. Called by
 * the routes that set the tenancy's branding or cover.
 */
export function recordBrandChange(platform: Platform, actor: AuthContext): IssuerProfile {
  const current = issuerProfile(platform, actor.tenantId);
  const next: IssuerProfile = {
    ...current,
    id: actor.tenantId,
    version: current.version + 1,
    brand: platform.exports.brandingIfConfigured(actor.tenantId) ?? null,
    updatedAt: new Date().toISOString(),
    updatedBy: actor.actorId,
    change: 'BRAND',
  };
  commitProfile(platform, actor.actorId, next);
  return next;
}

/** A past version, from the chain. Version 0 is the derived one and is not on the chain. */
export function issuerProfileVersion(platform: Platform, tenantId: string, version: number): IssuerProfile {
  // The ledger holds diffs; the state at each version is the diffs applied
  // in order up to that event. Every version ever set is therefore readable,
  // which is what "a document pins a version" needs to mean anything.
  const events = platform.ledger.eventsForEntity({ refType: 'IssuerProfile', refId: tenantId });
  let state: unknown = {};
  for (const event of events) {
    state = applyPatch(state, event.diff);
    if ((state as IssuerProfile).version === version) return state as IssuerProfile;
  }
  if (version === 0 && events.length === 0) return issuerProfile(platform, tenantId);
  throw new NotFoundError(`No version ${version} of this company's profile (${events.length} recorded)`);
}

// --- document numbers ------------------------------------------------------------

export type DocumentSequence = { id: string; tenantId: string; documentType: string; scopeKey: string; next: number; lastAllocated?: string };

function scopeKeyFor(rule: NumberingRule, now: Date): string {
  return rule.seqScope === 'year' ? String(now.getUTCFullYear()) : 'all';
}

export function renderNumber(rule: NumberingRule, seq: number, now: Date): string {
  const yyyy = String(now.getUTCFullYear());
  const body = rule.pattern
    .replace('{YYYY}', yyyy)
    .replace('{YY}', yyyy.slice(2))
    .replace('{MM}', String(now.getUTCMonth() + 1).padStart(2, '0'))
    .replace(/\{seq:(\d)\}/, (_, width: string) => String(seq).padStart(Number(width), '0'));
  return `${rule.prefix}${body}`;
}

/**
 * Allocate the next number for a document type. Atomic by construction — one
 * process, one request at a time, the counter on the chain — and gapless: a
 * number handed out is used, because the caller asked for it at the moment
 * of issue rather than in advance.
 */
export function allocateDocumentNumber(
  platform: Platform,
  actor: AuthContext,
  documentType: string,
  now = new Date(),
): { number: string; documentType: string; seq: number; profileVersion: number } {
  const profile = issuerProfile(platform, actor.tenantId);
  const rule = profile.numberingRules[documentType];
  if (!rule) {
    throw new DomainError(
      'NUMBERING_RULE_MISSING',
      `${actor.tenantId === platform.tenant(actor.tenantId).id ? platform.tenant(actor.tenantId).legalName : 'This company'} has no numbering rule for ${documentType}. Set one on the company profile.`,
      422,
    );
  }
  const scopeKey = scopeKeyFor(rule, now);
  const refId = `${actor.tenantId}:${documentType}:${scopeKey}`;
  const record = platform.ledger.get({ refType: 'DocumentSequence', refId });
  const sequence: DocumentSequence = record
    ? (record.state as unknown as DocumentSequence)
    : { id: refId, tenantId: actor.tenantId, documentType, scopeKey, next: 1 };
  const seq = sequence.next;
  const number = renderNumber(rule, seq, now);
  platform.ledger.commit({
    tenantId: actor.tenantId,
    projectId: governance(actor.tenantId),
    actor: { refType: 'User', refId: actor.actorId },
    source: 'SYSTEM',
    correlationId: ulid(),
    eventType: 'DOCUMENT_NUMBER_ALLOCATED',
    entity: { refType: 'DocumentSequence', refId },
    nextState: { ...sequence, next: seq + 1, lastAllocated: number } as unknown as Record<string, unknown>,
  });
  return { number, documentType, seq, profileVersion: profile.version };
}
