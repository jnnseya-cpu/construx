import { startGateway } from './api/gateway.ts';
import { rateLimiter } from './api/middleware.ts';
import { SharedLimiter } from './api/sharedlimiter.ts';
import { assertProductionSafety, config } from './config.ts';
import { Journal, RecordJournal } from './goldenthread/journal.ts';
import { WriterLock } from './goldenthread/writerlock.ts';
import type { ACUEntry } from './billing/acu.ts';
import { startNewsletterSchedule } from './messaging/newsletter.ts';
import { startCollectionSchedule } from './billing/collection.ts';
import { drain, outboxPosition, startOutboxDrain } from './notifications/outbox.ts';
import { rehydrateKeys } from './developer/keys.ts';
import { attachViewJournal, viewJournalPath } from './site/views.ts';
import { startAssurance } from './ops/assurance.ts';
import { armRepair, startRepair } from './ops/repair.ts';
import { egressConfigured, startEgress } from './ops/otlp.ts';
import { startWatch } from './ops/watch.ts';
import { Platform } from './platform.ts';

/**
 * Process entry point. One process brings up the gateway, the ledger, the AI
 * control plane and the console.
 *
 * Boot order matters and is fixed: restore the record, *then* accept traffic.
 * Listening first would serve reads against an empty ledger for as long as the
 * replay takes, and answer "no such project" for projects that exist.
 */

const platform = new Platform();

for (const warning of assertProductionSafety()) {
  process.stderr.write(`[config warning] ${warning}\n`);
}

// --- Durability -------------------------------------------------------------

let durability = 'in memory only — every record is lost on restart';
/** Held for as long as this process is the one extending the chain. */
let writerLock: WriterLock | undefined;

if (config.ledger.journalPath !== '') {
  // Claimed before the file is read, let alone appended to.
  //
  // Two containers on one volume interleave their appends, and every event
  // after the first interleave hashes against a predecessor that is not its
  // predecessor. Nothing verifies, and nobody finds out until a replay is run
  // to prove something in a dispute. So the second process refuses to start.
  writerLock = new WriterLock(`${config.ledger.journalPath}.writer`, {
    heartbeatSeconds: config.ledger.writerHeartbeatSeconds,
  });
  try {
    const claim = writerLock.acquire();
    if (claim.taken === 'TAKEN_OVER') {
      // Said out loud. The previous holder did not release, which means it was
      // killed rather than stopped — worth knowing on the way up.
      process.stderr.write(
        `[journal] took over the writer lock from ${claim.previous?.host} (pid ${claim.previous?.pid}), ` +
          `whose last heartbeat was ${claim.previous?.heartbeatAt}. That process did not shut down cleanly.\n`,
      );
    }
    writerLock.start();
  } catch (error) {
    process.stderr.write(`\n[journal] ${(error as Error).message}\n\n`);
    process.exit(1);
  }

  const journal = new Journal(config.ledger.journalPath, { fsync: config.ledger.fsync });
  const { events, stats } = journal.read();

  if (stats.truncated) {
    // The process died between writing the last line and finishing it. That is
    // a torn write, not corruption, and the repair drops exactly one event —
    // one that was never acknowledged to any caller, because the append had not
    // returned. Said out loud rather than fixed quietly.
    process.stderr.write(
      `[journal] the final line of ${stats.path} was incomplete and has been dropped. ` +
        'That event was never acknowledged to a caller; a torn tail is the expected result of a hard stop.\n',
    );
  }

  // Verifies every chain hash and state hash as it goes, and throws rather than
  // loading a record that has been altered. Refusing to start is the correct
  // response: a platform that boots on a broken chain is one that will be asked
  // to prove something from it later.
  const { restored, entities } = platform.ledger.restore(events);
  if (stats.truncated) journal.repair(events);

  // ACU entries are a separate double-entry ledger by a settled decision —
  // folding them into the chain would create a second source of truth for
  // spend. Same mechanism, own file.
  const walletPath = `${config.ledger.journalPath}.acu`;
  const wallets = new RecordJournal<ACUEntry>(walletPath, { fsync: config.ledger.fsync });
  const { records, truncated: walletTorn } = wallets.read();
  if (walletTorn) {
    process.stderr.write(`[journal] the final line of ${walletPath} was incomplete and has been dropped.\n`);
  }

  const byTenant = new Map<string, ACUEntry[]>();
  for (const entry of records) {
    const list = byTenant.get(entry.tenantId) ?? [];
    list.push(entry);
    byTenant.set(entry.tenantId, list);
  }

  // Blog page views. A third file beside the chain and the wallet, for the same
  // reason the wallet is separate: a page view is not a governed act, and one
  // line per view on the hash chain would bury the record of what the company
  // did under a stream of traffic. With no journal path configured, views are
  // counted in memory and lost on restart — which the console reports rather
  // than leaving somebody to discover when the numbers reset.
  const viewPath = viewJournalPath();
  if (viewPath !== '') {
    const { truncated: viewsTorn } = attachViewJournal(viewPath, { fsync: config.ledger.fsync });
    if (viewsTorn) {
      process.stderr.write(`[journal] the final line of ${viewPath} was incomplete and has been dropped.\n`);
    }
  }

  // The identity every generated document goes out under. Held in a map and
  // committed to the chain; without this a restarted process holds a complete
  // record and cannot brand a single document from it.
  const brandings = platform.exports.rehydrateBranding();

  // The ledger holds the projects; this restores the people who can reach them.
  // Without it a replay produces a full record and nobody able to sign in.
  const identity = platform.rehydrate(byTenant);

  // And the credentials that can. Authentication happens before the platform
  // knows whose request it is, so it cannot use a tenant-scoped read — the keys
  // are indexed here, at boot, the same way the people are. Without this a
  // restart silently invalidates every integration.
  rehydrateKeys(platform.ledger);

  journal.open();
  wallets.open();
  platform.ledger.attachJournal(journal);
  platform.attachWalletSink((entry) => wallets.append(entry));

  durability =
    `${stats.path} — ${restored} event${restored === 1 ? '' : 's'} restored into ${entities} entities, ` +
    `${identity.users} users across ${identity.tenants} tenancies, ${records.length} ACU entries, ` +
    `${brandings} branding${brandings === 1 ? '' : 's'}`;
  if (!config.ledger.fsync) durability += ' (fsync OFF)';
}

/**
 * The first operator, if the platform has none and one is configured.
 *
 * A deployment with no operator cannot be administered: every admin route
 * demands PLATFORM_ADMIN, the only thing that creates one is the demonstration
 * seed, and the demonstration seed is switched off in production. So the
 * platform would come up, serve the public site, and never be signable into.
 *
 * Guarded on the platform holding no operator at all rather than on the address
 * being absent, so this runs exactly once in a deployment's life. Leaving the
 * variable set afterwards is harmless — the second boot finds an operator and
 * does nothing — which matters because nobody remembers to unset it.
 */
let bootstrap = 'none configured';
const configuredOperator = config.platform.operatorEmail.trim().toLowerCase();
if (configuredOperator === '') {
  bootstrap =
    platform.operators().length > 0
      ? `${platform.operators().length} on record`
      : 'NONE — nobody can sign in. Set PLATFORM_OPERATOR_EMAIL';
} else if (platform.operators().some((o) => o.email.toLowerCase() === configuredOperator)) {
  bootstrap = `${configuredOperator} — already on record (${platform.operators().length} total)`;
} else {
  const operator = platform.createOperator({
    name: config.platform.operatorName,
    email: configuredOperator,
  });
  bootstrap = `created ${operator.email} — sign in at /app to administer the platform`;
}

// Rate-limit state, shared across replicas when a backend is configured.
// Unset means the buckets stay in this process, which is correct for one
// instance and is the multiplied-limit defect for more than one.
let limiterState = 'in-process (single instance only)';
if (config.rateLimit.redisUrl !== '') {
  rateLimiter.attachShared(new SharedLimiter({ url: config.rateLimit.redisUrl }));
  limiterState = `shared via ${new URL(config.rateLimit.redisUrl).host}`;
}

/**
 * The demonstration tenancy, when this deployment offers one.
 *
 * Primed at boot rather than on the first request. The seed carries a whole
 * lifecycle and takes seconds; doing it lazily would mean the first visitor to
 * open the sign-in page waits for it with nothing on screen, and in production
 * that visitor is the one the demonstration exists for.
 *
 * It goes through the same call the console uses, so there is one bootstrap
 * rather than two — including the part that adopts an already-seeded tenancy
 * instead of building a second one after a restart.
 *
 * The consumption figure is printed because it is real money in any mode but
 * `local`: seeding runs the AI steps of a full lifecycle against whichever
 * providers are configured. An operator switching this on in production should
 * see what it cost, not discover it on an invoice.
 */
let demonstration = 'off (set DEMO_TENANCY_ENABLED=true to seed one)';
if (config.demo.enabled) {
  const before = platform.demonstrationUsers().length;
  const { getOrCreateConsoleSession } = await import('./api/routes.ts');
  const session = await getOrCreateConsoleSession(platform);
  const seeded = platform.demonstrationUsers();
  const wallet = platform.wallet(seeded[0]?.tenantId ?? '');
  demonstration =
    `${session.portfolioName} — ${seeded.length} identities, ` +
    `${before > 0 ? 'adopted from the record' : 'seeded now'}, ` +
    // The balance, not "x of y". The wallet holds the configured opening credit
    // *plus* the tier's trial grant, so reporting it against the credit alone
    // prints a number larger than its own denominator.
    `wallet ${(wallet.availableMinor() / 100).toFixed(2)} GBP available ` +
    `(opening credit ${(config.demo.acuCreditMinor / 100).toFixed(2)} plus the tier grant, less what seeding spent)`;
}

const server = await startGateway(platform, config.port);

// Anything a previous process queued and died before sending. This is the
// whole reason the outbox exists, and boot is when it matters: on a restored
// journal these are notices the platform decided to send and never did.
const owed = outboxPosition(platform).due;
if (owed > 0) {
  process.stdout.write(`[outbox] ${owed} notice${owed === 1 ? '' : 's'} queued by a previous process — delivering\n`);
  void drain(platform).then((report) => {
    process.stdout.write(
      `[outbox] ${report.sent} sent, ${report.retrying} still owed, ${report.abandoned} out of attempts\n`,
    );
  });
}
const outboxTimer = startOutboxDrain(platform);

// The platform watching its own counters. Nothing read them before this; a
// counter nobody reads is one that will be wrong for a week before anybody
// notices.
const watchTimer = startWatch(platform);

// Telemetry egress. Unset means the counters still answer the admin screens and
// still die with the container, which is the state every deployment has been in
// until now — said out loud on the banner rather than left to be discovered
// after an incident nobody could reconstruct.
const egressTimer = startEgress();

// Verifying the chain before somebody has to rely on it. Without this the first
// moment a divergence could be discovered is during a dispute, by the person
// least able to do anything about it.
const assuranceTimer = startAssurance(platform);

// Auto-repair, bounded to restart and reroute. Handed a function rather than a
// timer handle, so it can re-arm the real drain rather than clear one it could
// not replace.
armRepair(() => startOutboxDrain(platform));
const repairTimer = startRepair(platform);

/**
 * The subscription collection cycle.
 *
 * Off unless armed. A billing timer that starts itself on a laptop, or on a
 * staging box restored from a production journal, raises charges against real
 * tenancies — so arming it is a deliberate act on a deployment.
 */
const collection = startCollectionSchedule(platform, (report) => {
  process.stdout.write(
    `[billing] ${report.raised} charge(s) raised, ${report.settled} settled, ${report.failed} unpaid, ` +
      `${report.suspended} tenancy(ies) suspended\n`,
  );
  for (const stopped of report.suspendedTenants) {
    process.stdout.write(`[billing] suspended ${stopped.tenantId}: ${stopped.because}\n`);
  }
});

const newsletter = startNewsletterSchedule(platform, (report) => {
  process.stdout.write(
    `[newsletter] ${report.campaign.week} issued — ${report.sent} sent, ${report.recorded} recorded, ${report.failed} failed\n`,
  );
});

process.stdout.write(
  [
    '',
    '  CONSTRUX — Construction Operating System',
    `  Site         http://localhost:${config.port}/`,
    `  Console      http://localhost:${config.port}/app`,
    `  API routes   http://localhost:${config.port}/v1/routes`,
    `  Rate limits  ${limiterState}`,
    `  Health       http://localhost:${config.port}/readyz`,
    `  Telemetry    ${
      egressConfigured()
        ? `shipping to ${config.otlp.endpoint} every ${config.otlp.intervalSeconds}s`
        : 'local only — counters and the security stream die with this container'
    }`,
    `  Ledger       ${durability}`,
    `  Evidence     ${
      platform.evidence.configured
        ? `${platform.evidence.backend} — up to ${Math.round(config.evidence.maxBytes / 1_048_576)}MB per object`
        : 'hashes only — no store configured, so the platform holds no files'
    }`,
    // Where the landing-page pictures are written, and whether they will still
    // be there tomorrow. Uploading one used to work, look right, and vanish on
    // the next rebuild — a silent loss with nothing anywhere saying it would
    // happen. Now the banner says it on every boot.
    `  Site media   ${
      process.env.SITE_MEDIA_PATH
        ? `${process.env.SITE_MEDIA_PATH} — survives a redeploy`
        : 'the checkout — fine on a laptop, LOST ON EVERY REDEPLOY in a container. Set SITE_MEDIA_PATH.'
    }`,
    `  Signing      ${
      config.signing.privateKeyPem === ''
        ? 'no key — every signature request will be refused'
        : 'Ed25519 key loaded; signatures are witnessed by the platform, not by the signatory'
    }`,
    `  AI mode      ${config.ai.mode}${config.ai.mode === 'local' ? ' (deterministic engines, no provider spend)' : ''}`,
    `  Operator     ${bootstrap}
  Demo         ${demonstration}
  Newsletter   ${
      config.newsletter.enabled
        ? `weekly, day ${config.newsletter.sendDayUtc} at ${config.newsletter.sendHourUtc}:00 UTC via ${config.smtp.host || 'no SMTP host — will record, not send'}`
        : 'disabled (set NEWSLETTER_ENABLED=true to arm the weekly send)'
    }
  Billing      ${
      config.billing.collectionEnabled
        ? `hourly collection, ${config.billing.subscriptionGraceDays}-day grace, then the tenancy stops`
        : 'collection disabled (set SUBSCRIPTION_COLLECTION_ENABLED=true — it raises charges against real tenancies)'
    }`,
    '',
  ].join('\n'),
);

/**
 * Stop accepting work, then close the journal.
 *
 * Order matters here too: the server stops first so no request can be part way
 * through a commit when the file descriptor closes. Every event already
 * acknowledged is already flushed — the close is a tidy-up, not the thing that
 * makes the data durable.
 */
const shutdown = (signal: string): void => {
  process.stdout.write(`\nReceived ${signal}, shutting down.\n`);
  newsletter.stop();
  collection.stop();
  outboxTimer();
  watchTimer();
  server.close(() => {
    platform.ledger.journal?.close();
    // Released last, after the descriptor is closed. Releasing first would
    // leave a window in which another process could claim the volume while
    // this one still had the journal open.
    writerLock?.release();
    process.exit(0);
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
