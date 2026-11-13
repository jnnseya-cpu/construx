import { authorise, type EngineContext } from '../engines/context.ts';
import { liveProjects } from './structure.ts';
import type { BidFlow, FlowState, FlowStep } from './bidflow.ts';

/**
 * The whole guided walkthrough for one workspace, from an empty account to a
 * won job — the one thing to do next, wherever the person is standing.
 *
 * `bidFlow` already answers "what happens now" for a job that exists. But it is
 * a map of one project, and the person who most needs a map has no project yet:
 * a brand-new subscriber lands on a platform with no company facts and no job,
 * and `bidFlow` cannot speak until both exist. The console then showed them
 * nothing at all — the one state where "what do I do now?" is the only question
 * they have.
 *
 * This wraps `bidFlow` rather than restating it. Two stages come first, and
 * they are facts about the tenancy, not the project: is the company's own
 * record filled in, and is there a job open to work on. Once a job is open its
 * `bidFlow` steps are folded in unchanged, so there is still one implementation
 * of the pricing-and-submission road and only one thing to drift. The journey
 * adds the stretch of road before that road begins.
 *
 * Computed here for the same reason `bidFlow` is: the browser holds no copy of
 * "what happens now", so the strip that shows it on every screen cannot
 * disagree with the record it is drawn from.
 */

export type JourneyGroup = 'SETUP' | 'WIN';

export type JourneyStage = {
  id: string;
  title: string;
  state: FlowState;
  detail: string;
  next?: string;
  /** The button to press, in the words printed on it. */
  door?: string;
  /** The console command the door opens, where the step's own screen carries one. */
  command?: string;
  /** The screen that takes the action. */
  screen: string;
  /** Which stretch of the road this belongs to: setting up, or winning the job. */
  group: JourneyGroup;
};

export type GuidedJourney = {
  stages: JourneyStage[];
  /** The one thing to do next, across the whole journey, or null when nothing is outstanding. */
  nowDo: JourneyStage | null;
  summary: string;
  why: string;
  hasProfile: boolean;
  hasProject: boolean;
  projectId: string | null;
  /** The road the open job is on, or null when no job is open. */
  road: BidFlow['road'] | null;
};

/**
 * @param ctx        A tenant (governance) context — the setup stages are tenancy facts.
 * @param projectFlow The open job's flow, computed by the route against that project's
 *                    own context, or null where no job is open or its flow is unreadable.
 * @param projectId  The open job, carried through so the strip can key its reads to it.
 */
export function guidedJourney(
  ctx: EngineContext,
  {
    projectFlow,
    projectId,
    brandingConfigured,
  }: {
    projectFlow: BidFlow | null;
    projectId: string | null;
    /**
     * Whether the company's document identity is set. Every export refuses
     * without it ("Client branding must be configured"), so a new subscriber
     * met that refusal on the return date, downloading their submission. Left
     * undefined by a caller that cannot tell, and the stage is then not shown.
     */
    brandingConfigured?: boolean;
  },
): GuidedJourney {
  authorise(ctx, 'PROJECT_SETUP', 'R');

  const hasProfile = Boolean(ctx.ledger.get({ refType: 'CompanyProfile', refId: `${ctx.tenantId}-profile` }));
  const projects = liveProjects(ctx.ledger, ctx.tenantId);
  const hasProject = projects.length > 0;

  const stages: JourneyStage[] = [];

  stages.push(
    hasProfile
      ? {
          id: 'COMPANY_FACTS',
          title: "Record your company's facts",
          state: 'DONE',
          detail:
            'Your legal name, turnover, insurances, accreditations and past projects are on file — every bid is set against them.',
          screen: 'pipeline',
          group: 'SETUP',
        }
      : {
          id: 'COMPANY_FACTS',
          title: "Record your company's facts",
          state: 'READY',
          detail: "Nothing is recorded about your business yet, so a buyer's requirements have nothing to be set against.",
          next:
            'Most of a compliance matrix is filled from these facts; what the platform cannot know, it leaves blank for you. This is done once, not per job.',
          door: "Record the company's facts",
          screen: 'pipeline',
          group: 'SETUP',
        },
  );

  if (brandingConfigured !== undefined) {
    stages.push(
      brandingConfigured
        ? {
            id: 'BRANDING',
            title: 'Set how your documents are branded',
            state: 'DONE',
            detail: 'Your company name and legal detail are on file, so quotations and submissions can be downloaded.',
            screen: 'enterprise',
            group: 'SETUP',
          }
        : {
            id: 'BRANDING',
            title: 'Set how your documents are branded',
            state: 'READY',
            detail:
              'No document identity is set, so no quotation, submission or programme can be downloaded yet — the export refuses until it is.',
            next: 'Your company name, address and registration number go on every document you send a buyer. This is done once.',
            door: 'Company brand',
            screen: 'enterprise',
            group: 'SETUP',
          },
    );
  }

  stages.push(
    hasProject
      ? {
          id: 'FIRST_JOB',
          title: 'Open the job you are working on',
          state: 'DONE',
          detail: `${projects.length} job${projects.length === 1 ? '' : 's'} on your workspace.`,
          screen: 'enterprise',
          group: 'SETUP',
        }
      : {
          id: 'FIRST_JOB',
          title: 'Start your first job',
          state: 'READY',
          detail: 'There is no job on your workspace yet — a job is where the invitation, the drawings, the price and the submission all live.',
          next: 'A job is created under an enterprise and a portfolio, and Enterprise & Portfolio takes all three in order.',
          door: 'Go to Enterprise & Portfolio',
          screen: 'enterprise',
          group: 'SETUP',
        },
  );

  // The job's own road, folded in unchanged. A FlowStep's screen is one of the
  // four flow screens; a JourneyStage's is any screen, so it widens cleanly.
  if (projectFlow) {
    for (const step of projectFlow.steps) {
      const stage: JourneyStage = {
        id: step.id,
        title: step.title,
        state: step.state,
        detail: step.detail,
        screen: step.screen,
        group: 'WIN',
        ...(step.next === undefined ? {} : { next: step.next }),
        ...(step.door === undefined ? {} : { door: step.door }),
        ...(step.command === undefined ? {} : { command: step.command }),
      };
      stages.push(stage);
    }
  }

  // The next thing to do is the first unfinished setup stage, and only once both
  // are done does the job's own next step take over. Setting the company up is
  // the prerequisite of the matrix, so it rightly comes before any bid step even
  // when a job is already open.
  const setupNext = stages.find((stage) => stage.group === 'SETUP' && stage.state === 'READY');
  const fromFlow: JourneyStage | null = projectFlow?.nowDo ? toStage(projectFlow.nowDo) : null;
  const nowDo: JourneyStage | null = setupNext ?? fromFlow ?? null;

  const needed = stages.filter((stage) => stage.state !== 'NOT_NEEDED').length;
  const done = stages.filter((stage) => stage.state === 'DONE').length;

  return {
    stages,
    nowDo,
    summary: nowDo
      ? `${done} of ${needed} done. Next: ${nowDo.title.toLowerCase()}.`
      : `${done} of ${needed} done. Nothing is outstanding — ${hasProject ? 'this job is ready to go out.' : 'set a job up to begin.'}`,
    why: !hasProfile
      ? 'Your company is not set up yet, so start there — every bid is built on these facts.'
      : !hasProject
        ? 'Your company is on file. Open a job and the road from enquiry to a priced, submitted bid appears here.'
        : (projectFlow?.why ?? 'This job is set up — its next step shows here as the record fills in.'),
    hasProfile,
    hasProject,
    projectId,
    road: projectFlow?.road ?? null,
  };
}

function toStage(step: FlowStep): JourneyStage {
  return {
    id: step.id,
    title: step.title,
    state: step.state,
    detail: step.detail,
    screen: step.screen,
    group: 'WIN',
    ...(step.next === undefined ? {} : { next: step.next }),
    ...(step.door === undefined ? {} : { door: step.door }),
    ...(step.command === undefined ? {} : { command: step.command }),
  };
}
