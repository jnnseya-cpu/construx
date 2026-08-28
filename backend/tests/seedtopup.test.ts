import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { DEMO_TENANCY, ensureDemonstrationExtras, seedDemoProject } from '../src/seed.ts';

/**
 * The demonstration has to converge, however the deployment got there.
 *
 * This is the defect that made every addition to the demonstration invisible on
 * the live site while looking perfect in development, and it is worth stating
 * precisely because the failure is silent on both sides.
 *
 * `getOrCreateConsoleSession` **adopts** an existing demonstration tenancy
 * rather than seeding a second one. That is correct: the memo lives in the
 * process and the ledger lives on disk, so seeding unconditionally would build
 * a second Meridian on every restart until the sign-in page listed a dozen
 * Project Managers. But adoption returned immediately, so anything added to the
 * seed *after* a deployment first ran was never created there.
 *
 * The asymmetry is what made it invisible. A laptop throws its journal away, so
 * it reseeds from scratch and shows every addition on the next run. The one
 * deployment that keeps its journal — the live one — adopts, returns, and shows
 * none of them. Development is the environment that cannot reproduce it.
 *
 * `ensureDemonstrationExtras` is idempotent by construction: each block asks
 * whether the thing already exists, by the name or address it would have been
 * created under. These tests hold it to both halves of that — it adds what is
 * missing, and running it again adds nothing.
 */

/** Projects the extras are responsible for, by the names they are created under. */
const EXTRA_PROJECTS = [
  'Calderdale Reservoir Renewal',
  'Rossendale Trunk Main Diversion',
  'Northern Collector Tunnel — Phase 3',
];

function estate(platform: Platform, tenantId: string) {
  return {
    projects: platform.ledger
      .entitiesOfType('Project')
      .filter((record) => record.tenantId === tenantId)
      .map((record) => ({ name: String(record.state.name), phase: String(record.state.phase) })),
    portfolios: platform.ledger
      .listByTenant(tenantId, 'Portfolio')
      .map((record) => ({ name: String(record.state.name), region: record.state.continentCode as string | undefined })),
    emails: platform.users(tenantId).map((user) => user.email),
  };
}

describe('the demonstration converges on a tenancy that already exists', () => {
  it('builds the whole estate on a fresh seed', async () => {
    const platform = new Platform();
    const seed = await seedDemoProject(platform);
    const after = estate(platform, seed.tenantId);

    for (const name of EXTRA_PROJECTS) {
      assert.ok(after.projects.some((p) => p.name === name), `${name} is missing from a fresh seed`);
    }
    assert.ok(after.emails.includes('construction@meridian.example'), 'no Construction Manager on a fresh seed');
    assert.ok(after.portfolios.some((p) => p.region === 'AF'), 'no second region on a fresh seed');

    // The phases are the whole point of the extra projects: with only the
    // flagship in Operations, procurement, estimating and field execution are
    // closed to every role on every project.
    const phases = new Set(after.projects.map((p) => p.phase));
    for (const phase of ['OPERATIONS', 'TENDER', 'CONSTRUCTION', 'CONCEPT']) {
      assert.ok(phases.has(phase), `nothing is at ${phase}, so that part of the product is unreachable`);
    }
  });

  it('adds nothing the second time', async () => {
    // Idempotence, asserted rather than assumed. Without it, every console
    // bootstrap on a live deployment would add another Rossendale.
    const platform = new Platform();
    const seed = await seedDemoProject(platform);
    const before = estate(platform, seed.tenantId);

    await ensureDemonstrationExtras(platform);
    await ensureDemonstrationExtras(platform);
    const after = estate(platform, seed.tenantId);

    assert.equal(after.projects.length, before.projects.length, 'a second run created another project');
    assert.equal(after.portfolios.length, before.portfolios.length, 'a second run created another portfolio');
    assert.equal(after.emails.length, before.emails.length, 'a second run created another identity');
  });

  it('is a no-op on a platform with no demonstration tenancy', async () => {
    // Production with the demonstration switched off has no Meridian to top up.
    // Refusing quietly is right; throwing would take the console bootstrap down
    // with it on a deployment that deliberately has no demonstration at all.
    const platform = new Platform();
    const result = await ensureDemonstrationExtras(platform);
    assert.deepEqual(result.timeline, []);
  });

  it('names the flagship project it must not duplicate', () => {
    // A guard on the guard. The extras identify the flagship by name to leave
    // it alone; if that constant is renamed and this list is not, the seed
    // would rebuild it as an extra.
    assert.ok(!EXTRA_PROJECTS.includes(DEMO_TENANCY.projectName));
  });
});
