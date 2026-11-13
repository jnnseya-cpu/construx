import { authorise, type EngineContext } from '../engines/context.ts';

/**
 * The platform's own knowledge of how it works — the step-by-step guide a
 * person follows to take a job from an empty account to a won, delivered
 * project, written down once so the product can teach it.
 *
 * ## Why this is a knowledge base, not model output
 *
 * The copilot (`conversation.ts`) is grounded on project *state* and is told to
 * invent no fact. That keeps it honest about the numbers, but it leaves it
 * unable to explain the one thing a first-timer most needs: *how the platform
 * itself works* — which screen, which button, in what order, and what each step
 * produces. A model asked that from general knowledge would make CONSTRUX up.
 *
 * So the mechanics live here, as curated content that is true by construction:
 * every topic names a real screen, real commands and the real order the engines
 * enforce. Two surfaces read it, and neither can drift from it because there is
 * one copy:
 *
 *   - the in-platform step-by-step guide, which works in `AI_MODE=local` with no
 *     provider spend because it is content, not a model call; and
 *   - the copilot, which folds the topics relevant to a question into its
 *     grounding, so when a reasoning provider is live Claude explains the real
 *     platform rather than a plausible invention of it.
 *
 * ## The rule for editing this file
 *
 * A topic is a promise that the platform behaves this way. Never describe a
 * screen, button or step that does not exist, and never leave one here after the
 * behaviour it describes is changed — a guide that lies is worse than no guide.
 * The screen ids are the console pages in `shared/vocabulary.js`
 * (`AREA_CONSOLE_PAGE`); the command ids are the `COMMANDS` the named screen
 * actually binds.
 */

/** A stretch of the road, so the guide can be read in the order work happens. */
export type GuideGroup = 'SET_UP' | 'FIND_WORK' | 'BID' | 'SUBMIT' | 'DELIVER' | 'HOW_IT_WORKS';

export const GUIDE_GROUP_TITLE: Record<GuideGroup, string> = {
  SET_UP: 'Set the company up',
  FIND_WORK: 'Find work to bid',
  BID: 'Work a tender',
  SUBMIT: 'Price, assemble and submit',
  DELIVER: 'Win and deliver',
  HOW_IT_WORKS: 'How the platform works',
};

export type GuideStep = {
  /** The action, in the words printed on the button where there is one. */
  do: string;
  /** Why, or what to watch, in one plain sentence. Optional. */
  detail?: string;
};

export type GuideTopic = {
  /** Stable slug — the grounding and the API both key on it. */
  id: string;
  group: GuideGroup;
  title: string;
  /** The console page this is done on (an `AREA_CONSOLE_PAGE` value). */
  screen: string;
  /** One line a busy builder can read at a glance. */
  summary: string;
  /** The ordered steps. */
  steps: GuideStep[];
  /** What the person has once the steps are done. */
  youGet: string;
  /** The traps worth naming before somebody hits them. */
  watchOut?: string[];
  /** Words a person would actually search for this topic by. */
  keywords: string[];
};

/**
 * The guide. Ordered the way the work happens, so reading it top to bottom is
 * the walkthrough and any one topic is the answer to "how do I do this bit".
 */
export const GUIDE_TOPICS: readonly GuideTopic[] = [
  {
    id: 'company-facts',
    group: 'SET_UP',
    title: 'Record the company’s own facts',
    screen: 'pipeline',
    summary:
      'Before anything scores a bid, tell the platform what the company is and can prove — turnover, accreditations, insurance limits, the trades you self-deliver.',
    steps: [
      { do: 'Open Pipeline & Bids and find “The company’s own facts”.', detail: 'It is the record the radar screens opportunities against and a bid is scored from.' },
      { do: 'Press “Record the company facts” and fill in what is true today.', detail: 'Only what you can evidence — the claim register will check promises against it later.' },
      { do: 'Save. The facts are now on record for every bid.' },
    ],
    youGet: 'A company profile the platform uses to filter opportunities and score bids — set once, used on every tender.',
    watchOut: [
      'Enter only figures you can prove. An insurance limit or accreditation you cannot evidence will fail the claim check on a live submission.',
    ],
    keywords: ['company', 'profile', 'facts', 'turnover', 'insurance', 'accreditation', 'set up', 'setup', 'start'],
  },
  {
    id: 'register-opportunity',
    group: 'FIND_WORK',
    title: 'Register an opportunity',
    screen: 'pipeline',
    summary: 'Log a job you might bid — the enquiry that everything about the tender hangs off.',
    steps: [
      { do: 'On Pipeline & Bids press “Register an opportunity”.' },
      { do: 'Name the client, the work and, where you can, the project it is for.', detail: 'Linking a project now is what lets the page later focus on this one tender and file its readings in the right place.' },
      { do: 'Save. It appears on the board at stage IDENTIFIED.' },
    ],
    youGet: 'An opportunity on the pipeline board you can qualify, read and decide on.',
    watchOut: [
      'An opportunity with no project linked cannot be “worked on” as a focused tender, and a site-visit finding has nowhere to file — link a project when you register it, or when you convert the win.',
    ],
    keywords: ['opportunity', 'enquiry', 'lead', 'register', 'new job', 'new tender'],
  },
  {
    id: 'record-itt',
    group: 'FIND_WORK',
    title: 'Record an ITT (the invitation to tender)',
    screen: 'pipeline',
    summary: 'Record the invitation itself — its reference, client and the return deadline in its own time zone.',
    steps: [
      { do: 'Press “Record an ITT”.' },
      { do: 'Enter the reference, the client and the return deadline in the zone the portal states.', detail: 'The platform resolves it to one instant — a noon-in-Dublin close has passed an hour before noon here.' },
      { do: 'Save. The invitation is on the board with its deadline counting down.' },
    ],
    youGet: 'A tender invitation with a live, time-zone-correct deadline the reminders watch.',
    keywords: ['itt', 'invitation', 'tender', 'record', 'deadline', 'return date'],
  },
  {
    id: 'upload-documents',
    group: 'BID',
    title: 'Upload the tender documents',
    screen: 'pipeline',
    summary: 'File whatever the portal produced — Word, spreadsheets, PDFs, drawings, a scan — each as its own hashed record.',
    steps: [
      { do: 'With the tender in focus, press “Upload tender documents”.' },
      { do: 'Select every file in the pack at once.', detail: 'Each is hashed in your browser and filed as one document — one document, one record.' },
      { do: 'File them. The platform stores the bytes and tells you what it can and cannot read.' },
    ],
    youGet: 'Every tender file on record, ready to be read into the compliance matrix.',
    watchOut: ['A file over the per-file size limit is refused at the picker, before anything is written — split or compress it.'],
    keywords: ['upload', 'documents', 'files', 'tender pack', 'attach', 'drawings'],
  },
  {
    id: 'read-into-matrix',
    group: 'BID',
    title: 'Read the invitation into a compliance matrix',
    screen: 'pipeline',
    summary:
      'Have the AI read the documents into a requirements matrix, then confirm what it read. Every requirement, with an owner and whether it is mandatory.',
    steps: [
      { do: 'Press “Read the invitation into a matrix” (or read a specific file from the reader panel).', detail: 'The AI quotes requirements from the documents rather than summarising them.' },
      { do: 'Review “Confirm what the AI read” and correct anything before you confirm.', detail: 'Nothing enters the matrix until a person confirms — the AI proposes, you decide.' },
      { do: 'Confirm. The requirements, terms and returns bind to this invitation as its matrix.' },
    ],
    youGet: 'One compliance matrix for the tender: every requirement, the mandatory gaps, the commercial bars, the quantified exposure, and whether it is ready to price.',
    watchOut: [
      'Reading a second document merges into the same matrix — it does not start a new one. One tender has one matrix.',
      'You can only confirm a reading onto a tender still in play; a won, lost or no-bid tender is not offered, so a reading cannot land on a closed job by mistake.',
      'When the page is focused on one tender, the confirm picker offers only that tender — another reason to press “Work on this” first.',
    ],
    keywords: ['read', 'matrix', 'compliance', 'requirements', 'ai read', 'confirm', 'analyse', 'analysis'],
  },
  {
    id: 'assign-returns',
    group: 'BID',
    title: 'Assign the returns',
    screen: 'pipeline',
    summary: 'Give every thing that must go back an owner and an internal date — the list a bid manager works from.',
    steps: [
      { do: 'In “What has to go back”, find the returns the reading filed.' },
      { do: 'Press “Assign a return” and set who here owns it and by when.', detail: 'A mandatory return with no owner blocks the decision to bid.' },
      { do: 'Repeat until no mandatory return is unowned.' },
    ],
    youGet: 'Every mandatory return owned and dated, so the bid decision is not blocked and nothing is forgotten the week before close.',
    keywords: ['return', 'deliverable', 'assign', 'owner', 'who does', 'responsibility'],
  },
  {
    id: 'decide-bid',
    group: 'BID',
    title: 'Decide to bid, or not',
    screen: 'pipeline',
    summary: 'Score the opportunity on the ten published factors and record the decision — a no-bid is a decision too.',
    steps: [
      { do: 'Qualify the opportunity so it can be scored.' },
      { do: 'Read the score and the recommendation, then record bid or no-bid.', detail: 'An override of the recommendation is allowed but never passes unremarked — it is recorded with its reason.' },
      { do: 'A tender decided as a bid moves to stage BID and can carry a response pack.' },
    ],
    youGet: 'A recorded, auditable bid/no-bid decision, and a tender that can go forward to pricing and assembly.',
    watchOut: ['Only a tender at stage BID can have a response pack planned against it or be converted to a project on award.'],
    keywords: ['bid', 'no bid', 'no-bid', 'decide', 'decision', 'score', 'qualify', 'pursue'],
  },
  {
    id: 'price-the-works',
    group: 'SUBMIT',
    title: 'Price the works',
    screen: 'commercial',
    summary: 'Measure the quantities, price the bill against your rates, and let the platform seed a construction duration from the measured works.',
    steps: [
      { do: 'Measure the take-off, then price the bill — apply stored library rates by selection, or a per-tender rate set.' },
      { do: 'Use the duration estimate to seed how many weeks the works run.', detail: 'It is derived from the measured works and trade phases, carries LOW confidence by design, and is a first number for a planner to confirm — it is not read from the ITT text.' },
      { do: 'Copy the pricing schedule (Appendix B) when the buyer asks for a priced schedule.' },
    ],
    youGet: 'A priced bill, a defensible first construction duration, and an exportable pricing schedule.',
    watchOut: [
      'The construction duration comes from the priced works, not from the ITT documents. The ITT gives the return deadline and the requirements; the weeks the job runs come from the quantities.',
    ],
    keywords: ['price', 'pricing', 'cost', 'rate', 'bill', 'boq', 'take-off', 'takeoff', 'duration', 'weeks', 'how long', 'time estimate', 'programme duration'],
  },
  {
    id: 'draft-answers',
    group: 'SUBMIT',
    title: 'Plan the response pack and draft the answers',
    screen: 'pipeline',
    summary: 'Turn the matrix into a response pack and draft the quality answers — priced and factual lines do not demand an essay.',
    steps: [
      { do: 'Press “Plan a response pack” against the tender’s matrix.' },
      { do: 'Draft each section that needs prose; reuse the answer library for company facts you have written before.', detail: 'A priced, logistical or date line is recorded as such, not forced into a narrative.' },
      { do: 'Read and edit the drafted answers against the buyer’s word and page limits.' },
    ],
    youGet: 'A response pack whose sections are drafted, reusing what the company has said before, within the buyer’s limits.',
    keywords: ['pack', 'response', 'answer', 'draft', 'quality', 'write', 'method statement', 'library'],
  },
  {
    id: 'red-team',
    group: 'SUBMIT',
    title: 'Red-team the submission',
    screen: 'pipeline',
    summary: 'Have the assurance engine attack the pack before the buyer does, and decide each finding.',
    steps: [
      { do: 'Run “the red team” against the drafted pack.' },
      { do: 'Work the findings — accept, mitigate, reject or assign each.', detail: 'A decision you record on a finding survives a re-run on sections you did not change.' },
      { do: 'Clear the critical findings before you issue.' },
    ],
    youGet: 'A submission that has been challenged and whose weaknesses are decided, not discovered by the evaluator.',
    keywords: ['red team', 'redteam', 'assurance', 'challenge', 'review', 'finding', 'attack', 'check'],
  },
  {
    id: 'issue-submit',
    group: 'SUBMIT',
    title: 'Issue the pack and submit',
    screen: 'pipeline',
    summary: 'Lock the pack, build the submission programme back from the deadline, and send it through the portal adapter.',
    steps: [
      { do: 'Issue the pack when the answers are complete and the red team is clear.', detail: 'An issued pack is frozen and read-only, but it stays downloadable — the clean PDF of what was sent is always there.' },
      { do: 'Build the tender programme if you have not — it back-plans the submission stages from the return deadline across the working calendar.' },
      { do: 'Submit through the portal adapter, or download the submission PDF to upload to the buyer’s own portal.' },
    ],
    youGet: 'A locked, hashed submission and a record of what went out, when and through where.',
    watchOut: [
      '“Issue the pack” is an internal lock on the quality answers; it is not the same as recording the award. They are two different records.',
    ],
    keywords: ['issue', 'submit', 'submission', 'lock', 'send', 'portal', 'download pdf', 'programme'],
  },
  {
    id: 'award-convert',
    group: 'DELIVER',
    title: 'Record the award and convert to a project',
    screen: 'pipeline',
    summary: 'When you win, record the award against the locked submission and convert the bid into a delivery project.',
    steps: [
      { do: 'Record the award against the locked submission pack.' },
      { do: 'Convert the opportunity to a project — it must be at stage BID, and it carries its origin across.', detail: 'A project sits in a portfolio, so pick or create one.' },
      { do: 'The won bid becomes a live job you deliver in the platform — nothing is finished outside it.' },
    ],
    youGet: 'A delivery project created from the bid, carrying its origin, ready for programme, procurement and site.',
    keywords: ['award', 'won', 'win', 'convert', 'project', 'delivery', 'start job'],
  },
  {
    id: 'deadline-reminders',
    group: 'HOW_IT_WORKS',
    title: 'Tender deadline reminders',
    screen: 'pipeline',
    summary: 'The platform emails the company before a tender closes — no per-tender setup.',
    steps: [
      { do: 'Record the ITT with its return deadline. That is all the setup there is.' },
      { do: 'The platform emails the owners and admins when a live tender is within the lead time of its close (five days by default).', detail: 'It reminds once per deadline, and never for a tender already decided no-bid or won.' },
    ],
    youGet: 'A standing watch on every tender deadline, in the platform, with no reminder to set by hand.',
    keywords: ['reminder', 'deadline', 'remind', 'alert', 'email', 'five days', 'notify'],
  },
  {
    id: 'focus-one-tender',
    group: 'HOW_IT_WORKS',
    title: 'Work on one tender at a time',
    screen: 'pipeline',
    summary: 'Focus the whole page on a single tender so you are not reading one job against every other.',
    steps: [
      { do: 'On the board, press “Work on this” on the tender’s row.', detail: 'The board, the matrices and the commands narrow to that one tender; the reader, packs and red team were already its.' },
      { do: 'Work the tender with everything about it, and nothing about the others, in front of you.' },
      { do: 'Press “Show all tenders” to step back to the whole pipeline.' },
    ],
    youGet: 'One tender per page — every action on a focused page acts only on that tender, so a reading or a rule cannot land on the wrong job.',
    keywords: ['focus', 'work on this', 'one tender', 'show all', 'mixing', 'filter', 'select project'],
  },
  {
    id: 'ai-modes',
    group: 'HOW_IT_WORKS',
    title: 'How the AI works — grounded, and what it costs',
    screen: 'pipeline',
    summary: 'The AI proposes and a person confirms; every figure is grounded on the record; a provider is called only when one is configured.',
    steps: [
      { do: 'Read the grounded answer first — it is free, reproducible arithmetic over the record.' },
      { do: 'Press “Ask for help” for a plain-English explanation.', detail: 'This calls the reasoning provider and costs ACUs; it is reserved and only charged on success, and refused rather than charged when no provider is configured.' },
      { do: 'Confirm anything the AI proposes — no AI action changes a record on its own.' },
    ],
    youGet: 'AI that explains and proposes without ever inventing a figure or acting without a person — and that says plainly when no model was called.',
    watchOut: [
      'With AI_MODE=local no language model is called at all; answers are deterministic and the “powered by Claude” explanation is unavailable until a provider key is set.',
    ],
    keywords: ['ai', 'claude', 'copilot', 'ask for help', 'acu', 'cost', 'local', 'model', 'how does the ai'],
  },
];

/** Every topic, in road order, for the in-platform guide. */
export function guideTopics(ctx: EngineContext): { groups: Array<{ group: GuideGroup; title: string; topics: GuideTopic[] }>; count: number } {
  // A light read gate: the guide is platform documentation, not tenant data,
  // but it is still only for a signed-in member of the tenancy.
  authorise(ctx, 'PROJECT_SETUP', 'R');
  const order: GuideGroup[] = ['SET_UP', 'FIND_WORK', 'BID', 'SUBMIT', 'DELIVER', 'HOW_IT_WORKS'];
  const groups = order
    .map((group) => ({ group, title: GUIDE_GROUP_TITLE[group], topics: GUIDE_TOPICS.filter((t) => t.group === group) }))
    .filter((g) => g.topics.length > 0);
  return { groups, count: GUIDE_TOPICS.length };
}

/**
 * The topics most relevant to a free-text question, highest first.
 *
 * A deliberately small, dependency-free scorer: a keyword hit is worth more than
 * a title hit, a title hit more than a summary hit. It never throws and never
 * reaches a provider — it decides which curated topics to hand the copilot so
 * the explanation is about the right part of the platform.
 */
export function relevantGuideTopics(question: string, limit = 3): GuideTopic[] {
  const text = question.toLowerCase();
  const words = text.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const scored = GUIDE_TOPICS.map((topic) => {
    let score = 0;
    for (const kw of topic.keywords) if (text.includes(kw)) score += 3;
    const title = topic.title.toLowerCase();
    const summary = topic.summary.toLowerCase();
    for (const w of words) {
      if (title.includes(w)) score += 2;
      else if (summary.includes(w)) score += 1;
    }
    return { topic, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.topic);
}

/**
 * The relevant topics flattened to grounding lines for the copilot's payload.
 *
 * Each line is a true statement about the platform the model may rely on, the
 * same way it relies on the project facts — so a plain-English answer can name
 * the real screen, button and order instead of inventing them, without ever
 * being handed a figure it could misattribute.
 */
export function guideGroundingLines(topics: GuideTopic[]): string[] {
  const lines: string[] = [];
  for (const topic of topics) {
    lines.push(`${topic.title} (screen: ${topic.screen}): ${topic.summary}`);
    topic.steps.forEach((step, i) => {
      lines.push(`  ${i + 1}. ${step.do}${step.detail ? ` — ${step.detail}` : ''}`);
    });
    if (topic.watchOut) for (const w of topic.watchOut) lines.push(`  Watch out: ${w}`);
  }
  return lines;
}
