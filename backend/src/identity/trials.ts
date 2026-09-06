import { config } from '../config.ts';

/**
 * Email domains that have already taken a free trial.
 *
 * Every `createTenant` on a free package grants the trial credit, and signup
 * creates a tenancy per verified address. Nothing counted, so a handful of
 * addresses at one company — or one address with plus-suffixes, or a
 * disposable-mail domain — took a fresh grant each time. Individually small;
 * automated, unbounded, and every pound of it buys real provider compute.
 *
 * Keyed on the domain rather than the address for exactly that reason: the
 * address is trivially varied and the domain is the organisation, which is what
 * the trial is offered to. Free-mail domains are the deliberate exception —
 * refusing a second trial to everyone at gmail.com would refuse it to every
 * sole trader in the country — so those are counted per address instead.
 *
 * **Rebuilt at boot, not forgotten.** This lived only in `signup.ts` and was
 * cleared on restart, so every deploy re-opened a fresh grant for every domain
 * that had already taken one — a money leak an automated signup could farm on
 * a schedule. It is its own module so `Platform.rehydrate` can count the
 * grants the wallets record without importing the signup flow.
 */
const trialsTaken = new Map<string, number>();

/**
 * Domains where one organisation does not mean one customer.
 *
 * A trial per address is right here; a trial per domain would be one trial for
 * every sole trader using a free mailbox, which is most of them.
 */
const SHARED_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'gmx.com',
  'yandex.com',
]);

function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The key a trial is counted against.
 *
 * Plus-addressing is stripped: `rowan+one@acme.com` and `rowan+two@acme.com`
 * are one mailbox at every major provider, and treating them as two customers
 * is the cheapest way to farm the grant.
 */
export function trialKey(email: string): string {
  const [local = '', domain = ''] = normaliseEmail(email).split('@');
  if (SHARED_MAIL_DOMAINS.has(domain)) {
    const withoutTag = local.split('+')[0] ?? local;
    // Dots are not significant in a Gmail address either.
    return `${domain === 'gmail.com' || domain === 'googlemail.com' ? withoutTag.replaceAll('.', '') : withoutTag}@${domain}`;
  }
  return domain;
}

/** How many free trials this organisation or mailbox has already taken. */
export function trialsTakenBy(email: string): number {
  return trialsTaken.get(trialKey(email)) ?? 0;
}

/** Record that a trial has been taken. Called once when a tenancy is provisioned, and once per grant on the record at boot. */
export function recordTrialTaken(email: string): void {
  const key = trialKey(email);
  trialsTaken.set(key, (trialsTaken.get(key) ?? 0) + 1);
}

/** Whether this address is entitled to the free grant at all. */
export function trialGrantAllowed(email: string): boolean {
  return trialsTakenBy(email) < config.billing.trialsPerOrganisation;
}

/** Forget every count. Tests, and the moment before a boot rebuilds them from the record. */
export function resetTrials(): void {
  trialsTaken.clear();
}
