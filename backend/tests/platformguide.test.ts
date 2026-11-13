import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { authOf } from '../src/seed.ts';
import { AREA_CONSOLE_PAGE } from '../../shared/vocabulary.js';
import {
  GUIDE_TOPICS,
  guideGroundingLines,
  guideTopics,
  relevantGuideTopics,
} from '../src/ai/platformguide.ts';

/**
 * The platform step-by-step guide — the knowledge base the in-platform guide
 * and the copilot both read. These tests pin the two promises the file makes:
 * every topic is well-formed and points at a real screen, and the relevance
 * scorer hands the copilot the right part of the platform for a question.
 */

function workspace() {
  const platform = new Platform();
  const { tenant } = platform.createTenant({
    legalName: 'Guide Test Ltd',
    enterpriseName: 'Guide',
    jurisdiction: 'GB',
    defaultCurrency: 'GBP',
    tier: 'ENTERPRISE',
  });
  const user = platform.createUser({
    tenantId: tenant.id,
    name: 'Owner',
    email: `owner-${Math.random().toString(36).slice(2)}@guide.test`,
    roles: ['OWNER'],
  });
  const auth = authOf(platform, user.id);
  const governance = platform.context(auth, `${tenant.id}-governance`, { source: 'WEB' });
  return { platform, tenantId: tenant.id, auth, governance };
}

const VALID_SCREENS = new Set(Object.values(AREA_CONSOLE_PAGE));

describe('Platform guide knowledge base', () => {
  it('every topic is well-formed and points at a real screen', () => {
    const ids = new Set<string>();
    for (const topic of GUIDE_TOPICS) {
      assert.ok(topic.id && !ids.has(topic.id), `duplicate or empty id: ${topic.id}`);
      ids.add(topic.id);
      assert.ok(topic.title.length > 0, `${topic.id}: title`);
      assert.ok(topic.summary.length > 0, `${topic.id}: summary`);
      assert.ok(topic.youGet.length > 0, `${topic.id}: youGet`);
      assert.ok(topic.steps.length > 0, `${topic.id}: steps`);
      assert.ok(topic.keywords.length > 0, `${topic.id}: keywords`);
      assert.ok(VALID_SCREENS.has(topic.screen), `${topic.id}: screen “${topic.screen}” is not a console page`);
      for (const step of topic.steps) assert.ok(step.do.length > 0, `${topic.id}: empty step`);
    }
    assert.ok(GUIDE_TOPICS.length >= 12, 'the guide should cover the end-to-end journey');
  });

  it('guideTopics returns the groups in road order with every topic', () => {
    const { governance } = workspace();
    const result = guideTopics(governance);
    assert.equal(result.count, GUIDE_TOPICS.length);
    const seen = result.groups.flatMap((g) => g.topics.length);
    assert.equal(
      seen.reduce((a, b) => a + b, 0),
      GUIDE_TOPICS.length,
      'every topic appears in exactly one group',
    );
    // Road order: setting up comes before winning and before how-it-works.
    const order = result.groups.map((g) => g.group);
    assert.ok(order.indexOf('SET_UP') < order.indexOf('BID'));
    assert.ok(order.indexOf('BID') < order.indexOf('DELIVER'));
    assert.ok(order.indexOf('DELIVER') < order.indexOf('HOW_IT_WORKS'));
  });

  it('every topic can be found by its id', () => {
    const ids = GUIDE_TOPICS.map((t) => t.id);
    assert.ok(ids.includes('read-into-matrix'));
    assert.ok(ids.includes('price-the-works'));
    assert.ok(ids.includes('focus-one-tender'));
  });

  it('a question about how long a job takes lands on pricing the works, not the ITT', () => {
    const topics = relevantGuideTopics('how long will the job take, what is the time estimate?');
    assert.ok(topics.length > 0);
    assert.equal(topics[0]!.id, 'price-the-works', 'duration is seeded from the measured works');
  });

  it('a question about mixing tenders lands on the focus topic', () => {
    const topics = relevantGuideTopics('everything is mixing, how do I work on just one tender?');
    assert.ok(topics.some((t) => t.id === 'focus-one-tender'));
  });

  it('a question about reading a tender lands on the matrix topic', () => {
    const topics = relevantGuideTopics('how do I get the AI to read the invitation requirements?');
    assert.ok(topics.some((t) => t.id === 'read-into-matrix'));
  });

  it('a question matching nothing returns no topics rather than guessing', () => {
    assert.equal(relevantGuideTopics('xyzzy quux frobnicate').length, 0);
  });

  it('grounding lines carry the screen and the numbered steps for the copilot', () => {
    const topics = relevantGuideTopics('how do I read the invitation into a matrix?');
    assert.ok(topics.length > 0);
    const topic = topics[0]!;
    const lines = guideGroundingLines([topic]);
    assert.ok(lines[0]!.includes(`screen: ${topic.screen}`));
    assert.ok(lines.some((l) => /^\s+1\./.test(l)), 'the first step is numbered');
    assert.equal(guideGroundingLines([]).length, 0);
  });
});
