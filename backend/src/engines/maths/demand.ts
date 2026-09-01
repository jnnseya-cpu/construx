/**
 * §4.1 — the demand and capacity engine.
 *
 * Capacity is time-phased, zone-specific and resilience-adjusted, and the
 * engine **stores formulas and assumptions, not just final quantities.** That
 * sentence is the whole design. A platform that recorded "seven WCs" would be
 * unable to answer the only two questions anybody asks six months later: seven
 * from what, and does it still hold now the workforce has moved.
 *
 * So nothing here returns a number. Every calculation returns a `Derivation`
 * carrying the formula as a person would check it, every input with its value,
 * unit, source and whether it was a fact or an assumption, every rate applied
 * with the basis it was applied on, and three capacities rather than one.
 *
 * ---
 *
 * ## Three capacities, not one
 *
 * The specification's calculation controls, and they are three different
 * questions that get collapsed into one number and then argued about:
 *
 * - **Normal operating capacity** — base demand × concurrency × utilisation.
 *   What the service carries on an ordinary day.
 * - **Peak design capacity** — the peak factor and planned growth on top. What
 *   it has to carry on the worst day it is designed for.
 * - **Continuity capacity** — what is held in reserve for a failure.
 *
 * ## Resilience by consequence, not by percentage
 *
 * The control that most changes what gets built. "Add 15% for resilience" is
 * the industry habit and it is wrong in both directions at once: it buys a
 * spare canteen nobody needs and leaves the potable water on a single tank.
 *
 * Every derivation declares what happens **when this service fails**, and the
 * continuity capacity follows from that. Losing potable water stops the site;
 * losing a drying room degrades a shift. They do not get the same reserve, and
 * the reason is stated on the record rather than left to whoever set the
 * percentage.
 *
 * ## Every rate in this file is named and sourced
 *
 * A demand engine whose rates are unexplained magic numbers is a spreadsheet
 * with better error handling. Each is a declared `Assumption` carrying the
 * basis it rests on, it travels with the result, and it can be argued with —
 * which is what a design basis is for.
 */

// --- What failure costs, and therefore what is held in reserve ---------------

export const FAILURE_CONSEQUENCE = {
  SITE_STOPS: {
    label: 'The site stops',
    detail: 'Nobody can work. Every hour of the outage is the whole workforce standing.',
    rule: 'N+1 on the supply, and 48 hours of stored autonomy — enough to cover a missed delivery and the slot after it.',
    autonomyHours: 48,
    spareUnits: 1,
  },
  STATUTORY_BREACH: {
    label: 'The site is in breach',
    detail:
      'Work can continue physically and cannot continue lawfully. An inspector arriving that day serves a notice.',
    rule: 'One spare unit, so a single failure cannot drop provision below the statutory minimum.',
    autonomyHours: 24,
    spareUnits: 1,
  },
  SHIFT_DEGRADED: {
    label: 'The shift is degraded',
    detail: 'Work continues at reduced productivity or comfort, and it is noticed within hours.',
    rule: 'Nothing held in reserve; a same-day response obligation instead. Duplicating the asset costs more than the loss.',
    autonomyHours: 8,
    spareUnits: 0,
  },
  TOLERABLE: {
    label: 'Tolerable for a period',
    detail: 'A loss that can run for days without affecting the work or the law.',
    rule: 'Nothing held in reserve. Repaired in the ordinary maintenance cycle.',
    autonomyHours: 0,
    spareUnits: 0,
  },
} as const;

export type ConsequenceClass = keyof typeof FAILURE_CONSEQUENCE;

// --- The shape of a derived capacity -----------------------------------------

export type DerivationInput = {
  itemId: string;
  label: string;
  value: number;
  unit: string;
  /** Whether the figure behind this is settled or assumed. Carried, not flattened. */
  status: 'KNOWN' | 'PROVISIONAL';
  source: string;
};

export type Assumption = {
  name: string;
  value: number | string;
  unit?: string;
  /** Why this rate, in the sentence it would be defended in. */
  basis: string;
};

export type Derivation = {
  id: string;
  label: string;
  unit: string;
  /** The arithmetic, written out so somebody can check it by hand. */
  formula: string;
  inputs: DerivationInput[];
  assumptions: Assumption[];
  /** Base demand × concurrency × utilisation. */
  normal: number;
  /** Peak factor and planned growth on top. */
  peak: number;
  /** What is held against failure. Units differ by derivation — see `continuityUnit`. */
  continuity: number;
  continuityUnit: string;
  consequence: ConsequenceClass;
  /** Why that reserve, from the consequence rather than a blanket percentage. */
  continuityBasis: string;
  /** The calculation controls' exceptions, where they fired. */
  exceptions: string[];
};

/** A calculation that could not run, and exactly what is missing. */
export type NotDerivable = { id: string; label: string; missing: string[] };

export type DemandPosition = {
  derivations: Derivation[];
  notDerivable: NotDerivable[];
};

/** A fact as the demand engine needs it: a number that knows where it came from. */
export type Known = { value: number; status: 'KNOWN' | 'PROVISIONAL'; source: string };

export type DemandFacts = Partial<Record<string, Known>>;

// --- Named rates -------------------------------------------------------------
//
// Every one is an assumption with a stated basis, applied through `rate()` so it
// travels with the result rather than disappearing into the arithmetic.

const RATES = {
  potableLitresPerPersonDay: {
    value: 50,
    unit: 'litres per person per day',
    basis:
      'Welfare provision including showers and a canteen. Drinking, hand-washing and food preparation alone is nearer 15; showers are the bulk of it.',
  },
  foulFractionOfPotable: {
    value: 0.9,
    basis: 'The tenth that does not reach the foul tank is consumed, evaporated or carried off site on people.',
  },
  diversityFactor: {
    value: 0.7,
    basis:
      'Not everything connected draws at once. 0.7 is the usual site figure; a compound with electric heating and no gas runs higher and should be stated rather than assumed.',
  },
  criticalLoadFraction: {
    value: 0.25,
    basis:
      'Fire alarm, emergency lighting, security, comms and the welfare block. The quarter of the load whose loss stops the site rather than slowing it.',
  },
  cleaningSqmPerHour: {
    value: 200,
    unit: 'm² per productive hour',
    basis: 'General welfare and office cleaning to a site standard. Kitchens and washrooms are slower and are counted separately.',
  },
  wasteM3PerPersonWeek: {
    value: 0.3,
    unit: 'm³ per person per week',
    basis: 'Site domestic and canteen waste across all streams. Construction and demolition arisings are not in this figure.',
  },
  showersPerPersons: {
    value: 15,
    unit: 'persons per shower',
    basis:
      'Schedule 1 requires showers where the work is dirty or for health reasons; one per fifteen is the provision that clears a shift change without queuing.',
  },
} as const;

function rate(name: keyof typeof RATES): Assumption {
  const declared = RATES[name];
  return {
    name,
    value: declared.value,
    ...('unit' in declared ? { unit: declared.unit } : {}),
    basis: declared.basis,
  };
}

/**
 * The statutory minimum number of sanitary conveniences.
 *
 * Workplace (Health, Safety and Welfare) Regulations 1992, Schedule 1, Table 1.
 * Re-exported through `domain/etablix/brief.ts` as well; the rule lives once and
 * both callers read the same function.
 */
export function statutoryWcs(persons: number): number {
  if (persons <= 0) return 0;
  if (persons <= 5) return 1;
  if (persons <= 25) return 2;
  if (persons <= 50) return 3;
  if (persons <= 75) return 4;
  if (persons <= 100) return 5;
  return 5 + Math.ceil((persons - 100) / 25);
}

// --- Building a derivation ---------------------------------------------------

function input(facts: DemandFacts, itemId: string, label: string, unit: string): DerivationInput | undefined {
  const fact = facts[itemId];
  if (!fact) return undefined;
  return { itemId, label, value: fact.value, unit, status: fact.status, source: fact.source };
}

/**
 * The peak factor, and the exception that separates an event peak from a
 * sustained one.
 *
 * A peak lasting two days is managed; one lasting two months is designed for.
 * Sizing permanent welfare to a two-day peak is hire nobody needed for the
 * other fifty weeks, and the specification asks for the two to be told apart
 * rather than added together.
 */
function peakFactor(facts: DemandFacts): { factor: number; assumptions: Assumption[]; exceptions: string[] } {
  const growth = facts.plannedGrowthPercent;
  const duration = facts.peakDurationDays;
  const exceptions: string[] = [];
  const assumptions: Assumption[] = [];

  const growthPercent = growth?.value ?? 10;
  assumptions.push({
    name: 'plannedGrowthPercent',
    value: growthPercent,
    unit: '%',
    basis: growth
      ? `Stated on the brief: ${growth.source}`
      : 'Not stated. 10% absorbs an ordinary programme change and not a scope one.',
  });

  if (duration !== undefined && duration.value <= 2) {
    exceptions.push(
      `The peak lasts ${duration.value} day${duration.value === 1 ? '' : 's'}. That is an event peak, not a sustained one — ` +
        'size the permanent provision to the ordinary day and manage the peak with temporary provision, or the hire runs for the whole programme.',
    );
  } else if (duration === undefined) {
    exceptions.push(
      'How long the peak lasts is not stated, so it is treated as sustained. That is the expensive assumption: it sizes every asset to a figure the site may hit twice.',
    );
  }

  return { factor: 1 + growthPercent / 100, assumptions, exceptions };
}

/**
 * Concurrency, and the specification's first exception.
 *
 * The number that decides every welfare quantity is not how many people are on
 * site in a day — it is how many are on site **at once**. A brief giving only a
 * total headcount has not answered the question, and the flag says so rather
 * than quietly assuming everybody overlaps.
 */
function concurrency(facts: DemandFacts): {
  persons: number | undefined;
  inputs: DerivationInput[];
  assumptions: Assumption[];
  exceptions: string[];
} {
  const overlap = input(facts, 'shiftOverlapPersons', 'People on site at changeover', 'persons');
  const visitors = input(facts, 'visitorsPerDay', 'Visitors per day', 'persons');
  const peak = input(facts, 'peakWorkforce', 'Peak workforce in a day', 'persons');

  const exceptions: string[] = [];
  const assumptions: Assumption[] = [];

  if (overlap) {
    return {
      persons: overlap.value + (visitors?.value ?? 0),
      inputs: [overlap, ...(visitors ? [visitors] : [])],
      assumptions: visitors
        ? []
        : [
            {
              name: 'visitorsPerDay',
              value: 0,
              unit: 'persons',
              basis: 'Not stated, so none are counted. Visitors use the same welfare and the same gate as everybody else.',
            },
          ],
      exceptions,
    };
  }

  if (peak) {
    // The exception the specification names: the customer gave a headcount and
    // nothing about concurrency, so the whole welfare basis rests on an
    // assumption nobody has agreed to.
    exceptions.push(
      'Only a total headcount was provided. Concurrency is assumed at 100% — everybody on site at once — which is the ' +
        'safe assumption and usually the wrong one. Confirm the changeover figure before anything is ordered against it.',
    );
    assumptions.push({
      name: 'concurrency',
      value: 1,
      basis: 'No shift pattern stated. The whole daily headcount is treated as concurrent.',
    });
    return { persons: peak.value, inputs: [peak], assumptions, exceptions };
  }

  return { persons: undefined, inputs: [], assumptions, exceptions };
}

// --- The derivations ---------------------------------------------------------

/**
 * Every capacity the brief supports, with what it could not derive and why.
 *
 * Nothing is computed against a missing input. A capacity derived from zero is
 * a number that looks like an answer, and the honest output is the list of what
 * is missing — which is already the brief's own gap register.
 */
export function demandPosition(facts: DemandFacts): DemandPosition {
  const derivations: Derivation[] = [];
  const notDerivable: NotDerivable[] = [];
  const peakOf = peakFactor(facts);
  const concurrent = concurrency(facts);

  const need = (id: string, label: string, missing: string[]): void => {
    notDerivable.push({ id, label, missing });
  };

  // --- Concurrent occupancy, which almost everything below is built on -------
  if (concurrent.persons === undefined) {
    need('concurrentOccupancy', 'Concurrent occupancy', ['shiftOverlapPersons or peakWorkforce']);
  } else {
    const persons = concurrent.persons;
    derivations.push({
      id: 'concurrentOccupancy',
      label: 'Concurrent occupancy',
      unit: 'persons',
      formula: 'people on site at changeover + visitors per day',
      inputs: concurrent.inputs,
      assumptions: [...concurrent.assumptions, ...peakOf.assumptions],
      normal: persons,
      peak: Math.ceil(persons * peakOf.factor),
      // People are not held in reserve. The continuity figure here is the
      // occupancy the site must still be able to carry when a facility fails,
      // which is the same number — the reserve is on the facilities below.
      continuity: persons,
      continuityUnit: 'persons',
      consequence: 'SITE_STOPS',
      continuityBasis:
        'Occupancy is the demand, not the asset. What is held in reserve is provision, and each facility below states its own.',
      exceptions: [...concurrent.exceptions, ...peakOf.exceptions],
    });

    // --- Sanitary provision ------------------------------------------------
    const consequenceOfWcLoss: ConsequenceClass = 'STATUTORY_BREACH';
    derivations.push({
      id: 'sanitaryProvision',
      label: 'Sanitary conveniences required',
      unit: 'WCs',
      formula: 'Workplace (Health, Safety and Welfare) Regulations 1992, Schedule 1, Table 1, against concurrent occupancy',
      inputs: concurrent.inputs,
      assumptions: [
        {
          name: 'sanitaryTable',
          value: 'Schedule 1, Table 1',
          basis:
            'One convenience to five people, then one more at 25, 50, 75 and 100, and one for every 25 or part thereof beyond that. This is the table an inspector arrives with.',
        },
        ...peakOf.assumptions,
      ],
      normal: statutoryWcs(persons),
      peak: statutoryWcs(Math.ceil(persons * peakOf.factor)),
      continuity: statutoryWcs(persons) + FAILURE_CONSEQUENCE[consequenceOfWcLoss].spareUnits,
      continuityUnit: 'WCs including one spare',
      consequence: consequenceOfWcLoss,
      continuityBasis: FAILURE_CONSEQUENCE[consequenceOfWcLoss].rule,
      exceptions: [...concurrent.exceptions, ...peakOf.exceptions],
    });

    derivations.push({
      id: 'showerProvision',
      label: 'Showers required',
      unit: 'showers',
      formula: 'concurrent occupancy ÷ persons per shower, rounded up',
      inputs: concurrent.inputs,
      assumptions: [rate('showersPerPersons'), ...peakOf.assumptions],
      normal: Math.ceil(persons / RATES.showersPerPersons.value),
      peak: Math.ceil((persons * peakOf.factor) / RATES.showersPerPersons.value),
      continuity: Math.ceil(persons / RATES.showersPerPersons.value) + 1,
      continuityUnit: 'showers including one spare',
      consequence: 'STATUTORY_BREACH',
      continuityBasis: FAILURE_CONSEQUENCE.STATUTORY_BREACH.rule,
      exceptions: [...concurrent.exceptions, ...peakOf.exceptions],
    });

    // --- Potable water ------------------------------------------------------
    const dailyLitres = persons * RATES.potableLitresPerPersonDay.value;
    const peakLitres = Math.ceil(persons * peakOf.factor) * RATES.potableLitresPerPersonDay.value;
    const autonomy = FAILURE_CONSEQUENCE.SITE_STOPS.autonomyHours;
    const waterExceptions = [...concurrent.exceptions, ...peakOf.exceptions];
    const interval = facts.tankerIntervalHours;
    if (interval && interval.value > autonomy) {
      waterExceptions.push(
        `The stored autonomy this recommends is ${autonomy} hours and a tanker reaches the site every ${interval.value}. ` +
          'Either the storage grows to the interval or the interval shortens; a design that splits the difference runs dry on the first missed slot.',
      );
    }
    derivations.push({
      id: 'potableWater',
      label: 'Potable water demand',
      unit: 'litres per day',
      formula: 'concurrent occupancy × litres per person per day',
      inputs: concurrent.inputs,
      assumptions: [rate('potableLitresPerPersonDay'), ...peakOf.assumptions],
      normal: dailyLitres,
      peak: peakLitres,
      // Storage, in litres, to carry the autonomy the consequence demands.
      continuity: Math.ceil((peakLitres * autonomy) / 24),
      continuityUnit: `litres of storage — ${autonomy} hours at peak draw`,
      consequence: 'SITE_STOPS',
      continuityBasis: FAILURE_CONSEQUENCE.SITE_STOPS.rule,
      exceptions: waterExceptions,
    });

    // --- Wastewater and tanker frequency ------------------------------------
    const foulDaily = Math.ceil((dailyLitres * RATES.foulFractionOfPotable.value) / 1000);
    const foulPeak = Math.ceil((peakLitres * RATES.foulFractionOfPotable.value) / 1000);
    const tank = input(facts, 'foulTankCapacityM3', 'Foul storage capacity', 'm³');
    if (!tank) {
      need('tankerFrequency', 'Tanker attendances required', ['foulTankCapacityM3']);
    } else if (tank.value <= 0) {
      need('tankerFrequency', 'Tanker attendances required', ['a foul storage capacity above zero']);
    } else {
      const perWeek = Math.ceil((foulPeak * 7) / tank.value);
      derivations.push({
        id: 'tankerFrequency',
        label: 'Tanker attendances required',
        unit: 'attendances per week',
        formula: '(peak foul volume per day × 7) ÷ foul storage capacity, rounded up',
        inputs: [...concurrent.inputs, tank],
        assumptions: [rate('potableLitresPerPersonDay'), rate('foulFractionOfPotable')],
        normal: Math.ceil((foulDaily * 7) / tank.value),
        peak: perWeek,
        continuity: perWeek + 1,
        continuityUnit: 'attendances per week including one recovery slot',
        consequence: 'SITE_STOPS',
        continuityBasis:
          'A foul tank that overflows closes the welfare block, so the schedule carries one slot that can absorb a missed attendance.',
        exceptions: [...concurrent.exceptions],
      });
    }
    derivations.push({
      id: 'wastewater',
      label: 'Wastewater generated',
      unit: 'm³ per day',
      formula: 'potable demand × the fraction reaching the foul system',
      inputs: concurrent.inputs,
      assumptions: [rate('potableLitresPerPersonDay'), rate('foulFractionOfPotable'), ...peakOf.assumptions],
      normal: foulDaily,
      peak: foulPeak,
      continuity: foulPeak,
      continuityUnit: 'm³ per day the system must still take',
      consequence: 'SITE_STOPS',
      continuityBasis: FAILURE_CONSEQUENCE.SITE_STOPS.rule,
      exceptions: [...concurrent.exceptions, ...peakOf.exceptions],
    });

    // --- Waste --------------------------------------------------------------
    derivations.push({
      id: 'wasteVolume',
      label: 'Waste generated',
      unit: 'm³ per week',
      formula: 'concurrent occupancy × m³ per person per week, across all streams',
      inputs: concurrent.inputs,
      assumptions: [rate('wasteM3PerPersonWeek'), ...peakOf.assumptions],
      normal: Math.round(persons * RATES.wasteM3PerPersonWeek.value * 10) / 10,
      peak: Math.round(persons * peakOf.factor * RATES.wasteM3PerPersonWeek.value * 10) / 10,
      continuity: 0,
      continuityUnit: 'nothing held — collection recovers within the cycle',
      consequence: 'SHIFT_DEGRADED',
      continuityBasis: FAILURE_CONSEQUENCE.SHIFT_DEGRADED.rule,
      exceptions: [...concurrent.exceptions, ...peakOf.exceptions],
    });

    // --- Gate throughput ----------------------------------------------------
    const gate = input(facts, 'gateThroughputPerHour', 'Gate throughput', 'persons per hour');
    if (!gate || gate.value <= 0) {
      need('gateClearance', 'Time to clear the gate', ['gateThroughputPerHour']);
    } else {
      const minutes = Math.ceil((persons / gate.value) * 60);
      derivations.push({
        id: 'gateClearance',
        label: 'Time to clear the gate',
        unit: 'minutes',
        formula: '(concurrent occupancy ÷ throughput per hour) × 60, rounded up',
        inputs: [...concurrent.inputs, gate],
        assumptions: peakOf.assumptions,
        normal: minutes,
        peak: Math.ceil(((persons * peakOf.factor) / gate.value) * 60),
        continuity: Math.ceil((persons / gate.value) * 60 * 2),
        continuityUnit: 'minutes with one lane out of service',
        consequence: 'SHIFT_DEGRADED',
        continuityBasis:
          'A failed lane doubles the queue rather than stopping the site. The reserve is a second lane, not a second gate.',
        exceptions: [...concurrent.exceptions, ...peakOf.exceptions],
      });
    }
  }

  // --- Electrical -------------------------------------------------------------
  const connected = input(facts, 'connectedLoadKva', 'Connected load', 'kVA');
  if (!connected) {
    need('maximumDemand', 'Maximum electrical demand', ['connectedLoadKva']);
  } else {
    const derived = Math.ceil(connected.value * RATES.diversityFactor.value);
    const stated = facts.maximumDemandKva;
    const exceptions: string[] = [...peakOf.exceptions];
    if (stated) {
      const drift = Math.abs(stated.value - derived) / derived;
      if (drift > 0.1) {
        exceptions.push(
          `The brief states a maximum demand of ${stated.value} kVA and the connected load at ${RATES.diversityFactor.value} diversity ` +
            `gives ${derived} kVA — ${Math.round(drift * 100)}% apart. One of the two was not derived from the other, and the load schedule decides which.`,
        );
      }
    }
    derivations.push({
      id: 'maximumDemand',
      label: 'Maximum electrical demand',
      unit: 'kVA',
      formula: 'connected load × diversity factor',
      inputs: [connected, ...(stated ? [input(facts, 'maximumDemandKva', 'Stated maximum demand', 'kVA')!] : [])],
      assumptions: [rate('diversityFactor'), rate('criticalLoadFraction'), ...peakOf.assumptions],
      normal: derived,
      peak: Math.ceil(derived * peakOf.factor),
      // N+1 on the critical portion only. Standby for the whole site load is
      // what a blanket resilience percentage buys and nobody can afford.
      continuity: Math.ceil(derived * RATES.criticalLoadFraction.value),
      continuityUnit: 'kVA of standby on the critical load',
      consequence: 'SITE_STOPS',
      continuityBasis:
        'Standby sized to the fire alarm, emergency lighting, security, comms and welfare rather than to the whole site. ' +
        FAILURE_CONSEQUENCE.SITE_STOPS.rule,
      exceptions,
    });
  }

  // --- Accommodation ----------------------------------------------------------
  const accommodated = input(facts, 'accommodatedWorkers', 'Workers requiring accommodation', 'persons');
  if (!accommodated) {
    need('bedDemand', 'Beds required', ['accommodatedWorkers']);
  } else {
    derivations.push({
      id: 'bedDemand',
      label: 'Beds required',
      unit: 'beds',
      formula: 'workers requiring accommodation, one bed each',
      inputs: [accommodated],
      assumptions: [
        {
          name: 'bedsPerWorker',
          value: 1,
          basis: 'A bed is not shared between shifts. Hot-bedding is a policy decision, not a default.',
        },
        ...peakOf.assumptions,
      ],
      normal: accommodated.value,
      peak: Math.ceil(accommodated.value * peakOf.factor),
      continuity: Math.ceil(accommodated.value * 0.02) + 1,
      continuityUnit: 'rooms held for a defect or a deep clean',
      consequence: 'SHIFT_DEGRADED',
      continuityBasis:
        'Two per cent plus one, held out of service. A room lost to a leak with no spare means somebody travels or does not work.',
      exceptions: peakOf.exceptions,
    });
  }

  // --- Cleaning ---------------------------------------------------------------
  const area = input(facts, 'cleanableAreaSqm', 'Cleanable area', 'm²');
  if (!area) {
    need('cleaningHours', 'Cleaning productive hours', ['cleanableAreaSqm']);
  } else {
    const hours = Math.ceil(area.value / RATES.cleaningSqmPerHour.value);
    derivations.push({
      id: 'cleaningHours',
      label: 'Cleaning productive hours',
      unit: 'hours per clean',
      formula: 'cleanable area ÷ m² per productive hour, rounded up',
      inputs: [area],
      assumptions: [rate('cleaningSqmPerHour'), ...peakOf.assumptions],
      normal: hours,
      peak: Math.ceil((area.value * peakOf.factor) / RATES.cleaningSqmPerHour.value),
      continuity: 0,
      continuityUnit: 'nothing held — cover is a contractual obligation, not a spare',
      consequence: 'SHIFT_DEGRADED',
      continuityBasis:
        'Absence cover belongs in the supplier’s obligation rather than in a standing reserve of cleaners nobody is paying for.',
      exceptions: peakOf.exceptions,
    });
  }

  // --- Transport --------------------------------------------------------------
  const travelling = input(facts, 'travellingWorkforce', 'Workforce needing transport', 'persons per shift');
  if (!travelling) {
    need('transportSeats', 'Transport seats required', ['travellingWorkforce']);
  } else {
    derivations.push({
      id: 'transportSeats',
      label: 'Transport seats required',
      unit: 'seats per shift',
      formula: 'workforce needing transport, one seat each',
      inputs: [travelling],
      assumptions: [
        {
          name: 'seatsPerPerson',
          value: 1,
          basis: 'Standing on a site bus is not a seat. Journey plans and fatigue rules assume everybody is seated.',
        },
        ...peakOf.assumptions,
      ],
      normal: travelling.value,
      peak: Math.ceil(travelling.value * peakOf.factor),
      continuity: Math.ceil(travelling.value * 0.1),
      continuityUnit: 'spare seats for a vehicle running short',
      consequence: 'SHIFT_DEGRADED',
      continuityBasis:
        'Ten per cent spare capacity across the fleet. A vehicle off the road with no slack means a shift starts late, not that the site stops.',
      exceptions: peakOf.exceptions,
    });
  }

  return { derivations, notDerivable };
}

// --- The asset deployment curve ----------------------------------------------

export type DeploymentWindow = {
  systemId: string;
  label: string;
  /** When the service must be operational. */
  fromDate: string;
  /** When it is no longer needed. */
  toDate: string;
  /** Working days between ordering it and it being usable. */
  leadDays: number;
};

export type DeploymentException = {
  systemId: string;
  kind: 'STRANDED_HIRE' | 'PREMATURE_REMOVAL' | 'LEAD_TIME_MISSED';
  statement: string;
  resolution: string;
};

/**
 * The specification's fourth calculation control: **prevent stranded hire and
 * premature removal.**
 *
 * Two failures, and they are opposites. Stranded hire is an asset still on
 * charge after the last thing needing it has gone — a compound paid for through
 * a winter nobody used it. Premature removal is the reverse and it is worse: a
 * cabin off-hired while the fire alarm panel inside it still covers the block
 * next door.
 *
 * Both are read from the deployment windows and the interfaces between them,
 * which is why the curve lives with the composer rather than in a hire schedule.
 */
export function deploymentExceptions(
  windows: readonly DeploymentWindow[],
  dependencies: readonly { from: string; to: string; note: string }[],
  today: string,
): DeploymentException[] {
  const byId = new Map(windows.map((window) => [window.systemId, window]));
  const exceptions: DeploymentException[] = [];

  // The last date anything is needed. An asset held past it is stranded, and
  // the only defensible reason is a dependency, which is checked separately.
  const lastNeeded = windows.reduce((latest, window) => (window.toDate > latest ? window.toDate : latest), '');

  for (const window of windows) {
    if (lastNeeded && window.toDate === lastNeeded && windows.length > 1) {
      // The last service off site is not stranded by definition — something has
      // to be last. Skipped rather than reported.
    } else if (lastNeeded && window.toDate > lastNeeded) {
      exceptions.push({
        systemId: window.systemId,
        kind: 'STRANDED_HIRE',
        statement: `${window.label} is held to ${window.toDate}, past the last date anything else needs the site (${lastNeeded}).`,
        resolution: 'Bring the off-hire forward, or record what it is still there for.',
      });
    }

    // A lead time that cannot be met from today. Not a warning about the past:
    // if the order has not been placed, the date is already gone.
    const daysAvailable = Math.floor((Date.parse(window.fromDate) - Date.parse(today)) / 86_400_000);
    if (Number.isFinite(daysAvailable) && daysAvailable < window.leadDays) {
      exceptions.push({
        systemId: window.systemId,
        kind: 'LEAD_TIME_MISSED',
        statement: `${window.label} needs ${window.leadDays} days to arrive and there are ${Math.max(
          daysAvailable,
          0,
        )} left before it is needed on ${window.fromDate}.`,
        resolution:
          'Move the need date, shorten the lead by paying for it, or accept the service is late and say which shift it affects.',
      });
    }
  }

  // Premature removal: something goes before a service that depends on it.
  for (const dependency of dependencies) {
    const supplier = byId.get(dependency.from);
    const dependent = byId.get(dependency.to);
    if (!supplier || !dependent) continue;
    if (supplier.toDate < dependent.toDate) {
      exceptions.push({
        systemId: supplier.systemId,
        kind: 'PREMATURE_REMOVAL',
        statement: `${supplier.label} comes out on ${supplier.toDate} and ${dependent.label} depends on it until ${dependent.toDate}. ${dependency.note}`,
        resolution:
          'Hold it until the dependent service is released, or move the dependency to a successor and accept that interface first.',
      });
    }
  }

  return exceptions;
}

// --- Reforecast against what was actually consumed ---------------------------

export type Observation = { derivationId: string; observed: number; over: string; source: string };

export type Reforecast = {
  derivationId: string;
  label: string;
  unit: string;
  basis: number;
  observed: number;
  /** Positive means consumption is above the design basis. */
  variancePercent: number;
  proposal: string;
  /** True where the proposal would lower the design basis. */
  reducesBaseline: boolean;
  /** Present on any proposal that lowers the basis. */
  requiresApproval?: string;
};

/**
 * The fifth calculation control: **observed consumption versus basis**.
 *
 * And its rule, which is the important half: **no baseline reduction without
 * service and change approval.** A design basis is not a forecast that gets
 * corrected downward as the meters come in. It is what the service was sized,
 * contracted and priced against, and lowering it silently means the first busy
 * week finds the site short with nobody able to say who decided.
 *
 * So a reduction is a *proposal* with an approval attached, and an increase is
 * an alert. The asymmetry is deliberate.
 */
export function reforecast(
  derivations: readonly Derivation[],
  observations: readonly Observation[],
): Reforecast[] {
  const byId = new Map(derivations.map((derivation) => [derivation.id, derivation]));
  const results: Reforecast[] = [];

  for (const observation of observations) {
    const derivation = byId.get(observation.derivationId);
    if (!derivation || derivation.normal <= 0) continue;

    const variance = ((observation.observed - derivation.normal) / derivation.normal) * 100;
    const reduces = observation.observed < derivation.normal;

    results.push({
      derivationId: derivation.id,
      label: derivation.label,
      unit: derivation.unit,
      basis: derivation.normal,
      observed: observation.observed,
      variancePercent: Math.round(variance * 10) / 10,
      proposal: reduces
        ? `Observed consumption over ${observation.over} is ${Math.abs(Math.round(variance))}% below the basis. ` +
          'Reducing the basis would release hire and running cost, and would leave the service unable to meet the figure it was contracted against.'
        : `Observed consumption over ${observation.over} is ${Math.round(variance)}% above the basis. ` +
          'The service is being used harder than it was sized for; the basis, not the usage, is what is wrong.',
      reducesBaseline: reduces,
      ...(reduces
        ? {
            requiresApproval:
              'A reduction changes what the service is obliged to deliver, so it needs the service owner and change control together. ' +
              'Until both have it, the basis stands and this is a note against it.',
          }
        : {}),
    });
  }

  return results;
}
