import { startGateway } from './api/gateway.ts';
import { assertProductionSafety, config } from './config.ts';
import { startNewsletterSchedule } from './messaging/newsletter.ts';
import { Platform } from './platform.ts';

/**
 * Process entry point. One process brings up the gateway, the ledger, the AI
 * control plane and the console.
 */

const platform = new Platform();

for (const warning of assertProductionSafety()) {
  process.stderr.write(`[config warning] ${warning}\n`);
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
    `  Console      http://localhost:${config.port}/`,
    `  API routes   http://localhost:${config.port}/v1/routes`,
    `  Health       http://localhost:${config.port}/readyz`,
    `  AI mode      ${config.ai.mode}${config.ai.mode === 'local' ? ' (deterministic engines, no provider spend)' : ''}`,
    `  Newsletter   ${
      config.newsletter.enabled
        ? `weekly, day ${config.newsletter.sendDayUtc} at ${config.newsletter.sendHourUtc}:00 UTC via ${config.smtp.host || 'no SMTP host — will record, not send'}`
        : 'disabled (set NEWSLETTER_ENABLED=true to arm the weekly send)'
    }`,
    '',
  ].join('\n'),
);

const shutdown = (signal: string): void => {
  process.stdout.write(`\nReceived ${signal}, shutting down.\n`);
  newsletter.stop();
  server.close(() => process.exit(0));
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
