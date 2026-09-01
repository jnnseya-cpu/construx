import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import { requireModule } from '../../identity/modules.ts';
import { TRADING_MODEL, type TradingModel } from '../integrator.ts';

/**
 * Which appointment this is, and therefore who is answerable for what.
 *
 * ETABLIX delivers the same site services under three completely different
 * appointments, and almost every argument on such a job traces back to somebody
 * assuming one of them while somebody else assumed another. Under **Advisory**
 * ETABLIX defines the service and the customer contracts every supplier. Under
 * **Management Integrator** the customer still holds the contracts but ETABLIX
 * runs the operation and administers the customer's remedies. Under **Prime
 * Service Contractor** ETABLIX holds the supply chain, pays it, and carries the
 * cash and performance exposure.
 *
 * Those are not three settings. They are three different businesses, and the
 * platform has to behave as three different products: different RACI, different
 * contract owner, different payment route, different enforcement power,
 * different invoice, different approval thresholds, and a different answer to
 * "may an agent do this unattended".
 *
 * ---
 *
 * ## What this module is not
 *
 * **It is not a second copy of `TRADING_MODEL`.** `domain/integrator.ts`
 * already holds the three models and the *commercial* consequence of each —
 * whether supplier cost passes through the account, what the cash risk is,
 * what the margin risk is. That is the settled source of truth and this module
 * imports it. What it adds is the layer `integrator.ts` deliberately does not
 * have: who contracts, who pays, who coordinates, who enforces, what the fee
 * is made of, and what has to be true before a model may be chosen at all.
 *
 * The spec writes the third model as "Prime Service Contractor" and this
 * codebase already calls it `PRINCIPAL_SERVICE_CONTRACTOR`. They are the same
 * appointment and it keeps one name: a synonym would split every query over
 * this decision in half.
 *
 * **It is not a responsibility matrix.** `domain/responsibility.ts` records who
 * carries which *obligation* on a project, package by package, and it stays the
 * place that answers that. This records which *appointment* is in force, which
 * is the thing that decides the defaults that matrix starts from.
 *
 * ## Changing the model is a transition, not a toggle
 *
 * The spec is explicit and it is the most important rule here. Once a baseline
 * exists, moving from Advisory to Prime means ETABLIX has agreed to take on a
 * supply chain, a cash exposure and a liability it did not have that morning.
 * Recording that as an edit to a field would lose the two things anybody would
 * later need: what changed, and who agreed to carry it. So a change after
 * baseline is a separate governed act, with its own event, its own approval and
 * a stated commercial basis — and it is refused outright where the new model's
 * viability gates do not pass.
 */

// --- The three appointments --------------------------------------------------

/**
 * The seven control points, and the answer under each appointment.
 *
 * Written out per model rather than derived from a rule, because there is no
 * rule: these are commercial positions negotiated into three different sets of
 * contract terms, and a formula that produced them would be a formula somebody
 * invented to avoid writing the table.
 */
export type ControlPoint = {
  id: string;
  /** The question being answered, in the words it is argued about in. */
  label: string;
  /** Why it matters — the failure that happens when it is left ambiguous. */
  matters: string;
  answers: Record<TradingModel, string>;
};

export const CONTROL_POINTS: readonly ControlPoint[] = [
  {
    id: 'SUPPLIER_CONTRACTING',
    label: 'Who holds the supplier contract',
    matters:
      'The party named on the contract is the only one who can instruct, vary or terminate it. Everything else on ' +
      'this list follows from it.',
    answers: {
      ADVISORY: 'Customer. ETABLIX writes the requirement and the customer contracts against it.',
      MANAGEMENT_INTEGRATOR: 'Customer. ETABLIX specifies, tenders and recommends; the customer signs.',
      PRINCIPAL_SERVICE_CONTRACTOR: 'ETABLIX. Every supplier is ETABLIX’s own subcontractor.',
    },
  },
  {
    id: 'SUPPLIER_PAYMENT',
    label: 'Who pays the supplier',
    matters:
      'Whoever pays carries the timing gap between paying out and being paid. That gap is what closes businesses, ' +
      'not the contract value.',
    answers: {
      ADVISORY: 'Customer, direct. No supplier cost passes through ETABLIX’s account.',
      MANAGEMENT_INTEGRATOR: 'Customer, after ETABLIX’s payment recommendation. ETABLIX values; the customer pays.',
      PRINCIPAL_SERVICE_CONTRACTOR: 'ETABLIX, under its own supplier terms, and recovers through one customer invoice.',
    },
  },
  {
    id: 'OPERATIONAL_COORDINATION',
    label: 'Who runs the operation day to day',
    matters:
      'The welfare, the buses, the cleaning and the security either have somebody coordinating them at seven in the ' +
      'morning or they do not. This is the control point most often assumed rather than appointed.',
    answers: {
      ADVISORY:
        'Customer, from handover onwards — unless ETABLIX is separately appointed for operations, which is a ' +
        'different engagement and must be stated.',
      MANAGEMENT_INTEGRATOR:
        'ETABLIX, under the customer’s contracts. It sets the daily regime, the helpdesk and the service review.',
      PRINCIPAL_SERVICE_CONTRACTOR:
        'ETABLIX, under its own contracts. The same daily regime, with the power to change it without asking.',
    },
  },
  {
    id: 'PERFORMANCE_ENFORCEMENT',
    label: 'Who enforces performance when a supplier fails',
    matters:
      'A service level nobody can enforce is a service level nobody meets. Under two of the three models ETABLIX ' +
      'cannot enforce directly and must not claim it can.',
    answers: {
      ADVISORY:
        'Not ETABLIX. It sets the requirement and recommends the mechanism; the customer is the only party who can use it.',
      MANAGEMENT_INTEGRATOR: 'ETABLIX administers the customer’s remedies under the customer’s contract.',
      PRINCIPAL_SERVICE_CONTRACTOR: 'ETABLIX, directly and contractually.',
    },
  },
  {
    id: 'COMMERCIAL_EXPOSURE',
    label: 'What ETABLIX is exposed to if it goes wrong',
    matters:
      'The difference between a professional indemnity claim and funding a supply chain out of working capital. ' +
      'They are not the same order of magnitude and should never be recorded as the same thing.',
    answers: {
      ADVISORY: 'Professional service liability only.',
      MANAGEMENT_INTEGRATOR: 'A management duty. No supplier principal risk — ETABLIX is not a party to those contracts.',
      PRINCIPAL_SERVICE_CONTRACTOR: 'Supplier default, cashflow, performance and integration exposure, in full.',
    },
  },
  {
    id: 'FEE_LOGIC',
    label: 'What ETABLIX is paid, and for what',
    matters: 'The fee has to match the exposure. A management fee against principal risk is how a business is lost.',
    answers: {
      ADVISORY: 'A fixed professional fee against defined deliverables.',
      MANAGEMENT_INTEGRATOR: 'A mobilisation fee plus a monthly management fee.',
      PRINCIPAL_SERVICE_CONTRACTOR: 'An integrated price, with allowances disclosed.',
    },
  },
  {
    id: 'INVOICE_OBJECT',
    label: 'What the customer actually receives as an invoice',
    matters:
      'Three different documents, three different approval routes, and three different things the finance team ' +
      'reconciles against.',
    answers: {
      ADVISORY: 'Professional milestones.',
      MANAGEMENT_INTEGRATOR: 'A fee invoice, alongside supplier payment recommendations the customer settles.',
      PRINCIPAL_SERVICE_CONTRACTOR: 'One customer invoice, with the supplier liabilities behind it.',
    },
  },
];

/**
 * What each appointment changes about how the platform behaves.
 *
 * Everything here is a consequence of the control points above, resolved once
 * so no screen and no command has to re-derive it.
 */
export type AppointmentProfile = {
  model: TradingModel;
  label: string;
  /** Whether ETABLIX may instruct a supplier at all. */
  mayInstructSupplier: boolean;
  /** Whether ETABLIX may enforce a service level itself, or only administer somebody else's remedy. */
  mayEnforceDirectly: boolean;
  /** Whether supplier cost is funded out of ETABLIX's account. From `TRADING_MODEL`. */
  fundsSupplierCost: boolean;
  /** Whether ETABLIX invoices the customer for supplier cost. From `TRADING_MODEL`. */
  invoicesClientForSupplierCost: boolean;
  /**
   * The highest approval class an agent may act at without a person.
   *
   * The spec's automation boundary in three letters. `A` is autonomous work
   * inside an approved baseline; `B` is prepared-then-approved; `C` is
   * human-controlled and no agent ever reaches it. Under Prime the exposure is
   * ETABLIX's own money, so the ceiling comes down: an agent may prepare a
   * supplier instruction but may not issue one.
   */
  agentCeiling: 'A' | 'B';
  /**
   * What a person must approve, and who.
   *
   * The spec's "approval thresholds", instantiated by the model rather than set
   * per project, because the threshold is a consequence of whose money it is.
   * Under Advisory ETABLIX commits nothing, so there is nothing to threshold;
   * under Management it is spending the customer's money on the customer's
   * contract, so **every** instruction goes to them; under Prime it is
   * ETABLIX's own money and its own liability, so a delegated limit is both
   * possible and necessary — a business that referred every purchase upward
   * could not run a site.
   */
  approvals: {
    /** Below this, in minor units, an ETABLIX manager may instruct alone. Zero means nothing is delegated. */
    delegatedInstructionMinor: number;
    /** Who must approve above it. */
    above: string;
    /** Acts that are never delegated whatever the figure. The spec's Class C. */
    neverDelegated: readonly string[];
  };
  /**
   * The insurance ETABLIX must evidence before it may act under this model.
   *
   * Instantiated by the appointment because the cover follows the exposure:
   * professional indemnity answers advice, and nothing else on this list is
   * needed until ETABLIX is standing behind a supply chain.
   */
  insuranceRequired: readonly string[];
  cashRisk: string;
  marginRisk: string;
  /** What ETABLIX undertakes to do, in the words the offer is made in. */
  headline: string;
  fee: string;
  undertakes: { pillar: string; detail: string }[];
  chooseWhen: string;
};

/**
 * What ETABLIX actually undertakes to do under each appointment, and when a
 * customer should choose it.
 *
 * The control points above answer *who is answerable*. These answer *what is
 * delivered*, which is the half a customer reads first and the half a delivery
 * team is measured against. Four pillars per model, in ETABLIX's own words,
 * because a scope written in the platform's words is a scope somebody has to
 * reconcile against the one in the contract.
 *
 * The "choose when" line is not marketing. It is the sentence the Model Fit
 * assessment is trying to evaluate, written out so a recommendation and the
 * offer it recommends cannot drift apart.
 */
export const MODEL_OFFER: Record<TradingModel, { headline: string; fee: string; undertakes: { pillar: string; detail: string }[]; chooseWhen: string }> = {
  ADVISORY: {
    headline: 'We define it, you buy it.',
    fee: 'Fixed professional fee',
    undertakes: [
      {
        pillar: 'Strategy',
        detail:
          'Site-services and workforce-village strategy: constraints, workforce demand, phasing, utility and logistics studies, and a recommended delivery model with its risk basis.',
      },
      {
        pillar: 'Technical requirements',
        detail:
          'Output specifications, package boundaries, the interface matrix, performance KPIs, evidence and acceptance criteria — a baseline the whole supply chain can price and deliver against.',
      },
      {
        pillar: 'Procurement documents',
        detail:
          'PQQ and ITT packs, scope sheets, pricing schedules, tender programme and contract recommendations, ready to issue.',
      },
      {
        pillar: 'Evaluation',
        detail:
          'Clarifications, technical and commercial bid normalisation, exclusion and risk review, and a defensible, auditable award recommendation.',
      },
    ],
    chooseWhen:
      'Choose Advisory when you have the procurement and operational capacity in-house, but need the strategy, specification and tender basis built to contractor standard before you commit the money.',
  },
  MANAGEMENT_INTEGRATOR: {
    headline: 'You contract, we control.',
    fee: 'Mobilisation fee plus monthly management fee',
    undertakes: [
      {
        pillar: 'Procurement',
        detail:
          'Market engagement, prequalification, controlled enquiries, evaluation and award recommendations, with contracts placed in your name on terms we help you set.',
      },
      {
        pillar: 'Coordination',
        detail:
          'One management team owns every supplier interface, mobilisation gate, readiness check and daily operating rhythm across all packages.',
      },
      {
        pillar: 'Commercial administration',
        detail:
          'Monthly valuations and payment recommendations against evidenced Earned Value, change control, cost coding and forecast reporting.',
      },
      {
        pillar: 'Performance management',
        detail:
          'KPIs, inspections, service-credit administration and supplier escalation, reported live on one CONSTRUX dashboard your leadership can open any day.',
      },
    ],
    chooseWhen:
      'Choose Management Integrator when you want direct supplier relationships and direct cash flow, but one party accountable for coordinating, administering and driving performance across the agreed site-services system. This is the core offer.',
  },
  PRINCIPAL_SERVICE_CONTRACTOR: {
    headline: 'One contract, complete service.',
    fee: 'Integrated contract price with markup and risk allowances',
    undertakes: [
      {
        pillar: 'One integrated contract',
        detail:
          'The complete site-services or workforce-village scope under a single commercial agreement with defined outputs and acceptance criteria.',
      },
      {
        pillar: 'The complete supply chain, ours',
        detail:
          'ETABLIX selects, contracts, pays and manages every specialist supplier. Supplier performance and supplier risk sit with ETABLIX, not with your team.',
      },
      {
        pillar: 'Accountability across the lifecycle',
        detail:
          'Mobilisation, daily operation, HSE interface, performance, change and complete removal, all owned by one organisation.',
      },
      {
        pillar: 'Transparent price build-up',
        detail:
          'Audited direct supplier cost plus defined allowances for management and integration, overhead, single-point-accountability risk, and a governed contingency controlled against a joint risk register — never a hidden margin.',
      },
    ],
    chooseWhen:
      'Choose Prime Service Contractor when a single contract for the whole scope is commercially justified and the funding, credit, liability and mobilisation gates are satisfied. These appointments are accepted selectively, because a partner that controls its own exposure is a partner that finishes.',
  },
};

/**
 * The five acts no appointment ever delegates.
 *
 * The specification's Class C: AI advises only, and a named authority or two
 * people decide. Held once rather than per model because they do not vary —
 * signing a contract is a human act under Advisory for the same reason it is
 * under Prime, and a per-model copy would eventually disagree with itself.
 */
const NEVER_DELEGATED = [
  'Supplier award',
  'Contract signature',
  'Safety-critical energisation or isolation',
  'Payment certification',
  'Contingency draw',
  'Termination',
  'Regulatory submission',
] as const;

const APPROVALS: Record<TradingModel, AppointmentProfile['approvals']> = {
  ADVISORY: {
    // Nothing is delegated because nothing is committed. ETABLIX under Advisory
    // does not instruct anybody, so a threshold would be a limit on an act that
    // cannot happen.
    delegatedInstructionMinor: 0,
    above: 'The customer. ETABLIX recommends and the customer instructs; there is no ETABLIX instruction to threshold.',
    neverDelegated: NEVER_DELEGATED,
  },
  MANAGEMENT_INTEGRATOR: {
    // Every instruction, because it is the customer's money on the customer's
    // contract. A delegated limit here would be ETABLIX committing somebody
    // else's funds under an authority it does not hold.
    delegatedInstructionMinor: 0,
    above:
      'The customer’s delegated authority holder. ETABLIX prepares and recommends; the customer’s own limit decides who signs it off.',
    neverDelegated: NEVER_DELEGATED,
  },
  PRINCIPAL_SERVICE_CONTRACTOR: {
    // ETABLIX's own money and own liability, so a limit is both possible and
    // necessary — a business that referred every purchase upward could not run
    // a site. The figure is a starting position recorded on the appointment,
    // not a rule: it is what the profile publishes so a screen can show what is
    // in force rather than leaving it to be assumed.
    delegatedInstructionMinor: 50_000_00,
    above: 'The ETABLIX project director, and the commercial manager jointly above £250,000.',
    neverDelegated: NEVER_DELEGATED,
  },
};

const INSURANCE_REQUIRED: Record<TradingModel, readonly string[]> = {
  ADVISORY: ['Professional indemnity'],
  MANAGEMENT_INTEGRATOR: ['Professional indemnity', 'Public liability', 'Employer’s liability'],
  PRINCIPAL_SERVICE_CONTRACTOR: [
    'Professional indemnity',
    'Public liability',
    'Employer’s liability',
    'Contract works',
    'Hired-in plant',
    'Performance bond, or a recorded decision that none is required',
  ],
};

export function profileFor(model: TradingModel): AppointmentProfile {
  const trading = TRADING_MODEL[model];
  return {
    model,
    label: trading.label,
    mayInstructSupplier: model !== 'ADVISORY',
    // The whole point of the distinction. Under Management ETABLIX runs the
    // operation and still cannot enforce: it is not a party to the contract,
    // and a platform that let it act as though it were would be manufacturing
    // an authority that does not exist.
    mayEnforceDirectly: model === 'PRINCIPAL_SERVICE_CONTRACTOR',
    fundsSupplierCost: trading.fundsSupplierCost,
    invoicesClientForSupplierCost: trading.invoicesClientForSupplierCost,
    agentCeiling: model === 'PRINCIPAL_SERVICE_CONTRACTOR' ? 'A' : 'B',
    approvals: APPROVALS[model],
    insuranceRequired: INSURANCE_REQUIRED[model],
    cashRisk: trading.cashRisk,
    marginRisk: trading.marginRisk,
    ...MODEL_OFFER[model],
  };
}

// --- The appointment record --------------------------------------------------

export type Appointment = {
  id: string;
  projectId: string;
  model: TradingModel;
  /** The legal entity ETABLIX is appointed by. Never optional — see the blocking rule. */
  contractingEntity: string;
  /** Where the money comes from. Also never optional. */
  fundingSource: string;
  /**
   * Whether a requirements baseline exists yet.
   *
   * Set by `baselineAgreed`, and the thing that turns a change of model from an
   * ordinary correction into a governed commercial transition.
   */
  baselined: boolean;
  baselinedAt?: string;
  setBy: string;
  setAt: string;
  basis: string;
  /** Every model this appointment has been under, oldest first. */
  history: readonly {
    model: TradingModel;
    from?: TradingModel;
    at: string;
    by: string;
    basis: string;
    /** Present only on a transition after baseline. */
    commercialBasis?: string;
  }[];
};

function currentAppointment(ctx: EngineContext): Appointment | undefined {
  const held = ctx.ledger.list(ctx.projectId, 'SiteServicesAppointment');
  return held.length > 0 ? (held[0]!.state as unknown as Appointment) : undefined;
}

/**
 * Appoint ETABLIX, once, at the start.
 *
 * `C` on `SITE_SERVICES` — the project director or the project manager, which
 * is who signs an appointment into existence. It is refused if one already
 * exists: a second appointment is not a correction, it is a transition, and
 * `transitionAppointment` is what records one.
 */
export function setAppointment(
  ctx: EngineContext,
  input: { model: TradingModel; contractingEntity: string; fundingSource: string; basis: string },
): Appointment {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  if (!(input.model in TRADING_MODEL)) {
    throw new DomainError('APPOINTMENT_MODEL_UNKNOWN', `${input.model} is not an appointment model`);
  }
  // Both are blocking rules from the model-fit specification, and they are
  // enforced here as well as there for the reason every gate worth having is
  // enforced at the write: an assessment can be skipped, and this cannot.
  if (!input.contractingEntity.trim()) {
    throw new DomainError(
      'APPOINTMENT_ENTITY_REQUIRED',
      'An appointment names the legal entity ETABLIX is appointed by. Without it there is nobody to enforce against and nobody to invoice.',
    );
  }
  if (!input.fundingSource.trim()) {
    throw new DomainError(
      'APPOINTMENT_FUNDING_REQUIRED',
      'An appointment names where the money comes from. Under Prime this is what ETABLIX is lending against; under the others it is who pays the suppliers.',
    );
  }
  if (!input.basis.trim()) {
    throw new DomainError('APPOINTMENT_BASIS_REQUIRED', 'Record why this model, in the words it would be defended in');
  }

  if (currentAppointment(ctx)) {
    throw new DomainError(
      'APPOINTMENT_EXISTS',
      'This project already has an appointment. Changing it is a commercial transition, not a second appointment.',
      409,
    );
  }

  const at = new Date().toISOString();
  const appointment: Appointment = {
    id: ulid(),
    projectId: ctx.projectId,
    model: input.model,
    contractingEntity: input.contractingEntity.trim(),
    fundingSource: input.fundingSource.trim(),
    baselined: false,
    setBy: ctx.auth.actorId,
    setAt: at,
    basis: input.basis.trim(),
    history: [{ model: input.model, at, by: ctx.auth.actorId, basis: input.basis.trim() }],
  };

  write(ctx, {
    eventType: 'SITE_SERVICES_APPOINTED',
    entity: { refType: 'SiteServicesAppointment', refId: appointment.id },
    nextState: appointment,
  });

  return appointment;
}

/**
 * Mark that a requirements baseline has been agreed.
 *
 * `A` on `SITE_SERVICES`. From this moment a change of model is a transition
 * rather than a correction, which is the only thing this flag decides — and the
 * reason it is a governed act rather than a date somebody types.
 */
export function baselineAgreed(ctx: EngineContext): Appointment {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const appointment = currentAppointment(ctx);
  if (!appointment) {
    throw new DomainError('APPOINTMENT_ABSENT', 'There is no appointment on this project to baseline', 404);
  }
  if (appointment.baselined) return appointment;

  const updated: Appointment = { ...appointment, baselined: true, baselinedAt: new Date().toISOString() };
  write(ctx, {
    eventType: 'SITE_SERVICES_BASELINE_AGREED',
    entity: { refType: 'SiteServicesAppointment', refId: appointment.id },
    nextState: updated,
  });
  return updated;
}

/**
 * Move to a different appointment model.
 *
 * Before baseline this is a correction and needs only the ordinary authority.
 * After baseline it is a commercial transition: ETABLIX is taking on — or
 * putting down — a supply chain, a cash exposure and a liability, and the
 * record has to carry the commercial basis on which that was agreed.
 *
 * Two things it refuses outright:
 *
 * - **A transition to the model already in force.** Not an error to swallow: it
 *   would write a transition event asserting a change that did not happen, and
 *   that event would then be indistinguishable on the register from a real one.
 * - **A transition after baseline with no commercial basis.** The whole reason
 *   this is not a settings toggle.
 */
export function transitionAppointment(
  ctx: EngineContext,
  input: { model: TradingModel; basis: string; commercialBasis?: string },
): Appointment {
  requireModule(ctx.grantedModules, 'ETABLIX');
  // `A`, not `U`. Changing the appointment changes who is liable for what, and
  // that is an approval, not an edit — the same reason a baseline is approved
  // rather than saved.
  authorise(ctx, 'SITE_SERVICES', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const appointment = currentAppointment(ctx);
  if (!appointment) {
    throw new DomainError('APPOINTMENT_ABSENT', 'There is no appointment on this project to change', 404);
  }
  if (!(input.model in TRADING_MODEL)) {
    throw new DomainError('APPOINTMENT_MODEL_UNKNOWN', `${input.model} is not an appointment model`);
  }
  if (input.model === appointment.model) {
    throw new DomainError(
      'APPOINTMENT_UNCHANGED',
      `This project is already appointed as ${TRADING_MODEL[appointment.model].label}.`,
    );
  }
  if (!input.basis.trim()) {
    throw new DomainError('APPOINTMENT_BASIS_REQUIRED', 'Record why the model is changing');
  }
  if (appointment.baselined && !input.commercialBasis?.trim()) {
    throw new DomainError(
      'APPOINTMENT_TRANSITION_UNCOMMERCIAL',
      'The baseline is agreed, so this is a commercial transition rather than a correction. Record what was agreed ' +
        'commercially — the fee change, who now holds the supplier contracts, and from when.',
    );
  }

  const at = new Date().toISOString();
  const updated: Appointment = {
    ...appointment,
    model: input.model,
    history: [
      ...appointment.history,
      {
        model: input.model,
        from: appointment.model,
        at,
        by: ctx.auth.actorId,
        basis: input.basis.trim(),
        ...(input.commercialBasis?.trim() ? { commercialBasis: input.commercialBasis.trim() } : {}),
      },
    ],
  };

  write(ctx, {
    eventType: 'SITE_SERVICES_APPOINTMENT_TRANSITIONED',
    entity: { refType: 'SiteServicesAppointment', refId: appointment.id },
    nextState: updated,
  });

  return updated;
}

export type AppointmentPosition = {
  appointment?: Appointment;
  profile?: AppointmentProfile;
  /** The seven control points, answered for the appointment in force. */
  controlPoints: { id: string; label: string; matters: string; answer: string }[];
  /** Every model, so a screen can show what the other two would have meant. */
  models: { model: TradingModel; label: string; answers: Record<string, string> }[];
  /** The most recent model-fit assessment, where one has been run. */
  assessment?: ModelFit;
};

export function appointmentPosition(ctx: EngineContext): AppointmentPosition {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const appointment = currentAppointment(ctx);
  const assessments = ctx.ledger
    .list(ctx.projectId, 'ModelFitAssessment')
    .map((record) => record.state as unknown as ModelFit)
    // Tiebroken on the id, which is a ULID and is monotonic within a
    // millisecond. Two assessments run back to back share a timestamp, and a
    // sort on the timestamp alone then returned whichever the map happened to
    // hold first — so the screen showed the older paper about half the time.
    .sort((a, b) => b.assessedAt.localeCompare(a.assessedAt) || b.id.localeCompare(a.id));

  return {
    appointment,
    profile: appointment ? profileFor(appointment.model) : undefined,
    controlPoints: appointment
      ? CONTROL_POINTS.map((point) => ({
          id: point.id,
          label: point.label,
          matters: point.matters,
          answer: point.answers[appointment.model],
        }))
      : [],
    // Shown whether or not an appointment exists. Before one is made it is the
    // comparison somebody is choosing from; after, it is what they gave up.
    models: (Object.keys(TRADING_MODEL) as TradingModel[]).map((model) => ({
      model,
      label: TRADING_MODEL[model].label,
      answers: Object.fromEntries(CONTROL_POINTS.map((point) => [point.id, point.answers[model]])),
    })),
    assessment: assessments[0],
  };
}

// --- The Model Fit agent -----------------------------------------------------

/**
 * The ten factors, and which way each one pushes.
 *
 * A coefficient per model, in the range -2..2. Positive means this factor,
 * scored high, argues *for* that appointment. The scores themselves are the
 * customer's evidence, on a 0–4 scale; the coefficients are ETABLIX's judgement
 * about what those facts mean, and they are stated here rather than buried in
 * an arithmetic expression so that a recommendation can be argued with.
 */
export const FIT_FACTORS = [
  {
    id: 'customerDeliveryCapacity',
    label: 'Customer’s own delivery capacity',
    high: 'The customer has the people to run site services themselves',
    weights: { ADVISORY: 2, MANAGEMENT_INTEGRATOR: 0, PRINCIPAL_SERVICE_CONTRACTOR: -2 },
  },
  {
    id: 'programmeUrgency',
    label: 'Programme urgency',
    high: 'Mobilisation is needed sooner than a customer-run tender can deliver',
    weights: { ADVISORY: -2, MANAGEMENT_INTEGRATOR: 1, PRINCIPAL_SERVICE_CONTRACTOR: 2 },
  },
  {
    id: 'packageCount',
    label: 'Number of separate service packages',
    high: 'Many packages, so the interface load between them is high',
    weights: { ADVISORY: -1, MANAGEMENT_INTEGRATOR: 2, PRINCIPAL_SERVICE_CONTRACTOR: 2 },
  },
  {
    id: 'customerProcurementMaturity',
    label: 'Customer’s procurement maturity',
    high: 'The customer runs competent tenders and holds its own supplier terms',
    weights: { ADVISORY: 2, MANAGEMENT_INTEGRATOR: 1, PRINCIPAL_SERVICE_CONTRACTOR: -1 },
  },
  {
    id: 'etablixCreditStrength',
    label: 'ETABLIX credit strength',
    high: 'Facilities and balance sheet can carry a supply chain between payments',
    weights: { ADVISORY: 0, MANAGEMENT_INTEGRATOR: 0, PRINCIPAL_SERVICE_CONTRACTOR: 2 },
  },
  {
    id: 'supplierCreditTerms',
    label: 'Supplier credit terms available',
    high: 'Suppliers will trade on terms long enough to bridge the customer’s payment cycle',
    weights: { ADVISORY: 0, MANAGEMENT_INTEGRATOR: 0, PRINCIPAL_SERVICE_CONTRACTOR: 2 },
  },
  {
    id: 'contractRiskTransfer',
    label: 'Risk transfer the customer is asking for',
    high: 'The customer wants performance risk carried by somebody else',
    weights: { ADVISORY: -2, MANAGEMENT_INTEGRATOR: 0, PRINCIPAL_SERVICE_CONTRACTOR: 2 },
  },
  {
    id: 'geographicSupplyDepth',
    label: 'Depth of the local supply market',
    high: 'Several credible suppliers for each package within reach of site',
    weights: { ADVISORY: 2, MANAGEMENT_INTEGRATOR: 1, PRINCIPAL_SERVICE_CONTRACTOR: -1 },
  },
  {
    id: 'operationalComplexity',
    label: 'Operational complexity',
    high: 'Shift patterns, accommodation, transport and 24-hour services running together',
    weights: { ADVISORY: -2, MANAGEMENT_INTEGRATOR: 2, PRINCIPAL_SERVICE_CONTRACTOR: 2 },
  },
  {
    id: 'singlePointAccountability',
    label: 'Single-point accountability required',
    high: 'The customer wants one party answerable for the whole site-services outcome',
    weights: { ADVISORY: -2, MANAGEMENT_INTEGRATOR: 0, PRINCIPAL_SERVICE_CONTRACTOR: 2 },
  },
] as const;

export type FitFactorId = (typeof FIT_FACTORS)[number]['id'];

/** The evidence each viability gate needs, and what it is protecting against. */
export type ViabilityEvidence = {
  /** Prime treasury gate: the credit facility available, in minor units. */
  creditLimitMinor?: number;
  /** Prime mobilisation gate: cash available before the first customer payment. */
  mobilisationCashMinor?: number;
  /** Prime mobilisation gate: what mobilisation will actually cost before recovery. */
  mobilisationCostMinor?: number;
  /** Prime liability gate: insurance in place, named. */
  insuranceCover?: string;
  /** Prime liability gate: bonds in place, or explicitly none. */
  bonds?: string;
  /** Management gate: the delegated authority ETABLIX actually holds. */
  delegatedAuthority?: string;
  /** Management gate: the customer's payment workflow ETABLIX recommends into. */
  paymentWorkflow?: string;
  /** Advisory gate: the deliverables, and who owns procurement afterwards. */
  advisoryOutputs?: string;
  procurementOwner?: string;
  handoverDate?: string;
  /** Advisory gate: what happens operationally after award. Must be stated, not implied. */
  postAwardResponsibilities?: string;
};

export type ModelViability = {
  model: TradingModel;
  label: string;
  score: number;
  /** The score as a percentage of what this model could have scored. */
  fitPercent: number;
  viable: boolean;
  /** Every gate that failed, in the words it would be explained in. */
  blockers: string[];
  /** What each gate needs, so a blocked model says what would unblock it. */
  gate: string;
};

export type ModelFit = {
  id: string;
  projectId: string;
  assessedAt: string;
  assessedBy: string;
  contractingEntity?: string;
  fundingSource?: string;
  /** Every factor with its score and its contribution to each model. */
  factors: {
    id: string;
    label: string;
    score: number;
    high: string;
    contribution: Record<TradingModel, number>;
  }[];
  viability: ModelViability[];
  /** The recommendation, or nothing at all where the first blocking rule fires. */
  recommended?: TradingModel;
  fallback?: TradingModel;
  /**
   * Why there is no recommendation, where there is none.
   *
   * The spec's first blocking rule: no recommendation at all if the contracting
   * entity or the funding source is unknown. Not a low-confidence answer — no
   * answer, because both of those decide which appointments are even legal.
   */
  refusedBecause?: string;
  /** Stated on every assessment, because it is what the document is for. */
  standing: string;
};

const SCALE_MAX = 4;

function gateFor(model: TradingModel): string {
  switch (model) {
    case 'PRINCIPAL_SERVICE_CONTRACTOR':
      return 'Treasury, liability and mobilisation: a credit facility that covers mobilisation, insurance and bonds named, and mobilisation cash in hand.';
    case 'MANAGEMENT_INTEGRATOR':
      return 'Enforceable authority: a stated delegated authority and the customer’s payment workflow ETABLIX recommends into.';
    default:
      return 'Completeness: defined outputs, a named customer procurement owner, a handover date, and post-award operational responsibilities stated.';
  }
}

function blockersFor(model: TradingModel, evidence: ViabilityEvidence): string[] {
  const blockers: string[] = [];

  if (model === 'PRINCIPAL_SERVICE_CONTRACTOR') {
    // Treasury. The facility has to cover what mobilisation costs, not merely
    // exist — a credit limit smaller than the first month's outlay is not a
    // facility, it is a shortfall with a number on it.
    const cost = evidence.mobilisationCostMinor;
    if (cost === undefined) {
      blockers.push('Mobilisation cost is not stated, so no treasury test can be run against it.');
    } else {
      if ((evidence.creditLimitMinor ?? 0) < cost) {
        blockers.push(
          'Treasury: the credit facility does not cover the mobilisation cost. Prime funds every supplier before the customer pays for any of them.',
        );
      }
      if ((evidence.mobilisationCashMinor ?? 0) < cost) {
        blockers.push(
          'Mobilisation: there is not enough cash in hand to mobilise before the first customer payment.',
        );
      }
    }
    if (!evidence.insuranceCover?.trim()) {
      blockers.push('Liability: no insurance cover is named. Under Prime every supplier’s default becomes ETABLIX’s.');
    }
    if (!evidence.bonds?.trim()) {
      blockers.push('Liability: the bond position is not stated. "None required" is an answer; silence is not.');
    }
  }

  if (model === 'MANAGEMENT_INTEGRATOR') {
    if (!evidence.delegatedAuthority?.trim()) {
      blockers.push(
        'Authority: no delegated authority is recorded. ETABLIX cannot be accountable for an operation it has no power to instruct.',
      );
    }
    if (!evidence.paymentWorkflow?.trim()) {
      blockers.push(
        'Payment: the customer’s payment workflow is not stated, so a payment recommendation would go nowhere.',
      );
    }
  }

  if (model === 'ADVISORY') {
    if (!evidence.advisoryOutputs?.trim()) blockers.push('Completeness: the advisory deliverables are not defined.');
    if (!evidence.procurementOwner?.trim()) {
      blockers.push('Completeness: no customer procurement owner is named, so there is nobody to hand the tender to.');
    }
    if (!evidence.handoverDate?.trim()) blockers.push('Completeness: no handover date is set.');
    if (!evidence.postAwardResponsibilities?.trim()) {
      blockers.push(
        'Completeness: post-award operational responsibilities are not stated. Advisory ends at award unless it says otherwise, and that is exactly what gets assumed either way.',
      );
    }
  }

  return blockers;
}

/**
 * Score the appointment models against the evidence, and say which fits.
 *
 * `X` on `SITE_SERVICES` — this is the Model Fit agent, and it runs against the
 * agent's own capability rather than an ordinary read, so it is metered and
 * refused on an empty wallet like every other agent.
 *
 * It produces a decision paper and never an appointment. `setAppointment` is a
 * separate act by a person, because choosing which of three businesses ETABLIX
 * is on this job is the definition of a commercial commitment.
 */
export function assessModelFit(
  ctx: EngineContext,
  input: {
    scores: Partial<Record<FitFactorId, number>>;
    evidence: ViabilityEvidence;
    contractingEntity?: string;
    fundingSource?: string;
  },
): ModelFit {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  const scores = input.scores ?? {};
  for (const factor of FIT_FACTORS) {
    const value = scores[factor.id];
    if (value === undefined) {
      throw new DomainError(
        'MODEL_FIT_INCOMPLETE',
        `${factor.label} has not been scored. A recommendation made on a subset of the ten factors is an opinion with arithmetic on it.`,
      );
    }
    if (!Number.isInteger(value) || value < 0 || value > SCALE_MAX) {
      throw new DomainError(
        'MODEL_FIT_SCORE_INVALID',
        `${factor.label} is scored ${value}. The scale is 0 to ${SCALE_MAX}.`,
      );
    }
  }

  const models = Object.keys(TRADING_MODEL) as TradingModel[];
  const factors = FIT_FACTORS.map((factor) => ({
    id: factor.id,
    label: factor.label,
    score: scores[factor.id]!,
    high: factor.high,
    contribution: Object.fromEntries(
      models.map((model) => [model, scores[factor.id]! * factor.weights[model]]),
    ) as Record<TradingModel, number>,
  }));

  const viability: ModelViability[] = models.map((model) => {
    const score = factors.reduce((sum, factor) => sum + factor.contribution[model], 0);
    // The best this model could have scored on this scale — every positively
    // weighted factor at the top of the range, every negative one at zero. A
    // raw total is meaningless across models whose coefficients differ.
    const ceiling = FIT_FACTORS.reduce(
      (sum, factor) => sum + Math.max(0, factor.weights[model]) * SCALE_MAX,
      0,
    );
    const blockers = blockersFor(model, input.evidence);
    return {
      model,
      label: TRADING_MODEL[model].label,
      score,
      fitPercent: ceiling > 0 ? Math.round((Math.max(0, score) / ceiling) * 1000) / 10 : 0,
      viable: blockers.length === 0,
      blockers,
      gate: gateFor(model),
    };
  });

  const entity = input.contractingEntity?.trim();
  const funding = input.fundingSource?.trim();
  // Blocking rule one, and it is absolute. Which appointments are even
  // available depends on who is contracting and where the money comes from;
  // recommending without them would be recommending against an unknown.
  const refusedBecause =
    !entity || !funding
      ? 'No recommendation: ' +
        [!entity ? 'the contracting entity' : '', !funding ? 'the funding source' : '']
          .filter(Boolean)
          .join(' and ') +
        ' is unknown. Which models are available at all depends on it.'
      : undefined;

  // Only a viable model can be recommended, however well it scores. A blocked
  // model at the top of the table is exactly the recommendation that gets a
  // business into an appointment it cannot fund.
  const ranked = [...viability]
    .filter((entry) => entry.viable)
    .sort((a, b) => b.fitPercent - a.fitPercent || a.model.localeCompare(b.model));

  const assessment: ModelFit = {
    id: ulid(),
    projectId: ctx.projectId,
    assessedAt: new Date().toISOString(),
    assessedBy: ctx.auth.actorId,
    ...(entity ? { contractingEntity: entity } : {}),
    ...(funding ? { fundingSource: funding } : {}),
    factors,
    viability,
    ...(refusedBecause ? { refusedBecause } : {}),
    ...(refusedBecause ? {} : { recommended: ranked[0]?.model, fallback: ranked[1]?.model }),
    standing:
      'A decision paper, not a commercial commitment. Appointing ETABLIX under any model is a separate act by a ' +
      'person with the authority to sign it.',
  };

  write(ctx, {
    eventType: 'SITE_SERVICES_MODEL_FIT_ASSESSED',
    entity: { refType: 'ModelFitAssessment', refId: assessment.id },
    nextState: assessment,
  });

  return assessment;
}
