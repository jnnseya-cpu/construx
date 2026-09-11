import { config } from '../config.ts';
import { DomainError } from '../core/errors.ts';
import { formatRef, ulid } from '../core/ids.ts';
import { authorise, currentPhase, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';
import { complianceMatrix } from './itt.ts';

/**
 * The tender portal port — §4.8.1, §14, `L7.7`.
 *
 * ---
 *
 * **What a port is, and what it is not.** A port is an interface plus the
 * adapters that satisfy it. This declares the interface a tender portal has to
 * satisfy — discover, fetch the pack, upload the submission, confirm receipt —
 * and ships the one adapter that is real.
 *
 * **The one adapter is `MANUAL`, and it is not a stub.** It is the process every
 * contractor runs today: somebody opens the buyer's portal, downloads the pack,
 * uploads the return and screenshots the confirmation. What was missing is not
 * the clicking, it is the **record**: what was checked before the upload
 * started, who started it, how long was left, and what came back. That is built
 * here and it works on launch day with no portal integration at all.
 *
 * **No portal-specific adapter exists, and the register says so.** There is no
 * Proactis, no Jaggaer, no Delta, no Find a Tender. Shipping an empty class per
 * portal would be a list of things that do not work, and a screen offering an
 * upload that silently does nothing is worse than one that says a person has to
 * do it. `portalAdapters()` publishes what each adapter can actually do and
 * names the reason where it cannot.
 *
 * This is `L7.7` demonstrated rather than asserted: the gate, the rule set, the
 * readiness check and the receipt binding all sit on this side of the port, so a
 * real portal adapter is an adapter and a configuration entry, never a change
 * to any of it.
 *
 * ## The three things that needed no portal and were missing anyway
 *
 * **The submission rule set.** Buyers state filenames, formats, page limits,
 * word limits and which documents are mandatory, and a submission rejected on
 * a filename is rejected as completely as one rejected on price. Recorded per
 * invitation and checked against what was actually assembled.
 *
 * **A readiness score that will not round up.** §4.8.1 asks for 100 on the hard
 * rules. A rule the record cannot check — a page count, a file size — is
 * reported as **uncheckable** and blocks readiness rather than passing quietly.
 * A check that cannot run is not a check that passed, and a screen that treats
 * the two the same is how a submission goes out short of a document.
 *
 * **The four-hour buffer.** Starting an upload twenty minutes before the
 * deadline is how a portal timeout becomes a lost bid. Refused inside the
 * buffer unless a named director overrides it, and the override is recorded
 * with its reason — because the question afterwards is never whether somebody
 * was in a hurry.
 */

// --- The port -----------------------------------------------------------------------

export const PORTAL_OPERATION = ['DISCOVER', 'FETCH_PACK', 'UPLOAD', 'CONFIRM'] as const;
export type PortalOperation = (typeof PORTAL_OPERATION)[number];

/** How an adapter satisfies an operation, or why it does not. */
export type OperationSupport =
  /** A person does it on the buyer's portal and the platform records what happened. */
  | { support: 'RECORDED'; note: string }
  /** The adapter performs it against the portal itself. */
  | { support: 'AUTOMATED'; note: string }
  /** Not built. The reason is stated rather than left as a gap on a screen. */
  | { support: 'NOT_BUILT'; note: string };

export type PortalAdapter = {
  id: string;
  name: string;
  /** Whether anything can actually be done through it today. */
  live: boolean;
  operations: Record<PortalOperation, OperationSupport>;
};

const MANUAL: PortalAdapter = {
  id: 'MANUAL',
  name: 'Manual — a person works the buyer’s portal',
  live: true,
  operations: {
    DISCOVER: {
      support: 'RECORDED',
      note: 'Opportunities are registered by hand or by the tender radar. No portal is polled.',
    },
    FETCH_PACK: {
      support: 'RECORDED',
      note: 'Somebody downloads the pack and uploads it here, where it is hashed and read. The hash is what the ' +
        'compliance matrix is bound to, so the record says which documents were actually read.',
    },
    UPLOAD: {
      support: 'RECORDED',
      note: 'A person uploads on the buyer’s portal. The platform gates the start, records who started it and how ' +
        'long was left, and binds the receipt to the pack’s content hash.',
    },
    CONFIRM: {
      support: 'RECORDED',
      note: 'The buyer’s acknowledgement is filed as evidence against the pack hash, so a dispute about what arrived ' +
        'is answerable.',
    },
  },
};

/**
 * Every adapter the deployment has.
 *
 * One, and the register says what it does rather than implying more. A screen
 * that listed six portals with five of them inert would be a list of things
 * that do not work.
 */
export function portalAdapters(): {
  adapters: PortalAdapter[];
  operations: PortalOperation[];
  summary: string;
  limits: string[];
} {
  return {
    adapters: [MANUAL],
    operations: [...PORTAL_OPERATION],
    summary:
      'One adapter: a person works the buyer’s portal and the platform gates, records and binds what they did. ' +
      'Every check that matters sits on this side of the port.',
    limits: [
      'No portal-specific adapter is built. There is no Proactis, Jaggaer, Delta or Find a Tender integration, and ' +
        'none is stubbed — an upload control that silently did nothing would be worse than none.',
      'A real adapter is a configuration entry and an implementation of the four operations above. Nothing in the ' +
        'rule set, the readiness check, the deadline buffer or the receipt binding would change.',
    ],
  };
}

export function portalAdapter(id: string): PortalAdapter | undefined {
  return portalAdapters().adapters.find((adapter) => adapter.id === id);
}

// --- The submission rule set — §4.8.1 -----------------------------------------------

export const RULE_KIND = ['FILENAME', 'FORMAT', 'WORD_LIMIT', 'PAGE_LIMIT', 'FILE_SIZE', 'REQUIRED_DOCUMENT'] as const;
export type RuleKind = (typeof RULE_KIND)[number];

export type SubmissionRule = {
  kind: RuleKind;
  /** What the buyer said, in their words. Quoted on every finding. */
  stated: string;
  /**
   * Whether failing it loses the bid.
   *
   * A hard rule must be satisfied for readiness to reach 100. A soft one is
   * reported. The buyer decides which is which, and the person recording the
   * rule set says what they read.
   */
  hard: boolean;
  /** A regular expression every deliverable's name must match. `FILENAME` only. */
  pattern?: string;
  /** Permitted extensions, lower case and without a dot. `FORMAT` only. */
  formats?: string[];
  /** The ceiling. `WORD_LIMIT`, `PAGE_LIMIT` and `FILE_SIZE` respectively. */
  maxWords?: number;
  maxPages?: number;
  maxBytes?: number;
  /** Which response section it applies to. Absent means every one. */
  sectionKey?: string;
  /** A document that must be in the submission. `REQUIRED_DOCUMENT` only. */
  documentName?: string;
};

export type SubmissionRuleSet = {
  analysisId: string;
  reference: string;
  /** Bumped every time the invitation is re-read, which an addendum makes necessary. */
  revision: number;
  rules: SubmissionRule[];
  recordedAt: string;
  recordedBy: string;
};

const STATED_MIN = 8;

function ruleSetOf(ctx: EngineContext, analysisId: string): SubmissionRuleSet | undefined {
  const record = ctx.ledger.get({ refType: 'SubmissionRuleSet', refId: analysisId });
  if (!record || record.tenantId !== ctx.tenantId) return undefined;
  return record.state as unknown as SubmissionRuleSet;
}

/**
 * Record what the buyer said about the shape of the submission.
 *
 * `ESTIMATE_TENDER` `C`. Bound to the analysis rather than to the pack, because
 * the rules come from the invitation and apply to whatever is submitted against
 * it.
 */
export function recordRuleSet(
  ctx: EngineContext,
  input: { analysisId: string; rules: SubmissionRule[] },
): SubmissionRuleSet {
  authorise(ctx, 'ESTIMATE_TENDER', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  // Reads the analysis through its own reader, which authorises and confines to
  // the tenancy. A rule set against an invitation that is not ours is a rule
  // set nothing can ever check.
  const analysis = complianceMatrix(ctx, input.analysisId);

  if (input.rules.length === 0) {
    throw new DomainError(
      'RULES_REQUIRED',
      'Record at least one rule. An empty rule set reads as "the buyer stated nothing", which is almost never true ' +
        'and makes the readiness check say a submission is ready when nothing was checked.',
      422,
    );
  }

  for (const rule of input.rules) {
    if (rule.stated.trim().length < STATED_MIN) {
      throw new DomainError(
        'RULE_STATEMENT_REQUIRED',
        `Quote what the buyer said, in at least ${STATED_MIN} characters. A rule with no words behind it cannot be ` +
          'argued from when the submission is challenged.',
        422,
        [{ field: 'stated', message: `At least ${STATED_MIN} characters` }],
      );
    }
    if (rule.kind === 'FILENAME') {
      if (!rule.pattern) {
        throw new DomainError('RULE_PATTERN_REQUIRED', 'A filename rule needs the pattern a name must match.', 422);
      }
      try {
        new RegExp(rule.pattern);
      } catch {
        // Stored unusable, it would throw on every readiness check afterwards.
        throw new DomainError(
          'RULE_PATTERN_INVALID',
          `"${rule.pattern}" is not a usable pattern. Record it in a form the check can run, or record the ` +
            'requirement as a required document instead.',
          422,
          [{ field: 'pattern', message: 'Not a valid expression' }],
        );
      }
    }
    if (rule.kind === 'FORMAT' && (rule.formats ?? []).length === 0) {
      throw new DomainError('RULE_FORMATS_REQUIRED', 'A format rule needs the formats the buyer permits.', 422);
    }
    if (rule.kind === 'REQUIRED_DOCUMENT' && !rule.documentName?.trim()) {
      throw new DomainError('RULE_DOCUMENT_REQUIRED', 'A required-document rule needs the document’s name.', 422);
    }
  }

  // Revisable, and the revision is its own event. An addendum changes what the
  // buyer asked for — a page limit moves, a format is added — and a second
  // reading of the invitation has to be recordable. Overwriting under the
  // create event would hide that the rules changed, which is the one thing
  // about a rule set somebody needs to be able to see.
  const existing = ruleSetOf(ctx, input.analysisId);
  const revision = (existing?.revision ?? 0) + 1;
  const ruleSet: SubmissionRuleSet = {
    analysisId: input.analysisId,
    reference: existing?.reference ?? formatRef('SRS', ctx.ledger.list(ctx.projectId, 'SubmissionRuleSet').length + 1),
    revision,
    rules: input.rules.map((rule) => ({ ...rule, stated: rule.stated.trim() })),
    recordedAt: new Date().toISOString(),
    recordedBy: ctx.auth.actorId,
  };

  write(ctx, {
    eventType: existing ? 'SUBMISSION_RULESET_REVISED' : 'SUBMISSION_RULESET_RECORDED',
    entity: { refType: 'SubmissionRuleSet', refId: input.analysisId },
    nextState: ruleSet as unknown as Record<string, unknown>,
    reason: existing
      ? `Revision ${revision}: ${input.rules.length} rule(s) re-read out of ${analysis.reference}, against ` +
        `${existing.rules.length} before`
      : `${input.rules.length} rule(s) read out of ${analysis.reference}`,
  });

  return ruleSet;
}

// --- Readiness ----------------------------------------------------------------------

export type CheckVerdict = 'PASS' | 'FAIL' | 'CANNOT_CHECK';

export type RuleCheck = {
  kind: RuleKind;
  stated: string;
  hard: boolean;
  verdict: CheckVerdict;
  /** What was found, or why the record cannot answer. */
  detail: string;
  /** The deliverable or section the finding is about, where it is about one. */
  subject?: string;
};

export type SubmissionReadiness = {
  analysisId: string;
  packId?: string;
  checks: RuleCheck[];
  hardFailures: number;
  /** Hard rules the record cannot check. These block, and say why. */
  uncheckableHard: number;
  /** Of the hard rules that could be checked, the percentage that passed. */
  scorePercent: number;
  ready: boolean;
  summary: string;
};

/** The extension of a deliverable's name, lower case and without the dot. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

type Deliverable = { name: string; words?: number };

/**
 * Check what was assembled against what the buyer asked for.
 *
 * Pure, so the same answer can be shown on a screen and enforced at the gate.
 * A rule the record cannot check is `CANNOT_CHECK` and, where it is hard, it
 * blocks: **a check that could not run is not a check that passed**, and a
 * screen treating the two alike is how a submission goes out short of a
 * document.
 */
export function checkAgainstRules(rules: SubmissionRule[], deliverables: Deliverable[]): RuleCheck[] {
  const checks: RuleCheck[] = [];

  for (const rule of rules) {
    switch (rule.kind) {
      case 'FILENAME': {
        const pattern = new RegExp(rule.pattern!);
        const wrong = deliverables.filter((entry) => !pattern.test(entry.name));
        checks.push({
          kind: rule.kind,
          stated: rule.stated,
          hard: rule.hard,
          verdict: deliverables.length === 0 ? 'CANNOT_CHECK' : wrong.length === 0 ? 'PASS' : 'FAIL',
          detail:
            deliverables.length === 0
              ? 'Nothing is assembled yet, so no name can be checked.'
              : wrong.length === 0
                ? `All ${deliverables.length} deliverable(s) match ${rule.pattern}.`
                : `${wrong.length} name(s) do not match ${rule.pattern}: ${wrong.map((entry) => entry.name).join(', ')}.`,
          ...(wrong.length > 0 ? { subject: wrong[0]!.name } : {}),
        });
        break;
      }
      case 'FORMAT': {
        const permitted = new Set((rule.formats ?? []).map((format) => format.toLowerCase().replace(/^\./, '')));
        const wrong = deliverables.filter((entry) => {
          const extension = extensionOf(entry.name);
          return extension !== '' && !permitted.has(extension);
        });
        const unnamed = deliverables.filter((entry) => extensionOf(entry.name) === '');
        checks.push({
          kind: rule.kind,
          stated: rule.stated,
          hard: rule.hard,
          verdict:
            deliverables.length === 0 || unnamed.length === deliverables.length
              ? 'CANNOT_CHECK'
              : wrong.length === 0
                ? 'PASS'
                : 'FAIL',
          detail:
            deliverables.length === 0
              ? 'Nothing is assembled yet.'
              : unnamed.length === deliverables.length
                ? 'No deliverable carries a file extension, so the format cannot be read from the record.'
                : wrong.length === 0
                  ? `Every deliverable is one of ${[...permitted].join(', ')}.`
                  : `${wrong.map((entry) => entry.name).join(', ')} are not among ${[...permitted].join(', ')}.`,
          ...(wrong.length > 0 ? { subject: wrong[0]!.name } : {}),
        });
        break;
      }
      case 'WORD_LIMIT': {
        const counted = deliverables.filter(
          (entry) => entry.words !== undefined && (rule.sectionKey === undefined || entry.name === rule.sectionKey),
        );
        const over = counted.filter((entry) => entry.words! > rule.maxWords!);
        checks.push({
          kind: rule.kind,
          stated: rule.stated,
          hard: rule.hard,
          verdict: counted.length === 0 ? 'CANNOT_CHECK' : over.length === 0 ? 'PASS' : 'FAIL',
          detail:
            counted.length === 0
              ? rule.sectionKey === undefined
                ? 'Nothing with a word count is assembled yet.'
                : `Nothing is written against ${rule.sectionKey} yet.`
              : over.length === 0
                ? `${counted.length} section(s) checked, the longest at ${Math.max(...counted.map((entry) => entry.words!))} words against a limit of ${rule.maxWords}.`
                : over.map((entry) => `${entry.name} is ${entry.words} words against a limit of ${rule.maxWords}`).join('; ') + '.',
          ...(over.length > 0 ? { subject: over[0]!.name } : {}),
        });
        break;
      }
      case 'PAGE_LIMIT':
      case 'FILE_SIZE': {
        // Neither is on the record. The platform holds a section's words and a
        // deliverable's name; a page count depends on how it is rendered and a
        // size on bytes nothing here stores. Saying so is the whole point — a
        // hard rule reported as passing because nothing looked is the failure
        // this check exists to prevent.
        checks.push({
          kind: rule.kind,
          stated: rule.stated,
          hard: rule.hard,
          verdict: 'CANNOT_CHECK',
          detail:
            rule.kind === 'PAGE_LIMIT'
              ? `A page count depends on how the document is rendered and is not on the record. Somebody has to open ` +
                `the file and confirm it is within ${rule.maxPages} page(s).`
              : `File size is not stored against a deliverable, so the ${rule.maxBytes} byte limit cannot be checked ` +
                'here. Confirm it before uploading.',
        });
        break;
      }
      case 'REQUIRED_DOCUMENT': {
        const wanted = rule.documentName!.trim().toLowerCase();
        const found = deliverables.some((entry) => entry.name.toLowerCase().includes(wanted));
        checks.push({
          kind: rule.kind,
          stated: rule.stated,
          hard: rule.hard,
          verdict: found ? 'PASS' : 'FAIL',
          detail: found
            ? `"${rule.documentName}" is in the assembly.`
            : `Nothing in the assembly is named for "${rule.documentName}".`,
          subject: rule.documentName!,
        });
        break;
      }
    }
  }

  return checks;
}

type PackState = {
  id?: string;
  assembly?: { attachments?: Array<{ name?: string }> };
};

type ResponseState = {
  analysisId?: string;
  sections?: Array<{ key: string; words?: number; status?: string }>;
};

/**
 * Everything the submission is made of, as names the rules can be run against.
 *
 * The locked pack's attachments and the response pack's written sections. Two
 * sources because a submission is two things: the documents and the prose.
 */
function deliverablesFor(ctx: EngineContext, analysisId: string, packId?: string): Deliverable[] {
  const deliverables: Deliverable[] = [];

  if (packId) {
    const pack = ctx.ledger.get({ refType: 'BidSubmissionPack', refId: packId });
    if (pack && pack.tenantId === ctx.tenantId) {
      for (const attachment of ((pack.state as PackState).assembly?.attachments ?? [])) {
        if (attachment.name) deliverables.push({ name: attachment.name });
      }
    }
  }

  for (const record of ctx.ledger.list(ctx.projectId, 'BidResponsePack')) {
    const state = record.state as unknown as ResponseState;
    if (state.analysisId !== analysisId) continue;
    for (const section of state.sections ?? []) {
      if (section.words === undefined) continue;
      deliverables.push({ name: section.key, words: section.words });
    }
  }

  return deliverables;
}

export function submissionReadiness(
  ctx: EngineContext,
  input: { analysisId: string; packId?: string },
): SubmissionReadiness {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const ruleSet = ruleSetOf(ctx, input.analysisId);
  if (!ruleSet) {
    return {
      analysisId: input.analysisId,
      ...(input.packId === undefined ? {} : { packId: input.packId }),
      checks: [],
      hardFailures: 0,
      uncheckableHard: 0,
      scorePercent: 0,
      ready: false,
      summary:
        'No submission rule set has been recorded against this invitation. Until somebody reads what the buyer said ' +
        'about filenames, formats and limits, there is nothing to check and readiness cannot be claimed.',
    };
  }

  const checks = checkAgainstRules(ruleSet.rules, deliverablesFor(ctx, input.analysisId, input.packId));
  const hard = checks.filter((check) => check.hard);
  const hardFailures = hard.filter((check) => check.verdict === 'FAIL').length;
  const uncheckableHard = hard.filter((check) => check.verdict === 'CANNOT_CHECK').length;
  const checkable = hard.filter((check) => check.verdict !== 'CANNOT_CHECK');
  const scorePercent =
    checkable.length === 0
      ? 0
      : Math.round(((checkable.length - hardFailures) / checkable.length) * 1000) / 10;

  const ready = hardFailures === 0 && uncheckableHard === 0 && hard.length > 0;

  return {
    analysisId: input.analysisId,
    ...(input.packId === undefined ? {} : { packId: input.packId }),
    checks,
    hardFailures,
    uncheckableHard,
    scorePercent,
    ready,
    summary: ready
      ? `${hard.length} hard rule(s), all satisfied.`
      : `${scorePercent}% of the checkable hard rules pass` +
        (hardFailures > 0 ? `, ${hardFailures} failing` : '') +
        (uncheckableHard > 0
          ? `, and ${uncheckableHard} that the record cannot check — a page count or a file size somebody has to open ` +
            'the file to confirm'
          : '') +
        (hard.length === 0 ? '. No rule was recorded as hard, so there is nothing to be ready against' : '') +
        '.',
  };
}

// --- The deadline buffer ------------------------------------------------------------

export type SubmissionWindow = {
  returnBy: string;
  hoursRemaining: number;
  bufferHours: number;
  insideBuffer: boolean;
  passed: boolean;
  reading: string;
};

export function submissionWindow(returnBy: string, now?: string): SubmissionWindow {
  const bufferHours = config.submissionBufferHours;
  const at = Date.parse(now ?? new Date().toISOString());
  const deadline = Date.parse(returnBy);
  const hoursRemaining = Math.round(((deadline - at) / 3_600_000) * 10) / 10;

  return {
    returnBy,
    hoursRemaining,
    bufferHours,
    insideBuffer: hoursRemaining < bufferHours,
    passed: hoursRemaining <= 0,
    reading:
      hoursRemaining <= 0
        ? `The return deadline passed ${Math.abs(hoursRemaining)} hours ago.`
        : hoursRemaining < bufferHours
          ? `${hoursRemaining} hours left, inside the ${bufferHours}-hour buffer. Starting an upload this late is how ` +
            'a portal timeout becomes a lost bid.'
          : `${hoursRemaining} hours left, outside the ${bufferHours}-hour buffer.`,
  };
}

// --- Starting the upload ------------------------------------------------------------

export type SubmissionStart = {
  id: string;
  reference: string;
  analysisId: string;
  packId: string;
  adapterId: string;
  startedAt: string;
  startedBy: string;
  window: SubmissionWindow;
  readiness: SubmissionReadiness;
  /** Present only where somebody overrode the buffer, and names them. */
  override?: { authorisedBy: string; reason: string };
};

const OVERRIDE_REASON_MIN = 20;

function requirePack(ctx: EngineContext, packId: string): EntityRecord {
  const pack = ctx.ledger.get({ refType: 'BidSubmissionPack', refId: packId });
  if (!pack || pack.tenantId !== ctx.tenantId) {
    throw new DomainError('BID_PACK_NOT_FOUND', `No bid submission pack ${packId}`, 404);
  }
  return pack;
}

/**
 * A human starts the upload — §4.8.1.
 *
 * `PROCUREMENT_AWARD` `I`, the same authority that records the receipt, because
 * this is the first half of the same act. Three things have to be true: the pack
 * is locked, the hard rules are satisfied, and there is more than the buffer
 * left. The third can be overridden by a named person with a reason; the first
 * two cannot, because neither is a matter of judgement.
 */
export function beginSubmission(
  ctx: EngineContext,
  input: {
    packId: string;
    analysisId: string;
    adapterId: string;
    returnBy: string;
    override?: { authorisedBy: string; reason: string };
    now?: string;
  },
): SubmissionStart {
  authorise(ctx, 'PROCUREMENT_AWARD', 'I', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const pack = requirePack(ctx, input.packId);
  const adapter = portalAdapter(input.adapterId);
  if (!adapter) {
    throw new DomainError(
      'PORTAL_ADAPTER_UNKNOWN',
      `No portal adapter ${input.adapterId}. This deployment has ${portalAdapters()
        .adapters.map((entry) => entry.id)
        .join(', ')} — a portal-specific adapter is an adapter and a configuration entry, and none is built.`,
      404,
    );
  }
  if (pack.state.submission) {
    throw new DomainError(
      'ALREADY_SUBMITTED',
      'This pack already carries a receipt. A resubmission is a new pack, not a second start on this one.',
      409,
    );
  }
  if (pack.state.status !== 'LOCKED') {
    throw new DomainError(
      'BID_PACK_NOT_LOCKED',
      `This pack is ${String(pack.state.status).toLowerCase()}. Only a locked pack has the hash the receipt will be ` +
        'bound to, and uploading one that can still change means the record cannot say what was sent.',
    );
  }

  const readiness = submissionReadiness(ctx, { analysisId: input.analysisId, packId: input.packId });
  if (!readiness.ready) {
    throw new DomainError(
      'SUBMISSION_NOT_READY',
      `${readiness.summary} ` +
        (readiness.hardFailures > 0
          ? `Failing: ${readiness.checks
              .filter((check) => check.hard && check.verdict === 'FAIL')
              .map((check) => `${check.kind} — ${check.detail}`)
              .join('; ')}. `
          : '') +
        (readiness.uncheckableHard > 0
          ? 'A hard rule the record cannot check is not a hard rule that passed. Open the files, confirm it, and ' +
            'record the rule as met or not. '
          : '') +
        'A submission rejected on a filename is rejected as completely as one rejected on price.',
      422,
    );
  }

  const window = submissionWindow(input.returnBy, input.now);
  if (window.passed) {
    throw new DomainError(
      'RETURN_DEADLINE_PASSED',
      `${window.reading} Recording a start after the deadline would put a time on the record that contradicts the ` +
        'buyer’s own clock.',
    );
  }
  if (window.insideBuffer && !input.override) {
    throw new DomainError(
      'INSIDE_SUBMISSION_BUFFER',
      `${window.reading} A director can authorise it, and the authorisation is recorded — because the question ` +
        'afterwards is never whether somebody was in a hurry.',
      422,
    );
  }
  if (input.override) {
    if (!input.override.authorisedBy.trim()) {
      throw new DomainError('OVERRIDE_AUTHORITY_REQUIRED', 'An override has to name who authorised it.', 422);
    }
    if (input.override.reason.trim().length < OVERRIDE_REASON_MIN) {
      throw new DomainError(
        'OVERRIDE_REASON_REQUIRED',
        `Say why, in at least ${OVERRIDE_REASON_MIN} characters.`,
        422,
        [{ field: 'reason', message: `At least ${OVERRIDE_REASON_MIN} characters` }],
      );
    }
  }

  const id = ulid();
  const start: SubmissionStart = {
    id,
    reference: formatRef('SUB', ctx.ledger.list(ctx.projectId, 'SubmissionStart').length + 1),
    analysisId: input.analysisId,
    packId: input.packId,
    adapterId: adapter.id,
    startedAt: input.now ?? new Date().toISOString(),
    startedBy: ctx.auth.actorId,
    window,
    readiness,
    ...(input.override
      ? {
          override: {
            authorisedBy: input.override.authorisedBy.trim(),
            reason: input.override.reason.trim(),
          },
        }
      : {}),
  };

  write(ctx, {
    eventType: 'SUBMISSION_STARTED',
    entity: { refType: 'SubmissionStart', refId: id },
    nextState: start as unknown as Record<string, unknown>,
    evidenceRefs: [{ refType: 'BidSubmissionPack', refId: input.packId }],
    ...(input.override ? { reason: `Buffer overridden by ${input.override.authorisedBy}: ${input.override.reason}` } : {}),
  });

  return start;
}

export type SubmissionRegister = {
  starts: Array<{
    reference: string;
    packId: string;
    adapterId: string;
    startedAt: string;
    startedBy: string;
    hoursRemaining: number;
    overridden: boolean;
    /** Whether a receipt has been recorded against the pack since. */
    receipted: boolean;
  }>;
  adapters: ReturnType<typeof portalAdapters>;
  summary: string;
};

/** Every upload started, whether it was overridden, and whether a receipt followed. */
export function submissionRegister(ctx: EngineContext): SubmissionRegister {
  authorise(ctx, 'PROCUREMENT_AWARD', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const starts = ctx.ledger
    .list(ctx.projectId, 'SubmissionStart')
    .map((record) => record.state as unknown as SubmissionStart)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((start) => {
      const pack = ctx.ledger.get({ refType: 'BidSubmissionPack', refId: start.packId });
      return {
        reference: start.reference,
        packId: start.packId,
        adapterId: start.adapterId,
        startedAt: start.startedAt,
        startedBy: start.startedBy,
        hoursRemaining: start.window.hoursRemaining,
        overridden: start.override !== undefined,
        receipted: Boolean(pack?.state.submission),
      };
    });

  const open = starts.filter((start) => !start.receipted).length;

  return {
    starts,
    adapters: portalAdapters(),
    summary:
      starts.length === 0
        ? 'No upload has been started through the port yet.'
        : `${starts.length} upload(s) started, ${open} with no receipt recorded yet, ` +
          `${starts.filter((start) => start.overridden).length} started inside the deadline buffer under an override.`,
  };
}
