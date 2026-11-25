import { DomainError } from '../../core/errors.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import { requireModule } from '../../identity/modules.ts';
import type { PermissionCode } from '../../identity/roles.ts';

/**
 * The integrated management system's shared ground: the module and permission
 * guard, the company record it is written on, the people it is read against,
 * and the company's own settings.
 *
 * An IMS belongs to the company, not to a project, so every IMS record is
 * written on the tenancy's governance record — the same place the supplier
 * register already lives — and reads the delivery records every project keeps
 * (incidents, NCRs, competencies) without copying them.
 */

export function guard(ctx: EngineContext, code: PermissionCode): void {
  requireModule(ctx.grantedModules, 'IMS');
  authorise(ctx, 'MANAGEMENT_SYSTEM', code);
  if (ctx.projectId !== companyRecordOf(ctx.tenantId)) {
    // The system is the company's. Written on a delivery project it would be one
    // project's system, invisible to the next, which is the opposite of the point.
    throw new DomainError('IMS_COMPANY_RECORD', 'The management system is kept on the company’s record, not on a project.', 409);
  }
}

export const companyRecordOf = (tenantId: string): string => `${tenantId}-governance`;

export const states = <T>(ctx: EngineContext, type: string): T[] => ctx.ledger.list(ctx.projectId, type).map((record) => record.state as unknown as T);

export const stateOf = <T>(ctx: EngineContext, type: string, id: string): (T & { version: number }) | undefined => {
  const record = ctx.ledger.get({ refType: type, refId: id });
  if (!record || record.projectId !== ctx.projectId) return undefined;
  return { ...(record.state as unknown as T), version: record.version };
};

export function text(value: unknown, field: string, min: number, what: string, max = 20_000): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length < min) throw new DomainError('IMS_FIELD_REQUIRED', what, 422, [{ field, message: what }]);
  if (trimmed.length > max) throw new DomainError('IMS_FIELD_TOO_LONG', `${field} is limited to ${max} characters.`, 422, [{ field, message: `at most ${max} characters` }]);
  return trimmed;
}

export const optionalText = (value: unknown, max = 4000): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed.slice(0, max) : undefined;
};

export function isoDate(value: unknown, field: string, what = 'A date, YYYY-MM-DD.'): string {
  const date = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new DomainError('IMS_DATE', what, 422, [{ field, message: 'YYYY-MM-DD' }]);
  }
  return date;
}

export const today = (): string => new Date().toISOString().slice(0, 10);

export function addMonths(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** The next reference in a series: PRO-001, AUD-002. */
export function nextReference(ctx: EngineContext, type: string, prefix: string, filter?: (state: Record<string, unknown>) => boolean): string {
  const count = ctx.ledger.list(ctx.projectId, type).filter((record) => !filter || filter(record.state)).length;
  return `${prefix}-${String(count + 1).padStart(3, '0')}`;
}

// =============================================================================
// People: who is in the company, as the identity layer knows them
// =============================================================================

/**
 * The company's people, passed in by the caller.
 *
 * Identities are held by the platform, not on the ledger, so the engine cannot
 * look them up itself; the route hands over the tenancy's own directory. Only
 * active people count towards who must acknowledge a procedure or hold a
 * competence.
 */
export type Person = { id: string; name: string; roles: readonly string[]; status?: string };

export const activePeople = (people: readonly Person[]): Person[] => people.filter((person) => !person.status || person.status === 'ACTIVE');

export const nameOf = (people: readonly Person[], id: string | undefined): string =>
  id ? (people.find((person) => person.id === id)?.name ?? id) : '—';

// =============================================================================
// The company's own settings
// =============================================================================

/**
 * Decisions the standards leave to the organisation.
 *
 * ISO 14001 6.1.2 has the organisation set its own criteria for a significant
 * aspect; how often a procedure is reviewed and a supplier re-evaluated are the
 * company's calls too. The values below are only where a new system starts —
 * every one is the company's to change, and the change is on the record.
 */
export type ImsSettings = {
  /** Months between periodic reviews of a controlled document. */
  documentReviewMonths: number;
  /** Severity × likelihood at or above which an environmental aspect is significant. */
  aspectSignificanceThreshold: number;
  /** Months between performance evaluations of an approved supplier. */
  supplierEvaluationMonths: number;
  /** Average score (1–5) below which a supplier's approval is put to review. */
  supplierReviewBelow: number;
  /** Days ahead a competence about to expire is shown as expiring. */
  competenceWarningDays: number;
  updatedBy?: string;
  updatedAt?: string;
  note?: string;
};

export const STARTING_SETTINGS: ImsSettings = {
  documentReviewMonths: 12,
  aspectSignificanceThreshold: 12,
  supplierEvaluationMonths: 6,
  supplierReviewBelow: 3,
  competenceWarningDays: 60,
};

const SETTING_LIMITS: Record<keyof Omit<ImsSettings, 'updatedBy' | 'updatedAt' | 'note'>, [number, number]> = {
  documentReviewMonths: [1, 60],
  aspectSignificanceThreshold: [1, 25],
  supplierEvaluationMonths: [1, 36],
  supplierReviewBelow: [1, 5],
  competenceWarningDays: [1, 365],
};

export function settings(ctx: EngineContext): ImsSettings {
  return stateOf<ImsSettings>(ctx, 'ImsSettings', `${ctx.tenantId}-ims-settings`) ?? STARTING_SETTINGS;
}

export function setSettings(ctx: EngineContext, input: Partial<ImsSettings> & { note: string }): ImsSettings {
  guard(ctx, 'A');
  const note = text(input.note, 'note', 5, 'Say why the setting is changed — it is a decision about how the system works.');
  const current = settings(ctx);
  const next: ImsSettings = { ...current };
  for (const key of Object.keys(SETTING_LIMITS) as Array<keyof typeof SETTING_LIMITS>) {
    const value = input[key];
    if (value === undefined) continue;
    const [min, max] = SETTING_LIMITS[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw new DomainError('IMS_SETTING', `${key} is a number from ${min} to ${max}.`, 422, [{ field: key, message: `${min}–${max}` }]);
    }
    next[key] = value;
  }
  next.updatedBy = ctx.auth.actorId;
  next.updatedAt = new Date().toISOString();
  next.note = note;
  write(ctx, { eventType: 'IMS_SETTINGS_SET', entity: { refType: 'ImsSettings', refId: `${ctx.tenantId}-ims-settings` }, nextState: next as unknown as Record<string, unknown>, reason: note });
  return next;
}
