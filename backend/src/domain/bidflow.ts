import { authorise, type EngineContext } from '../engines/context.ts';
import { ingestedFiles } from '../evidence/pipeline.ts';
import { documentsOf } from '../group/issuance.ts';
import type { Platform } from '../platform.ts';

/**
 * Where this job actually is, and the one thing to do next.
 *
 * Said plainly by the person paying for it, after walking the same enquiry
 * through four screens: *"the flow is not working everywhere in this OS"*. Each
 * screen was right on its own. What was missing is the thing that makes a set
 * of screens an operating system rather than a filing cabinet — anywhere in it,
 * an answer to "what happens now".
 *
 * The symptom was a chain of dead ends, each individually correct. Read the
 * invitation: no tender requirements, because the enquiry is a letter. Confirm
 * it: no compliance matrix, because the company's facts are not recorded. Plan
 * a response pack: nothing to act on, because there is no matrix. Three
 * truthful refusals in a row, and nothing anywhere saying that this job does
 * not need a matrix at all — it needs a price.
 *
 * ## Two roads, and a job takes one of them
 *
 * **Price it.** An enquiry arrives as a letter or an email with drawings
 * attached: read the sheets, measure them, price the bill, send a quotation.
 * No compliance matrix, no response pack, no red team. This is most small works
 * and it is the road that had no map.
 *
 * **Bid it.** A formal invitation arrives with instructions to tenderers and a
 * numbered return register: read the invitation, file what has to go back, set
 * it against what this business holds, write the submission, attack it, submit.
 * It *also* needs a price, so the pricing road runs underneath it rather than
 * instead of it.
 *
 * Which road a job is on is a fact about the enquiry, not a preference, so it
 * is derived rather than asked: an invitation carrying more than a price is a
 * bid; anything else is a quotation.
 *
 * ## Computed here, not in the browser
 *
 * Every step's state is read from the record — files ingested, quantities
 * measured, an estimate built, a document issued. The console holds no copy of
 * these rules, for the same reason it holds no copy of the permission matrix:
 * a second implementation of "what happens now" is a second thing to drift, and
 * the one that drifts is always the one nobody tests.
 */

export type FlowState = 'DONE' | 'READY' | 'BLOCKED' | 'NOT_NEEDED';

export type FlowStep = {
  id: string;
  title: string;
  state: FlowState;
  /** What is true now, from the record. */
  detail: string;
  /** What to do about it, where it is not done. */
  next?: string;
  /**
   * The button to press, in the words printed on it.
   *
   * Reported as *"there is not do this Price the bill anywhere"*: the panel
   * named the step — "measure the drawings" — and the screen has no button of
   * that name, because the button is called "Read and price the pack". Naming
   * the step and not the door leaves somebody hunting a screen for a control
   * that is right in front of them under another name.
   */
  door?: string;
  /**
   * The console command the door opens, where it is a single one.
   *
   * Carried so the panel can put the button itself in front of somebody rather
   * than describing where to scroll for it. The screen's own dispatcher runs
   * it: the panel emits the id and holds no knowledge of what the command does,
   * which is the same arrangement every other command bar uses.
   */
  command?: string;
  /** The screen that takes the action. */
  screen: 'pipeline' | 'procurement' | 'documents' | 'enterprise';
};

export type BidFlow = {
  road: 'PRICE' | 'BID';
  why: string;
  /** Every step of the road this job is on, in order. */
  steps: FlowStep[];
  /** The one thing to do next, or null when the job is finished. */
  nowDo: FlowStep | null;
  summary: string;
};

export function bidFlow(platform: Platform, ctx: EngineContext): BidFlow {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const files = ingestedFiles(ctx).filter((file) => file.status !== 'QUARANTINED');
  const drawings = files.filter((file) => file.classification.kind === 'DRAWING');
  const boqItems = ctx.ledger.list(ctx.projectId, 'BoQItem').map((record) => record.state);
  const estimates = ctx.ledger.list(ctx.projectId, 'Estimate').map((record) => record.state);
  const complete = estimates.filter((estimate) => ((estimate.omissions as string[] | undefined) ?? []).length === 0);
  const invitation = ctx.ledger.list(ctx.projectId, 'TenderInvitation').map((record) => record.state).at(-1);
  const analyses = ctx.ledger.list(ctx.projectId, 'ITTAnalysis');
  const packs = ctx.ledger.list(ctx.projectId, 'BidResponsePack').map((record) => record.state);
  const reviews = ctx.ledger.list(ctx.projectId, 'AssuranceReview');
  const profile = ctx.ledger.get({ refType: 'CompanyProfile', refId: ctx.tenantId });

  // Quotations are legal instruments and live on the company's own chain rather
  // than the project's, so they are read from there and matched by the estimate
  // they were drawn from.
  const estimateIds = new Set(estimates.map((estimate) => String(estimate.id)));
  const quotations = documentsOf(platform, ctx.tenantId).filter(
    (document) => document.documentType === 'quotation' && document.source && estimateIds.has(document.source.refId),
  );
  const issued = quotations.filter((document) => document.status === 'ISSUED');

  const deliverables = (invitation?.deliverables as Array<{ title?: string }> | undefined) ?? [];
  // An invitation asking for more than a price is a submission to write. One
  // that asks only for a price is a quotation, whatever it calls itself.
  const wantsSubmission = deliverables.length > 1;
  const road: BidFlow['road'] = wantsSubmission ? 'BID' : 'PRICE';

  const steps: FlowStep[] = [];

  steps.push(
    drawings.length > 0
      ? {
          id: 'PACK_FILED',
          title: 'File the pack',
          state: 'DONE',
          detail: `${files.length} file${files.length === 1 ? '' : 's'} filed, ${drawings.length} of them read as drawings.`,
          screen: 'pipeline',
        }
      : {
          id: 'PACK_FILED',
          title: 'File the pack',
          state: 'READY',
          detail:
            files.length === 0
              ? 'Nothing is filed on this project yet.'
              : `${files.length} file${files.length === 1 ? ' is' : 's are'} filed and none reads as a drawing.`,
          next:
            files.length === 0
              ? 'Nothing downstream can measure a pack that is not here.'
              : 'A file keeps whatever the rules said when it was filed, so a drawing typed as something else is re-read rather than re-uploaded.',
          door: files.length === 0 ? 'Upload a tender document' : 'Re-read, on the file’s own row',
          screen: 'pipeline',
        },
  );

  steps.push(
    boqItems.length > 0
      ? {
          id: 'MEASURED',
          title: 'Measure the drawings',
          state: 'DONE',
          detail: `${boqItems.length} measured item${boqItems.length === 1 ? '' : 's'} in the bill.`,
          screen: 'procurement',
        }
      : {
          id: 'MEASURED',
          title: 'Measure the drawings',
          state: drawings.length > 0 ? 'READY' : 'BLOCKED',
          detail: 'Nothing is measured yet, so there is nothing to price.',
          next:
            drawings.length > 0
              ? 'It reads every sheet, measures it, and proposes a rate for each line from your own past estimates — and accepting it does the pricing and the quotation in the same act. "Enter measured quantities", beside it, is the door for a take-off you did with a scale rule.'
              : 'A drawing has to be filed before anything can be measured off it.',
          ...(drawings.length > 0 ? { door: 'Read and price the pack', command: 'price-pack' } : {}),
          screen: 'procurement',
        },
  );

  steps.push(
    complete.length > 0
      ? {
          id: 'ESTIMATED',
          title: 'Price the bill',
          state: 'DONE',
          detail: `${complete.length} complete estimate${complete.length === 1 ? '' : 's'} across the twenty cost heads.`,
          screen: 'procurement',
        }
      : {
          id: 'ESTIMATED',
          title: 'Price the bill',
          state: boqItems.length > 0 ? 'READY' : 'BLOCKED',
          detail:
            estimates.length > 0
              ? `${estimates.length} estimate${estimates.length === 1 ? '' : 's'} built, ${estimates.length === 1 ? 'it carries' : 'each carrying'} a cost head that is neither priced nor excluded.`
              : 'Nothing is priced yet.',
          next:
            estimates.length > 0
              ? 'Price the outstanding heads or state them as exclusions. A nought against a head is not a job without it, and a quotation cannot be drawn from an estimate that carries one.'
              : boqItems.length > 0
                ? 'The button sits under the bill, and is locked until something is measured — which it now is. Accepting the pack run prices it in the same act instead.'
                : 'A bill of quantities has to exist before it can be priced. The button is there and locked until it does.',
          door: 'Price the bill',
          ...(boqItems.length > 0 ? { command: 'build-estimate' } : {}),
          screen: 'procurement',
        },
  );

  steps.push(
    quotations.length > 0
      ? {
          id: 'QUOTED',
          title: 'Draw up the quotation',
          state: 'DONE',
          detail: `${quotations.length} quotation${quotations.length === 1 ? '' : 's'} drafted from ${quotations.length === 1 ? 'this estimate' : 'these estimates'}.`,
          screen: 'procurement',
        }
      : {
          id: 'QUOTED',
          title: 'Draw up the quotation',
          state: complete.length > 0 ? 'READY' : 'BLOCKED',
          detail: 'No offer has been composed from this estimate.',
          next:
            complete.length > 0
              ? 'It sits under the estimate build-up. The customer sees the works, the quantities, the money and the qualifications — never the build-up.'
              : 'A complete estimate has to exist before an offer can be composed from it.',
          door: 'Draw up the quotation',
          ...(complete.length > 0 ? { command: 'quote' } : {}),
          screen: 'procurement',
        },
  );

  steps.push(
    issued.length > 0
      ? {
          id: 'ISSUED',
          title: 'Issue it',
          state: 'DONE',
          detail: `Issued as ${issued.map((document) => document.issuance?.number ?? '—').join(', ')}.`,
          screen: 'documents',
        }
      : {
          id: 'ISSUED',
          title: 'Issue it',
          state: quotations.length > 0 ? 'READY' : 'BLOCKED',
          detail: 'Nothing has gone out under a number yet.',
          next:
            quotations.length > 0
              ? 'Under Legal instruments: generate, then submit, then approve, then issue. Issuing reserves the number and freezes what was approved, which is the one step here that is a legal act rather than arithmetic.'
              : 'A quotation has to be drafted before it can be issued.',
          door: 'Generate a revision, on the quotation’s own row',
          screen: 'documents',
        },
  );

  // The submission road. Present on every job so its absence is a statement
  // rather than a silence: a reader looking for the compliance matrix on a
  // letter enquiry is told it does not need one.
  const bidStep = (step: Omit<FlowStep, 'state'> & { state: FlowState }): FlowStep =>
    wantsSubmission ? step : { ...step, state: 'NOT_NEEDED', detail: 'This enquiry asks only for a price, so there is no submission to write.', ...(step.next ? { next: undefined } : {}) };

  const registerDone = invitation?.requirementsExtracted === true;
  steps.push(
    bidStep({
      id: 'RETURN_REGISTER',
      title: 'Record what has to go back',
      state: registerDone ? 'DONE' : invitation ? 'READY' : 'BLOCKED',
      detail: registerDone
        ? `${deliverables.length} return item${deliverables.length === 1 ? '' : 's'} recorded.`
        : invitation
          ? 'Nothing is recorded about what the submission has to contain.'
          : 'No invitation is recorded on this project.',
      next: registerDone
        ? undefined
        : invitation
          ? 'For an enquiry that arrived as a letter, that is the whole of it. "Add a deliverable", beside it, files one item at a time where a formal invitation asks for several — and reading the invitation with AI files the whole register at once.'
          : 'Record the invitation first.',
      door: invitation ? 'It only asks for a price' : 'Record an ITT',
      ...(invitation ? { command: 'quote-only' } : {}),
      screen: 'pipeline',
    }),
  );

  steps.push(
    bidStep({
      id: 'MATRIX',
      title: 'Set it against what this business holds',
      state: analyses.length > 0 ? 'DONE' : profile ? 'READY' : 'BLOCKED',
      detail:
        analyses.length > 0
          ? `${analyses.length} compliance matri${analyses.length === 1 ? 'x' : 'ces'} on file.`
          : profile
            ? 'No matrix has been produced from a confirmed reading.'
            : 'This company’s own facts are not recorded, so there is nothing to set a buyer’s requirements against.',
      next:
        analyses.length > 0
          ? undefined
          : profile
            ? 'The matrix is produced by the confirmation, not by the reading, so the reading has to be confirmed before it exists.'
            : 'Most of the form is filled in from your own projects; what the platform cannot know is left blank.',
      door: profile ? 'Read this invitation, on the document’s own row' : 'Record the company’s facts',
      screen: 'pipeline',
    }),
  );

  steps.push(
    bidStep({
      id: 'RESPONSE_PACK',
      title: 'Write the submission',
      state: packs.length > 0 ? 'DONE' : analyses.length > 0 ? 'READY' : 'BLOCKED',
      detail:
        packs.length > 0
          ? `${packs.length} response pack${packs.length === 1 ? '' : 's'} planned.`
          : 'No submission has been planned.',
      next:
        packs.length > 0
          ? 'Write the next section until none remains, then attack the pack before issuing it.'
          : analyses.length > 0
            ? 'Then write one section at a time: the size of the tender decides how many passes run, never how much of it fits into one.'
            : 'A compliance matrix has to exist before a submission can be planned against it.',
      door: packs.length > 0 ? 'Write the next section' : 'Plan a response pack',
      command: packs.length > 0 ? 'bid-section' : 'bid-plan',
      screen: 'pipeline',
    }),
  );

  steps.push(
    bidStep({
      id: 'RED_TEAM',
      title: 'Attack it before the buyer does',
      state: reviews.length > 0 ? 'DONE' : packs.length > 0 ? 'READY' : 'BLOCKED',
      detail:
        reviews.length > 0
          ? `${reviews.length} assurance review${reviews.length === 1 ? '' : 's'} on file.`
          : 'Nothing has challenged this pack.',
      next:
        reviews.length > 0
          ? undefined
          : packs.length > 0
            ? 'A pack that passes every completeness rule can still score nothing, because completeness is not the question a scorer asks.'
            : 'A pack has to exist before it can be attacked.',
      door: 'Attack the pack',
      command: 'bid-challenge',
      screen: 'pipeline',
    }),
  );

  const actionable = steps.filter((step) => step.state === 'READY' || step.state === 'BLOCKED');
  const nowDo = actionable.find((step) => step.state === 'READY') ?? actionable[0] ?? null;

  const done = steps.filter((step) => step.state === 'DONE').length;
  const needed = steps.filter((step) => step.state !== 'NOT_NEEDED').length;

  return {
    road,
    why: wantsSubmission
      ? `${deliverables.length} return items are recorded against this invitation, so it is a submission to write as well as a price to build.`
      : 'Nothing recorded against this enquiry asks for more than a price, so it is a quotation rather than a submission.',
    steps,
    nowDo,
    summary: nowDo
      ? `${done} of ${needed} done. Next: ${nowDo.title.toLowerCase()}.`
      : `${done} of ${needed} done. Nothing is outstanding on this road.`,
  };
}
