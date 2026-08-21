import { startGateway } from './api/gateway.ts';
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
    `  Health       http://localhost:${config.port}/readyz`,
    `  Ledger       ${durability}`,
    `  AI mode      ${config.ai.mode}${config.ai.mode === 'local' ? ' (deterministic engines, no provider spend)' : ''}`,
    `  Newsletter   ${
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
