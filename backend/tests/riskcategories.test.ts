import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RISK_CATEGORY, values } from '../../shared/vocabulary.js';
import { RISK_CATEGORIES } from '../src/engines/maths/risk.ts';
import { ROUTES } from '../src/api/routes.ts';

/**
 * The risk screen offers exactly the categories the risk engine scores under.
 * It used to offer GROUND and LABOUR, which the engine does not name, so a risk
 * registered under either was a category nothing else on the platform read.
 */
describe('one list of risk categories', () => {
  it('the screen offers exactly the engine’s categories', () => {
    assert.deepEqual([...values(RISK_CATEGORY)].sort(), [...RISK_CATEGORIES].sort());
  });

  it('the register route refuses any other', () => {
    const route = ROUTES.find((entry) => entry.method === 'POST' && entry.pattern === '/v1/projects/:projectId/risk')!;
    const category = (route.schema as { properties: { category: { enum: string[] } } }).properties.category;
    assert.deepEqual([...category.enum].sort(), [...RISK_CATEGORIES].sort());
  });
});
