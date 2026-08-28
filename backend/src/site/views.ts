import { RecordJournal } from '../goldenthread/journal.ts';
import { config } from '../config.ts';

/**
 * How many people have read each post.
 *
 * **Not Golden Thread events, deliberately.** A page view is not a governed act
 * — nobody decides anything by it, nothing is evidenced against it, and one line
 * per view on the hash chain would bury the record of what the company actually
 * did under a stream of traffic. It uses the same mechanism the ACU wallet uses
 * for the same reason: `RecordJournal` is a durable line-delimited log for
 * records that are deliberately outside the chain.
 *
 * **What this counts, said plainly, because a view count is the most
 * over-claimed number on any content screen.** It counts *server-rendered
 * requests for a published post's page*, one per request, with no browser
 * involved. That means:
 *
 * - a bot, a crawler and a link preview all count as a view;
 * - one person reading a post four times counts four times;
 * - somebody who reads the whole post with JavaScript off still counts, which
 *   is more than most analytics can say;
 * - nothing here identifies anybody. No cookie, no address, no fingerprint. The
 *   record is a slug and a day, and that is the whole of it.
 *
 * So the number is a measure of **requests**, not of readers, and the console
 * says so rather than labelling it "readers" and letting somebody quote it in a
 * meeting. A count that is honest about being a request count is worth more than
 * a bigger one nobody can defend.
 *
 * If somebody later wants deduplicated readers, that needs a cookie and a
 * consent decision, and the consent machinery already exists for the analytics
 * tag. It is not built here and is not implied by anything on the screen.
 */

/** One request for one post's page. A slug and a day; nothing about a person. */
export type PostView = { slug: string; day: string; at: string };

let journal: RecordJournal<PostView> | undefined;

/** Counts held in memory, rebuilt from the journal at boot. */
const totals = new Map<string, number>();
const daily = new Map<string, Map<string, number>>();

function remember(view: PostView): void {
  totals.set(view.slug, (totals.get(view.slug) ?? 0) + 1);
  const days = daily.get(view.slug) ?? new Map<string, number>();
  days.set(view.day, (days.get(view.day) ?? 0) + 1);
  daily.set(view.slug, days);
}

/**
 * Attach the durable log and replay what it holds.
 *
 * Called once at boot beside the ledger journal. With no journal path
 * configured, views are counted in memory and lost on restart — which is
 * correct for a test process, and is reported by `viewsPosition` rather than
 * left for somebody to discover when the numbers reset.
 */
export function attachViewJournal(path: string, options: { fsync?: boolean } = {}): { restored: number; truncated: boolean } {
  journal = new RecordJournal<PostView>(path, options);
  const { records, truncated } = journal.read();
  totals.clear();
  daily.clear();
  for (const record of records) remember(record);
  return { restored: records.length, truncated };
}

/**
 * Record one view.
 *
 * Never throws. A blog post that fails to render because its view counter could
 * not be written would be the analytics tail wagging the publishing dog — the
 * page is the product, the count is not.
 */
export function recordView(slug: string): void {
  const now = new Date();
  const view: PostView = { slug, day: now.toISOString().slice(0, 10), at: now.toISOString() };
  remember(view);
  try {
    journal?.append(view);
  } catch {
    // Deliberately swallowed, and deliberately not logged per request: a broken
    // volume would otherwise turn every page view into a line of noise in the
    // log. `viewsPosition().durable` is where the absence shows up.
  }
}

export function viewsFor(slug: string): number {
  return totals.get(slug) ?? 0;
}

export type ViewsPosition = {
  /** Whether counts survive a restart. */
  durable: boolean;
  total: number;
  bySlug: { slug: string; views: number; last30: number }[];
  /** Estate-wide daily totals over the window, for a line. */
  daily: { date: string; views: number }[];
  windowDays: number;
  note: string;
};

const WINDOW_DAYS = 30;

export function viewsPosition(windowDays = WINDOW_DAYS): ViewsPosition {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
  const estateDaily = new Map<string, number>();

  const bySlug = [...totals.entries()]
    .map(([slug, views]) => {
      let last30 = 0;
      for (const [day, count] of daily.get(slug) ?? []) {
        if (day < since) continue;
        last30 += count;
        estateDaily.set(day, (estateDaily.get(day) ?? 0) + count);
      }
      return { slug, views, last30 };
    })
    .sort((a, b) => b.views - a.views);

  return {
    durable: journal !== undefined,
    total: bySlug.reduce((sum, entry) => sum + entry.views, 0),
    bySlug,
    daily: [...estateDaily.entries()].map(([date, views]) => ({ date, views })).sort((a, b) => a.date.localeCompare(b.date)),
    windowDays,
    note:
      'Server-rendered requests for a post’s page, one per request. A crawler counts; one person reading twice counts ' +
      'twice; nobody is identified, because no cookie, address or fingerprint is recorded — the log holds a slug and a ' +
      'day. It is a count of requests, not of readers, and is labelled that way everywhere it appears.' +
      (journal ? '' : ' No journal is attached on this process, so these counts are lost on restart.'),
  };
}

/** The path the view log lives at, derived from the ledger's so they share a volume. */
export function viewJournalPath(): string {
  return config.ledger.journalPath === '' ? '' : `${config.ledger.journalPath}.views`;
}

/** Test isolation only. */
export function resetViews(): void {
  journal = undefined;
  totals.clear();
  daily.clear();
}
