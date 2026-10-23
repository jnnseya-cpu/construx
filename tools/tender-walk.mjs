/**
 * The normal tender, walked end to end in a real browser.
 *
 * ## Why this exists
 *
 * A user lost a tender because the platform could not take them to a
 * submission, and then lost a day on Bid-On for the same reason: commands that
 * are correct and unreachable. `tools/bidon-walk.mjs` closed that for the
 * module; this closes it for the path every tenancy uses — Pipeline & Bids,
 * which is this business bidding its own work.
 *
 * Writing it found five of them, each the same shape: a correct rule in front
 * of a remedy with no door.
 *
 *   1. **The compliance matrix had no console door at all.** `Plan a response
 *      pack`, the submission rules, the waivers and the addenda review every
 *      take an `analysisId`, and the only two routes that mint one were
 *      reachable from nowhere — so everything after an invitation was
 *      permanently empty with no screen saying why.
 *   2. **Neither half of the bid/no-bid decision had one either.** The screen
 *      publishes a ten-factor algorithm and gave nobody any way to run it, so a
 *      pursuit could only sit at `IDENTIFIED` and `Record how a bid ended` was
 *      padlocked for ever.
 *   3. **A read invitation could never be cleared to bid.** Every mandatory
 *      return needs an owner and an internal date; a reading cannot file either
 *      because neither is in the buyer's document, and adding one refused the
 *      reference as a duplicate. The gate named blockers nothing could clear,
 *      and the return register was not readable on any screen.
 *   4. **The pack bar was a dead end on the wrong project.** A pack is written
 *      to a project in tender; the bar showed the phase of whatever project was
 *      open and offered nowhere to go.
 *   5. **A win could not become a project.** A pursuit registered before any
 *      project existed — the normal case — had nowhere to become one, so the
 *      business created the delivery project by hand elsewhere and it pointed
 *      at nothing: the score, the decision and the invitation behind the job
 *      were all on the thread and unreachable from it.
 *
 * ## What it proves, and where it stops
 *
 * It proves a person can get from no pipeline at all to a recorded decision to
 * bid, a planned response pack with its compliance matrix bound to the
 * invitation, a recorded outcome and a delivery project carrying the thread —
 * and that the gates in between refuse with their reasons rather than
 * misleading.
 *
 * It stops at writing sections, because that is an agent and this runs on
 * `AI_MODE=local` deliberately — a check that needs a vendor key is a check
 * nobody runs. So the walk asserts that the section command **opens and refuses
 * by name**, which is where an unreachable command hides, and that `Issue the
 * pack` refuses while sections are unwritten rather than issuing a pack with
 * holes in it.
 *
 * ## Usage
 *
 *   npm install --no-save playwright-core
 *   PORT=8123 DEMO_TENANCY_ENABLED=true AI_MODE=local npm start &
 *   node tools/tender-walk.mjs
 */

import { chooseProject, log, openBrowser, openScreen, runCommand, signIn, tally } from './walklib.mjs';

const BASE = process.env.WALK_BASE ?? 'http://localhost:8123';
/** OWNER's union carries BUSINESS_DEVELOPMENT and ESTIMATE_TENDER. */
const BIDDER = process.env.WALK_ROLE ?? 'owner@meridian.example';

const { pass, fail, finish } = tally();
const stamp = Date.now().toString().slice(-6);

log('\nTender walk — Pipeline & Bids\n');

const { browser, page, notices } = await openBrowser();

try {
  await signIn(page, BASE, BIDDER);
  await openScreen(page, 'pipeline', 'Pipeline');
  pass('opened Pipeline & Bids');

  await runCommand(page, 'opportunity', {
    title: `Platform Housing EPC assessments ${stamp}`,
    clientName: `Platform Housing Group ${stamp}`,
    sectorType: 'UTILITIES',
    estimatedValue: '1250000',
    source: 'Portal',
    // `datetime-local`, so a date alone is malformed. The buyer's close is a
    // time of day, and the field is right to insist on one.
    submissionDueAt: '2027-11-02T14:00',
  });
  pass('registered an opportunity');

  await openScreen(page, 'pipeline', 'Pipeline');
  await runCommand(page, 'invitation', {
    opportunityId: { labelContains: stamp },
    reference: `RFX${stamp}`,
    issuedAt: '2027-10-01T09:00',
    returnLocal: '2027-11-02T14:00',
    clarificationLocal: '2027-10-24T17:00',
    // The third date on an invitation, and the one somebody has to be in a van
    // for. It was recorded here and published nowhere, so it could be entered
    // and then never seen again anywhere in the product.
    siteVisitLocal: '2027-10-14T10:00',
  });
  pass('recorded the ITT, with all three of its dates');

  await openScreen(page, 'pipeline', 'Pipeline');
  const datesRead = await page.evaluate((reference) => {
    const text = document.body.textContent.replace(/\s+/g, ' ');
    return {
      visit: text.includes('2027-10-14 10:00'),
      questions: text.includes('2027-10-24 17:00'),
      reference: text.includes(reference),
    };
  }, `RFX${stamp}`);
  if (!datesRead.visit) throw new Error('the site visit date is recorded and not shown anywhere on the board');
  if (!datesRead.questions) throw new Error('the clarification deadline is recorded and not shown anywhere on the board');
  pass('the board reads back the site visit and the question deadline');

  /*
   * The step that had no door until today. Everything after it takes the
   * matrix it produces, and before this command existed every one of those
   * pickers was permanently empty.
   */
  await openScreen(page, 'pipeline', 'Pipeline');
  await runCommand(page, 'requirements', {
    invitationId: { labelContains: stamp },
    reference: `RFX${stamp}`,
    clientName: `Platform Housing Group ${stamp}`,
    returnBy: '2027-11-02',
    estimatedValue: '1250000',
    durationWeeks: '208',
    contractForm: 'JCT Measured Term Contract 2024',
    requirements:
      'R1 | Quality | Describe your EPC assessment process from instruction to lodgement | M | Method statement | 25 | 500\n' +
      'R2 | Health and safety | Set out your lone-working arrangements for domestic visits | M | Policy and procedure | 15 | 400\n' +
      'R3 | Commercial | Confirm your rates hold for the full term | M | Priced cost model | 20 |',
    deliverables:
      'APP2 | Order form, completed and signed | M | PDF | | SIG\n' +
      'APP5 | EPC cost model, fully priced | M | XLSX | |\n' +
      'APP3 | Schedule of amendments, accepted or qualified | M | PDF | | SIG',
    sourceDocument: 'Invitation to Tender, section 4',
    paymentDays: '30',
    retentionPercent: '5',
  });
  pass('read the invitation into a compliance matrix');

  /*
   * The decision this screen is named after. Both halves of it — the ten-factor
   * score and the bid/no-bid — had routes, tests, a published algorithm and no
   * door anywhere in the console, so a pursuit could only ever sit at
   * `IDENTIFIED` and "Record how a bid ended" was padlocked for ever.
   */
  await openScreen(page, 'pipeline', 'Pipeline');
  await runCommand(page, 'qualify', {
    opportunityId: { labelContains: stamp },
    relevantExperience: '4',
    clientAttractiveness: '4',
    contractSize: '4',
    geography: '4',
    supplyChainCapacity: '3',
    competition: '3',
    marginOpportunity: '4',
    cashflowRisk: '4',
    strategicValue: '4',
    winProbability: '3',
  });
  pass('scored the opportunity against the ten factors');

  /*
   * The gate in front of the decision to bid, and the door that did not exist.
   *
   * Every mandatory return has to carry an owner, our own internal date and a
   * source. A reading files what the buyer asked for and cannot file the first
   * two — they are this business committing its people — and `addDeliverable`
   * refuses a reference already on the invitation. So the blockers the decision
   * named were blockers **nothing in the platform could clear**, and the return
   * register itself was not readable on any screen.
   */
  await openScreen(page, 'pipeline', 'Pipeline');
  for (const reference of ['APP2', 'APP5', 'APP3']) {
    await runCommand(page, 'assign-deliverable', {
      target: { labelContains: `RFX${stamp} · ${reference}` },
      owner: 'QS',
      internalDueBy: '2027-10-26',
    });
    await openScreen(page, 'pipeline', 'Pipeline');
  }
  pass('gave all three mandatory returns an owner and our own date');

  await runCommand(page, 'decide', {
    opportunityId: { labelContains: stamp },
    bid: true,
    rationale:
      'Four years of EPC assessment work for two registered providers in the same region, and the rates hold at ' +
      'the volume the buyer states.',
    conditions: 'Bid, provided the lone-working procedure is reviewed before the method statement goes out.',
  });
  pass('recorded the decision to bid, with its rationale');

  /*
   * The second dead end, and the reason this walk exists rather than a unit
   * test. A matrix belongs to the company; a pack is written to a project, and
   * the platform refuses one on a project past tender. The demonstration
   * tenancy opens on a project in operations, so the three pack commands were
   * padlocked with the phase of a project nobody had chosen and nothing to
   * press — correct, and indistinguishable from broken.
   */
  await openScreen(page, 'pipeline', 'Pipeline');
  const switched = await page.evaluate(() => {
    const section = [...document.querySelectorAll('section.card')].find((card) =>
      card.textContent.includes('Bid response packs'),
    );
    if (!section) return 'the bid response pack section is not on this screen';
    if (section.querySelector('[data-command="bid-plan"]')) return null;
    const escape = section.querySelector('[data-open-project]');
    if (!escape) return 'the pack commands are locked and the screen offers no project that would accept one';
    escape.click();
    return 'switched';
  });
  if (switched && switched !== 'switched') throw new Error(switched);
  if (switched === 'switched') {
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('section.card')]
          .find((card) => card.textContent.includes('Bid response packs'))
          ?.querySelector('[data-command="bid-plan"]') != null,
      { timeout: 25000 },
    );
    pass('the locked pack bar named a project that would take it, and opened it');
  }

  // The matrix has to be visible to the commands that take it, which is the
  // half that was broken: a matrix that exists and no picker offering it would
  // be the same dead end one step further on.
  await runCommand(page, 'bid-plan', { analysisId: { labelContains: `RFX${stamp}` } });
  pass('planned a response pack from the matrix');

  /*
   * The site visit that is part of the tender.
   *
   * Reported from a live bid as "the apps section is not ready yet". The engine
   * was: it sits under `LOOKAHEAD_CONSTRAINTS` rather than `FIELD_EXECUTION`
   * precisely so a pre-award project can use it. The vocabulary was not — there
   * was no `BID` purpose, so the only options were to mislabel the walk as a
   * pre-construction one on work the business had not won, or to keep the
   * findings in a notebook.
   */
  await openScreen(page, 'field', 'Field');
  await runCommand(page, 'site-visit', {
    purpose: 'BID',
    visitedOn: '2026-10-14',
    attendees: 'Nadia Hussain, Harry O’Neill — buyer’s representative',
    weather: 'Dry, 9C',
    notes: `Buyer-led bidder visit for RFX${stamp}; three of the five tenderers attended.`,
  });
  pass('recorded the walk as a bid visit, which it could not be called before');

  await openScreen(page, 'field', 'Field');
  await runCommand(page, 'finding', {
    visitId: { index: 0 },
    category: 'ACCESS_AND_EGRESS',
    description:
      'Twenty-two of the sampled properties are third-floor walk-ups with no lift; each assessment takes a full ' +
      'extra hour that the rate schedule does not allow for',
    location: 'Blackpole estate, blocks C to F',
    basis: 'ADVISED',
    source: 'Buyer’s housing officer on the visit, 14 October',
    consequences: 'PRICES',
    closesBy: 'TENDER_RETURN',
    owner: 'Nadia Hussain',
  });
  pass('raised a finding owed before the submission goes back');

  await openScreen(page, 'field', 'Field');
  const owed = await page.evaluate(() => {
    const text = document.body.textContent.replace(/\s+/g, ' ');
    return text.includes('settled before the tender goes back');
  });
  if (!owed) throw new Error('a finding owed before the return is not stated anywhere on the register');
  pass('the register says what is owed before the tender goes back');

  // An agent, refused on the local engines by name. This is where an
  // unreachable command hides: the panel has to open and the refusal has to be
  // the platform's rather than a timeout.
  await openScreen(page, 'pipeline', 'Pipeline');
  const section = await runCommand(page, 'bid-section', { packId: { index: 0 } }, { expectRefusal: true });
  pass('the section writer opens and refuses by name', section.refused.slice(0, 70));

  // And the gate in front of issuing holds while the sections are unwritten.
  await openScreen(page, 'pipeline', 'Pipeline');
  const issue = await runCommand(page, 'bid-issue', { packId: { index: 0 } }, { expectRefusal: true });
  pass('issuing refuses while the pack is incomplete', issue.refused.slice(0, 70));

  await openScreen(page, 'pipeline', 'Pipeline');
  await runCommand(page, 'bid-outcome', {
    opportunityId: { labelContains: stamp },
    outcome: 'WON',
    decidedOn: '2027-11-20',
    qualityScorePercent: '78',
    commercialScorePercent: '81',
    rank: '1',
    tenderers: '5',
    feedback: 'Marked highest on the assessment process and on lone working.',
  });
  pass('recorded how the bid ended');

  /*
   * And the end of the path: the win becomes a project carrying its own thread.
   * This had no door either, so a business that won a pursuit created the
   * delivery project by hand somewhere else and it pointed at nothing — the
   * score, the decision and the invitation were all on the thread and all
   * unreachable from the job they produced.
   */
  await openScreen(page, 'pipeline', 'Pipeline');
  await runCommand(page, 'convert', {
    opportunityId: { labelContains: stamp },
    projectName: `Platform Housing EPC assessments ${stamp}`,
    portfolioId: { index: 0 },
    assetType: 'Domestic EPC assessments',
    continentCode: 'EU',
    countryCode: 'GB',
    city: 'Worcester',
    currency: 'GBP',
    contractValue: '1250000',
    plannedStart: '2027-01-01',
    plannedCompletion: '2030-12-31',
  });
  pass('turned the win into a delivery project, with the thread carried forward');

  /*
   * And the last thing the calibration reads: the result, the marks and the
   * buyer's own words, on the project that was bid.
   *
   * Until this existed, a project bid at tender had nowhere to put any of it:
   * `tenderOutcome` was declared on the control report and written by nothing,
   * the win rate said "no bid outcome has been recorded" for ever, and the one
   * thing a business learns from losing went into an email folder.
   */
  // First the refusal, which is the instruction enforced from the other side:
  // there is nowhere on the platform to assert a win without the contract. The
  // console is still looking at the project the pack was planned on, which has
  // no award.
  await openScreen(page, 'control', 'Project Control');
  const claimed = await runCommand(
    page,
    'tender-result',
    { outcome: 'WON', decidedOn: '2026-11-20' },
    { expectRefusal: true },
  );
  pass('a win cannot be claimed without the award', claimed.refused.slice(0, 70));

  /*
   * And the other ending, on a project bid as a project.
   *
   * A pursuit converted from the pipeline carries its outcome on the
   * opportunity, which is where `recordBidOutcome` has always put it. The
   * project-level outcome is for the other road in — a project opened at
   * `TENDER` and bid from, with no pipeline pursuit behind it — which is what
   * the response pack, the estimate and the award gate are all built on and
   * which could settle nothing at all until now.
   *
   * So the walk opens one, loses it, enters the buyer's own words, and checks
   * that the process stops there. That is the instruction end to end.
   */
  const lost = `Teme Valley reactive repairs ${stamp}`;
  await openScreen(page, 'enterprise', 'Enterprise');
  await runCommand(page, 'project', {
    portfolioId: { index: 0 },
    name: lost,
    sectorType: 'UTILITIES',
    assetType: 'Reactive repairs',
    continentCode: 'EU',
    countryCode: 'GB',
    city: 'Worcester',
    contractValue: '310000',
    currency: 'GBP',
    plannedStart: '2027-06-01',
    plannedCompletion: '2028-06-01',
    startingPhase: 'TENDER',
    startingPhaseReason: 'Competitive tender against the buyer’s own schedule of rates.',
  });
  pass('opened a project at tender, which is the other road in');

  await chooseProject(page, lost);
  await openScreen(page, 'control', 'Project Control');
  await runCommand(page, 'tender-result', {
    outcome: 'LOST',
    decidedOn: '2026-11-20',
    winningPriceMinor: '268000',
    winnerName: 'The incumbent',
    qualityScorePercent: '71',
    commercialScorePercent: '58',
    rank: '3',
    tenderers: '5',
    feedback:
      'Priced 14% above the winner on the hourly rate.\n' +
      'The panel asked why the lone-working procedure was not evidenced in the method statement.',
  });
  pass('recorded the loss and the buyer’s own words, where the agents read them');

  // Then the state, which is the act that stops the work.
  await openScreen(page, 'control', 'Project Control');
  await runCommand(page, 'tenderOutcome', {
    to: { labelContains: 'Closed lost' },
    commercialOutcome: 'LOST',
    reason: 'Unsuccessful; the buyer confirmed the award to the incumbent by letter on 20 November.',
    wonBy: 'The incumbent',
  });
  pass('closed it lost, which is where the process stops');

  // And it is stopped. A command that would have been accepted an hour ago is
  // refused by name, with the way back named in the refusal.
  await openScreen(page, 'control', 'Project Control');
  const stopped = await runCommand(
    page,
    'workstream',
    { type: { index: 0 }, status: 'ACTIVE', reason: 'Opening the mobilisation workstream anyway.' },
    { expectRefusal: true },
  );
  pass('and nothing further is filed against it', stopped.refused.slice(0, 80));
} catch (error) {
  fail('complete the walk', error.message);
}

await browser.close();

if (notices.length > 0) {
  log('');
  log(`Browser console notices (${notices.length}) — the refusals this walk asserts appear here as 4xx and 503:`);
  for (const line of notices.slice(0, 8)) log(`  ${line.slice(0, 160)}`);
}

process.exit(
  finish(
    'A bidder can get from no pipeline at all to a scored opportunity, a recorded decision to bid, a planned ' +
      'response pack and a delivery project carrying the thread — and every gate in between refuses with its reason.',
  ),
);
