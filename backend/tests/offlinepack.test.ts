import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import {
  MAX_PACK_HOURS,
  PACK_CLASS,
  PACK_CLASSES,
  estimatePack,
  issuePack,
  manifestIsOurs,
  packManifest,
  packPosition,
  recordPackReceipt,
  revokePack,
} from '../src/field/pack.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The offline pack — §14.6.
 *
 * The lifecycle is estimate, authorise, sign, verify, activate. Most of it is
 * ordinary; three parts are not, and those are what these tests are mostly
 * about, because each has a plausible implementation that is wrong in a way
 * nobody would notice until a site crew lost a shift.
 *
 * **A new pack must not destroy the last valid one.** The obvious
 * implementation revokes the previous pack when a new one is issued, and it is
 * wrong: a download that fails halfway then leaves a device with nothing. The
 * old pack has to survive until the new one is verified.
 *
 * **Expiry is per class, not per pack.** Taking the longest freshness and
 * calling the whole pack current would present a fortnight-old permit as live.
 * The pack expires as soon as its shortest-lived class does.
 *
 * **The receipt is a report, not a fact.** The platform never watched the
 * device hash anything. What it *can* enforce is that a device does not
 * activate a pack whose required content — permits, method statements — it says
 * it did not verify.
 */

let platform: Platform;
let seed: SeedResult;

const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
const asSupervisor = () => platform.context(seed.users.siteManager!.auth, seed.projectId, { source: 'PWA' });

beforeEach(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('the class table', () => {
  it('gives every class a freshness inside the fourteen days §16.5 allows', () => {
    for (const id of PACK_CLASSES) {
      assert.ok(PACK_CLASS[id].freshnessHours > 0, `${id} has no freshness`);
      assert.ok(PACK_CLASS[id].freshnessHours <= MAX_PACK_HOURS, `${id} outlives the offline ceiling`);
      assert.ok(PACK_CLASS[id].entities.length > 0, `${id} carries nothing`);
      assert.ok(PACK_CLASS[id].why.length > 20, `${id} does not say why its freshness is what it is`);
    }
  });

  it('makes permits the shortest-lived thing a device carries', () => {
    // Not a stylistic preference. A permit decides whether work may start, so
    // it must go stale before anything else in the pack does.
    const shortest = PACK_CLASSES.reduce((soonest, id) =>
      PACK_CLASS[id].freshnessHours < PACK_CLASS[soonest].freshnessHours ? id : soonest,
    );
    assert.equal(shortest, 'PERMITS');
  });
});

describe('the estimate', () => {
  it('refuses an unscoped pack rather than offering the estate', () => {
    throwsCode(() => estimatePack(asPM(), {}), 'PACK_SCOPE_REQUIRED');
  });

  it('refuses a class nobody declared, naming the ones that exist', () => {
    throwsCode(() => estimatePack(asPM(), { classes: ['EVERYTHING'] }), 'NO_SUCH_PACK_CLASS');
  });

  it('resolves a field module to the classes it actually works to', () => {
    const estimate = estimatePack(asPM(), { module: 'construction' });
    assert.ok(estimate.classes.length > 0);
    // Construction works to permits and method statements; the asset register
    // belongs to handover and has no business on a construction pack.
    assert.ok(estimate.classes.some((entry) => entry.id === 'PERMITS'));
  });

  it('changes nothing — an estimate is not an issue', () => {
    const before = platform.ledger.list(seed.projectId, 'OfflinePack').length;
    estimatePack(asPM(), { module: 'construction' });
    assert.equal(platform.ledger.list(seed.projectId, 'OfflinePack').length, before);
  });

  it('says how many files it could not size, so the total reads as a floor', () => {
    const estimate = estimatePack(asPM(), { module: 'construction' });
    assert.equal(typeof estimate.filesOfUnknownSize, 'number');
    assert.ok(estimate.filesOfUnknownSize <= estimate.totalFiles);
  });

  it('takes its expiry from the shortest-lived class it contains, and names it', () => {
    const estimate = estimatePack(asPM(), { classes: ['PERMITS', 'ASSETS'] });
    assert.equal(estimate.expiryDrivenBy, 'PERMITS');
    // Not the two-week asset freshness: the pack is stale when any part is.
    const hours = (Date.parse(estimate.expiresAt) - Date.now()) / 3_600_000;
    assert.ok(hours <= PACK_CLASS.PERMITS.freshnessHours + 1, `expiry ran to ${hours} hours`);
  });
});

describe('issuing', () => {
  it('needs a device, because a pack with no holder can never be withdrawn', () => {
    throwsCode(() => issuePack(asPM(), { deviceId: '  ', module: 'construction' }), 'DEVICE_REQUIRED');
  });

  it('signs the manifest so the platform can recognise its own later', () => {
    const { manifest } = issuePack(asPM(), { deviceId: 'handset-1', module: 'construction' });
    const { signature, ...body } = manifest;
    assert.ok(signature.value.length > 0);
    assert.ok(signature.kid.length > 0);
    assert.equal(manifestIsOurs(body, signature), true);
  });

  it('refuses a manifest whose scope was altered after issue', () => {
    // The attack the signature exists for: a device presenting a manifest it
    // widened, claiming an authorisation it was never granted.
    const { manifest } = issuePack(asPM(), { deviceId: 'handset-1', module: 'construction' });
    const { signature, ...body } = manifest;
    const widened = { ...body, entities: [...body.entities, { refType: 'Contract', refId: 'not-granted', stateHash: 'x', class: 'WORK' as const, required: false }] };
    assert.equal(manifestIsOurs(widened, signature), false);
  });

  it('carries the stream position it was cut at, so a device knows where to resume', () => {
    const before = platform.ledger.events({ projectId: seed.projectId }).at(-1)?.streamVersion;
    const { manifest } = issuePack(asPM(), { deviceId: 'handset-1', module: 'construction' });

    // The cursor is the stream as it stood when the pack was cut — before the
    // pack's own issuance event, which the device will receive on its first
    // pull. Cutting it after would hand the device a cursor past an event it
    // never saw.
    assert.equal(manifest.streamCursor, before);
    const after = platform.ledger.events({ projectId: seed.projectId }).at(-1)?.streamVersion;
    assert.equal(after, (before ?? 0) + 1, 'issuing wrote exactly one event');
  });

  it('gives every entity the hash a device verifies against', () => {
    const { manifest } = issuePack(asPM(), { deviceId: 'handset-1', module: 'construction' });
    assert.ok(manifest.entities.length > 0, 'the seed carries nothing this module packs');
    for (const entry of manifest.entities) {
      const record = platform.ledger.get({ refType: entry.refType, refId: entry.refId });
      assert.equal(entry.stateHash, record?.stateHash, `${entry.refType} ${entry.refId} carries the wrong hash`);
    }
  });

  it('marks permits and method statements required, and the rest optional', () => {
    const { manifest } = issuePack(asPM(), { deviceId: 'handset-1', classes: ['PERMITS', 'INFORMATION'] });
    for (const entry of manifest.entities) {
      assert.equal(entry.required, entry.class === 'PERMITS' || entry.class === 'SAFETY');
    }
  });

  it('numbers each pack for a device, so a re-cut is visible as a re-cut', () => {
    const first = issuePack(asPM(), { deviceId: 'handset-1', module: 'construction' });
    const second = issuePack(asPM(), { deviceId: 'handset-1', module: 'construction' });
    assert.equal(first.manifest.version, 1);
    assert.equal(second.manifest.version, 2);
    assert.equal(second.manifest.manifestId !== first.manifest.manifestId, true);
  });
});

describe('a new pack never destroys the last valid one', () => {
  it('leaves the previous pack live until the new one is verified', () => {
    const first = issuePack(asPM(), { deviceId: 'handset-1', module: 'construction' });
    const second = issuePack(asPM(), { deviceId: 'handset-1', module: 'construction' });

    // The moment that matters: the second pack exists and has not been
    // verified. A device whose download died here still has the first.
    const mid = packPosition(asPM());
    const held = mid.packs.find((entry) => entry.id === first.packId);
    assert.equal(held?.status, 'ISSUED', 'the first pack was withdrawn before the second verified');
    assert.equal(mid.packs.find((entry) => entry.id === second.packId)?.supersedes, first.packId);

    // Its manifest still serves, which is the practical test.
    assert.ok(packManifest(asPM(), first.packId).entities.length >= 0);
  });

  it('supersedes the previous pack only once the new one activates', () => {
    const first = issuePack(asPM(), { deviceId: 'handset-1', module: 'construction' });
    const second = issuePack(asPM(), { deviceId: 'handset-1', module: 'construction' });

    const result = recordPackReceipt(asPM(), {
      packId: second.packId,
      deviceId: 'handset-1',
      entitiesVerified: second.manifest.entities.length,
      filesVerified: second.manifest.files.length,
      activated: true,
    });

    assert.equal(result.supersededPackId, first.packId);
    const after = packPosition(asPM());
    assert.equal(after.packs.find((entry) => entry.id === first.packId)?.status, 'SUPERSEDED');
    assert.equal(after.packs.find((entry) => entry.id === second.packId)?.status, 'ACTIVE');
  });

  it('leaves the previous pack alone where the device verified but did not activate', () => {
    const first = issuePack(asPM(), { deviceId: 'handset-1', module: 'construction' });
    const second = issuePack(asPM(), { deviceId: 'handset-1', module: 'construction' });

    recordPackReceipt(asPM(), {
      packId: second.packId,
      deviceId: 'handset-1',
      entitiesVerified: second.manifest.entities.length,
      filesVerified: 0,
      activated: false,
    });

    const after = packPosition(asPM());
    assert.equal(after.packs.find((entry) => entry.id === first.packId)?.status, 'ISSUED');
    assert.equal(after.packs.find((entry) => entry.id === second.packId)?.status, 'ISSUED');
  });
});

describe('the receipt', () => {
  it('refuses activation where the device says it did not verify the required content', () => {
    // A pack activated without its permits would let a shift start against
    // authorisations nobody checked.
    const issued = issuePack(asPM(), { deviceId: 'handset-1', classes: ['PERMITS'] });
    const required = issued.manifest.entities.filter((entry) => entry.required).length;
    if (required === 0) return;

    throwsCode(
      () =>
        recordPackReceipt(asPM(), {
          packId: issued.packId,
          deviceId: 'handset-1',
          entitiesVerified: required - 1,
          filesVerified: 0,
          activated: true,
        }),
      'REQUIRED_CONTENT_UNVERIFIED',
    );
  });

  it('refuses a receipt from a device the pack was not issued to', () => {
    const issued = issuePack(asPM(), { deviceId: 'handset-1', module: 'construction' });
    throwsCode(
      () =>
        recordPackReceipt(asPM(), {
          packId: issued.packId,
          deviceId: 'somebody-elses-handset',
          entitiesVerified: 0,
          filesVerified: 0,
          activated: false,
        }),
      'PACK_NOT_FOR_DEVICE',
    );
  });

  it('refuses a second receipt, because the first is the record a dispute turns on', () => {
    const issued = issuePack(asPM(), { deviceId: 'handset-1', module: 'construction' });
    const receipt = {
      packId: issued.packId,
      deviceId: 'handset-1',
      entitiesVerified: issued.manifest.entities.length,
      filesVerified: 0,
      activated: true,
    };
    recordPackReceipt(asPM(), receipt);
    throwsCode(() => recordPackReceipt(asPM(), receipt), 'PACK_ALREADY_RECEIPTED');
  });

  it('records what the device reported rather than asserting the platform saw it', () => {
    const issued = issuePack(asPM(), { deviceId: 'handset-1', module: 'construction' });
    recordPackReceipt(asSupervisor(), {
      packId: issued.packId,
      deviceId: 'handset-1',
      entitiesVerified: issued.manifest.entities.length,
      filesVerified: 3,
      activated: true,
      note: 'Two files deferred to Wi-Fi.',
    });

    const held = packPosition(asPM()).packs.find((entry) => entry.id === issued.packId);
    assert.equal(held?.receipt?.activated, true);
    assert.equal(held?.receipt?.filesVerified, 3);
    assert.equal(held?.receipt?.reportedBy, seed.users.siteManager!.auth.actorId);
    assert.ok(held?.receipt?.reportedAt);
  });
});

describe('withdrawal', () => {
  it('needs a reason somebody can answer for', () => {
    const issued = issuePack(asPM(), { deviceId: 'handset-1', module: 'construction' });
    throwsCode(() => revokePack(asPM(), { packId: issued.packId, reason: 'no' }), 'REASON_REQUIRED');
  });

  it('refuses the manifest from then on', () => {
    const issued = issuePack(asPM(), { deviceId: 'handset-1', module: 'construction' });
    revokePack(asPM(), { packId: issued.packId, reason: 'Handset reported lost on the northern compound.' });
    throwsCode(() => packManifest(asPM(), issued.packId), 'PACK_REVOKED');
  });

  it('cannot be argued with by a receipt', () => {
    const issued = issuePack(asPM(), { deviceId: 'handset-1', module: 'construction' });
    revokePack(asPM(), { packId: issued.packId, reason: 'Access withdrawn while the device was offline.' });
    throwsCode(
      () =>
        recordPackReceipt(asPM(), {
          packId: issued.packId,
          deviceId: 'handset-1',
          entitiesVerified: 999,
          filesVerified: 999,
          activated: true,
        }),
      'PACK_REVOKED',
    );
  });

  it('is refused twice over', () => {
    const issued = issuePack(asPM(), { deviceId: 'handset-1', module: 'construction' });
    const reason = 'Project access revoked pending an investigation.';
    revokePack(asPM(), { packId: issued.packId, reason });
    throwsCode(() => revokePack(asPM(), { packId: issued.packId, reason }), 'PACK_ALREADY_REVOKED');
  });
});

describe('who may do it', () => {
  it('closes every pack event to an AI actor at the catalogue', () => {
    // The control that matters is at the append, not at the call site: no agent
    // decides what controlled information leaves the platform on a handset, and
    // `ledger.commit` refuses an AI actor on any of these four events however
    // it is reached.
    for (const code of ['OFFLINE_PACK_ISSUED', 'OFFLINE_PACK_ACTIVATED', 'OFFLINE_PACK_SUPERSEDED', 'OFFLINE_PACK_REVOKED']) {
      assert.equal(lookupEventType(code)?.aiAllowed, false, `${code} admits an AI actor`);
    }

    throwsCode(
      () =>
        platform.ledger.commit({
          tenantId: seed.tenantId,
          projectId: seed.projectId,
          actor: { refType: 'AI', refId: 'agent-under-test' },
          source: 'AI',
          correlationId: 'test',
          eventType: 'OFFLINE_PACK_ISSUED',
          entity: { refType: 'OfflinePack', refId: 'forged' },
          nextState: { id: 'forged' },
        }),
      'AI_NOT_PERMITTED',
    );
  });

  it('does not answer for a project that has no such pack', () => {
    throwsCode(() => packManifest(asPM(), 'not-a-pack'), 'NO_SUCH_PACK');
  });
});

describe('the register', () => {
  it('counts live, expired and withdrawn separately, and lists the devices holding one', () => {
    issuePack(asPM(), { deviceId: 'handset-1', module: 'construction' });
    const second = issuePack(asPM(), { deviceId: 'handset-2', module: 'commissioning' });
    revokePack(asPM(), { packId: second.packId, reason: 'Second handset returned to the store.' });

    const position = packPosition(asPM());
    assert.equal(position.revoked, 1);
    assert.equal(position.live, 1);
    assert.deepEqual(position.devices, ['handset-1']);
  });

  it('does not publish the signature or the manifest body on the register', () => {
    // The register is a list for a screen. Republishing every entity hash and
    // the signature on a list read is a needlessly large answer, and the
    // signature belongs with the manifest a device actually fetches.
    issuePack(asPM(), { deviceId: 'handset-1', module: 'construction' });
    const [entry] = packPosition(asPM()).packs;
    assert.ok(entry);
    assert.equal('manifest' in entry, false);
    assert.equal('signature' in entry, false);
    assert.equal(typeof entry.entities, 'number');
  });
});
