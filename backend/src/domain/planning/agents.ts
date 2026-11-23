import { expertBriefing } from '../../ai/expertise.ts';
import { SOURCE_MATERIAL_RULE } from '../../ai/sourcematerial.ts';
import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { registerEvidence, runAI, write, type EngineContext } from '../../engines/context.ts';
import { packText } from '../../evidence/pipeline.ts';
import { applicationOf, requirements, updateRequirement } from './applications.ts';
import { consentOf, recordCondition, TRIGGERS } from './consents.ts';
import { gateRegister } from './gates.ts';
import {
  evaluations,
  guard,
  planningChanged,
  proposals,
  recordProposal,
  recordSiteFact,
  recordSiteVersion,
  siteFacts,
  siteVersions,
  states,
  text,
} from './planning.ts';
import { DEVELOPMENT_CATEGORIES, isCategory, SITE_FACTS, type SiteFactKey } from './rules.ts';
import { studies, updateStudy } from './studies.ts';

/**
 * The planning agents: the AI does the reading, the drafting and the
 * legwork; a person decides.
 *
 * Six agents, each a reasoning run on the CONSENT engine, each filing
 * **proposals** — never the record itself:
 *
 * - **Intake** reads the planning need as somebody writes it ("a 2-form-entry
 *   primary school on 1.8 ha, temporary classrooms for 3 years") and proposes
 *   the site area and the structured proposal.
 * - **Site facts** reads the planning documents on the project — flood map
 *   extracts, desk studies, surveys, the authority's letters — and proposes
 *   each fact the rules read, quoting the passage it came from.
 * - **Conditions** reads an issued decision notice and proposes every
 *   condition word for word, with its trigger and phases.
 * - **Study scopes** drafts the brief for each study the application needs.
 * - **Statement** drafts the planning statement from the record.
 * - **Next actions** reads the gates, requirements and studies and proposes who
 *   does what by when.
 *
 * A quote that is not in the document is dropped in code before anybody sees
 * it. Accepting a proposal runs the ordinary command **as the person
 * accepting it**, under their own permissions — so every authoritative act,
 * every gate and every second-person check stays human. The agents never
 * approve anything.
 */

export const AGENT_KINDS = ['PROPOSAL', 'SITE_FACT', 'CONDITION', 'STUDY_SCOPE', 'STATEMENT', 'ASSIGNMENT'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export type AgentProposal = {
  id: string;
  kind: AgentKind;
  /** What the agent was asked to do, so the screen can group a run's proposals. */
  runId: string;
  summary: string;
  payload: Record<string, unknown>;
  /** The passage it came from, where it came from a document. */
  citation?: { document: string; quote: string };
  status: 'PROPOSED' | 'ACCEPTED' | 'REJECTED';
  proposedAt: string;
  requestedBy: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
  /** The record accepting it created or changed. */
  result?: { refType: string; refId: string };
};

export const agentProposals = (ctx: EngineContext): AgentProposal[] => states<AgentProposal>(ctx, 'PlanningAgentProposal');

const normalise = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

const MODEL_REQUIRED = {
  code: 'PLANNING_AGENT_NEEDS_A_MODEL',
  message: 'The planning agents need a reasoning model; the local stand-in cannot read or draft planning work. Configure a provider cleared for this data.',
};

/** One run's proposals, filed as the agent's writes. */
function proposalWrite(ctx: EngineContext, runId: string, kind: AgentKind, summary: string, payload: Record<string, unknown>, citation?: AgentProposal['citation']) {
  const proposal: AgentProposal = {
    id: ulid(),
    kind,
    runId,
    summary,
    payload,
    ...(citation ? { citation } : {}),
    status: 'PROPOSED',
    proposedAt: new Date().toISOString(),
    requestedBy: ctx.auth.actorId,
  };
  return { eventType: 'PLANNING_AGENT_PROPOSED', entity: { refType: 'PlanningAgentProposal', refId: proposal.id }, nextState: proposal as unknown as Record<string, unknown> };
}

export type AgentRun = { runId: string; proposed: number; dropped: number; provider: string; modelClass?: string };

// =============================================================================
// Planning documents
// =============================================================================

/** File a planning document; its bytes follow, and it is scanned and read on arrival. */
export function recordPlanningDocument(ctx: EngineContext, input: { hash: string; filename: string }): { evidenceId: string } {
  guard(ctx, 'C');
  const filename = text(input.filename, 'filename', 1, 'Name the document.');
  if (!/^[a-f0-9]{64}$/i.test(String(input.hash ?? '').replace(/^sha256:/, ''))) {
    throw new DomainError('DOCUMENT_HASH', 'The document is named by its SHA-256 hash.', 422, [{ field: 'hash', message: 'sha-256' }]);
  }
  const evidence = registerEvidence(ctx, { type: 'PLANNING_DOCUMENT', hash: input.hash, description: `Planning document: ${filename}`, linkedEntities: [] });
  return { evidenceId: evidence.refId };
}

/** The planning documents on the project, with how much of each could be read. */
export function planningDocuments(ctx: EngineContext): Array<{ ingestionId: string; filename: string; status: string; characters: number }> {
  const hashes = new Set(
    ctx.ledger
      .list(ctx.projectId, 'EvidenceItem')
      .filter((record) => record.state.type === 'PLANNING_DOCUMENT')
      .map((record) => String(record.state.hash)),
  );
  const files = ctx.ledger.list(ctx.projectId, 'IngestedFile').filter((record) => hashes.has(String(record.state.hash)));
  const read = packText(ctx, { only: files.map((record) => record.refId), purpose: 'PLANNING' });
  return files.map((record) => ({
    ingestionId: record.refId,
    filename: String(record.state.filename ?? record.refId),
    status: String(record.state.status),
    characters: read.files.find((file) => file.ingestionId === record.refId)?.characters ?? 0,
  }));
}

function documentsText(ctx: EngineContext, only?: string[]): { text: string; names: Map<string, string> } {
  const documents = planningDocuments(ctx).filter((entry) => entry.status !== 'QUARANTINED' && entry.characters > 0 && (!only || only.includes(entry.ingestionId)));
  if (documents.length === 0) {
    throw new DomainError('NO_PLANNING_DOCUMENTS', 'There is no readable planning document on this project. Upload the documents first.', 409);
  }
  const read = packText(ctx, { only: documents.map((entry) => entry.ingestionId), maxCharacters: 150_000, purpose: 'PLANNING' });
  return { text: read.text, names: new Map(documents.map((entry) => [entry.ingestionId, entry.filename])) };
}

// =============================================================================
// 1. Intake: the need in words → a proposal
// =============================================================================

export async function runIntake(ctx: EngineContext, input: { need: string }): Promise<AgentRun> {
  guard(ctx, 'C');
  const need = text(input.need, 'need', 10, 'Describe what is to be built and where, in a sentence or two.');
  const runId = ulid();
  const site = siteVersions(ctx).at(-1);
  let proposed = 0;
  let dropped = 0;
  const categories = Object.entries(DEVELOPMENT_CATEGORIES).map(([key, entry]) => `${key} (${entry.label})`).join('; ');
  const result = await runAI(ctx, {
    engine: 'CONSENT',
    taskType: 'planning_intake',
    capability: 'REASONING',
    inputRefs: site ? [{ refType: 'PlanningSiteVersion', refId: site.id }] : [],
    requireModel: MODEL_REQUIRED,
    request: {
      task:
        `${expertBriefing('DEVELOPMENT_MANAGER', { stage: 1 })} ` +
        'Turn this planning need into a structured proposal. Choose the category that fits from the list. Give only numbers the ' +
        'description states or that follow arithmetically from it (hectares to square metres); leave anything else null rather than ' +
        'estimating it. Say whether a full or outline application suits, and list the assumptions you made and the questions a planner ' +
        `must answer before applying. Categories: ${categories}.`,
      payload: { need, siteAlreadyRecorded: site ? { areaM2: site.confirmedAreaM2 ?? site.calculatedAreaM2, authority: site.authority.name } : null },
      responseSchema: {
        type: 'object',
        properties: {
          scenarioName: { type: 'string' },
          category: { type: 'string' },
          route: { type: 'string', enum: ['full', 'outline'] },
          siteAreaHa: { type: ['number', 'null'] },
          authority: { type: ['string', 'null'] },
          dwellings: { type: ['integer', 'null'] },
          floorspaceM2: { type: ['number', 'null'] },
          capacityCount: { type: ['integer', 'null'] },
          capacityUnit: { type: ['string', 'null'] },
          temporaryMonths: { type: ['number', 'null'] },
          capacityMW: { type: ['number', 'null'] },
          assumptions: { type: 'array', items: { type: 'string' } },
          questions: { type: 'array', items: { type: 'string' } },
        },
        required: ['scenarioName', 'category', 'route', 'assumptions', 'questions'],
      },
    },
    toWrites: (output) => {
      const category = String(output.category ?? '');
      const route = output.route === 'outline' ? 'outline' : 'full';
      const positive = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);
      if (!isCategory(category) || !String(output.scenarioName ?? '').trim()) {
        dropped += 1;
        return [];
      }
      const areaHa = positive(output.siteAreaHa);
      const payload: Record<string, unknown> = {
        need,
        scenarioName: String(output.scenarioName).trim().slice(0, 120),
        category,
        route,
        dwellings: category === 'RESIDENTIAL' || category === 'MIXED' ? (Number.isInteger(output.dwellings) && (output.dwellings as number) > 0 ? output.dwellings : null) : null,
        floorspaceM2: positive(output.floorspaceM2),
        capacityUnits: Number.isInteger(output.capacityCount) && (output.capacityCount as number) > 0 && String(output.capacityUnit ?? '').trim() ? { count: output.capacityCount, unit: String(output.capacityUnit).trim() } : null,
        temporaryMonths: positive(output.temporaryMonths),
        capacityMW: positive(output.capacityMW),
        assumptions: ((output.assumptions as unknown[]) ?? []).map(String).filter(Boolean).slice(0, 20),
        questions: ((output.questions as unknown[]) ?? []).map(String).filter(Boolean).slice(0, 20),
        ...(!site && areaHa ? { site: { areaHa, authority: String(output.authority ?? '').trim() || 'To be confirmed' } } : {}),
      };
      proposed += 1;
      return [proposalWrite(ctx, runId, 'PROPOSAL', `${payload.scenarioName}: ${DEVELOPMENT_CATEGORIES[category].label.toLowerCase()}, ${route}`, payload, { document: 'The need as written', quote: need })];
    },
  });
  return { runId, proposed, dropped, provider: result.provider, ...(result.modelClass ? { modelClass: result.modelClass } : {}) };
}

// =============================================================================
// 2. Site facts from the planning documents
// =============================================================================

export async function readSiteFacts(ctx: EngineContext, input: { ingestionIds?: string[] }): Promise<AgentRun> {
  guard(ctx, 'C');
  const { text: corpus, names } = documentsText(ctx, input.ingestionIds);
  const haystack = normalise(corpus);
  const runId = ulid();
  let proposed = 0;
  let dropped = 0;
  const known = siteFacts(ctx);
  const result = await runAI(ctx, {
    engine: 'CONSENT',
    taskType: 'planning_site_facts',
    capability: 'REASONING',
    inputRefs: [...names.keys()].map((refId) => ({ refType: 'IngestedFile', refId })),
    requireModel: MODEL_REQUIRED,
    request: {
      task:
        `${expertBriefing('DEVELOPMENT_MANAGER', { stage: 1 })} ${SOURCE_MATERIAL_RULE} ` +
        'From these planning documents, find each of the listed site facts the documents state. For each, give the value from its ' +
        'allowed list, the document it is in, and the sentence that states it word for word. Report only what a document states; a ' +
        'fact the documents do not state is left out, never inferred — a blank map is not Flood Zone 1.',
      payload: {
        facts: Object.fromEntries(Object.entries(SITE_FACTS).map(([key, entry]) => [key, { label: entry.label, values: entry.values }])),
        documents: corpus,
      },
      responseSchema: {
        type: 'object',
        properties: {
          facts: {
            type: 'array',
            items: {
              type: 'object',
              properties: { key: { type: 'string' }, value: { type: 'string' }, document: { type: 'string' }, quote: { type: 'string' } },
              required: ['key', 'value', 'document', 'quote'],
            },
          },
        },
        required: ['facts'],
      },
    },
    toWrites: (output) => {
      const writes = [];
      for (const raw of (output.facts as Array<Record<string, unknown>> | undefined) ?? []) {
        const key = String(raw.key ?? '');
        const value = String(raw.value ?? '');
        const quote = String(raw.quote ?? '').trim();
        const allowed = key in SITE_FACTS ? (SITE_FACTS[key as SiteFactKey].values as readonly string[]) : [];
        // The grounding check: a value outside the list, or a quote not in the documents, is not a finding.
        if (!allowed.includes(value) || quote.length < 8 || !haystack.includes(normalise(quote))) {
          dropped += 1;
          continue;
        }
        const label = SITE_FACTS[key as SiteFactKey].label;
        const already = known[key as SiteFactKey];
        proposed += 1;
        writes.push(
          proposalWrite(ctx, runId, 'SITE_FACT', `${label}: ${value}${already && already.value !== value ? ` (recorded now: ${already.value})` : ''}`, { key, value }, {
            document: String(raw.document ?? 'Planning documents').slice(0, 200),
            quote: quote.slice(0, 1000),
          }),
        );
      }
      return writes;
    },
  });
  return { runId, proposed, dropped, provider: result.provider, ...(result.modelClass ? { modelClass: result.modelClass } : {}) };
}

// =============================================================================
// 3. Conditions from the decision notice
// =============================================================================

export async function readConditions(ctx: EngineContext, input: { consentId: string; ingestionId: string }): Promise<AgentRun> {
  guard(ctx, 'C');
  const consent = consentOf(ctx, input.consentId);
  const { text: corpus, names } = documentsText(ctx, [input.ingestionId]);
  const haystack = normalise(corpus);
  const runId = ulid();
  let proposed = 0;
  let dropped = 0;
  const result = await runAI(ctx, {
    engine: 'CONSENT',
    taskType: 'planning_conditions',
    capability: 'REASONING',
    inputRefs: [{ refType: 'IngestedFile', refId: input.ingestionId }, { refType: 'PlanningConsent', refId: consent.id }],
    requireModel: MODEL_REQUIRED,
    request: {
      task:
        `${expertBriefing('DEVELOPMENT_MANAGER', { stage: 4 })} ${SOURCE_MATERIAL_RULE} ` +
        'This is a planning decision notice. List every numbered condition exactly as worded — word for word, nothing added or ' +
        'tidied — with its number, a plain statement of what it requires, its trigger, any phases it is limited to, and for a ' +
        `bespoke trigger the words that set it. Triggers: ${TRIGGERS.join(', ')}. Phases of this permission: ${consent.phases.join(', ')}.`,
      payload: { notice: corpus },
      responseSchema: {
        type: 'object',
        properties: {
          conditions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                number: { type: 'string' },
                wording: { type: 'string' },
                interpretation: { type: 'string' },
                trigger: { type: 'string' },
                triggerText: { type: ['string', 'null'] },
                phases: { type: 'array', items: { type: 'string' } },
              },
              required: ['number', 'wording', 'interpretation', 'trigger'],
            },
          },
        },
        required: ['conditions'],
      },
    },
    toWrites: (output) => {
      const writes = [];
      for (const raw of (output.conditions as Array<Record<string, unknown>> | undefined) ?? []) {
        const wording = String(raw.wording ?? '').trim();
        const trigger = String(raw.trigger ?? '');
        if (wording.length < 10 || !haystack.includes(normalise(wording)) || !(TRIGGERS as readonly string[]).includes(trigger)) {
          dropped += 1;
          continue;
        }
        const phases = ((raw.phases as unknown[]) ?? []).map(String).filter((phase) => consent.phases.includes(phase));
        proposed += 1;
        writes.push(
          proposalWrite(
            ctx,
            runId,
            'CONDITION',
            `${consent.reference} condition ${String(raw.number)}: ${String(raw.interpretation ?? '').slice(0, 160)}`,
            {
              consentId: consent.id,
              number: String(raw.number ?? '').slice(0, 20),
              wording,
              interpretation: String(raw.interpretation ?? '').slice(0, 2000),
              trigger,
              ...(raw.triggerText ? { triggerText: String(raw.triggerText).slice(0, 1000) } : {}),
              phases,
            },
            { document: names.get(input.ingestionId) ?? 'Decision notice', quote: wording.slice(0, 1000) },
          ),
        );
      }
      return writes;
    },
  });
  return { runId, proposed, dropped, provider: result.provider, ...(result.modelClass ? { modelClass: result.modelClass } : {}) };
}

// =============================================================================
// 4. Study scopes, 5. the planning statement, 6. next actions
// =============================================================================

function recordFor(ctx: EngineContext, applicationId: string) {
  const application = applicationOf(ctx, applicationId);
  const subject = application.proposalId ? proposals(ctx).find((entry) => entry.id === application.proposalId) : undefined;
  const evaluation = subject ? evaluations(ctx).filter((entry) => entry.proposalId === subject.id).at(-1) : undefined;
  const site = siteVersions(ctx).at(-1);
  return {
    application: { reference: application.reference, route: application.route, phases: application.phases, status: application.status, targetSubmissionOn: application.targetSubmissionOn ?? null },
    need: subject
      ? {
          category: DEVELOPMENT_CATEGORIES[subject.category]?.label,
          description: subject.description ?? null,
          dwellings: subject.dwellings,
          floorspaceM2: subject.createdGiaM2,
          capacity: subject.capacityUnits ?? null,
          temporaryMonths: subject.temporaryMonths ?? null,
          capacityMW: subject.capacityMW ?? null,
          assumptions: subject.assumptions,
        }
      : null,
    site: site ? { areaM2: site.confirmedAreaM2 ?? site.calculatedAreaM2, authority: site.authority.name } : null,
    facts: Object.fromEntries(Object.values(siteFacts(ctx)).map((fact) => [fact!.key, { value: fact!.value, source: fact!.source }])),
    findings: (evaluation?.findings ?? []).map((finding) => ({ code: finding.code, title: finding.title, status: finding.status, reason: finding.reason, evidenceNeeded: finding.evidenceNeeded, source: finding.source.title })),
  };
}

export async function draftStudyScopes(ctx: EngineContext, input: { applicationId: string }): Promise<AgentRun> {
  guard(ctx, 'C');
  const record = recordFor(ctx, input.applicationId);
  const open = studies(ctx, input.applicationId).filter((study) => study.applicability !== 'NOT_REQUIRED' && !study.scope);
  if (open.length === 0) throw new DomainError('NO_STUDIES_TO_SCOPE', 'Every study is either scoped or ruled out; plan the studies first.', 409);
  const runId = ulid();
  let proposed = 0;
  let dropped = 0;
  const ids = new Set(open.map((study) => study.id));
  const result = await runAI(ctx, {
    engine: 'CONSENT',
    taskType: 'planning_study_scopes',
    capability: 'REASONING',
    inputRefs: open.map((study) => ({ refType: 'PlanningStudy', refId: study.id })),
    requireModel: MODEL_REQUIRED,
    request: {
      task:
        `${expertBriefing('DEVELOPMENT_MANAGER', { stage: 2 })} ` +
        'Draft the brief a consultant would be appointed on for each study: the questions it must answer for this site and need, the ' +
        'survey work and any seasonal timing, the outputs the planning application needs, and what it depends on. Ground each brief in ' +
        'the findings and facts given; say where a fact is unknown rather than assume it.',
      payload: { ...record, studies: open.map((study) => ({ id: study.id, title: study.title, applicability: study.applicability, basis: study.basis })) },
      responseSchema: {
        type: 'object',
        properties: { scopes: { type: 'array', items: { type: 'object', properties: { studyId: { type: 'string' }, scope: { type: 'string' } }, required: ['studyId', 'scope'] } } },
        required: ['scopes'],
      },
    },
    toWrites: (output) => {
      const writes = [];
      for (const raw of (output.scopes as Array<Record<string, unknown>> | undefined) ?? []) {
        const studyId = String(raw.studyId ?? '');
        const scope = String(raw.scope ?? '').trim();
        if (!ids.has(studyId) || scope.length < 40) {
          dropped += 1;
          continue;
        }
        const study = open.find((entry) => entry.id === studyId)!;
        proposed += 1;
        writes.push(proposalWrite(ctx, runId, 'STUDY_SCOPE', `Brief for ${study.title}`, { studyId, scope: scope.slice(0, 8000) }));
      }
      return writes;
    },
  });
  return { runId, proposed, dropped, provider: result.provider, ...(result.modelClass ? { modelClass: result.modelClass } : {}) };
}

export async function draftStatement(ctx: EngineContext, input: { applicationId: string }): Promise<AgentRun> {
  guard(ctx, 'C');
  const record = recordFor(ctx, input.applicationId);
  const runId = ulid();
  let proposed = 0;
  let dropped = 0;
  const result = await runAI(ctx, {
    engine: 'CONSENT',
    taskType: 'planning_statement',
    capability: 'REASONING',
    inputRefs: [{ refType: 'PlanningApplication', refId: input.applicationId }],
    requireModel: MODEL_REQUIRED,
    request: {
      task:
        `${expertBriefing('DEVELOPMENT_MANAGER', { stage: 3 })} ` +
        'Draft the planning statement for this application in sections: the site and its context, the proposal, the planning history ' +
        'if any is recorded, the planning considerations the findings raise and how the evidence addresses each, and a conclusion. ' +
        'Write only from the record given. Where something the statement needs is unknown, write "[to be confirmed: …]" rather than ' +
        'inventing it. Cite no policy by number unless the record names it.',
      payload: record,
      responseSchema: {
        type: 'object',
        properties: { sections: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, body: { type: 'string' } }, required: ['heading', 'body'] } } },
        required: ['sections'],
      },
    },
    toWrites: (output) => {
      const sections = ((output.sections as Array<Record<string, unknown>> | undefined) ?? [])
        .map((section) => ({ heading: String(section.heading ?? '').trim().slice(0, 200), body: String(section.body ?? '').trim().slice(0, 20_000) }))
        .filter((section) => section.heading && section.body.length >= 20);
      if (sections.length === 0) {
        dropped += 1;
        return [];
      }
      proposed += 1;
      return [proposalWrite(ctx, runId, 'STATEMENT', `Planning statement for ${record.application.reference}: ${sections.length} sections`, { applicationId: input.applicationId, sections })];
    },
  });
  return { runId, proposed, dropped, provider: result.provider, ...(result.modelClass ? { modelClass: result.modelClass } : {}) };
}

export async function adviseNextActions(ctx: EngineContext, input: { applicationId: string }): Promise<AgentRun> {
  guard(ctx, 'C');
  const record = recordFor(ctx, input.applicationId);
  const gates = gateRegister(ctx).applications.find((entry) => entry.applicationId === input.applicationId)?.gates ?? [];
  const open = requirements(ctx, input.applicationId).filter((entry) => !['ACCEPTED', 'NOT_APPLICABLE'].includes(entry.delivery));
  if (open.length === 0) throw new DomainError('NOTHING_OPEN', 'Every requirement of this application is accepted or ruled out.', 409);
  const ids = new Set(open.map((entry) => entry.id));
  const runId = ulid();
  let proposed = 0;
  let dropped = 0;
  const today = new Date().toISOString().slice(0, 10);
  const result = await runAI(ctx, {
    engine: 'CONSENT',
    taskType: 'planning_next_actions',
    capability: 'REASONING',
    inputRefs: [{ refType: 'PlanningApplication', refId: input.applicationId }],
    requireModel: MODEL_REQUIRED,
    request: {
      task:
        `${expertBriefing('DEVELOPMENT_MANAGER', { stage: 2 })} ` +
        'Plan the open requirements: for each, the role that should own it (planning lead, consultant discipline, commercial lead, legal) ' +
        `and the date it is needed by to meet the target submission, working back from that date; today is ${today}. Explain each in one sentence.`,
      payload: { ...record, gates: gates.map((gate) => ({ gate: gate.gate, status: gate.status, blockers: gate.blockers.map((blocker) => blocker.reason) })), open: open.map((entry) => ({ id: entry.id, title: entry.title, gate: entry.gate, owner: entry.owner ?? null, dueOn: entry.dueOn ?? null })) },
      responseSchema: {
        type: 'object',
        properties: { actions: { type: 'array', items: { type: 'object', properties: { requirementId: { type: 'string' }, owner: { type: 'string' }, dueOn: { type: 'string' }, why: { type: 'string' } }, required: ['requirementId', 'owner', 'dueOn', 'why'] } } },
        required: ['actions'],
      },
    },
    toWrites: (output) => {
      const writes = [];
      for (const raw of (output.actions as Array<Record<string, unknown>> | undefined) ?? []) {
        const requirementId = String(raw.requirementId ?? '');
        const dueOn = String(raw.dueOn ?? '');
        const owner = String(raw.owner ?? '').trim();
        if (!ids.has(requirementId) || !/^\d{4}-\d{2}-\d{2}$/.test(dueOn) || Number.isNaN(Date.parse(`${dueOn}T00:00:00Z`)) || owner.length < 2) {
          dropped += 1;
          continue;
        }
        const requirement = open.find((entry) => entry.id === requirementId)!;
        proposed += 1;
        writes.push(proposalWrite(ctx, runId, 'ASSIGNMENT', `${requirement.title} → ${owner} by ${dueOn}`, { requirementId, owner: owner.slice(0, 200), dueOn, why: String(raw.why ?? '').slice(0, 500) }));
      }
      return writes;
    },
  });
  return { runId, proposed, dropped, provider: result.provider, ...(result.modelClass ? { modelClass: result.modelClass } : {}) };
}

// =============================================================================
// Deciding a proposal: the ordinary command, as the person accepting it
// =============================================================================

export function decideProposal(ctx: EngineContext, id: string, input: { decision: string; note?: string }): AgentProposal {
  guard(ctx, 'U');
  const proposal = agentProposals(ctx).find((entry) => entry.id === id);
  if (!proposal) throw new DomainError('AGENT_PROPOSAL_NOT_FOUND', 'No such proposal on this project.', 404);
  if (proposal.status !== 'PROPOSED') throw new DomainError('AGENT_PROPOSAL_DECIDED', `That proposal was already ${proposal.status.toLowerCase()}.`, 409);
  if (input.decision !== 'ACCEPT' && input.decision !== 'REJECT') throw new DomainError('AGENT_DECISION', 'Accept or reject it.', 422, [{ field: 'decision', message: 'ACCEPT or REJECT' }]);
  let result: AgentProposal['result'];
  if (input.decision === 'ACCEPT') {
    const p = proposal.payload;
    switch (proposal.kind) {
      case 'PROPOSAL': {
        let site = siteVersions(ctx).at(-1);
        const stated = p.site as { areaHa: number; authority: string } | undefined;
        if (!site && stated) {
          site = recordSiteVersion(ctx, {
            confirmedAreaM2: Math.round(stated.areaHa * 10_000 * 100) / 100,
            authority: { name: stated.authority.length >= 3 ? stated.authority : 'To be confirmed', confirmed: false },
            boundarySource: `Stated in the planning need: “${String(p.need).slice(0, 240)}”`,
          });
        }
        if (!site) throw new DomainError('SITE_FIRST', 'Record the site — its area at least — before accepting a proposal.', 409);
        const recorded = recordProposal(ctx, {
          siteVersionId: site.id,
          scenarioName: String(p.scenarioName),
          route: String(p.route),
          category: String(p.category),
          description: String(p.need),
          dwellingCount: (p.dwellings as number | null) ?? null,
          createdGiaM2: (p.floorspaceM2 as number | null) ?? null,
          temporaryMonths: (p.temporaryMonths as number | null) ?? null,
          capacityMW: (p.capacityMW as number | null) ?? null,
          capacityUnits: (p.capacityUnits as { count: number; unit: string } | null) ?? null,
          assumptions: [...((p.assumptions as string[]) ?? []), ...((p.questions as string[]) ?? []).map((question) => `To answer: ${question}`)],
        });
        result = { refType: 'PlanningProposal', refId: recorded.id };
        break;
      }
      case 'SITE_FACT': {
        recordSiteFact(ctx, { key: String(p.key), value: String(p.value), source: `${proposal.citation!.document}: “${proposal.citation!.quote.slice(0, 400)}”`, note: 'Read by the planning agent; accepted by a person' });
        result = { refType: 'PlanningSiteFact', refId: `${ctx.projectId}-fact-${String(p.key)}` };
        break;
      }
      case 'CONDITION': {
        const condition = recordCondition(ctx, String(p.consentId), {
          number: String(p.number),
          wording: String(p.wording),
          interpretation: String(p.interpretation),
          trigger: String(p.trigger),
          ...(p.triggerText ? { triggerText: String(p.triggerText) } : {}),
          phases: (p.phases as string[]) ?? [],
        });
        result = { refType: 'PlanningCondition', refId: condition.id };
        break;
      }
      case 'STUDY_SCOPE': {
        updateStudy(ctx, String(p.studyId), { scope: String(p.scope) });
        result = { refType: 'PlanningStudy', refId: String(p.studyId) };
        break;
      }
      case 'ASSIGNMENT': {
        updateRequirement(ctx, String(p.requirementId), { owner: String(p.owner), dueOn: String(p.dueOn) });
        result = { refType: 'PlanningRequirement', refId: String(p.requirementId) };
        break;
      }
      case 'STATEMENT':
        // The draft itself is the product: accepted, it is downloaded and finished by a person.
        result = { refType: 'PlanningAgentProposal', refId: proposal.id };
        break;
    }
  }
  const next: AgentProposal = {
    ...proposal,
    status: input.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED',
    decidedBy: ctx.auth.actorId,
    decidedAt: new Date().toISOString(),
    ...(input.note?.trim() ? { decisionNote: input.note.trim() } : {}),
    ...(result ? { result } : {}),
  };
  write(ctx, { eventType: 'PLANNING_AGENT_PROPOSAL_DECIDED', entity: { refType: 'PlanningAgentProposal', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${proposal.summary} — ${next.status.toLowerCase()}` });
  planningChanged(ctx);
  return next;
}

/** How much of the planning work the agents carried: proposals made, accepted and the records they produced. */
export function agentShare(ctx: EngineContext): { proposed: number; accepted: number; rejected: number; pending: number; byKind: Record<string, { proposed: number; accepted: number }> } {
  const all = agentProposals(ctx);
  const byKind: Record<string, { proposed: number; accepted: number }> = {};
  for (const proposal of all) {
    byKind[proposal.kind] ??= { proposed: 0, accepted: 0 };
    byKind[proposal.kind]!.proposed += 1;
    if (proposal.status === 'ACCEPTED') byKind[proposal.kind]!.accepted += 1;
  }
  return {
    proposed: all.length,
    accepted: all.filter((proposal) => proposal.status === 'ACCEPTED').length,
    rejected: all.filter((proposal) => proposal.status === 'REJECTED').length,
    pending: all.filter((proposal) => proposal.status === 'PROPOSED').length,
    byKind,
  };
}
