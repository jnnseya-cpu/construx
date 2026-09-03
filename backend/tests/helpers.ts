import assert from 'node:assert/strict';
import { currentCodeFor, useAuthenticatorClock } from '../src/identity/authenticators.ts';
import { totp } from '../src/identity/totp.ts';

/**
 * Assert that a call fails with a specific domain error code.
 *
 * The platform separates the machine-readable `code` from the human-readable
 * message, so matching on the message alone would let a renamed error pass
 * silently. This checks the code, which is what clients actually branch on.
 *
 * Returns the refusal it caught, so a test that cares about the sentence a
 * person reads — not only the code a machine matches — can assert on that too.
 */
export function throwsCode(fn: () => unknown, code: string, message?: string): { code?: string; message?: string } {
  try {
    fn();
  } catch (error) {
    const actual = (error as { code?: string }).code;
    assert.equal(actual, code, message ?? `expected error code ${code}, received ${actual ?? '(none)'}`);
    return error as { code?: string; message?: string };
  }
  assert.fail(message ?? `expected the call to throw ${code}, but it returned normally`);
}

export async function rejectsCode(
  fn: () => Promise<unknown>,
  code: string,
  message?: string,
): Promise<{ code?: string; message?: string }> {
  try {
    await fn();
  } catch (error) {
    const actual = (error as { code?: string }).code;
    assert.equal(actual, code, message ?? `expected error code ${code}, received ${actual ?? '(none)'}`);
    // Returned like `throwsCode`, so a test can go on to assert what the
    // refusal actually said. A code proves the right rule fired; the sentence
    // is what the person on the other end of it reads.
    return error as { code?: string; message?: string };
  }
  assert.fail(message ?? `expected the call to reject with ${code}, but it resolved`);
}

/**
 * A project at CONSTRUCTION with nothing done on it yet.
 *
 * Several suites need to prove a refusal that only applies to a site which has
 * not done its paperwork — no Construction Phase Plan, no lookahead, no
 * constraint log. They used to borrow the demonstration estate's construction
 * project for it, which worked only for as long as that project stayed empty.
 *
 * It did not stay empty: it now carries a full delivery record, because a
 * console whose every screen correctly reported nothing read as unbuilt rather
 * than as unstarted. That broke seven tests in two suites at once, and the
 * lesson is the one worth keeping — a fixture that depends on *another* fixture
 * staying poor is a test that fails the moment somebody improves the product.
 *
 * So this builds its own, through the same gates a person walks: a scope
 * package to leave CONCEPT, a maturity assessment to leave DESIGN, a frozen
 * estimate and an executed contract to leave TENDER. Nothing is asserted that
 * the platform would have refused, and the project it hands back has done
 * exactly none of the things the callers are testing the absence of.
 */
export async function bareConstructionProject(
  platform: import('../src/platform.ts').Platform,
  seed: import('../src/seed.ts').SeedResult,
  name = 'Bare Construction Fixture',
): Promise<{ projectId: string; packageId: string }> {
  const structure = await import('../src/domain/structure.ts');
  const tender = await import('../src/engines/tender.ts');
  const claims = await import('../src/engines/claims.ts');
  const bim = await import('../src/engines/bim.ts');

  const owner = seed.users.owner!.auth;
  const qs = seed.users.qs!.auth;
  const pm = seed.users.pm!.auth;

  const source = platform.ledger.entitiesOfType('Project').find((r) => r.state.id === seed.projectId)!;
  // Creating a project is an enterprise administrator's act. No role of OWNER
  // holds "C" on PROJECT_SETUP, which the platform says in exactly those words
  // — the seed builds projects the same way, through the governance scope.
  const gov = platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

  const { projectId } = structure.createProject(gov, {
    portfolioId: String(source.state.portfolioId),
    programmeId: String(source.state.programmeId),
    name,
    sectorType: 'UTILITIES',
    assetType: 'Fixture',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Rawtenstall' },
    contractValueMinor: 100_000_000,
    currency: 'GBP',
    plannedStart: '2026-02-02',
    plannedCompletion: '2027-08-13',
  });

  const ownerCtx = platform.context(owner, projectId, { source: 'WEB' });
  const qsCtx = platform.context(qs, projectId, { source: 'WEB' });
  const pmCtx = platform.context(pm, projectId, { source: 'WEB' });

  const { packageId } = structure.createScopePackage(pmCtx, {
    name: 'Fixture package',
    discipline: 'CIVILS',
    scopeOfWorks: 'A package that exists so the project can leave concept.',
    inclusions: ['Everything named here'],
    exclusions: ['Everything not named here'],
    acceptanceCriteria: ['Accepted when complete'],
    estimatedValueMinor: 90_000_000,
    designResponsibility: 'CONTRACTOR',
  });
  structure.transitionPhase(ownerCtx, { to: 'DESIGN', justification: 'Scope defined' });

  structure.assessDesignMaturity(pmCtx, {
    packageId,
    disciplineScores: [{ discipline: 'CIVILS', ribaStage: 5, completenessPercent: 90, frozen: true }],
    informationGaps: [],
    assessorNotes: 'Priceable.',
  });
  structure.transitionPhase(ownerCtx, { to: 'TENDER', justification: 'Design frozen' });

  // An estimate must price at least one measured line, and a measured line
  // needs a BoQ item, which needs a take-off off a registered drawing. The
  // refusal chain is the product working: there is no route to a frozen
  // estimate that skips the measurement it was built from.
  const drawing = await bim.registerDrawing(platform.context(seed.users.bim!.auth, projectId, { source: 'WEB' }), {
    fileHash: 'b'.repeat(64),
    titleBlock: {
      drawingNumber: 'F-0001',
      title: 'Fixture drawing',
      revision: 'A',
      discipline: 'CIVILS',
      issueDate: '2025-11-18',
      status: 'FOR CONSTRUCTION',
    },
    packageIds: [packageId],
  });
  const takeoff = await tender.runTakeoff(qsCtx, {
    packageId,
    sources: [{ drawingRef: { refType: 'Drawing', refId: drawing.drawingId }, discipline: 'CIVILS', sheetId: 'F-0001' }],
    costCodePrefix: 'FIX',
    items: [{ description: 'Fixture item', unit: 'm', quantity: 100, sourceSheet: 'F-0001' }],
  });

  const estimate = tender.buildEstimate(qsCtx, {
    packageId,
    durationWeeks: 20,
    lines: [
      { boqItemId: takeoff.boqItemIds[0] as string, description: 'Fixture item', unit: 'm', quantity: 100, labourRateMinor: 5_000, plantRateMinor: 2_000 },
    ],
    timeRelated: [{ head: 'SITE_MANAGEMENT', description: 'Site manager', weeklyRateMinor: 200_000, quantity: 1 }],
    quantified: [],
    margin: { overheadPercent: 6, profitPercent: 7 },
    basisOfEstimate: 'Fixture.',
    assumptions: [],
  });
  tender.freezeEstimate(qsCtx, estimate.estimateId, 'Frozen for the fixture');

  const contract = claims.createContract(qsCtx, {
    suite: 'NEC4',
    form: 'NEC4 ECC Option A',
    parties: [
      { role: 'CLIENT', partyId: 'CLIENT-FIXTURE', name: 'Fixture Client' },
      { role: 'CONTRACTOR', partyId: 'CONTRACTOR-MERIDIAN', name: 'Meridian Infrastructure Group Ltd' },
    ],
    contractSumMinor: estimate.totalMinor,
    commencementDate: '2026-02-02',
    completionDate: '2027-08-13',
    liquidatedDamagesPerDayMinor: 100_000,
    ldCapPercent: 8,
    retentionPercent: 3,
    defectsLiabilityMonths: 12,
  });
  claims.executeContract(ownerCtx, {
    contractId: contract.contractId,
    signedDocumentHash: 'a'.repeat(64),
    signatureMethod: 'DEED',
    executedOn: '2026-01-19',
  });
  structure.transitionPhase(ownerCtx, { to: 'CONSTRUCTION', justification: 'Contract executed and estimate frozen' });

  return { projectId, packageId };
}

// --- signing in over HTTP, second factor included -----------------------------

let authenticatorSkew = 0;
let authenticatorClockInstalled = false;

/**
 * The next thirty-second step of the authenticator clock. Codes and their
 * verification both read the injected clock, so stepping it forward makes the
 * next code a fresh one instead of a replay — which the platform must refuse,
 * and which a test that signs an operator in five times in a row would
 * otherwise hit.
 */
function nextAuthenticatorStep(): number {
  if (!authenticatorClockInstalled) {
    useAuthenticatorClock(() => new Date(Date.now() + authenticatorSkew));
    authenticatorClockInstalled = true;
  }
  authenticatorSkew += 30_000;
  return Date.now() + authenticatorSkew;
}

async function postJson(base: string, path: string, token: string | null, payload: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  });
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Finish a sign-in the way the console does once `/v1/auth/mfa/verify` has
 * answered.
 *
 * Somebody with nothing required gets tokens straight back. An operator —
 * required to hold a second factor by default — gets an enrolment-only session
 * the first time; this enrols an authenticator app for them and returns the
 * session the confirmation mints. On every later sign-in the platform withholds
 * tokens until the app's code arrives, and this supplies the next one. Tests
 * about packages, alerts or site media should not each have to know that.
 */
export async function completeSignIn(base: string, verified: Record<string, unknown>): Promise<string> {
  if (verified.secondFactorRequired === true) {
    const actorId = String(verified.actorId);
    const now = nextAuthenticatorStep();
    const code = currentCodeFor(actorId, new Date(now));
    assert.ok(code, `${actorId} was asked for an authenticator code but holds no authenticator`);
    const signedIn = await postJson(base, '/v1/auth/mfa/factor', null, { actorId, factorChallengeId: verified.factorChallengeId, code });
    assert.ok(signedIn.accessToken, `second factor refused: ${JSON.stringify(signedIn)}`);
    return String(signedIn.accessToken);
  }
  const token = String(verified.accessToken);
  if (verified.enrolmentRequired !== true) return token;
  const started = await postJson(base, '/v1/me/authenticator/begin', token, {});
  assert.ok(started.secret, `enrolment did not start: ${JSON.stringify(started)}`);
  const confirmed = await postJson(base, '/v1/me/authenticator/confirm', token, {
    enrolmentId: started.enrolmentId,
    code: totp(String(started.secret), nextAuthenticatorStep()),
  });
  assert.ok(confirmed.accessToken, `enrolment was not confirmed: ${JSON.stringify(confirmed)}`);
  return String(confirmed.accessToken);
}
