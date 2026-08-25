import { startGateway } from './api/gateway.ts';
import { rateLimiter } from './api/middleware.ts';
import { SharedLimiter } from './api/sharedlimiter.ts';
import { assertProductionSafety, config } from './config.ts';
import { Journal, RecordJournal } from './goldenthread/journal.ts';
import type { ACUEntry } from './billing/acu.ts';
import { startNewsletterSchedule } from './messaging/newsletter.ts';
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

if (config.ledger.journalPath !== '') {
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

  // The ledger holds the projects; this restores the people who can reach them.
  // Without it a replay produces a full record and nobody able to sign in.
  const identity = platform.rehydrate(byTenant);

  journal.open();
  wallets.open();
  platform.ledger.attachJournal(journal);
  platform.attachWalletSink((entry) => wallets.append(entry));

  durability =
    `${stats.path} — ${restored} event${restored === 1 ? '' : 's'} restored into ${entities} entities, ` +
    `${identity.users} users across ${identity.tenants} tenancies, ${records.length} ACU entries`;
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

const server = await startGateway(platform, config.port);

const newsletter = startNewsletterSchedule(platform, (report) => {
  process.stdout.write(
    `[newsletter] ${report.campaign.week} issued — ${report.sent} sent, ${report.recorded} recorded, ${report.failed} failed\n`,
  );
});

process.stdout.write(
  [
    '',
    '  CONSTRUX.AI — Construction Operating System',
    `  Site         http://localhost:${config.port}/`,
    `  Console      http://localhost:${config.port}/app`,
    `  API routes   http://localhost:${config.port}/v1/routes`,
    `  Rate limits  ${limiterState}`,
    `  Health       http://localhost:${config.port}/readyz`,
    `  Ledger       ${durability}`,
    `  Evidence     ${
      config.evidence.storePath === ''
        ? 'hashes only — no store configured, so the platform holds no files'
        : `${config.evidence.storePath} — up to ${Math.round(config.evidence.maxBytes / 1_048_576)}MB per object`
    }`,
    `  Signing      ${
      config.signing.privateKeyPem === ''
        ? 'no key — every signature request will be refused'
        : 'Ed25519 key loaded; signatures are witnessed by the platform, not by the signatory'
    }`,
    `  AI mode      ${config.ai.mode}${config.ai.mode === 'local' ? ' (deterministic engines, no provider spend)' : ''}`,
    `  Operator     ${bootstrap}
  Newsletter   ${
      config.newsletter.enabled
        ? `weekly, day ${config.newsletter.sendDayUtc} at ${config.newsletter.sendHourUtc}:00 UTC via ${config.smtp.host || 'no SMTP host — will record, not send'}`
        : 'disabled (set NEWSLETTER_ENABLED=true to arm the weekly send)'
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
  server.close(() => {
    platform.ledger.journal?.close();
    process.exit(0);
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
