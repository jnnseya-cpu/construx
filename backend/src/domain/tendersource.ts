import type { EngineContext } from '../engines/context.ts';
import type { IngestedFileState } from '../evidence/pipeline.ts';

/**
 * Where in the tender pack a requirement was read from.
 *
 * A reading asks the model for `sourceQuote`, a passage copied from the
 * document, and the checks already confirm it is really there. Until now the
 * quote was dropped on confirmation: the matrix said what the buyer wanted but
 * not where they said it, so a bid manager had to search five documents again
 * to settle whether the buyer really asked for the thing. This finds the quote
 * in the documents themselves — in code, not by asking the model — and records
 * the file, the page it is printed on where the PDF's pages are known, the
 * clause or question number, and the passage.
 *
 * Nothing is invented. A quote that is not in the documents is recorded as not
 * located, and the line says so, rather than being given a plausible page.
 */

export type QuoteSource = {
  /** The file the passage is in, as it was uploaded. Absent when the passage was not found. */
  document?: string;
  ingestionId?: string;
  /** The page it is printed on — PDFs read from their text layer only. */
  page?: number;
  /** The clause, paragraph or question number the reading gave it. */
  clause?: string;
  /** The passage, as the document prints it. */
  quote?: string;
  /** True only where the passage was found in the documents by this code. */
  located: boolean;
};

export type SourceDocument = {
  ingestionId?: string;
  filename: string;
  text: string;
  pageStarts?: Array<{ page: number; offset: number }>;
};

/**
 * The documents a reading drew on: the pack's files, or the one file read, or
 * none where the text was pasted.
 */
export function sourceDocumentsForDraft(ctx: EngineContext, draft: Record<string, unknown>): SourceDocument[] {
  const files = ctx.ledger
    .list(ctx.projectId, 'IngestedFile')
    .map((record) => record.state as unknown as IngestedFileState)
    .filter((file) => file.status === 'INGESTED');
  const packIds = Array.isArray(draft.packFiles)
    ? (draft.packFiles as Array<{ ingestionId?: unknown }>).map((file) => String(file.ingestionId ?? ''))
    : undefined;
  const chosen = packIds
    ? files.filter((file) => packIds.includes(file.ingestionId))
    : files.filter((file) => draft.evidenceHash !== undefined && file.hash === draft.evidenceHash).slice(0, 1);
  return chosen.flatMap((file) => {
    const extraction = (file.extraction ?? {}) as { text?: unknown; pageStarts?: unknown };
    const text = typeof extraction.text === 'string' ? extraction.text : '';
    if (text.trim() === '') return [];
    return [
      {
        ingestionId: file.ingestionId,
        filename: file.filename ?? file.hash.slice(0, 12),
        text,
        ...(Array.isArray(extraction.pageStarts) ? { pageStarts: extraction.pageStarts as SourceDocument['pageStarts'] } : {}),
      },
    ];
  });
}

/** One kind of quote and dash, lower case, runs of whitespace as one space — with each character's place in the original. */
function normaliseWithMap(text: string): { normal: string; at: number[] } {
  let normal = '';
  const at: number[] = [];
  let lastSpace = true;
  for (let index = 0; index < text.length; index += 1) {
    let char = text[index]!;
    if (/\s/.test(char)) {
      if (lastSpace) continue;
      char = ' ';
      lastSpace = true;
    } else {
      lastSpace = false;
      // One character in, one out, so the map stays aligned: the few letters
      // whose lower case is two characters are compared as they are.
      const lower = char.toLowerCase();
      char = (lower.length === 1 ? lower : char)
        .replace(/[‘’`´]/, "'")
        .replace(/[“”]/, '"')
        .replace(/[‐-―−]/, '-');
    }
    normal += char;
    at.push(index);
  }
  return { normal, at };
}

function normalise(text: string): string {
  return normaliseWithMap(text).normal.trim();
}

/** The page a character offset falls on, where the document's pages are known. */
function pageAt(document: SourceDocument, offset: number): number | undefined {
  if (!document.pageStarts || document.pageStarts.length === 0) return undefined;
  let page: number | undefined;
  for (const start of document.pageStarts) {
    if (start.offset <= offset) page = start.page;
    else break;
  }
  return page;
}

/** Below this, a "quote" is a word or two and would be found anywhere. */
const MIN_QUOTE = 12;

/**
 * Find a passage in the documents. The quote is tried first, then the
 * requirement's own words; the first document that holds either is cited.
 */
export function locateQuote(
  documents: SourceDocument[],
  input: { quote?: unknown; fallback?: unknown; clause?: unknown },
): QuoteSource {
  const clause = typeof input.clause === 'string' && input.clause.trim() !== '' ? input.clause.trim() : undefined;
  const candidates = [input.quote, input.fallback]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => normalise(value).length >= MIN_QUOTE);
  const indexed = documents.map((document) => ({ document, ...normaliseWithMap(document.text) }));
  for (const candidate of candidates) {
    const needle = normalise(candidate);
    for (const { document, normal, at } of indexed) {
      const found = normal.indexOf(needle);
      if (found < 0) continue;
      const start = at[found]!;
      const end = at[found + needle.length - 1]! + 1;
      const page = pageAt(document, start);
      return {
        document: document.filename,
        ...(document.ingestionId ? { ingestionId: document.ingestionId } : {}),
        ...(page !== undefined ? { page } : {}),
        ...(clause ? { clause } : {}),
        // As the document prints it, whitespace tidied — not as the model retyped it.
        quote: document.text.slice(start, end).replace(/\s+/g, ' ').trim(),
        located: true,
      };
    }
  }
  const quote = typeof input.quote === 'string' && input.quote.trim() !== '' ? input.quote.trim() : undefined;
  return { ...(clause ? { clause } : {}), ...(quote ? { quote } : {}), located: false };
}

/** The citation in one line: "Volume 1 ITT.pdf, p. 12, Q3". */
export function describeQuoteSource(source: QuoteSource | undefined): string {
  if (!source) return 'no source recorded';
  if (!source.located) return 'not found in the documents — check it against the pack';
  return [source.document, source.page !== undefined ? `p. ${source.page}` : undefined, source.clause]
    .filter(Boolean)
    .join(', ');
}
