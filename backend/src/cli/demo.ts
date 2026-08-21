import { formatContractValue, formatMoney } from '../billing/invoice.ts';
import { ask } from '../ai/conversation.ts';
import { replayProject } from '../goldenthread/replay.ts';
import { Platform } from '../platform.ts';
import { seedDemoProject } from '../seed.ts';

/**
 * End-to-end demonstration: one asset taken from concept to operations, then
 * verified by replaying its own event log.
 */

const BOLD = '[1m';
const ORANGE = '[38;5;208m';
const GREY = '[38;5;245m';
const GREEN = '[38;5;41m';
const RED = '[38;5;203m';
const RESET = '[0m';

const out = (text = ''): void => {
  process.stdout.write(`${text}\n`);
};

function heading(text: string): void {
  out();
  out(`${ORANGE}${BOLD}${text}${RESET}`);
  out(`${GREY}${'─'.repeat(text.length)}${RESET}`);
}

const platform = new Platform();

out();
out(`${BOLD}CONSTRU${ORANGE}X${RESET}${BOLD} — Construction Operating System${RESET}`);
out(`${GREY}Concept → Design → Tender → Construction → Commissioning → Handover → O&M${RESET}`);

heading('Running the full lifecycle');
const seed = await seedDemoProject(platform);
for (const line of seed.timeline) out(`  ${GREY}▸${RESET} ${line}`);

// --- What the ledger now holds ----------------------------------------------
heading('Golden Thread');
const events = platform.ledger.events({ projectId: seed.projectId });
const byGroup = new Map<string, number>();
for (const event of events) {
  const actor = event.actor.refType;
  byGroup.set(actor, (byGroup.get(actor) ?? 0) + 1);
}
out(`  ${events.length} events written for this project, none of them editable`);
for (const [actor, count] of [...byGroup.entries()].sort()) {
  out(`    ${GREY}${actor.padEnd(7)}${RESET} ${count} events`);
}
out(`  Chain head: ${GREY}${platform.ledger.chainHead(seed.projectId).slice(0, 26)}…${RESET}`);

// --- Independent verification -----------------------------------------------
heading('Verification replay');
const report = replayProject(platform.ledger, seed.tenantId, seed.projectId, new Date().toISOString());
out(`  Events replayed:  ${report.eventsReplayed}`);
out(`  Entities rebuilt: ${report.entities.length}`);
out(`  State root hash:  ${GREY}${report.rootHash.slice(0, 34)}…${RESET}`);
out(
  `  Verification:     ${report.verificationStatus === 'VERIFIED' ? `${GREEN}VERIFIED${RESET}` : `${RED}FAILED${RESET}`}` +
    ` (${report.summary.VERIFIED} verified, ${report.failures.length} failures)`,
);

// A regulator replaying the same project sees a redacted view — same root hash,
// different visible entities.
const regulatorView = replayProject(platform.ledger, seed.tenantId, seed.projectId, new Date().toISOString(), {
  audience: 'REGULATOR',
});
out(
  `  Regulator view:   ${regulatorView.entities.length} entities visible, ` +
    `${regulatorView.redactionLog.length} commercially sensitive records withheld`,
);

// --- Tamper detection --------------------------------------------------------
heading('Tamper detection');
const tampered = platform.ledger.events({ projectId: seed.projectId }).find((e) => e.eventType === 'ESTIMATE_FROZEN');
if (tampered) {
  const original = tampered.afterHash;
  // Simulate someone altering a stored hash directly in the database.
  (tampered as { afterHash: string }).afterHash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  const tamperedReport = replayProject(platform.ledger, seed.tenantId, seed.projectId, new Date().toISOString());
  out(`  A stored hash on the frozen estimate was altered directly in storage.`);
  out(
    `  Replay result:    ${tamperedReport.verificationStatus === 'FAILED' ? `${RED}FAILED${RESET}` : `${GREEN}VERIFIED${RESET}`}` +
      ` — ${tamperedReport.failures.length} integrity failure(s) detected`,
  );
  const first = tamperedReport.failures[0];
  if (first) out(`  First failure:    ${GREY}${first.status} on ${first.eventType}${RESET}`);
  (tampered as { afterHash: string }).afterHash = original;
}

// --- Commercial position -----------------------------------------------------
heading('Commercial position');
const project = platform.ledger.require({ refType: 'Project', refId: seed.projectId });
const cvrs = platform.ledger.list(seed.projectId, 'CVR');
const cvr = cvrs[cvrs.length - 1]?.state;
const claims = platform.ledger.list(seed.projectId, 'Claim');
const claim = claims[claims.length - 1]?.state;

out(`  Contract value:      ${formatContractValue(Number(project.state.contractValueMinor), 'GBP')}`);
if (cvr) {
  out(`  Forecast final cost: ${formatContractValue(Number(cvr.forecastFinalCostMinor), 'GBP')}`);
  out(`  Forecast margin:     ${cvr.forecastMarginPercent}% (tender ${cvr.marginAtTenderPercent}%)`);
  for (const alert of (cvr.alerts as string[]) ?? []) out(`    ${RED}!${RESET} ${alert}`);
}
if (claim) {
  out(`  Claim:               ${claim.claimedDays}d claimed → ${GREEN}${claim.assessedDays}d assessed${RESET}`);
  out(`  Entitlement score:   ${claim.entitlementScore}`);
  out(`  ${GREY}${String(claim.recommendation)}${RESET}`);
}

// --- Commercial model --------------------------------------------------------
heading('ACU economics');
const wallet = platform.wallet(seed.tenantId);
const snapshot = wallet.snapshot();
out(`  Provider cost incurred: ${formatMoney(snapshot.monthRawSpendMinor, 'GBP')}`);
out(`  Charged to the tenant:  ${formatMoney(snapshot.monthBilledMinor, 'GBP')}`);
out(
  `  Effective multiplier:   ${
    snapshot.monthRawSpendMinor === 0 ? '—' : `${(snapshot.monthBilledMinor / snapshot.monthRawSpendMinor).toFixed(2)}×`
  }`,
);
out(`  Balance remaining:      ${formatMoney(snapshot.availableMinor, 'GBP')}`);
out();
out(`  ${GREY}Cost attribution by engine:${RESET}`);
for (const attribution of wallet.attributionByModule()) {
  out(
    `    ${attribution.module.padEnd(18)} ${String(attribution.calls).padStart(3)} calls  ` +
      `${formatMoney(attribution.billedMinor, 'GBP').padStart(9)}`,
  );
}

const invoice = platform.issueInvoice(seed.tenantId, new Date().toISOString().slice(0, 7));
out();
out(`  Invoice: subscription ${formatMoney(invoice.subscriptionMinor)} + AI ${formatMoney(invoice.aiUsageMinor)} = ${BOLD}${formatMoney(invoice.totalMinor)}${RESET}`);

// --- Copilot -----------------------------------------------------------------
heading('Copilot');
const pmContext = platform.context(seed.users.pm?.auth as never, seed.projectId);
for (const question of [
  'what is our delay exposure and how do we recover it?',
  'how is the margin looking?',
  'are we safe to keep excavating?',
]) {
  out(`  ${BOLD}?${RESET} ${question}`);
  const answer = ask(pmContext, question);
  for (const line of answer.answer.split('\n')) out(`    ${GREY}${line}${RESET}`);
  if (answer.suggestedActions.length > 0) {
    out(`    ${GREY}next:${RESET} ${answer.suggestedActions.map((a) => (a.permitted ? a.command : `${a.command} (denied)`)).join(', ')}`);
  }
  out();
}

// --- Access control ----------------------------------------------------------
heading('Access control');
const regulatorContext = platform.context(seed.users.regulator?.auth as never, seed.projectId);
const regulatorAnswer = ask(regulatorContext, 'show me the commercial margin position');
out(`  A regulator asking for commercial data:`);
for (const action of regulatorAnswer.suggestedActions) {
  out(`    ${action.permitted ? GREEN + '✓' : RED + '✗'}${RESET} ${action.command}${action.reason ? ` ${GREY}— ${action.reason}${RESET}` : ''}`);
}
out(`  ${GREY}Tools available to this regulator: ${regulatorAnswer.availableTools.join(', ')}${RESET}`);

out();
out(`${GREEN}${BOLD}Lifecycle complete.${RESET} ${GREY}Run \`npm start\` and open http://localhost:8080 for the command centre.${RESET}`);
out();
