import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES } from '../api/routes.ts';
import type { RequestContext } from '../api/middleware.ts';
import { PACKAGES } from '../billing/seats.ts';
import { config } from '../config.ts';
import { NotFoundError } from '../core/errors.ts';
import type { AuthContext } from '../identity/auth.ts';
import type { Platform } from '../platform.ts';
import { render } from '../site/index.ts';
import { partners, position, programmePosition, type Partner, type PartnerPosition, type ProgrammePosition } from './partners.ts';

/**
 * The growth programme read as a whole: whether a referral can be attributed
 * at all, whether the codes out there are earning, and what the operator owes
 * and to whom.
 *
 * `partners.ts` records agreements and walks receipts for one partner at a
 * time. This module stands back from it, the way `site/visibility.ts` stands
 * back from one post: does the signup form actually carry `?ref=` through to
 * the route; does the public page say what the programme is; is anybody
 * enrolled; are codes arriving that nobody holds; which codes have brought
 * nothing; is what has been earned being paid within a reasonable time; does a
 * bounty ever exceed what the platform receives for a first month.
 *
 * Every check reads the real thing — the served signup script, the route
 * table, the rendered page, the agreements, the receipts. The score is the
 * weights of what passes and decides nothing: commission is computed from
 * settled receipts whatever the score says, and that rule is not this
 * module's to soften.
 */

export type ProgrammeFinding = { check: string; ok: boolean; weight: number; detail: string };

/** A code that has brought nothing for this long is a link nobody is sending. */
export const IDLE_DAYS = 30;
/** Earnings unpaid this long after the receipt that produced them are overdue. */
export const SETTLEMENT_DAYS = 30;
/** A programme reads as alive while something attributed arrived inside this window. */
export const FRESH_DAYS = 90;
/** Referred tenancies that go on to pay, below which the traffic is not the audience. */
export const CONVERSION_FLOOR_PERCENT = 25;

const FRONTEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'frontend');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function daysBetween(from: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(from).getTime()) / 86_400_000);
}

/** The cheapest package that costs anything: what one converted tenancy pays for its first month, at least. */
function lowestPaidMonthlyMinor(): number {
  return Math.min(...Object.values(PACKAGES).map((pkg) => pkg.monthlyPriceMinor).filter((price) => price > 0));
}

/** The newest settled receipt on any of a partner's referred tenancies, or null. */
function newestReceiptAt(platform: Platform, entry: PartnerPosition): string | null {
  let newest: string | null = null;
  for (const referral of entry.referrals) {
    for (const receipt of platform.paymentReceipts(referral.tenantId)) {
      if (newest === null || receipt.recordedAt > newest) newest = receipt.recordedAt;
    }
  }
  return newest;
}

/** Earnings owed and produced by a receipt older than the settlement window. */
function overdue(platform: Platform, entry: PartnerPosition, now: Date): boolean {
  if (entry.owedMinor <= 0) return false;
  const newest = newestReceiptAt(platform, entry);
  return newest !== null && daysBetween(newest, now) > SETTLEMENT_DAYS;
}

export function programmeSweep(platform: Platform, programme: ProgrammePosition, now: Date = new Date()): ProgrammeFinding[] {
  const everyone = [...programme.partners, ...programme.influencers];
  const active = everyone.filter((entry) => entry.status === 'ACTIVE');

  // 1. The link works end to end: the served signup script reads `?ref=` and
  // the signup route accepts what it sends.
  const signupScript = join(FRONTEND_DIR, 'pages', 'signup.js');
  const scriptReadsRef = existsSync(signupScript) && /get\('ref'\)/.test(readFileSync(signupScript, 'utf8'));
  const signupRoute = ROUTES.find((route) => route.method === 'POST' && route.pattern === '/v1/signup');
  const schema = signupRoute?.schema as { properties?: Record<string, unknown> } | undefined;
  const routeTakesCode = Boolean(schema?.properties && 'referralCode' in schema.properties);

  // 2. The public page names the mechanism.
  let pageOk = false;
  try {
    const html = render('/growth', platform, { locale: 'en-GB' } as unknown as RequestContext);
    pageOk = html.includes('?ref=CODE') && html.includes('href="/get-started"');
  } catch {
    pageOk = false;
  }

  // 5. Codes that have brought nothing in the idle window.
  const idle = active.filter((entry) => entry.referredCount === 0 && daysBetween(entry.agreedAt, now) > IDLE_DAYS);

  // 6. Conversion across everything referred.
  const referred = programme.totals.referredTenancies;
  const converted = programme.totals.convertedTenancies;
  const conversion = referred === 0 ? null : Math.round((converted / referred) * 100);

  // 7. A bounty larger than a first month pays out more than arrives.
  const floor = lowestPaidMonthlyMinor();
  const richBounties = programme.influencers.filter((entry) => (entry.bountyMinor ?? 0) > floor);

  // 8. Paid more than earned.
  const overpaid = everyone.filter((entry) => entry.paidMinor > entry.earnedMinor);

  // 9. Owed and old.
  const late = everyone.filter((entry) => overdue(platform, entry, now));

  // 10. Reachable.
  const unreachable = active.filter((entry) => !EMAIL.test(entry.email));

  // 11. Something attributed recently.
  const newestJoin = everyone.flatMap((entry) => entry.referrals.map((referral) => referral.joinedAt)).sort().at(-1);
  const joinAge = newestJoin ? daysBetween(newestJoin, now) : Number.POSITIVE_INFINITY;

  return [
    {
      check: 'Referral link',
      ok: scriptReadsRef && routeTakesCode,
      weight: 12,
      detail:
        scriptReadsRef && routeTakesCode
          ? `${config.publicBaseUrl}/app/signup?ref=CODE reads the code and the signup route fixes it on the tenancy.`
          : `${scriptReadsRef ? '' : 'The served signup form does not read ?ref=. '}${routeTakesCode ? '' : 'The signup route does not accept referralCode.'}`.trim(),
    },
    {
      check: 'Public programme page',
      ok: pageOk,
      weight: 8,
      detail: pageOk ? '/growth says how a code works and links to the signup form.' : '/growth does not describe the referral link or does not link to Get started.',
    },
    {
      check: 'Enrolled',
      ok: active.length > 0,
      weight: 8,
      detail: active.length > 0 ? `${active.length} active agreement${active.length === 1 ? '' : 's'} of ${everyone.length} enrolled.` : 'Nobody is enrolled, so every code that arrives is unattributed.',
    },
    {
      check: 'Unattributed codes',
      ok: programme.unattributed.length === 0,
      weight: 12,
      detail:
        programme.unattributed.length === 0
          ? 'Every referral code on a tenancy belongs to somebody in the programme.'
          : `${programme.unattributed.length} tenanc${programme.unattributed.length === 1 ? 'y' : 'ies'} arrived with a code nobody holds: ${[...new Set(programme.unattributed.map((entry) => entry.code))].join(', ')}. Somebody is sending traffic for no credit.`,
    },
    {
      check: 'Idle codes',
      ok: idle.length === 0,
      weight: 10,
      detail: idle.length === 0 ? `No active code has gone ${IDLE_DAYS} days without bringing a tenancy.` : `${idle.map((entry) => `${entry.code} (${entry.name})`).join(', ')} — active over ${IDLE_DAYS} days with nothing attributed. Send the kit, or pause the agreement.`,
    },
    {
      check: 'Conversion',
      ok: conversion !== null && conversion >= CONVERSION_FLOOR_PERCENT,
      weight: 10,
      detail:
        conversion === null
          ? 'Nothing referred yet, so nothing to convert.'
          : `${converted} of ${referred} referred tenancies have paid something (${conversion}%); under ${CONVERSION_FLOOR_PERCENT}% the traffic is not the audience.`,
    },
    {
      check: 'Bounty economics',
      ok: richBounties.length === 0,
      weight: 8,
      detail:
        richBounties.length === 0
          ? `Every bounty is at or under the cheapest paid month (${(floor / 100).toFixed(2)}), so a conversion never pays out more than arrives.`
          : `${richBounties.map((entry) => `${entry.name} ${(entry.bountyMinor! / 100).toFixed(2)}`).join(', ')} exceed${richBounties.length === 1 ? 's' : ''} the cheapest paid month (${(floor / 100).toFixed(2)}).`,
    },
    {
      check: 'Payouts reconciled',
      ok: overpaid.length === 0,
      weight: 8,
      detail: overpaid.length === 0 ? 'Nobody has been paid more than they have earned.' : `Paid exceeds earned for ${overpaid.map((entry) => entry.name).join(', ')}.`,
    },
    {
      check: 'Settlement',
      ok: late.length === 0,
      weight: 10,
      detail:
        late.length === 0
          ? programme.totals.owedMinor > 0
            ? `${(programme.totals.owedMinor / 100).toFixed(2)} owed, all of it earned inside the last ${SETTLEMENT_DAYS} days.`
            : 'Nothing is owed.'
          : `${late.map((entry) => `${entry.name} ${(entry.owedMinor / 100).toFixed(2)}`).join(', ')} — earned on receipts older than ${SETTLEMENT_DAYS} days and not yet recorded as paid.`,
    },
    {
      check: 'Contactable',
      ok: unreachable.length === 0,
      weight: 6,
      detail: unreachable.length === 0 ? 'Every active agreement has a reachable address.' : `No usable address for ${unreachable.map((entry) => entry.name).join(', ')}.`,
    },
    {
      check: 'Fresh attribution',
      ok: joinAge <= FRESH_DAYS,
      weight: 8,
      detail: newestJoin ? `Newest attributed tenancy joined ${joinAge} day${joinAge === 1 ? '' : 's'} ago; the programme reads as alive inside ${FRESH_DAYS}.` : 'No tenancy has ever arrived on a code.',
    },
  ];
}

export type HealthScore = { score: number; band: 'STRONG' | 'WORKABLE' | 'WEAK'; passing: number; total: number; summary: string };

export function healthScore(findings: readonly ProgrammeFinding[]): HealthScore {
  const total = findings.reduce((sum, finding) => sum + finding.weight, 0);
  const earned = findings.filter((finding) => finding.ok).reduce((sum, finding) => sum + finding.weight, 0);
  const score = total === 0 ? 0 : Math.round((earned / total) * 100);
  const failing = findings.filter((finding) => !finding.ok).sort((a, b) => b.weight - a.weight);
  return {
    score,
    band: score >= 90 ? 'STRONG' : score >= 65 ? 'WORKABLE' : 'WEAK',
    passing: findings.length - failing.length,
    total: findings.length,
    summary:
      failing.length === 0
        ? 'Every check passes. Codes attribute, codes earn, and what is earned is being paid.'
        : `${failing.length} check${failing.length === 1 ? '' : 's'} failing, costliest first: ${failing.map((finding) => finding.check).join(', ')}.`,
  };
}

// --- The kit ------------------------------------------------------------------

export type KitEntry = { channel: string; label: string; url?: string; text: string };

/**
 * What a partner pastes where: their links, one per paid package, and copy
 * that says what the product does without a figure the platform does not
 * measure — the rule the public /growth page holds creators to.
 */
export function referralKit(partner: Pick<Partner, 'code' | 'kind' | 'name'>): KitEntry[] {
  const base = config.publicBaseUrl.replace(/\/$/, '');
  const link = `${base}/app/signup?ref=${encodeURIComponent(partner.code)}`;
  const packages = Object.entries(PACKAGES)
    .filter(([, pkg]) => pkg.monthlyPriceMinor > 0)
    .map(([key, pkg]) => ({ channel: `package:${key}`, label: `${pkg.label} link`, url: `${base}/app/signup?package=${key}&ref=${encodeURIComponent(partner.code)}`, text: `${pkg.label}: ${base}/app/signup?package=${key}&ref=${encodeURIComponent(partner.code)}` }));
  return [
    { channel: 'link', label: 'Referral link', url: link, text: link },
    ...packages,
    {
      channel: 'email',
      label: 'Email',
      text:
        `Subject: A construction operating system worth trying\n\n` +
        `CONSTRUX holds a project's whole record — programme, cost, contracts, risk, field, handover — as one append-only, hash-chained ` +
        `log that replays from its own history. You can start an account yourself and run a payment cycle through to its final ` +
        `date on the demo before you decide.\n\nStart here: ${link}\n\n` +
        `Disclosure: ${partner.kind === 'PARTNER' ? 'I am a CONSTRUX partner and receive a share of what accounts I introduce pay.' : 'I am paid a fixed amount for each account I introduce that goes on to pay.'}`,
    },
    {
      channel: 'linkedin',
      label: 'LinkedIn',
      text:
        `One record from concept to the thirtieth year of operation, computed rather than typed, and a payment cycle that refuses ` +
        `to be paid twice. If you run projects, try it on the demo first: ${link}\n\n` +
        `#construction #projectcontrols #goldenthread\n\n` +
        `(${partner.kind === 'PARTNER' ? 'Partner link — I receive a share of what introduced accounts pay.' : 'Creator link — I am paid per account that goes on to pay.'})`,
    },
  ];
}

// --- The statement ------------------------------------------------------------

export type StatementRow = {
  tenancy: string;
  tenantId: string;
  receiptAt: string;
  reference: string;
  method: string;
  receiptMinor: number;
  /** This partner's earning from this receipt: the share, or the bounty on a tenancy's first receipt, else nothing. */
  earnedMinor: number;
};

/** Every receipt a partner's earnings rest on, one row each, oldest first. */
export function partnerStatement(platform: Platform, entry: PartnerPosition): { rows: StatementRow[]; earnedMinor: number; paidMinor: number; owedMinor: number } {
  const rows: StatementRow[] = [];
  for (const referral of entry.referrals) {
    const receipts = [...platform.paymentReceipts(referral.tenantId)].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    receipts.forEach((receipt, index) => {
      rows.push({
        tenancy: referral.legalName,
        tenantId: referral.tenantId,
        receiptAt: receipt.recordedAt,
        reference: receipt.reference,
        method: receipt.method,
        receiptMinor: receipt.amountMinor,
        earnedMinor:
          entry.kind === 'PARTNER'
            ? Math.floor((receipt.amountMinor * (entry.commissionBps ?? 0)) / 10_000)
            : index === 0
              ? (entry.bountyMinor ?? 0)
              : 0,
      });
    });
  }
  rows.sort((a, b) => a.receiptAt.localeCompare(b.receiptAt));
  return { rows, earnedMinor: entry.earnedMinor, paidMinor: entry.paidMinor, owedMinor: entry.owedMinor };
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function partnerStatementCsv(platform: Platform, entry: PartnerPosition): string {
  const statement = partnerStatement(platform, entry);
  const terms = entry.kind === 'PARTNER' ? `${((entry.commissionBps ?? 0) / 100).toFixed(2)}% of settled receipts` : `${((entry.bountyMinor ?? 0) / 100).toFixed(2)} per paying tenancy`;
  const lines = [
    ['Partner', entry.name, 'Code', entry.code, 'Terms', terms].map(csvCell).join(','),
    ['Tenancy', 'Receipt at', 'Reference', 'Method', 'Receipt', 'Earned'].join(','),
    ...statement.rows.map((row) => [row.tenancy, row.receiptAt, row.reference, row.method, (row.receiptMinor / 100).toFixed(2), (row.earnedMinor / 100).toFixed(2)].map(csvCell).join(',')),
    '',
    ['Earned', (statement.earnedMinor / 100).toFixed(2)].join(','),
    ['Recorded as paid', (statement.paidMinor / 100).toFixed(2)].join(','),
    ['Owed', (statement.owedMinor / 100).toFixed(2)].join(','),
    ...entry.payouts.map((payout) => ['Payout', payout.at, payout.reference, (payout.amountMinor / 100).toFixed(2), payout.note ?? ''].map(csvCell).join(',')),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

/** The statement for one partner by id, with the operator's check applied by `programmePosition`. */
export function partnerStatementFor(platform: Platform, actor: AuthContext, partnerId: string): { partner: PartnerPosition; csv: string } {
  const programme = programmePosition(platform, actor);
  const entry = [...programme.partners, ...programme.influencers].find((candidate) => candidate.id === partnerId);
  if (!entry) throw new NotFoundError(`No partner ${partnerId}`);
  return { partner: entry, csv: partnerStatementCsv(platform, entry) };
}

// --- Results ------------------------------------------------------------------

export type MonthlyResult = { month: string; revenueMinor: number; earnedMinor: number; receipts: number };

/** Attributed revenue and what it earned, by calendar month of the receipt. */
export function monthlyResults(platform: Platform, programme: ProgrammePosition): MonthlyResult[] {
  const byMonth = new Map<string, MonthlyResult>();
  for (const entry of [...programme.partners, ...programme.influencers]) {
    for (const row of partnerStatement(platform, entry).rows) {
      const month = row.receiptAt.slice(0, 7);
      const bucket = byMonth.get(month) ?? { month, revenueMinor: 0, earnedMinor: 0, receipts: 0 };
      bucket.revenueMinor += row.receiptMinor;
      bucket.earnedMinor += row.earnedMinor;
      bucket.receipts += 1;
      byMonth.set(month, bucket);
    }
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

// --- Recommendations ------------------------------------------------------------

export type Recommendation = {
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  detail: string;
  action?: { label: string; command: 'enrol' | 'payout' | 'kit' | 'status' | 'deploy'; partnerId?: string; code?: string };
};

export function recommendations(platform: Platform, programme: ProgrammePosition, findings: readonly ProgrammeFinding[], now: Date = new Date()): Recommendation[] {
  const out: Recommendation[] = [];
  const everyone = [...programme.partners, ...programme.influencers];
  const byCheck = new Map(findings.map((finding) => [finding.check, finding]));

  const link = byCheck.get('Referral link');
  if (link && !link.ok) out.push({ priority: 'HIGH', title: 'The referral link does not attribute', detail: link.detail, action: { label: 'What to deploy', command: 'deploy' } });

  for (const unattributed of programme.unattributed) {
    if (out.some((item) => item.action?.code === unattributed.code)) continue;
    out.push({
      priority: 'HIGH',
      title: `Enrol or correct code ${unattributed.code}`,
      detail: `${unattributed.legalName} arrived on it and nobody holds it. Enrol the person under this exact code and the attribution is theirs from the record; or tell them the code their link should carry.`,
      action: { label: `Enrol with ${unattributed.code}`, command: 'enrol', code: unattributed.code },
    });
  }

  for (const entry of everyone.filter((candidate) => overdue(platform, candidate, now))) {
    out.push({
      priority: 'HIGH',
      title: `Pay ${entry.name} ${(entry.owedMinor / 100).toFixed(2)}`,
      detail: `Earned on receipts older than ${SETTLEMENT_DAYS} days and not yet recorded as paid. Send it, then record the bank reference here.`,
      action: { label: 'Record a payout', command: 'payout', partnerId: entry.id },
    });
  }

  for (const entry of everyone.filter((candidate) => candidate.status === 'ACTIVE' && candidate.referredCount === 0 && daysBetween(candidate.agreedAt, now) > IDLE_DAYS)) {
    out.push({
      priority: 'MEDIUM',
      title: `${entry.name} has brought nothing in ${daysBetween(entry.agreedAt, now)} days`,
      detail: 'Send them their kit — the link, one per package, and copy that discloses the relationship — or pause the agreement so the register says what is live.',
      action: { label: 'Open the kit', command: 'kit', partnerId: entry.id },
    });
  }

  const enrolled = byCheck.get('Enrolled');
  if (enrolled && !enrolled.ok) {
    out.push({ priority: 'MEDIUM', title: 'Enrol the first partner', detail: enrolled.detail, action: { label: 'Enrol a partner', command: 'enrol' } });
  }

  for (const check of ['Conversion', 'Bounty economics', 'Payouts reconciled', 'Contactable', 'Public programme page']) {
    const finding = byCheck.get(check);
    if (finding && !finding.ok && !finding.detail.startsWith('Nothing referred')) {
      out.push({ priority: finding.weight >= 10 ? 'MEDIUM' : 'LOW', title: `Fix: ${check}`, detail: finding.detail });
    }
  }

  return out.slice(0, 10);
}

// --- The position -----------------------------------------------------------------

export type GrowthPosition = {
  health: HealthScore;
  sweep: ProgrammeFinding[];
  results: {
    totals: ProgrammePosition['totals'] & { enrolled: number; conversionPercent: number | null };
    series: MonthlyResult[];
  };
  people: Array<{
    id: string;
    kind: Partner['kind'];
    name: string;
    code: string;
    status: Partner['status'];
    kit: KitEntry[];
    newestReceiptAt: string | null;
    overdue: boolean;
    idleDays: number | null;
  }>;
  recommendations: Recommendation[];
  limits: string[];
};

export function growthPosition(platform: Platform, actor: AuthContext, now: Date = new Date()): GrowthPosition {
  const programme = programmePosition(platform, actor);
  const sweep = programmeSweep(platform, programme, now);
  const everyone = [...programme.partners, ...programme.influencers];
  const referred = programme.totals.referredTenancies;
  return {
    health: healthScore(sweep),
    sweep,
    results: {
      totals: {
        ...programme.totals,
        enrolled: everyone.length,
        conversionPercent: referred === 0 ? null : Math.round((programme.totals.convertedTenancies / referred) * 100),
      },
      series: monthlyResults(platform, programme),
    },
    people: everyone.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      code: entry.code,
      status: entry.status,
      kit: referralKit(entry),
      newestReceiptAt: newestReceiptAt(platform, entry),
      overdue: overdue(platform, entry, now),
      idleDays: entry.status === 'ACTIVE' && entry.referredCount === 0 ? daysBetween(entry.agreedAt, now) : null,
    })),
    recommendations: recommendations(platform, programme, sweep, now),
    limits: [
      'Attribution is the code the signup link carried, fixed at creation. A customer who heard of the product from a partner and typed the address by hand is attributed to nobody, and no guess is made.',
      'Commission is computed from settled receipts. A signup, a trial and an unpaid invoice earn nothing, and the score cannot change that.',
      'Recording a payout records that money was sent; the platform has no outbound rail and moves none.',
    ],
  };
}

/** Exported for the route and the tests: the partners currently on the record, unpositioned. */
export { partners, position };
