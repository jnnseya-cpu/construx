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
  /*
   * The invitation, wherever it actually lives.
   *
   * It does not live on the project, and cannot: an invitation arrives before
   * there is a project, which is the whole point of a pipeline. Opportunities
   * and their invitations are written on the tenant's governance chain, and a
   * project created from one records the opportunity it came from.
   *
   * This read only looked at the project's own chain. On every real project
   * there has ever been it found nothing, put the job on the PRICE road, and
   * blocked every bid step behind *"No invitation is recorded on this
   * project"* — including the compliance matrix, which is why **"Plan a
   * response pack — nothing to act on yet"** was the answer on a project whose
   * invitation was sitting on the pipeline board two screens away.
   *
   * Both chains, in that order: an invitation recorded directly against a
   * project wins, because somebody put it there deliberately; otherwise the
   * one belonging to the opportunity this project came from.
   */
  const project = ctx.ledger.get({ refType: 'Project', refId: ctx.projectId })?.state;
  const originOpportunityId = project?.originOpportunityId ? String(project.originOpportunityId) : null;
  const governanceInvitations = ctx.ledger
    .list(`${ctx.tenantId}-governance`, 'TenderInvitation')
    .map((record) => record.state);
  // The opportunity this open job *is*: a pursuit linked to the project at
  // registration carries `projectId`; a win converted into it carries
  // `convertedProjectId`. This is the exact link the pipeline board resolves
  // each tender's returns through, so reading the invitation this way makes the
  // guide and the board agree by construction.
  //
  // Without it, a tenancy running several tenders at once fell to the fuzzy
  // name match below, whose `.at(-1)` picked the LAST-recorded invitation whose
  // buyer name merely overlapped the project name. With two "Telford and Wrekin
  // Council" tenders on the board, the guide reported one tender's "27 returns
  // still without an owner" while the board showed the tender actually in focus
  // with every return owned — a gate the user could never clear, because the
  // screen the guide pointed them at was not the tender the guide was counting.
  const linkedOpportunityId = ctx.ledger
    .list(`${ctx.tenantId}-governance`, 'Opportunity')
    .map((record) => record.state)
    .find(
      (state) =>
        String(state.projectId ?? '') === ctx.projectId || String(state.convertedProjectId ?? '') === ctx.projectId,
    )?.id;
  const projectName = String(project?.name ?? '').toLowerCase().trim();
  const invitation =
    // 1. Recorded directly against the project — somebody put it there on purpose.
    ctx.ledger.list(ctx.projectId, 'TenderInvitation').map((record) => record.state).at(-1) ??
    // 2. The opportunity this job is — the same opportunity→invitation link the
    //    board resolves returns through, so the two never disagree.
    (linkedOpportunityId
      ? governanceInvitations.filter((state) => String(state.opportunityId ?? '') === String(linkedOpportunityId)).at(-1)
      : undefined) ??
    // 3. The invitation on the opportunity this project was converted from.
    (originOpportunityId
      ? governanceInvitations.filter((state) => String(state.opportunityId ?? '') === originOpportunityId).at(-1)
      : undefined) ??
    // 4. A project created outside "convert a won opportunity into a project"
    //    carries no originOpportunityId, so it has no stored link to the
    //    invitation that lives on the opportunity. That left the flow telling
    //    the user to "Record an ITT" for an invitation already recorded — a
    //    dead-end loop, going in a circle. The flow is advisory and commits
    //    nothing, so it is safe to find the invitation by the strongest signal
    //    on the record: the buyer's name or the tender reference naming this
    //    project (a job named "South Holland District Council" is the one the
    //    "South Holland District Council" invitation belongs to). A guess here
    //    can only change guidance, never the ledger.
    (projectName.length > 2
      ? governanceInvitations
          .filter((state) => {
            const client = String(state.clientName ?? '').toLowerCase().trim();
            const reference = String(state.reference ?? '').toLowerCase().trim();
            const title = String(state.title ?? '').toLowerCase().trim();
            return (
              (client.length > 2 && (projectName.includes(client) || client.includes(projectName))) ||
              (reference.length > 2 && projectName.includes(reference)) ||
              (title.length > 2 && (projectName.includes(title) || title.includes(projectName)))
            );
          })
          .at(-1)
      : undefined);
  const analyses = ctx.ledger.list(ctx.projectId, 'ITTAnalysis');
  const packs = ctx.ledger.list(ctx.projectId, 'BidResponsePack').map((record) => record.state);
  // A pack is "planned" the moment it exists, but planned is not written: its
  // sections are drafted one at a time and a section is written once it carries
  // a `writtenAt`. The guide reported a pack with every section still blank as
  // "Write the submission — done", and then sent the person to attack an empty
  // pack. Counting the written sections is what lets the next step be the real
  // one — write the next section — until none is left.
  const packSections = packs.flatMap((p) => (p.sections as Array<{ writtenAt?: string }> | undefined) ?? []);
  const sectionsTotal = packSections.length;
  const sectionsWritten = packSections.filter((section) => section.writtenAt).length;
  const packPlanned = packs.length > 0;
  const packFullyWritten = packPlanned && sectionsTotal > 0 && sectionsWritten === sectionsTotal;
  const reviews = ctx.ledger.list(ctx.projectId, 'AssuranceReview');
  /*
   * The company's own facts, by the id they are actually written under.
   *
   * `setCompanyProfile` writes `<tenantId>-profile`; this read asked for
   * `<tenantId>` and therefore never found one. A business that had filled the
   * form in was told, for ever, that **"this company's own facts are not
   * recorded, so there is nothing to set a buyer's requirements against"** —
   * and the compliance matrix, and everything behind it, stayed blocked.
   *
   * The same shape as the drawing register reading `file.kind` where the API
   * publishes `classification.kind`: two names for one thing, a read that
   * quietly returns nothing, and a screen that reports the absence as a fact
   * about the customer's business rather than about the lookup.
   */
  const profile = ctx.ledger.get({ refType: 'CompanyProfile', refId: `${ctx.tenantId}-profile` });

  // Quotations are legal instruments and live on the company's own chain rather
  // than the project's, so they are read from there and matched by the estimate
  // they were drawn from.
  const estimateIds = new Set(estimates.map((estimate) => String(estimate.id)));
  const quotations = documentsOf(platform, ctx.tenantId).filter(
    (document) => document.documentType === 'quotation' && document.source && estimateIds.has(document.source.refId),
  );
  const issued = quotations.filter((document) => document.status === 'ISSUED');

  const deliverables =
    (invitation?.deliverables as
      | Array<{ title?: string; mandatory?: boolean; owner?: string; internalDueBy?: string; source?: unknown }>
      | undefined) ?? [];
  // A return register is recorded, and then each mandatory return needs an
  // owner, a source and an internal date or it blocks the submission — the same
  // rule the board shows as "N blocking". The register step is not done while any of
  // those is open; "recorded" and "owned" are two different states and the guide
  // conflated them, reporting the register done while the board said 16 blocking.
  const unassignedReturns = deliverables.filter(
    (d) => d.mandatory === true && (!d.owner || !d.internalDueBy || !d.source),
  ).length;
  // An invitation asking for more than a price is a submission to write. One
  // that asks only for a price is a quotation, whatever it calls itself.
  //
  // The return register is the clearest signal, but it is filed by hand, and a
  // tender can be read and its compliance matrix produced before anybody files
  // it. At that point the matrix is itself proof the job is a tender: it carries
  // the buyer's evaluation weightings and the scored and mandatory pass/fail
  // requirements, none of which a price-only enquiry has. Reading only the
  // deliverable count classed such a tender as a quotation and greyed out its
  // whole submission road — reported on SHDC 000189, a 60/5/35 tender the panel
  // told the bidder to "just price it".
  const analysedAsTender = analyses.some((record) => {
    const state = record.state;
    const stated = Number((state.weightings as { stated?: number } | undefined)?.stated ?? 0);
    const lines = (state.matrix as Array<{ mandatory?: boolean; weightingPercent?: number }> | undefined) ?? [];
    return stated > 0 || lines.some((line) => line.mandatory === true || line.weightingPercent !== undefined);
  });
  const wantsSubmission = deliverables.length > 1 || analysedAsTender;
  const road: BidFlow['road'] = wantsSubmission ? 'BID' : 'PRICE';

  const steps: FlowStep[] = [];

  // A pack is filed once its files are here, and the step is done once there is
  // something to price from them — either a drawing to measure, or an invitation
  // read, which is the whole of the pack for a fee or services bid that has no
  // drawings at all (a consultancy tender, a schedule of rates). Keying "done"
  // on `drawings.length > 0` alone left such a bid stuck here for ever: its pack
  // was filed and read, it never had a drawing, and the step kept sending it to
  // "re-read the drawing" — a door for a drawing that does not exist.
  const packFiledDone = drawings.length > 0 || (files.length > 0 && invitation !== undefined);
  steps.push(
    packFiledDone
      ? {
          id: 'PACK_FILED',
          title: 'File the pack',
          state: 'DONE',
          detail:
            drawings.length > 0
              ? `${files.length} file${files.length === 1 ? '' : 's'} filed, ${drawings.length} of them read as drawings.`
              : `${files.length} file${files.length === 1 ? ' is' : 's are'} filed and read. This invitation has no drawings, so it is priced as a fee — enter the quantities at the next step. A file that is actually a drawing can be re-read on its own row.`,
          screen: 'pipeline',
        }
      : {
          id: 'PACK_FILED',
          title: 'File the pack',
          state: 'READY',
          detail:
            files.length === 0
              ? 'Nothing is filed on this project yet.'
              : `${files.length} file${files.length === 1 ? ' is' : 's are'} filed. Read the invitation to build its matrix and return register.`,
          next:
            files.length === 0
              ? 'Nothing downstream can measure a pack that is not here.'
              : 'Reading the invitation classifies each file and builds the matrix. A file that is actually a drawing to measure off is re-read on its own row so it is read as one.',
          door: files.length === 0 ? 'Upload a tender document' : 'Read an invitation with AI',
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
      : (() => {
          // A bill can always be entered by hand, so "no drawing" is never a
          // dead end on a job that is actually being worked: a fee or services
          // bid — a consultancy tender, a schedule of rates, a lump sum — has no
          // drawings at all and is priced entirely by hand. The manual take-off
          // door was only ever offered beside a drawing, which left such a bid
          // with its pricing road blocked and no way in; the person reported it
          // as "I cannot see how to price". On a truly empty project (nothing
          // filed, no invitation) the step still waits for the pack to be filed
          // first, so the clean "start here" narrative is unchanged.
          const canEnterByHand = invitation !== undefined || files.length > 0;
          return {
            id: 'MEASURED',
            title: drawings.length > 0 ? 'Measure the drawings' : 'Enter the quantities to price',
            state: drawings.length > 0 || canEnterByHand ? 'READY' : 'BLOCKED',
            detail:
              drawings.length > 0 || !canEnterByHand
                ? 'Nothing is measured yet, so there is nothing to price.'
                : 'No drawing is filed — but a bill can still be entered by hand, which is how a fee or services bid is priced.',
            next:
              drawings.length > 0
                ? 'It reads every sheet, measures it, and proposes a rate for each line from your own past estimates — and accepting it does the pricing and the quotation in the same act. "Enter measured quantities", beside it, is the door for a take-off you did with a scale rule.'
                : canEnterByHand
                  ? '"Enter measured quantities" files the bill from a take-off you did yourself — by the metre, the item, the day, or as a single lump sum for a fee — and "Price the bill" builds the money from it. No drawing is needed to price this way.'
                  : 'A drawing has to be filed before anything can be measured off it.',
            ...(drawings.length > 0
              ? { door: 'Read and price the pack', command: 'price-pack' }
              : canEnterByHand
                ? { door: 'Enter measured quantities', command: 'measured-takeoff' }
                : {}),
            screen: 'procurement',
          };
        })(),
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

  const registerRecorded = invitation?.requirementsExtracted === true;
  // Recorded, and then owned. The register is done only when every mandatory
  // return has an owner, a source and a date; while any is open it is the next
  // step — assign a return — not a finished one.
  const registerDone = registerRecorded && unassignedReturns === 0;
  steps.push(
    bidStep({
      id: 'RETURN_REGISTER',
      title: 'Record what has to go back',
      state: registerDone ? 'DONE' : registerRecorded || invitation ? 'READY' : 'BLOCKED',
      detail: registerDone
        ? `${deliverables.length} return item${deliverables.length === 1 ? '' : 's'} recorded and owned.`
        : registerRecorded
          ? `${deliverables.length} return item${deliverables.length === 1 ? '' : 's'} recorded, ${unassignedReturns} mandatory ${unassignedReturns === 1 ? 'return' : 'returns'} still without an owner, a source or a date.`
          : invitation
            ? 'Nothing is recorded about what the submission has to contain.'
            : 'No invitation is recorded on this project.',
      next: registerDone
        ? undefined
        : registerRecorded
          ? 'A mandatory return with no owner, no source or no date blocks the submission (not the decision to bid — that is a commercial call you make from the score). Assign a return, and set who owns it and by when.'
          : invitation
            ? 'For an enquiry that arrived as a letter, that is the whole of it. "Add a deliverable", beside it, files one item at a time where a formal invitation asks for several — and reading the invitation with AI files the whole register at once.'
            : 'Record the invitation first.',
      door: registerRecorded ? 'Assign a return' : invitation ? 'It only asks for a price' : 'Record an ITT',
      ...(registerRecorded ? { command: 'assign-deliverable' } : invitation ? { command: 'quote-only' } : {}),
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
          ? // Not the raw count of analysis records — a tender read one document
            // at a time holds a dozen superseded fragments, and "21 compliance
            // matrices on file" reported those rather than the one that counts.
            // The step is binary: a matrix exists, built from the confirmed reading.
            'A compliance matrix is on file, built from the confirmed reading.'
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
      // Planned is not written. DONE only when a pack exists and every section
      // carries prose; a planned pack with sections still blank is READY — the
      // next step is to write the next one, not to move on from a submission
      // that is not written.
      state: packFullyWritten ? 'DONE' : packPlanned || analyses.length > 0 ? 'READY' : 'BLOCKED',
      detail: packFullyWritten
        ? `${packs.length} response pack${packs.length === 1 ? '' : 's'} planned, every section written.`
        : packPlanned
          ? `${packs.length} response pack${packs.length === 1 ? '' : 's'} planned, ${sectionsWritten} of ${sectionsTotal} section${sectionsTotal === 1 ? '' : 's'} written.`
          : 'No submission has been planned.',
      next: packFullyWritten
        ? 'Every section is written — attack the pack before issuing it.'
        : packPlanned
          ? 'Write one section at a time until none remains; the size of the tender decides how many passes run, never how much of it fits into one.'
          : analyses.length > 0
            ? 'Then write one section at a time: the size of the tender decides how many passes run, never how much of it fits into one.'
            : 'A compliance matrix has to exist before a submission can be planned against it.',
      door: packPlanned ? 'Write the next section' : 'Plan a response pack',
      command: packPlanned ? 'bid-section' : 'bid-plan',
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

  // Price the risk register. A tender discipline, not a quotation one, so it
  // follows the submission road (NOT_NEEDED on a price-only enquiry). It is a
  // visible step with its own door, but it is kept out of the headline "do next"
  // below: a bidder is steered down the critical pricing and submission path
  // first, and pricing the risks is the deliberate pass they take alongside it
  // rather than a gate that displaces writing the bid.
  const openRisks = ctx.ledger.list(ctx.projectId, 'RiskRegisterItem').filter((r) => r.state.status === 'OPEN');
  steps.push(
    bidStep({
      id: 'RISK',
      title: 'Price the risk register',
      state: openRisks.length > 0 ? 'DONE' : complete.length > 0 ? 'READY' : 'BLOCKED',
      detail:
        openRisks.length > 0
          ? `${openRisks.length} risk${openRisks.length === 1 ? '' : 's'} on the register, priced into a contingency held beside the base estimate.`
          : complete.length > 0
            ? 'No tender risks are priced yet. A risk with no price is an exposure nobody has funded.'
            : 'Price the bill first — a risk is sized against the job it sits on.',
      next:
        openRisks.length > 0
          ? undefined
          : complete.length > 0
            ? 'Record each cause → event → impact with its probability and cost, and who carries it. The P80 contingency is then defended line by line and sits beside the base estimate, counted once rather than buried in a rate.'
            : 'A priced bill gives the value a risk is sized against.',
      door: 'Register a tender risk',
      command: 'register-risk',
      screen: 'procurement',
    }),
  );

  // Settle, then record the award. The last two stages of the arc, so the guide
  // carries the whole process through to how the bid ended rather than stopping
  // at the red team. Both follow the submission road and, like RISK, are shown
  // with their doors but kept out of the headline below.
  const settlements = ctx.ledger.list(ctx.projectId, 'Settlement').map((record) => record.state);
  const settlementApproved = settlements.some((s) => s.finalPriceMinor !== undefined);
  const submissionPacks = ctx.ledger.list(ctx.projectId, 'BidSubmissionPack').map((record) => record.state);
  const awarded = submissionPacks.some((p) => (p.award as { outcome?: string } | undefined)?.outcome);

  steps.push(
    bidStep({
      id: 'SETTLE',
      title: 'Settle and approve the price',
      state: settlementApproved ? 'DONE' : complete.length > 0 ? 'READY' : 'BLOCKED',
      detail: settlementApproved
        ? 'The price is settled and approved under a named authority.'
        : complete.length > 0
          ? 'The estimate is priced but the settlement is not approved. The bridge, the risk contingency and the departures are reconciled here and signed off.'
          : 'Price the bill first — a settlement moves a price that exists.',
      next: settlementApproved
        ? undefined
        : complete.length > 0
          ? 'Open the settlement, move the price with a reason and an owner, carry what is unresolved as a stated condition, and approve it under a named authority and its limit.'
          : 'A priced estimate is what a settlement settles.',
      door: 'Open the settlement',
      command: 'open-settlement',
      screen: 'procurement',
    }),
  );

  steps.push(
    bidStep({
      id: 'AWARD',
      title: 'Record how it ended',
      state: awarded ? 'DONE' : submissionPacks.length > 0 ? 'READY' : 'BLOCKED',
      detail: awarded
        ? 'The award outcome is on the record, with any standstill counted down.'
        : submissionPacks.length > 0
          ? 'A pack has been submitted and carries no outcome yet.'
          : 'Nothing has been submitted, so there is no outcome to record.',
      next: awarded
        ? undefined
        : submissionPacks.length > 0
          ? 'Record the client’s award notice — won, lost or withdrawn — with any standstill it opened. Why a bid was lost, and the marks, go on the opportunity’s outcome, which the calibration reads.'
          : 'A submission has to go in before it can be awarded.',
      door: 'Record the award outcome',
      command: 'record-award',
      screen: 'procurement',
    }),
  );

  // 'RISK', 'SETTLE' and 'AWARD' are deliberately not in the nowDo candidacy:
  // they are shown and clickable but never the headline, so they cannot displace
  // the pricing or submission step a bidder is told to do next.
  const ADVISORY_STEP_IDS = new Set(['RISK', 'SETTLE', 'AWARD']);
  // Once a submission has gone in — a submission pack is on the record, or an
  // outcome is already against it — every pre-submission step is behind the
  // bidder, including one left incomplete. The pack has gone; sending them back
  // to "assign a return" or "open the settlement" on a bid that is submitted,
  // and sometimes already won or lost, is the guide looping on work the
  // submission closed. The three tenders a user reported this on were each
  // submitted — one lost, one awaiting the result — and each still headlined
  // "record what has to go back". When submitted, the only live step is
  // recording how it ended, so that is the only nowDo candidate.
  const submitted = submissionPacks.length > 0 || Boolean(awarded);
  const actionable = submitted
    ? steps.filter((step) => step.id === 'AWARD' && (step.state === 'READY' || step.state === 'BLOCKED'))
    : steps.filter(
        (step) => (step.state === 'READY' || step.state === 'BLOCKED') && !ADVISORY_STEP_IDS.has(step.id),
      );
  /*
   * The headline next step. On a submission the pricing road and the submission
   * road run in parallel, and the pricing road is listed first — so the first
   * ready step across both was the pricing one, and a bidder who had just read
   * the invitation into a matrix was told the next thing to do was "file the
   * pack / measure the drawings", a road that does not even apply to a tender
   * priced from a schedule. For a submission, the headline prefers the
   * submission road; the pricing steps stay in the list, they are just not what
   * a just-read tender is told to do first. A price-only enquiry is unchanged.
   */
  const SUBMISSION_STEP_IDS = new Set(['RETURN_REGISTER', 'MATRIX', 'RESPONSE_PACK', 'RED_TEAM']);
  const preferred = wantsSubmission ? actionable.filter((step) => SUBMISSION_STEP_IDS.has(step.id)) : actionable;
  const nowDo =
    preferred.find((step) => step.state === 'READY') ??
    actionable.find((step) => step.state === 'READY') ??
    preferred[0] ??
    actionable[0] ??
    null;

  const done = steps.filter((step) => step.state === 'DONE').length;
  const needed = steps.filter((step) => step.state !== 'NOT_NEEDED').length;

  return {
    road,
    why: !wantsSubmission
      ? 'Nothing recorded against this enquiry asks for more than a price, so it is a quotation rather than a submission.'
      : deliverables.length > 1
        ? `${deliverables.length} return items are recorded against this invitation, so it is a submission to write as well as a price to build.`
        : 'The compliance matrix carries the buyer’s evaluation weightings, so this is a tender to submit as well as a price to build — record the return register so every return has an owner and a date.',
    steps,
    nowDo,
    summary: nowDo
      ? `${done} of ${needed} done. Next: ${nowDo.title.toLowerCase()}.`
      : `${done} of ${needed} done. Nothing is outstanding on this road.`,
  };
}
