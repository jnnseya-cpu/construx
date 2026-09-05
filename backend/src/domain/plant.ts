import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, write, type EngineContext } from '../engines/context.ts';

/**
 * The plant register: what is on hire, what it costs, and whether it is working.
 *
 * Plant reached the platform three ways before this existed and none of them
 * was a register. The site diary records the hours a machine worked and stood
 * each day; a photograph read by the equipment task files what was seen as a
 * site observation; the estimate carries a plant cost head. What nobody could
 * answer was the question a commercial manager asks on a Friday: what is on
 * hire right now, what is it costing this week, and which of it has not turned
 * a wheel since it arrived.
 *
 * So the register records the hire — the item, who it is from, the rate and its
 * basis, the day it came, the day it went — and **derives** utilisation from the
 * records that already exist rather than asking anybody to enter it twice. A
 * diary line naming the machine gives its hours worked and idle; a site
 * observation naming it is a sighting. Both are matched by description, which
 * is stated on the result, and a diary line that matches nothing on the
 * register is reported as plant working on site that nobody has hired — which
 * is either a register that is behind or a machine somebody is paying for
 * outside it.
 *
 * Nothing here is a hire contract. An off-hire is the record that the machine
 * was released, with the day; whether the hirer's minimum term still bills is
 * the hirer's commercial matter, reported as a shortfall so the invoice is not
 * a surprise.
 */

export type RateBasis = 'HOUR' | 'DAY' | 'WEEK';
export const RATE_BASES: RateBasis[] = ['HOUR', 'DAY', 'WEEK'];

export type PlantItem = {
  id: string;
  projectId: string;
  /** What it is, as the diary will name it: "13t excavator", "telehandler 17m". */
  description: string;
  /** The hirer's fleet number or the asset tag, unique on the project where given. */
  reference?: string;
  ownership: 'HIRED' | 'OWNED';
  supplierId?: string;
  supplierName?: string;
  rateMinor: number;
  rateBasis: RateBasis;
  onHireFrom: string;
  expectedOffHire?: string;
  /** The hirer's minimum term in days. Off-hiring inside it is recorded, and the shortfall reported. */
  minimumHireDays?: number;
  purpose?: string;
  status: 'ON_HIRE' | 'OFF_HIRE';
  offHiredOn?: string;
  offHireReason?: string;
  minimumHireShortfallDays?: number;
  registeredBy: string;
  registeredAt: string;
  offHiredBy?: string;
};

export type PlantUtilisation = PlantItem & {
  /** Calendar days on hire to the reporting date, inclusive of both ends. */
  hireDays: number;
  /** What the hire has cost to the reporting date on its rate basis, where it can be derived. */
  costToDateMinor?: number;
  costBasis: string;
  hoursWorked: number;
  hoursIdle: number;
  /** Diary days on which the item was named. */
  diaryDays: number;
  lastDiaryDate?: string;
  utilisationPercent?: number;
  /** The share of the hire cost attributable to standing time, where both are known. */
  standingCostMinor?: number;
  sightings: number;
  lastSeen?: string;
  /** On hire, and not named in a diary for a week or more. */
  idleAlert?: string;
};

export type PlantPosition = {
  asOf: string;
  items: PlantUtilisation[];
  onHire: number;
  /** Rate of spend for the coming week on what is on hire, where the basis allows it. */
  weeklyRunRateMinor: number;
  costToDateMinor: number;
  standingCostMinor: number;
  /** Diary plant lines that match nothing on the register, aggregated by description. */
  unregistered: Array<{ description: string; hoursWorked: number; hoursIdle: number; days: number; lastDate: string }>;
  alerts: number;
  statement: string;
};

const DAY_MS = 86_400_000;
const isoDay = /^\d{4}-\d{2}-\d{2}$/;

function requireDate(value: string, field: string): string {
  if (!isoDay.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new DomainError('PLANT_DATE_INVALID', `${field} must be a date, as YYYY-MM-DD`);
  }
  return value;
}

function daysInclusive(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

/** Lower case, letters and digits only: "13t Excavator (CAT 313)" and "13T excavator cat313" meet here. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function itemsOf(ctx: EngineContext): PlantItem[] {
  return ctx.ledger.list(ctx.projectId, 'PlantItem').map((record) => record.state as unknown as PlantItem);
}

function requireItem(ctx: EngineContext, plantId: string): PlantItem {
  const record = ctx.ledger.get({ refType: 'PlantItem', refId: plantId });
  if (!record || record.state.projectId !== ctx.projectId) {
    throw new DomainError('PLANT_NOT_FOUND', `No plant item ${plantId} on this project`, 404);
  }
  return record.state as unknown as PlantItem;
}

export function onHirePlant(
  ctx: EngineContext,
  input: {
    description: string;
    reference?: string;
    ownership?: 'HIRED' | 'OWNED';
    supplierId?: string;
    supplierName?: string;
    rateMinor: number;
    rateBasis: string;
    onHireFrom: string;
    expectedOffHire?: string;
    minimumHireDays?: number;
    purpose?: string;
  },
): PlantItem {
  authorise(ctx, 'FIELD_EXECUTION', 'C', { lifecyclePhase: currentPhase(ctx) });

  const description = input.description.trim();
  if (description.length < 3) throw new DomainError('PLANT_DESCRIPTION_REQUIRED', 'Say what the machine is, as the diary will name it');
  if (!Number.isInteger(input.rateMinor) || input.rateMinor < 0) {
    throw new DomainError('PLANT_RATE_INVALID', 'The rate is a whole number of minor units, zero or more. Owned plant may carry an internal rate or none.');
  }
  if (!RATE_BASES.includes(input.rateBasis as RateBasis)) {
    throw new DomainError('PLANT_RATE_BASIS_INVALID', `The rate is per HOUR, DAY or WEEK, not "${input.rateBasis}"`);
  }
  const onHireFrom = requireDate(input.onHireFrom, 'onHireFrom');
  if (input.expectedOffHire !== undefined && requireDate(input.expectedOffHire, 'expectedOffHire') < onHireFrom) {
    throw new DomainError('PLANT_OFF_HIRE_BEFORE_ON_HIRE', 'The expected off-hire cannot precede the on-hire');
  }
  if (input.minimumHireDays !== undefined && (!Number.isInteger(input.minimumHireDays) || input.minimumHireDays < 0)) {
    throw new DomainError('PLANT_MINIMUM_INVALID', 'The minimum hire is a whole number of days');
  }
  const reference = input.reference?.trim() || undefined;
  if (reference) {
    const clash = itemsOf(ctx).find((item) => item.status === 'ON_HIRE' && item.reference?.toLowerCase() === reference.toLowerCase());
    if (clash) {
      throw new DomainError('PLANT_REFERENCE_ON_HIRE', `${reference} is already on hire as ${clash.description}. Off-hire it before registering it again.`, 409);
    }
  }
  const ownership = input.ownership ?? 'HIRED';
  if (ownership === 'HIRED' && !input.supplierName?.trim() && !input.supplierId) {
    throw new DomainError('PLANT_HIRER_REQUIRED', 'Hired plant is hired from somebody. Name the hirer, or mark the item as owned.');
  }

  const item: PlantItem = {
    id: ulid(),
    projectId: ctx.projectId,
    description,
    ...(reference ? { reference } : {}),
    ownership,
    ...(input.supplierId ? { supplierId: input.supplierId } : {}),
    ...(input.supplierName?.trim() ? { supplierName: input.supplierName.trim() } : {}),
    rateMinor: input.rateMinor,
    rateBasis: input.rateBasis as RateBasis,
    onHireFrom,
    ...(input.expectedOffHire ? { expectedOffHire: input.expectedOffHire } : {}),
    ...(input.minimumHireDays !== undefined ? { minimumHireDays: input.minimumHireDays } : {}),
    ...(input.purpose?.trim() ? { purpose: input.purpose.trim() } : {}),
    status: 'ON_HIRE',
    registeredBy: ctx.auth.actorId,
    registeredAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: 'PLANT_ON_HIRED',
    entity: { refType: 'PlantItem', refId: item.id },
    nextState: item as unknown as Record<string, unknown>,
  });
  return item;
}

export function offHirePlant(ctx: EngineContext, input: { plantId: string; offHiredOn: string; reason?: string }): PlantItem {
  authorise(ctx, 'FIELD_EXECUTION', 'U', { lifecyclePhase: currentPhase(ctx) });
  const item = requireItem(ctx, input.plantId);
  if (item.status === 'OFF_HIRE') {
    throw new DomainError('PLANT_ALREADY_OFF_HIRE', `${item.description} was off-hired on ${item.offHiredOn}`, 409);
  }
  const offHiredOn = requireDate(input.offHiredOn, 'offHiredOn');
  if (offHiredOn < item.onHireFrom) {
    throw new DomainError('PLANT_OFF_HIRE_BEFORE_ON_HIRE', `${item.description} came on hire on ${item.onHireFrom}; it cannot go off before that`);
  }
  const days = daysInclusive(item.onHireFrom, offHiredOn);
  const shortfall = item.minimumHireDays !== undefined && days < item.minimumHireDays ? item.minimumHireDays - days : undefined;
  const updated: PlantItem = {
    ...item,
    status: 'OFF_HIRE',
    offHiredOn,
    ...(input.reason?.trim() ? { offHireReason: input.reason.trim() } : {}),
    ...(shortfall !== undefined ? { minimumHireShortfallDays: shortfall } : {}),
    offHiredBy: ctx.auth.actorId,
  };
  write(ctx, {
    eventType: 'PLANT_OFF_HIRED',
    entity: { refType: 'PlantItem', refId: item.id },
    nextState: updated as unknown as Record<string, unknown>,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
  });
  return updated;
}

type DiaryLine = { diaryDate: string; description: string; hoursWorked: number; hoursIdle: number };

/** Whether a diary or observation line names this item. Reference first, then description either way round. */
function names(item: PlantItem, text: string): boolean {
  const line = normalise(text);
  if (line === '') return false;
  if (item.reference && normalise(item.reference).length >= 3 && line.includes(normalise(item.reference))) return true;
  const description = normalise(item.description);
  return description.length >= 3 && (line.includes(description) || description.includes(line));
}

export function plantPosition(ctx: EngineContext, today = new Date().toISOString().slice(0, 10)): PlantPosition {
  authorise(ctx, 'FIELD_EXECUTION', 'R', { lifecyclePhase: currentPhase(ctx) });
  const items = itemsOf(ctx).sort((a, b) => a.onHireFrom.localeCompare(b.onHireFrom) || a.description.localeCompare(b.description));

  const diaryLines: DiaryLine[] = ctx.ledger.list(ctx.projectId, 'SiteDiary').flatMap((record) => {
    const diaryDate = String(record.state.diaryDate ?? '').slice(0, 10);
    const plant = (record.state.plant as Array<{ description?: string; hoursWorked?: number; hoursIdle?: number }> | undefined) ?? [];
    return plant.map((line) => ({
      diaryDate,
      description: String(line.description ?? ''),
      hoursWorked: Number(line.hoursWorked ?? 0),
      hoursIdle: Number(line.hoursIdle ?? 0),
    }));
  });
  const sightings = ctx.ledger
    .list(ctx.projectId, 'SiteObservation')
    .map((record) => ({ description: String(record.state.description ?? ''), at: String(record.state.observedAt ?? '').slice(0, 10) }))
    .filter((entry) => entry.description.startsWith('Plant and equipment read from site photography'));

  const matchedLines = new Set<DiaryLine>();
  const utilisation: PlantUtilisation[] = items.map((item) => {
    const end = item.offHiredOn ?? today;
    const hireDays = Math.max(0, daysInclusive(item.onHireFrom, end));
    const inWindow = (date: string): boolean => date >= item.onHireFrom && date <= end;
    const lines = diaryLines.filter((line) => inWindow(line.diaryDate) && names(item, line.description));
    for (const line of lines) matchedLines.add(line);
    const hoursWorked = Number(lines.reduce((sum, line) => sum + line.hoursWorked, 0).toFixed(2));
    const hoursIdle = Number(lines.reduce((sum, line) => sum + line.hoursIdle, 0).toFixed(2));
    const diaryDates = [...new Set(lines.map((line) => line.diaryDate))].sort();
    const lastDiaryDate = diaryDates.at(-1);
    const total = hoursWorked + hoursIdle;
    const utilisationPercent = total > 0 ? Math.round((hoursWorked / total) * 1000) / 10 : undefined;

    let costToDateMinor: number | undefined;
    let costBasis: string;
    const chargeableDays = item.status === 'OFF_HIRE' && item.minimumHireDays !== undefined ? Math.max(hireDays, item.minimumHireDays) : hireDays;
    if (item.rateBasis === 'DAY') {
      costToDateMinor = chargeableDays * item.rateMinor;
      costBasis = `${chargeableDays} day${chargeableDays === 1 ? '' : 's'} at the day rate${chargeableDays > hireDays ? ', the minimum term billing beyond the hire' : ''}`;
    } else if (item.rateBasis === 'WEEK') {
      const weeks = Math.ceil(chargeableDays / 7);
      costToDateMinor = weeks * item.rateMinor;
      costBasis = `${weeks} whole week${weeks === 1 ? '' : 's'} at the week rate${chargeableDays > hireDays ? ', the minimum term billing beyond the hire' : ''}`;
    } else if (lines.length > 0) {
      costToDateMinor = Math.round(hoursWorked * item.rateMinor);
      costBasis = `${hoursWorked} hours worked from ${diaryDates.length} diary day${diaryDates.length === 1 ? '' : 's'} at the hour rate`;
    } else {
      costBasis = 'Charged by the hour and named in no diary, so the cost to date cannot be derived. Record the hours in the site diary.';
    }
    const standingCostMinor =
      costToDateMinor !== undefined && total > 0 && item.rateBasis !== 'HOUR' ? Math.round((costToDateMinor * hoursIdle) / total) : undefined;

    const seen = sightings.filter((entry) => inWindow(entry.at) && names(item, entry.description));
    const lastSeen = seen.map((entry) => entry.at).sort().at(-1);

    let idleAlert: string | undefined;
    if (item.status === 'ON_HIRE' && hireDays >= 7) {
      const sinceDiary = lastDiaryDate ? daysInclusive(lastDiaryDate, today) - 1 : hireDays;
      if (sinceDiary >= 7) {
        idleAlert = lastDiaryDate
          ? `On hire and named in no site diary for ${sinceDiary} days; the last was ${lastDiaryDate}.`
          : `On hire ${hireDays} days and named in no site diary at all. Either it is standing or the diary is not recording it.`;
      }
    }

    return {
      ...item,
      hireDays,
      ...(costToDateMinor !== undefined ? { costToDateMinor } : {}),
      costBasis,
      hoursWorked,
      hoursIdle,
      diaryDays: diaryDates.length,
      ...(lastDiaryDate ? { lastDiaryDate } : {}),
      ...(utilisationPercent !== undefined ? { utilisationPercent } : {}),
      ...(standingCostMinor !== undefined ? { standingCostMinor } : {}),
      sightings: seen.length,
      ...(lastSeen ? { lastSeen } : {}),
      ...(idleAlert ? { idleAlert } : {}),
    };
  });

  const unregisteredByName = new Map<string, PlantPosition['unregistered'][number]>();
  for (const line of diaryLines) {
    if (matchedLines.has(line) || line.description.trim() === '') continue;
    const key = normalise(line.description);
    const entry = unregisteredByName.get(key) ?? { description: line.description.trim(), hoursWorked: 0, hoursIdle: 0, days: 0, lastDate: line.diaryDate };
    entry.hoursWorked = Number((entry.hoursWorked + line.hoursWorked).toFixed(2));
    entry.hoursIdle = Number((entry.hoursIdle + line.hoursIdle).toFixed(2));
    entry.days += 1;
    if (line.diaryDate > entry.lastDate) entry.lastDate = line.diaryDate;
    unregisteredByName.set(key, entry);
  }

  const onHire = utilisation.filter((item) => item.status === 'ON_HIRE');
  const weeklyRunRateMinor = onHire.reduce((sum, item) => sum + (item.rateBasis === 'DAY' ? item.rateMinor * 5 : item.rateBasis === 'WEEK' ? item.rateMinor : 0), 0);
  const costToDateMinor = utilisation.reduce((sum, item) => sum + (item.costToDateMinor ?? 0), 0);
  const standingCostMinor = utilisation.reduce((sum, item) => sum + (item.standingCostMinor ?? 0), 0);
  const alerts = utilisation.filter((item) => item.idleAlert).length;
  const hourly = onHire.filter((item) => item.rateBasis === 'HOUR').length;

  const statement =
    items.length === 0
      ? 'Nothing on the plant register. Plant named in the site diary is listed below as unregistered until it is on-hired here.'
      : `${onHire.length} item${onHire.length === 1 ? '' : 's'} on hire, running at about ${(weeklyRunRateMinor / 100).toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })} a week` +
        `${hourly > 0 ? ` before ${hourly} charged by the hour` : ''}. ` +
        `${(costToDateMinor / 100).toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })} to date` +
        `${standingCostMinor > 0 ? `, of which ${(standingCostMinor / 100).toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })} was paid for standing time the diary recorded` : ''}. ` +
        `${alerts > 0 ? `${alerts} item${alerts === 1 ? ' has' : 's have'} not appeared in a diary for a week or more. ` : ''}` +
        `${unregisteredByName.size > 0 ? `${unregisteredByName.size} plant description${unregisteredByName.size === 1 ? '' : 's'} in the diary match nothing on the register.` : ''}`.trim();

  return {
    asOf: today,
    items: utilisation,
    onHire: onHire.length,
    weeklyRunRateMinor,
    costToDateMinor,
    standingCostMinor,
    unregistered: [...unregisteredByName.values()].sort((a, b) => b.hoursWorked + b.hoursIdle - (a.hoursWorked + a.hoursIdle)),
    alerts,
    statement,
  };
}
