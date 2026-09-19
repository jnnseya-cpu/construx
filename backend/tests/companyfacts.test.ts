import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validate } from '../src/core/validate.ts';
import { matchRoute } from '../src/api/routes.ts';
import * as radar from '../src/domain/radar.ts';

/**
 * The form the whole bid pipeline waits on, and the schema that refused it.
 *
 * Reported from the console as
 * `VALIDATION_FAILED — turnoverMinorByYear must contain at least 1 item(s);
 * targetMarginPercent must be of type number, received object`.
 *
 * The form was right and the schema was wrong, in two places at once, and both
 * are the same defect: the schema had drifted from the engine it guards.
 *
 * - `turnoverMinorByYear` is `number[]` on `CompanyProfile`. The schema said
 *   `items: { type: 'object' }`, so a correctly filled year list was refused
 *   for being exactly what the engine reads.
 * - `targetMarginPercent` is `{ min, max }`, and the radar reads
 *   `profile.targetMarginPercent.max`. The schema said `type: 'number'` — so
 *   every correct submission was refused, and anything that satisfied the
 *   schema would have crashed the radar reading `.max` of a number.
 *
 * A schema that disagrees with its own engine refuses the right answer and
 * accepts the wrong one, which is worse than having no schema at all. This
 * pins the shape from both ends: the payload the console sends must pass the
 * schema, and the value the schema admits must be the shape the engine's own
 * type declares.
 */

/** Exactly what `frontend/pages/pipeline.js` builds and sends. */
const AS_THE_CONSOLE_SENDS_IT = {
  legalName: 'JNseya Construction & Consultants Ltd',
  turnoverMinorByYear: [140_000_00, 96_000_00],
  netAssetsMinor: 38_000_00,
  workingCapitalMinor: 22_000_00,
  regions: ['Rawtenstall', 'Manchester'],
  sectors: ['RMI'],
  cpvCodes: [],
  valueBandMinor: { min: 5_000_00, max: 750_000_00 },
  insurances: [],
  accreditations: ['CHAS'],
  references: [],
  selfDeliveredTrades: ['Masonry'],
  targetMarginPercent: { min: 8, max: 14 },
  capacity: { concurrentProjects: 4, committedProjects: 1 },
};

/** Every field violation, as the console would be told them. */
const failuresFor = (body: unknown, method: string, path: string): string =>
  validate(body, schemaFor(method, path))
    .map((failure) => JSON.stringify(failure))
    .join('; ');

const schemaFor = (method: string, path: string) => {
  const matched = matchRoute(method, path);
  assert.ok(matched, `${method} ${path} does not resolve to a route`);
  assert.ok(matched.route.schema, `${method} ${path} has no schema to check`);
  return matched.route.schema!;
};

describe('the company profile the bid pipeline waits on', () => {
  it('accepts the body the console actually sends', () => {
    assert.equal(failuresFor(AS_THE_CONSOLE_SENDS_IT, 'PUT', '/v1/company/profile'), '');
  });

  it('takes the turnover as money rather than as objects', () => {
    assert.match(
      failuresFor({ ...AS_THE_CONSOLE_SENDS_IT, turnoverMinorByYear: [{ year: 2026, amount: 1 }] }, 'PUT', '/v1/company/profile'),
      /turnoverMinorByYear/,
    );
    // And the business rule behind it stands: the radar sizes what a company
    // can carry from its turnover and will not invent it.
    assert.match(failuresFor({ ...AS_THE_CONSOLE_SENDS_IT, turnoverMinorByYear: [] }, 'PUT', '/v1/company/profile'), /turnoverMinorByYear/);
  });

  it('takes the target margin as the range the radar reads', () => {
    // A bare number is what the schema used to demand, and it is the one shape
    // that would break the engine.
    assert.match(failuresFor({ ...AS_THE_CONSOLE_SENDS_IT, targetMarginPercent: 12 }, 'PUT', '/v1/company/profile'), /targetMarginPercent/);
    assert.match(failuresFor({ ...AS_THE_CONSOLE_SENDS_IT, targetMarginPercent: { min: 8 } }, 'PUT', '/v1/company/profile'), /max/);
  });

  it('is the shape the engine’s own type declares', () => {
    // Structural, not nominal: the object above is assigned to the engine's
    // type, so a change to `CompanyProfile` that this payload no longer
    // satisfies fails the typecheck rather than a test nobody reruns.
    const profile: radar.CompanyProfile = AS_THE_CONSOLE_SENDS_IT as radar.CompanyProfile;
    assert.equal(profile.targetMarginPercent.max, 14);
    assert.equal(profile.turnoverMinorByYear[0], 140_000_00);
    assert.equal(profile.capacity.concurrentProjects, 4);
  });
});
