import { ulid } from '../core/ids.ts';
import { config } from '../config.ts';
import type { ACUWallet } from '../billing/acu.ts';
import type { ExportDocument } from './exporter.ts';
import type { ImageResolver } from './pdf.ts';
import { DOCX_CONTENT_TYPE } from './docx.ts';

/**
 * Rendering a document out of the platform, and charging for it.
 *
 * Generation was metered and rendering was not. The AI narrative sections
 * inside a document reserved and settled against the wallet; turning the
 * finished document into a file anybody could hold was free and unrecorded, so
 * a tenancy could take five hundred branded reports out and the ACU statement
 * would show the writing and none of the issuing.
 *
 * That is the wrong way round for the thing that actually leaves the building.
 * A rendered document is the platform's output as a customer experiences it —
 * it carries their branding, their client's name, the redaction decision and
 * the attestation hash — and it is the artefact a dispute is argued over three
 * years later. It should appear on the bill, and it should appear whichever
 * form was asked for.
 *
 * **One price for both forms.** A Word file and a PDF are the same instrument
 * off the same `ExportDocument`, with the same `contentHash`. Charging
 * differently would be charging for the file extension, and it would push
 * people towards the form that suits the bill rather than the form that suits
 * the job.
 *
 * **Reserved and settled, not debited.** The wallet's hold-then-settle path is
 * the one every other charge takes, so a render lands in the statement with a
 * module and a feature against it and shows up in the attribution report beside
 * everything else. A private debit helper would have been a second way money
 * leaves a wallet.
 *
 * **The charge is taken after the bytes exist.** A render that throws must not
 * bill: the hold is released and nothing is settled, so a customer is never
 * charged for a document they did not receive.
 */

export type RenderedDocument = {
  contentType: string;
  filename: string;
  bytes: Uint8Array;
  /** What this render cost, in the units the ACU statement is written in. */
  chargedMinor: number;
};

/** The two forms a document may be taken out in. */
export type RenderableFormat = 'PDF' | 'DOCX';

const CONTENT_TYPE: Record<RenderableFormat, string> = {
  PDF: 'application/pdf',
  DOCX: DOCX_CONTENT_TYPE,
};

const EXTENSION: Record<RenderableFormat, string> = { PDF: 'pdf', DOCX: 'docx' };

/**
 * What the saved file is called.
 *
 * The reference is the traceable code — it is printed on the cover and in every
 * footer, and it is what a dispute is argued over. It is not a name a person
 * recognises in a downloads folder, and when a tenancy has not configured its
 * own reference prefix it inherits the project's name, so a tender submission
 * came down the wire as `RFX1000209 - EPC Assessments-00002.pdf` — the name of
 * an unrelated project with a sequence number on it.
 *
 * The document's `title` is the human name the person asked for the thing to be
 * — "Tender Submission — South Holland District Council", "Pricing Schedule" —
 * and the subtitle distinguishes one project's schedule from another's. That is
 * what the file should be called. The reference stays inside the document, where
 * traceability belongs; it does not need to be the filename as well.
 */
function downloadFilename(document: ExportDocument, format: RenderableFormat): string {
  const title = (document.title ?? '').trim();
  const subtitle = (document.subtitle ?? '').trim();
  // The subtitle earns its place only when it says something the title does not
  // already — the project behind a bare "Pricing Schedule", not a repeat of a
  // client already named in the title.
  const composed = subtitle && !title.toLowerCase().includes(subtitle.toLowerCase()) ? `${title} - ${subtitle}` : title;

  // Fold to a name a filesystem and a bare `filename="…"` Content-Disposition
  // header can both carry: ASCII only, no characters a filesystem forbids. The
  // dashes and quotation marks in the domain text are kept as their plain
  // equivalents rather than dropped, so the name still reads as written.
  const stem = (composed || document.reference)
    .replace(/[‒-―−]/g, '-') // figure/en/em dash, horizontal bar, minus → hyphen
    .replace(/[‘’‚‛]/g, "'") // single quotation marks → apostrophe
    .replace(/[“”„‟]/g, '"') // double quotation marks → straight quote
    .replace(/[\\/:*?"<>|]/g, ' ') // characters a filesystem or the header cannot carry
    .replace(/[^\x20-\x7e]/g, ' ') // anything else outside printable ASCII
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150)
    .trim();

  return `${stem.length > 0 ? stem : 'document'}.${EXTENSION[format]}`;
}

/**
 * What a render will cost, without doing one.
 *
 * The console quotes before it offers the button, exactly as it does for an AI
 * command — the rule that nothing spends a tenancy's balance without showing
 * the price first does not stop being true because the work is local.
 */
export function quoteRender(wallet: ACUWallet): {
  chargeMinor: number;
  affordable: boolean;
  availableMinor: number;
  /** Named when it is not affordable, so the control can say why rather than just being shut. */
  blockedReason?: string;
} {
  const quote = wallet.quote(config.billing.documentRenderRawCostMinor);
  return {
    chargeMinor: quote.chargeMinor,
    affordable: quote.blockedReason === undefined,
    availableMinor: quote.availableMinor,
    ...(quote.blockedReason ? { blockedReason: quote.blockedReason } : {}),
  };
}

/**
 * Render a document to a file and charge the tenancy for it.
 *
 * @param renderers The two renderers, supplied rather than imported, so this
 *   file stays a billing decision about a document rather than a second place
 *   that knows how to draw one.
 */
export function renderAndCharge(
  wallet: ACUWallet,
  document: ExportDocument,
  input: {
    format: RenderableFormat;
    projectId?: string;
    userId?: string;
    resolveImage?: ImageResolver;
  },
  renderers: {
    pdf: (document: ExportDocument, resolveImage?: ImageResolver) => Uint8Array;
    docx: (document: ExportDocument, resolveImage?: ImageResolver) => Uint8Array;
  },
): RenderedDocument {
  // One figure, read once, used for both the hold and the settlement.
  //
  // Reading the config twice let the two drift: a change that made the hold
  // bigger than the settlement would quietly under-charge, and the reverse
  // would refuse renders a tenancy could afford. Neither shows up in a test
  // that only inspects the final charge, which is how it survived a mutation.
  const rawCostMinor = config.billing.documentRenderRawCostMinor;

  // Reserved first, so a tenancy with an empty wallet is refused before the
  // work is done rather than after — the same order the AI path takes.
  const hold = wallet.reserve({
    aiRequestId: ulid(),
    estimatedRawCostMinor: rawCostMinor,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
    module: 'EXPORT',
    feature: `document_render_${input.format.toLowerCase()}`,
  });

  let bytes: Uint8Array;
  try {
    bytes = input.format === 'DOCX' ? renderers.docx(document, input.resolveImage) : renderers.pdf(document, input.resolveImage);
  } catch (error) {
    // Nothing was produced, so nothing is charged.
    wallet.release(hold.holdId, 'Document render failed');
    throw error;
  }

  const entry = wallet.settle(hold.holdId, rawCostMinor, 'LOCAL');

  return {
    contentType: CONTENT_TYPE[input.format],
    filename: downloadFilename(document, input.format),
    bytes,
    chargedMinor: entry.billedMinor,
  };
}
