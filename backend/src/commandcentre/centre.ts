import { DomainError } from '../core/errors.ts';
import { morningBriefing } from '../agents/briefing.ts';
import { pendingProposals } from '../agents/runtime.ts';
import { fleetManifest } from '../agents/runtime.ts';
import { securitySummary } from '../api/telemetry.ts';
import { commitmentPosition } from '../domain/commitments.ts';
import { lessonsLibrary, projectControl } from '../domain/control.ts';
import { costIntelligence } from '../domain/costintel.ts';
import { bidDiscipline, pipeline } from '../domain/business.ts';
import { changeWindow } from '../domain/portfolio.ts';
import { latestRadarRun } from '../domain/radar.ts';
import { commercialControlPosition } from '../domain/valuechain.ts';
import { abbreviateMoney } from '../domain/locale.ts';
import type { EngineContext } from '../engines/context.ts';

/**
 * The AI command centre — one per person, assembled from the same seven
 * functions.
 *
 * A command centre is not a chat window. It is a working surface with four
 * fixed regions, and the platform already answers all four for every screen:
 * **what is happening**, **what changed**, **what is at risk**, and **what to do
 * next**. This populates them from the ledger rather than from a prompt.
 *
 * ## The rule that makes it safe
 *
 * A command centre inherits the authority of the person viewing it and never
 * exceeds it. That is enforced by **calling the ordinary domain read**, which
 * authorises exactly as it does for any other caller — not by filtering results
 * afterwards, and not by consulting a permission table of this module's own.
 *
 * The distinction matters. A parallel permission model here would be a second
 * source of truth for who may see what, and the two would eventually disagree —
 * at which point the command centre is either refusing something a person may
 * see, or showing something they may not. So there is no permission logic in
 * this file at all. Each function calls the reads it needs; a `DomainError`
 * coming back means this viewer may not have that, and the region says so in
 * the words the domain used.
 *
 * A non-`DomainError` propagates. Swallowing everything would turn a genuine
 * defect into an empty panel, which is the failure mode that makes a dashboard
 * untrustworthy: nobody can tell "nothing is wrong" from "this is broken".
 *
 * ## Nothing here asks a model
 *
 * Every figure is arithmetic over materialised state, exactly as the morning
 * briefing is. The AI in "AI command centre" is the agent fleet whose findings
 * appear in **next**, and those findings are themselves arithmetic. A surface
 * somebody acts on before they have had coffee should be checkable.
 */

export type Region = 'HAPPENING' | 'CHANGED' | 'AT_RISK' | 'NEXT';

export type Card = {
  region: Region;
  severity: 'URGENT' | 'ATTENTION' | 'INFO';
  /** The fact, in the language a project person would use. */
  headline: string;
  /** The number behind it, or the consequence. Never a restatement. */
  detail: string;
  /** Where it came from, so it can be checked. */
  source?: { refType: string; refId: string };
  dueBy?: string;
  valueMinor?: number;
};

export type CentreFunctionId =
  | 'CHIEF_OF_STAFF'
  | 'ANALYST'
  | 'RESEARCH'
  | 'AUTOMATION'
  | 'GROWTH'
  | 'SECURITY'
  | 'KNOWLEDGE';

export type FunctionReport = {
  id: CentreFunctionId;
  label: string;
  /** What this function is for, in one sentence. */
  what: string;
  /** False where the viewer's authority does not reach it. */
  available: boolean;
  /** Why it is unavailable, in the words the domain used. Absent when available. */
  because?: string;
  cards: Card[];
};

export type CommandCentre = {
  asAt: string;
  /** Who this centre is assembled for, and what they hold. */
  viewer: { actorId: string; roles: string[] };
  functions: FunctionReport[];
  /** Cards from every available function, ordered by consequence. */
  attention: Card[];
  /** One line, if the reader reads nothing else. */
  headline: string;
};

const SEVERITY_ORDER = { URGENT: 0, ATTENTION: 1, INFO: 2 } as const;

function money(minor: number, currency = 'GBP'): string {
  return abbreviateMoney(minor, currency);
}

/**
 * Run one read, and turn a refusal into a fact about authority.
 *
 * `DomainError` only. Anything else is a defect, and a defect that presented as
 * an empty panel would make every empty panel ambiguous.
 */
function attempt<T>(read: () => T): { ok: true; value: T } | { ok: false; because: string } {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    if (error instanceof DomainError) return { ok: false, because: error.message };
    throw error;
  }
}

/**
 * Order by consequence, not by recency.
 *
 * A time-barred notice outranks a late drawing however much later the drawing
 * was noticed — which is the ordering a person actually needs and the opposite
 * of what a feed gives them. Within a severity, the thing with a date comes
 * before the thing without, soonest first, and then the larger sum.
 */
function byConsequence(a: Card, b: Card): number {
  const severity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (severity !== 0) return severity;

  const aDue = a.dueBy ?? '';
  const bDue = b.dueBy ?? '';
  if (aDue !== bDue) {
    if (aDue === '') return 1;
    if (bDue === '') return -1;
    return aDue.localeCompare(bDue);
  }
  return (b.valueMinor ?? 0) - (a.valueMinor ?? 0);
}

// ------------------------------------------------------------ the functions

type Builder = (ctx: EngineContext, today: string) => Card[];

const FUNCTIONS: Array<{ id: CentreFunctionId; label: string; what: string; build: Builder }> = [
  {
    id: 'CHIEF_OF_STAFF',
    label: 'Chief of staff',
    what: 'The day: what needs a decision, what is overdue, and what is about to be.',
    build: (ctx, today) => {
      const cards: Card[] = [];

      const briefing = morningBriefing(ctx, { today });
      cards.push({
        region: 'HAPPENING',
        severity: 'INFO',
        headline: briefing.headline,
        detail: `${briefing.delivery.projects} project${briefing.delivery.projects === 1 ? '' : 's'} on the estate.`,
      });

      for (const action of briefing.actions.slice(0, 8)) {
        cards.push({
          region: 'NEXT',
          severity: action.severity,
          headline: action.action,
          detail: action.because,
          source: action.source,
          dueBy: action.dueBy,
          valueMinor: action.valueMinor,
        });
      }

      if (briefing.money.marginErosionMinor > 0) {
        cards.push({
          region: 'AT_RISK',
          severity: 'ATTENTION',
          headline: `${money(briefing.money.marginErosionMinor)} of margin has already gone`,
          detail: 'The cost report says so; the question is whether anything is being done about it.',
          valueMinor: briefing.money.marginErosionMinor,
        });
      }
      if (briefing.delivery.worstDelayDays > 0) {
        cards.push({
          region: 'AT_RISK',
          severity: briefing.delivery.worstDelayDays > 28 ? 'URGENT' : 'ATTENTION',
          headline: `${briefing.delivery.worstDelayDays} days of forecast delay on ${briefing.delivery.worstDelayProject ?? 'a project'}`,
          detail: 'Forecast from the critical path, not from a status report.',
        });
      }

      // Obligations that carry a date somebody promised in writing. These are
      // the ones that outrank everything else in the ordering above.
      const obligations = attempt(() => commitmentPosition(ctx));
      if (obligations.ok) {
        const position = obligations.value;

        // A commitment read out of a letter and not yet confirmed by a person.
        // It is not an obligation until somebody says it is — the platform will
        // not put an invented undertaking in a calendar — so this belongs in
        // NEXT as a decision rather than in AT_RISK as a fact.
        for (const awaiting of position.awaitingDecision.slice(0, 5)) {
          cards.push({
            region: 'NEXT',
            severity: awaiting.statedDueDate && awaiting.statedDueDate <= today ? 'URGENT' : 'ATTENTION',
            headline: `Confirm or discard: ${awaiting.description}`,
            detail:
              `Read from ${awaiting.correspondenceReference} as a ${awaiting.kind.toLowerCase()} by ${awaiting.party}. ` +
              'It is not an obligation until somebody confirms it.',
            dueBy: awaiting.statedDueDate,
            source: { refType: 'CorrespondenceCommitment', refId: awaiting.commitmentId },
          });
        }

        if (position.unread > 0) {
          cards.push({
            region: 'AT_RISK',
            severity: 'ATTENTION',
            headline: `${position.unread} letter${position.unread === 1 ? '' : 's'} nobody has read for a date`,
            detail:
              'Correspondence the platform holds and has never looked at for what it promises. ' +
              'A date buried in a letter binds this business exactly as much as one in a contract.',
          });
        }
      }

      return cards;
    },
  },

  {
    id: 'ANALYST',
    label: 'Analyst',
    what: 'A commercial or programme question, answered with the records the answer came from.',
    build: (ctx) => {
      const cards: Card[] = [];

      const control = projectControl(ctx);
      cards.push({
        region: 'HAPPENING',
        severity: 'INFO',
        headline: `At ${control.phase}, measured as ${control.projectScaleLabel}`,
        detail:
          control.completenessPercent === null
            ? `${control.applicableItems} control items apply at this size; none is due yet.`
            : `${control.completenessPercent}% of the ${control.applicableItems} control items that apply at this size are in place.`,
        source: { refType: 'Project', refId: ctx.projectId },
      });

      if (control.blockingGaps.length > 0) {
        cards.push({
          region: 'AT_RISK',
          severity: 'URGENT',
          headline: `${control.blockingGaps.length} gap${control.blockingGaps.length === 1 ? '' : 's'} will stop the next stage gate`,
          detail:
            `${control.blockingGaps.slice(0, 3).join('; ')}. ` +
            'These are gate criteria rather than discipline — the project does not move on without them.',
        });
      } else if (control.gaps.length > 0) {
        cards.push({
          region: 'AT_RISK',
          severity: 'ATTENTION',
          headline: `${control.gaps.length} control item${control.gaps.length === 1 ? '' : 's'} due and absent`,
          detail: 'Discipline rather than a gate. Nothing is blocked; the record is thinner than the standard asks for.',
        });
      }

      const commercial = attempt(() => commercialControlPosition(ctx));
      if (commercial.ok) {
        const position = commercial.value;

        cards.push({
          region: 'HAPPENING',
          severity: 'INFO',
          headline: `${position.chains.length} value chain${position.chains.length === 1 ? '' : 's'} traced from instruction to certificate`,
          detail: position.summary,
        });

        const unpaidMinor = position.unpaid.reduce((sum, entry) => sum + entry.unpaidMinor, 0);
        if (unpaidMinor > 0) {
          cards.push({
            region: 'AT_RISK',
            severity: 'URGENT',
            headline: `${money(unpaidMinor)} certified and not paid, across ${position.unpaid.length} change${position.unpaid.length === 1 ? '' : 's'}`,
            detail:
              'Work agreed, valued and certified, with the money still outstanding. This is the figure a cash-flow ' +
              'forecast is wrong by if nobody is chasing it.',
            valueMinor: unpaidMinor,
          });
        }

        // A time bar the platform derived but nobody has checked against the
        // executed contract. Presenting a derived statutory date as a verified
        // one is how a right gets lost on a date that was never right.
        if (position.unvalidatedTimeBars.length > 0) {
          cards.push({
            region: 'AT_RISK',
            severity: 'URGENT',
            headline: `${position.unvalidatedTimeBars.length} time bar${position.unvalidatedTimeBars.length === 1 ? '' : 's'} derived and never checked against the contract`,
            detail:
              `${position.unvalidatedTimeBars.slice(0, 3).join(', ')}. The platform computed these from the standard ` +
              'form; the executed contract may amend them, and a date nobody verified is not a date to rely on.',
          });
        }

        for (const deadline of position.deadlines.filter((entry) => entry.timeBarred).slice(0, 3)) {
          cards.push({
            region: 'NEXT',
            severity: 'URGENT',
            headline: `${deadline.reference} is time-barred as of ${deadline.dueDate}`,
            detail: `${deadline.category}, under ${deadline.ruleSource}. Passing it removes an entitlement rather than weakening one.`,
            dueBy: deadline.dueDate,
          });
        }
      }

      return cards;
    },
  },

  {
    id: 'RESEARCH',
    label: 'Research',
    what: 'Outside-in: what work is out there, and what this business has learned about pricing it.',
    build: (ctx) => {
      const cards: Card[] = [];

      const radar = attempt(() => latestRadarRun(ctx));
      if (radar.ok) {
        const run = radar.value;
        if (run) {
          cards.push({
            region: 'CHANGED',
            severity: 'INFO',
            headline: `${Number(run.suitable ?? 0)} opportunities passed screening of ${Number(run.detected ?? 0)} detected`,
            detail: `Last run ${String(run.ranOn ?? 'not recorded')}. The rest were filtered before anybody read them.`,
          });
        } else {
          // Absent is a fact, not an empty panel. A radar that has never run and
          // a radar that found nothing look identical unless one says so.
          cards.push({
            region: 'HAPPENING',
            severity: 'INFO',
            headline: 'The opportunity radar has never been run',
            detail: 'Nothing has been screened, so nothing has been rejected either.',
          });
        }
      }

      const rates = attempt(() => costIntelligence(ctx));
      if (rates.ok) {
        const intelligence = rates.value;
        cards.push({
          region: 'HAPPENING',
          severity: 'INFO',
          headline: `${intelligence.rates.length} rates from ${intelligence.totals.projects} settled project${intelligence.totals.projects === 1 ? '' : 's'}`,
          detail:
            'Built from what this business actually paid, not from a published book — and each one reports how ' +
            'many observations stand behind it.',
        });
        const thin = intelligence.rates.filter((rate) => rate.confidence === 'NONE' || rate.confidence === 'THIN').length;
        if (thin > 0) {
          cards.push({
            region: 'AT_RISK',
            severity: 'ATTENTION',
            headline: `${thin} rate${thin === 1 ? '' : 's'} rest on too little history to trust`,
            detail:
              'Reported at THIN or NONE confidence rather than presented as fact. Pricing from one of these is a ' +
              'guess with a number on it, and the number is the convincing part.',
          });
        }
      }

      return cards;
    },
  },

  {
    id: 'AUTOMATION',
    label: 'Automation',
    what: 'What the agent fleet found, what it wants run, and how far any of it may go alone.',
    build: (ctx) => {
      const cards: Card[] = [];
      const queue = pendingProposals(ctx);
      const mine = queue.filter((proposal) => proposal.mine);

      cards.push({
        region: 'HAPPENING',
        severity: 'INFO',
        headline: `${queue.length} proposal${queue.length === 1 ? '' : 's'} open, ${mine.length} for you to decide`,
        detail:
          `${fleetManifest().filter((agent) => agent.deployment !== 'DECLARED').length} agents are running. ` +
          'None of them can approve its own proposal.',
      });

      for (const proposal of mine.slice(0, 6)) {
        cards.push({
          region: 'NEXT',
          severity: proposal.finding.severity,
          headline: proposal.command ? proposal.command.effect : proposal.finding.summary,
          detail: proposal.finding.consequence,
          source: { refType: 'AgentProposal', refId: proposal.id },
          valueMinor: proposal.command?.estimatedAcuMinor,
        });
      }

      // Somebody else's queue is not this reader's work, and it is worth
      // knowing it exists — a proposal nobody has picked up is the one that
      // sits for a fortnight.
      const others = queue.length - mine.length;
      if (others > 0) {
        cards.push({
          region: 'AT_RISK',
          severity: 'INFO',
          headline: `${others} proposal${others === 1 ? '' : 's'} awaiting somebody else`,
          detail: 'Not yours to decide. Shown because a queue nobody has picked up is the one that sits.',
        });
      }

      return cards;
    },
  },

  {
    id: 'GROWTH',
    label: 'Growth',
    what: 'What this business wins, what it loses, and the discipline behind the difference.',
    build: (ctx) => {
      const cards: Card[] = [];

      const summary = pipeline(ctx);
      const live = summary.opportunities.length;
      cards.push({
        region: 'HAPPENING',
        severity: 'INFO',
        headline: `${live} pursuit${live === 1 ? '' : 's'} on the record, ${money(summary.liveValueMinor)} still live`,
        detail: `${money(summary.wonValueMinor)} won. Stages: ${Object.entries(summary.byStage).map(([stage, count]) => `${count} ${stage.toLowerCase()}`).join(', ') || 'none recorded'}.`,
        valueMinor: summary.liveValueMinor,
      });

      if (summary.overrides > 0) {
        cards.push({
          region: 'AT_RISK',
          severity: 'ATTENTION',
          headline: `${summary.overrides} decision${summary.overrides === 1 ? '' : 's'} taken against the platform's own recommendation`,
          detail:
            'One override is judgement. A pattern of them is a scoring model nobody believes, which is worse than ' +
            'having no model — it costs the time to run it and changes nothing.',
        });
      }

      const discipline = attempt(() => bidDiscipline(ctx));
      if (discipline.ok) {
        const record = discipline.value;
        cards.push({
          region: 'HAPPENING',
          severity: record.noBidRatePercent < 10 ? 'ATTENTION' : 'INFO',
          headline: `${record.noBidRatePercent}% of ${record.decided} decided pursuits were declined`,
          detail:
            record.noBidRatePercent < 10
              ? 'A business that declines almost nothing is not qualifying, it is queuing. The cost is estimating ' +
                'time spent on jobs it was never going to win.'
              : `${money(record.declinedValueMinor)} of work turned down deliberately.`,
        });

        // Win rate by recommendation band. This is the only figure that says
        // whether the scoring model predicts anything at all.
        for (const band of record.byBand.filter((entry) => entry.winRatePercent !== null && entry.decided >= 3)) {
          cards.push({
            region: 'CHANGED',
            severity: 'INFO',
            headline: `${band.winRatePercent}% win rate where the model said ${band.band} (${band.range})`,
            detail: `${band.converted} won and ${band.lost} lost of ${band.decided} decided. This is what tells you whether the scoring predicts anything.`,
          });
        }
      }

      return cards;
    },
  },

  {
    id: 'SECURITY',
    label: 'Security',
    what: 'Who reached what, from where, and what was refused.',
    build: (ctx) => {
      // Not the platform-wide stream — that is an operator's view and this is a
      // customer's screen. What a tenancy is entitled to see about itself is
      // what its own people did, which the ledger already carries.
      const cards: Card[] = [];
      const summary = securitySummary();

      const denials = summary.byKind.AUTHZ_DENY ?? 0;
      const failures = summary.byKind.AUTH_FAILURE ?? 0;

      cards.push({
        region: 'HAPPENING',
        severity: 'INFO',
        headline: `${summary.total} security events recorded since this process started`,
        detail: `${denials} authorisation denials and ${failures} authentication failures.`,
      });

      if (summary.repeatSources.length > 0) {
        const worst = summary.repeatSources[0]!;
        cards.push({
          region: 'AT_RISK',
          severity: worst.failures >= 10 ? 'URGENT' : 'ATTENTION',
          headline: `${worst.failures} failures from one network (${worst.remote})`,
          detail:
            'The brute-force shape. The address is truncated to its network on purpose — enough to see the ' +
            'pattern, not enough to be personal data.',
        });
      }

      const window = attempt(() => changeWindow(ctx, dayBefore(), new Date().toISOString()));
      if (window.ok) {
        const changed = window.value;
        const withheld = changed.groups.reduce((sum, group) => sum + group.withheld, 0);
        cards.push({
          region: 'CHANGED',
          severity: 'INFO',
          headline: `${changed.total} records written across the tenancy in the last day`,
          detail:
            `Across ${changed.groups.length} kinds of activity. Every one is attributable and none is editable.` +
            (withheld > 0
              ? ` ${withheld} are withheld from this view because your authority does not reach them — said out loud rather than silently omitted.`
              : ''),
        });
      }

      return cards;
    },
  },

  {
    id: 'KNOWLEDGE',
    label: 'Knowledge',
    what: 'What this business learned on the last job like this one.',
    build: (ctx) => {
      const cards: Card[] = [];
      const library = lessonsLibrary(ctx);

      cards.push({
        region: 'HAPPENING',
        severity: 'INFO',
        headline: `${library.lessons.length} lessons carried across projects`,
        detail:
          library.lessons.length === 0
            ? 'Nothing has been captured yet, so nothing can be carried. A lessons library nobody writes to is a folder.'
            : 'Corporate memory, held against the stage each was learned at rather than in a document nobody opens.',
      });

      // The ones that cost money last time, surfaced against the stage this
      // project is at now — which is the only moment a lesson is useful.
      // What has cost money on more than one job. A category that recurs across
      // projects is a business problem rather than bad luck on one, which is
      // exactly the distinction a lessons library exists to make.
      for (const recurring of library.recurring.filter((entry) => entry.projects > 1).slice(0, 5)) {
        cards.push({
          region: 'AT_RISK',
          severity: recurring.costImpactMinor > 0 ? 'ATTENTION' : 'INFO',
          headline: `${recurring.category} has gone wrong on ${recurring.projects} separate projects`,
          detail:
            `${recurring.occurrences} occurrences, ${money(recurring.costImpactMinor)} of cost and ` +
            `${recurring.scheduleImpactDays} days between them.`,
          valueMinor: recurring.costImpactMinor,
        });
      }

      if (library.costOfRepeatedMistakesMinor > 0) {
        cards.push({
          region: 'HAPPENING',
          severity: 'ATTENTION',
          headline: `${money(library.costOfRepeatedMistakesMinor)} spent on mistakes this business had already made once`,
          detail: 'The number a lessons library exists to make smaller, and the only test of whether anybody reads it.',
          valueMinor: library.costOfRepeatedMistakesMinor,
        });
      }

      for (const observation of library.observations.slice(0, 3)) {
        cards.push({ region: 'AT_RISK', severity: 'INFO', headline: observation, detail: 'Read from the library itself.' });
      }

      return cards;
    },
  },
];

function dayBefore(): string {
  return new Date(Date.now() - 86_400_000).toISOString();
}

/**
 * Assemble the command centre for whoever is asking.
 *
 * Every function runs. One that the viewer's authority does not reach comes back
 * `available: false` with the domain's own sentence, rather than being hidden —
 * because a panel that vanishes tells a person nothing, and "you do not hold
 * CONTRACTS_CLAIMS on this project" tells them exactly who to ask.
 */
export function commandCentre(
  ctx: EngineContext,
  options: { today?: string; only?: CentreFunctionId[] } = {},
): CommandCentre {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const wanted = options.only?.length ? FUNCTIONS.filter((fn) => options.only!.includes(fn.id)) : FUNCTIONS;

  const functions: FunctionReport[] = wanted.map((fn) => {
    const outcome = attempt(() => fn.build(ctx, today));
    if (!outcome.ok) {
      return { id: fn.id, label: fn.label, what: fn.what, available: false, because: outcome.because, cards: [] };
    }
    return { id: fn.id, label: fn.label, what: fn.what, available: true, cards: outcome.value.sort(byConsequence) };
  });

  const attention = functions
    .flatMap((report) => report.cards)
    .filter((card) => card.severity !== 'INFO')
    .sort(byConsequence)
    .slice(0, 12);

  const urgent = attention.filter((card) => card.severity === 'URGENT').length;
  const reachable = functions.filter((report) => report.available).length;

  return {
    asAt: today,
    viewer: { actorId: ctx.auth.actorId, roles: [...ctx.auth.roles] },
    functions,
    attention,
    headline:
      urgent > 0
        ? `${urgent} thing${urgent === 1 ? '' : 's'} needs deciding today — ${attention[0]?.headline ?? ''}`
        : attention.length > 0
          ? `Nothing urgent. ${attention.length} item${attention.length === 1 ? '' : 's'} worth a look.`
          : `Nothing needs you. ${reachable} of ${functions.length} functions are within your authority.`,
  };
}

/** The seven functions and what each is for, so a client never hardcodes them. */
export function centreCatalogue(): Array<{ id: CentreFunctionId; label: string; what: string }> {
  return FUNCTIONS.map((fn) => ({ id: fn.id, label: fn.label, what: fn.what }));
}
