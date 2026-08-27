import { DomainError } from '../core/errors.ts';
import type { DocumentBlock, ExportAudience } from '../export/exporter.ts';
import type { EngineContext } from '../engines/context.ts';

/**
 * Document generation — the engine.
 *
 * A construction document is not a template with the project name substituted
 * into it. It is a *composition of records*, and the difference is the whole
 * point of this file.
 *
 * The requirement was: extremely detailed, deeply reasoned, **no generic
 * information**, fully branded. Three of those four are matters of care. The
 * third is architectural, and it cannot be met by instructing a model to avoid
 * being generic — a model asked to write a permit to work with no permit behind
 * it will write an excellent permit to work, and every word of it will be
 * invented. On a document that authorises a person to enter a confined space,
 * that is not a quality problem. It is a fatality waiting for a coroner.
 *
 * So the guarantee here is a **refusal**, not a prompt:
 *
 * > Every document type declares the records it is composed from. A mandatory
 * > source that does not exist is a refusal naming exactly what is missing and
 * > where to record it. Nothing is ever written to fill the gap.
 *
 * ---
 *
 * **What the AI does, and what it must never do.**
 *
 * Every figure, date, name, reference, quantity and hash on a generated
 * document comes from a record. The model contributes the connective reasoning
 * a good document has and a generated one usually lacks — why this sequence
 * rather than another, how a hazard leads to the control chosen for it, what
 * the pattern across forty diary entries actually says. It is given the records
 * and asked to reason about them; it is never asked for a fact.
 *
 * Each narrative section is marked on the page as machine-written, with the
 * model's own confidence beside it, because a reader deciding how much weight
 * to give a paragraph is entitled to know who wrote it.
 *
 * **Depth is composition, not length.** A permit to work that lists its
 * operatives is a form. One that lists each operative *beside the qualification
 * that authorises them and the date that qualification expires* — checked
 * against the permit's own end date — is a document. Both are the same length.
 * The second is possible only because the platform holds the competency
 * records, and that is what every generator here is built to exploit.
 */

export type Row = Record<string, unknown>;

/**
 * One record set a document is composed from.
 *
 * `contributes` and `recordedBy` exist for the refusal. When the source is
 * missing, the person reading the error needs to know what the document wanted
 * it for and where to go and create it — "no RAMS found" tells them neither.
 */
export type SourceBinding = {
  refType: string;
  /** What this source contributes, in the words the refusal will use. */
  contributes: string;
  /** Where a person goes to record it. */
  recordedBy: string;
  /**
   * Mandatory sources are the ones the document would have to invent. Their
   * absence is a refusal. An optional source's absence is a stated gap on the
   * page — which is a different and honest thing.
   */
  mandatory: boolean;
  /** Narrows the set: an approved RAMS is a source, a draft one is not. */
  predicate?: (state: Row) => boolean;
  /** Describes the predicate for the refusal — "approved", "issued", "open". */
  qualifier?: string;
};

export type NarrativeSection = {
  heading: string;
  /**
   * What the model is asked to reason about. Never "write the section" — the
   * section's facts are already on the page above it.
   */
  brief: string;
};

export type DocumentCategory = 'SAFETY_AND_HEALTH' | 'PROJECT_MANAGEMENT' | 'QUALITY_AND_COMPLIANCE';

/**
 * Whether one document covers the project or one covers a single record.
 *
 * A construction phase plan is the project's. A permit to work is one permit's,
 * and generating "the permits" as a single document would produce something
 * nobody can sign, hand to an operative, or close out.
 */
export type DocumentScope = 'PROJECT' | 'RECORD';

export type ResolvedSources = Map<string, Row[]>;

export type DocumentDefinition = {
  code: string;
  title: string;
  category: DocumentCategory;
  /** What the document is for, on the document itself. */
  purpose: string;
  scope: DocumentScope;
  /** For RECORD scope: the entity one document covers. */
  subject?: string;
  /**
   * For RECORD scope: where a person goes to create that record.
   *
   * Named per type rather than left generic. "The screen that creates it" is
   * true and useless — it was what the console showed for four of the fifteen
   * types, beside four others that named a real screen, and the contrast made
   * the platform look like it did not know.
   */
  subjectRecordedBy?: string;
  audience: ExportAudience;
  sources: SourceBinding[];
  narrative: NarrativeSection[];
  /**
   * Build the body. Branding, the control block, the attestation and the
   * content hash are the engine's and the exporter's — a generator that also
   * wrote its own header would put branding in fifteen places.
   */
  compose: (input: ComposeInput) => DocumentBlock[];
  /** The reference on the document, from the subject record where there is one. */
  reference?: (input: ComposeInput) => string | undefined;
};

export type ComposeInput = {
  ctx: EngineContext;
  project: Row;
  sources: ResolvedSources;
  /** The single record this document covers, for RECORD-scope types. */
  subject?: Row;
  /** Narrative by heading. Absent where the model was not run or could not answer. */
  narrative: Map<string, { text: string; confidence?: number }>;
  today: string;
};

/** Everything a source binding could not find, in the words a person needs. */
export type MissingSource = {
  refType: string;
  contributes: string;
  recordedBy: string;
  qualifier?: string;
};

/**
 * Resolve every declared source, and say what is missing.
 *
 * Returns rather than throws: the console asks this question to decide whether
 * to offer the command at all, and a screen that has to catch an exception to
 * render a disabled button is a screen that will forget to.
 */
export function resolveSources(
  ctx: EngineContext,
  definition: DocumentDefinition,
  subject?: Row,
): { sources: ResolvedSources; missing: MissingSource[] } {
  const sources: ResolvedSources = new Map();
  const missing: MissingSource[] = [];

  for (const binding of definition.sources) {
    const rows = ctx.ledger
      .list(ctx.projectId, binding.refType)
      .map((record) => record.state as Row)
      .filter((state) => (binding.predicate ? binding.predicate(state) : true));

    sources.set(binding.refType, rows);

    if (rows.length === 0 && binding.mandatory) {
      missing.push({
        refType: binding.refType,
        contributes: binding.contributes,
        recordedBy: binding.recordedBy,
        qualifier: binding.qualifier,
      });
    }
  }

  // A record-scoped document also needs its subject, which is not one of the
  // declared sources — it is the thing the document is about.
  if (definition.scope === 'RECORD' && !subject) {
    missing.push({
      refType: definition.subject ?? 'record',
      contributes: `the ${humanEntity(definition.subject ?? 'record')} this document is written about — every figure, ` +
        'date and name on it comes from that one record',
      recordedBy: definition.subjectRecordedBy ?? 'the screen that creates it',
    });
  }

  return { sources, missing };
}

/**
 * The refusal.
 *
 * This sentence is the product. It is what a person reads instead of a
 * plausible document, and it has to leave them able to act — which means
 * naming the record, saying what the document wanted it for, and saying where
 * to go and create it.
 */
export function assertGenerable(definition: DocumentDefinition, missing: MissingSource[]): void {
  if (missing.length === 0) return;

  const sentences = missing.map(
    (source) =>
      `no ${source.qualifier ? `${source.qualifier} ` : ''}${humanEntity(source.refType)} exists, which is where ` +
      `${source.contributes} comes from (recorded on ${source.recordedBy})`,
  );

  throw new DomainError(
    'DOCUMENT_SOURCES_MISSING',
    `A ${definition.title} cannot be generated yet: ${sentences.join('; and ')}. ` +
      'Nothing here writes a document from what it assumes — a section with no record behind it would read exactly like one ' +
      'with a record behind it, and nobody downstream could tell them apart.',
    409,
  );
}

/** `SiteLogisticsPlan` → "site logistics plan". Used only in the refusal. */
export function humanEntity(refType: string): string {
  return refType
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
}

// --- Blocks the generators share -------------------------------------------

/**
 * A section the platform cannot fill, said out loud on the page.
 *
 * The alternative — omitting it — is worse: a reader cannot tell a section that
 * did not apply from one nobody completed, and the second is the one that gets
 * somebody hurt.
 */
export function gapBlock(what: string, why: string): DocumentBlock {
  return { kind: 'PARAGRAPH', text: `[Not recorded: ${what}. ${why}]` };
}

/**
 * A machine-written section, marked as one.
 *
 * A reader deciding how much weight to give a paragraph is entitled to know who
 * wrote it. Where the model could not be run — an empty wallet, a provider
 * outage — the heading stays and the absence is stated, because a document that
 * silently drops a section it was supposed to have is a document that lies by
 * omission.
 */
export function narrativeBlocks(
  heading: string,
  written: { text: string; confidence?: number } | undefined,
): DocumentBlock[] {
  const blocks: DocumentBlock[] = [{ kind: 'HEADING', level: 2, text: heading }];

  if (!written?.text.trim()) {
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        '[This section is written by the platform’s reasoning engine from the records above, and could not be produced for ' +
        'this issue. The records themselves are unaffected — everything factual in this document is on the pages above.]',
    });
    return blocks;
  }

  blocks.push({ kind: 'PARAGRAPH', text: written.text });
  blocks.push({
    kind: 'PARAGRAPH',
    text:
      'Written by the platform’s reasoning engine from the records set out above' +
      (written.confidence !== undefined ? `, at a stated confidence of ${(written.confidence * 100).toFixed(0)}%` : '') +
      '. It contains no figure, date, name or reference that is not already on this document.',
  });

  return blocks;
}

/**
 * Formats a value for a document, never inventing a placeholder for an absent
 * one — and never printing `[object Object]`.
 *
 * That last clause is the reason this is not just `String(value)`. A structured
 * field bound by mistake used to render as `[object Object]` on the page, which
 * is worse than saying nothing: it looks like data, it survives review because
 * the eye slides over it, and it tells the reader the platform does not know
 * what it is talking about. An object reaching here is a binding error, and the
 * honest output for a binding error is the same as for an absent value.
 */
export function shown(value: unknown, absent = 'Not recorded'): string {
  if (value === null || value === undefined) return absent;
  if (typeof value === 'object') return absent;
  const text = String(value).trim();
  return text.length > 0 ? text : absent;
}

/**
 * A location object as a person would write an address.
 *
 * The platform stores place as ISO codes so portfolio filters aggregate
 * cleanly worldwide. A document is read by a person standing at a gate, and
 * "EU/GB/Manchester" is not where they are.
 */
export function place(value: unknown, absent = 'Not recorded'): string {
  if (!value || typeof value !== 'object') return shown(value, absent);
  const location = value as Record<string, unknown>;
  const parts = [location.address, location.city, location.region, location.postcode, location.countryCode]
    .map((part) => shown(part, ''))
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(', ') : absent;
}

/**
 * Actor ids resolved to the people they name.
 *
 * "Issued by 01M105X7W7PNHQH08NNPJW3G5Y" is true and useless. On a permit to
 * work the reader needs a person — the one they will go and find when the gas
 * test reading looks wrong. The directory lives in the tenancy's own governance
 * scope rather than on the project, which is why this reaches across to it: a
 * document naming ids is a document nobody can act on.
 *
 * Falls back to the id rather than to a blank. An unresolvable actor is still a
 * traceable one, and losing it would be worse than showing it raw.
 */
export function people(ctx: EngineContext): (actorId: unknown) => string {
  const directory = new Map<string, string>();
  for (const record of ctx.ledger.list(`${ctx.tenantId}-governance`, 'User')) {
    const id = String(record.state.id ?? record.refId);
    const name = shown(record.state.name, '');
    if (name.length > 0) directory.set(id, name);
  }
  // Operatives are not platform users — they are people on a site, and the
  // induction register is where the platform learns their names. Without this
  // a permit names the ticket that authorises somebody and then identifies them
  // as `op-welder-1`, which is the half of the record that does not help.
  for (const record of ctx.ledger.list(ctx.projectId, 'Induction')) {
    const id = shown(record.state.personId, '');
    const name = shown(record.state.personName, '');
    if (id.length > 0 && name.length > 0) directory.set(id, name);
  }
  return (actorId: unknown) => {
    const id = shown(actorId, '');
    if (id.length === 0) return 'Not recorded';
    return directory.get(id) ?? id;
  };
}

/** `HOT_WORK` → "Hot work". Enum codes are for machines; documents are read. */
export function humanValue(value: unknown, absent = 'Not recorded'): string {
  const text = shown(value, '');
  if (text.length === 0) return absent;
  if (!/^[A-Z][A-Z0-9_]*$/.test(text)) return text;
  const spaced = text.replace(/_/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * An instant as a person standing at a gate reads it.
 *
 * A permit that says `2027-02-08T07:00:00.000Z` is a permit whose validity
 * nobody checks, because reading it takes a moment longer than glancing at it
 * and the glance is what actually happens at 06:55 on a wet morning.
 */
export function shownTime(value: unknown, absent = 'Not recorded'): string {
  const text = shown(value, '');
  if (text.length === 0 || Number.isNaN(Date.parse(text))) return absent;
  const at = new Date(text);
  const day = at.toISOString().slice(0, 10);
  const time = at.toISOString().slice(11, 16);
  return `${day} at ${time}`;
}

export function shownDate(value: unknown, absent = 'Not recorded'): string {
  const text = shown(value, '');
  return text.length === 0 ? absent : text.slice(0, 10);
}
