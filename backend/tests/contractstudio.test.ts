import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { ROUTES } from '../src/api/routes.ts';
import { CATALOGUE, draftable, formByKey } from '../src/domain/contracts/catalogue.ts';
import * as studio from '../src/domain/contracts/drafts.ts';
import { scheduleFor } from '../src/domain/contracts/schedules.ts';
import { recommendForms, RULE_KEYS } from '../src/domain/contracts/selection.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Contracts Studio, stage 1: the catalogue by exact edition, a shortlist with
 * reasons, and a contract draft completed against a pinned schedule — every
 * value normalised, every change a revision made against the one the person saw.
 */

let platform: Platform;
let seed: SeedResult;
const as = (who: string, projectId = seed.projectId): EngineContext => platform.context(seed.users[who]!.auth, projectId, { source: 'WEB' });
const refused = (fn: () => unknown, code: string) => assert.throws(fn, (error: { code?: string }) => error.code === code, `expected ${code}`);
const names = () => '—';

const JCT_DB = 'jct:2024:db';
const NEC_ECC = 'nec:nec4-jan-2023-revision:ecc';
const FIDIC_YELLOW = 'fidic:2017-2022-reprint:yellow';

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('the catalogue', () => {
  it('holds the handoff’s 168 forms by exact edition, each once, and no wording', () => {
    assert.equal(CATALOGUE.length, 168);
    assert.equal(new Set(CATALOGUE.map((entry) => entry.key)).size, 168);
    for (const entry of CATALOGUE) assert.ok(entry.source.startsWith('https://'), entry.key);
    assert.equal(CATALOGUE.filter((entry) => entry.status === 'CURRENT').length, 111);
    assert.ok(!draftable(formByKey('jct:legacy:legacy')!), 'an earlier-editions import route is not a form');
  });

  it('gives the three first forms their own schedule, pinned to the exact edition', () => {
    for (const key of [JCT_DB, NEC_ECC, FIDIC_YELLOW]) {
      assert.equal(formByKey(key)!.status, 'CURRENT');
      assert.equal(scheduleFor(key).formKey, key);
    }
    assert.equal(scheduleFor('fidic:2017-original:yellow').formKey, null, 'the 2017 original is not the 2022 reprint');
    assert.equal(scheduleFor('nec:nec4-jan-2023-revision:ecs').formKey, null, 'ECC main options are not carried to another NEC form');
  });
});

describe('the shortlist', () => {
  it('names only current, draftable forms that exist', () => {
    for (const key of RULE_KEYS) {
      const entry = formByKey(key);
      assert.ok(entry, key);
      assert.equal(entry!.status, 'CURRENT', key);
    }
  });

  it('suits the form to the job, with the reason, and says what it was not told', () => {
    const db = recommendForms({ package: 'MAIN_WORKS', design: 'CONTRACTOR', pricing: 'LUMP_SUM_WITHOUT_QUANTITIES', valueBand: 'LARGE' });
    assert.equal(db.recommendations[0]!.key, JCT_DB);
    assert.match(db.recommendations[0]!.reasons.join(' '), /designs and builds/);
    assert.equal(recommendForms({ package: 'MAIN_WORKS', design: 'EMPLOYER', pricing: 'TARGET_COST', valueBand: 'LARGE' }).recommendations[0]!.key, NEC_ECC);
    assert.equal(recommendForms({ package: 'MAIN_WORKS', design: 'CONTRACTOR', valueBand: 'LARGE', international: true }).recommendations[0]!.key, FIDIC_YELLOW);
    assert.equal(recommendForms({ package: 'MAIN_WORKS', design: 'EMPLOYER', pricing: 'LUMP_SUM_WITH_QUANTITIES', valueBand: 'SMALL' }).recommendations[0]!.key, 'jct:2024:mw');
    assert.equal(recommendForms({ package: 'HOMEOWNER' }).recommendations[0]!.key, 'jct:2021:ho-b');
    assert.deepEqual(recommendForms({ package: 'MAIN_WORKS' }).missing, ['design', 'pricing', 'valueBand']);
  });

  it('puts the form the tender names first, whatever the rules say', () => {
    const named = recommendForms({ package: 'MAIN_WORKS', design: 'CONTRACTOR', valueBand: 'LARGE', tenderNamedFormKey: NEC_ECC });
    assert.equal(named.recommendations[0]!.key, NEC_ECC);
    assert.match(named.recommendations[0]!.reasons.join(' '), /tender names this form/);
    refused(() => recommendForms({ package: 'MAIN_WORKS', tenderNamedFormKey: 'jct:1998:imaginary' }), 'CONTRACT_FORM_NOT_FOUND');
  });
});

describe('a contract draft', () => {
  let ecc: studio.ContractDraft;

  it('is refused without the module, and to a role not cleared for commercial terms', () => {
    refused(() => studio.studioOverview(as('qs'), names), 'MODULE_NOT_GRANTED');
    platform.setModuleGrant({ moduleId: 'CONTRACTS_STUDIO', tenantId: seed.tenantId, status: 'ACTIVE', reason: 'Contracts Studio test', decidedBy: seed.users.operator!.id });
    refused(() => studio.studioOverview(as('planner'), names), 'ACCESS_DENIED');
    assert.equal(studio.studioOverview(as('qs'), names).catalogue.length, 168);
  });

  it('opens only on a pinned edition the person confirms', () => {
    refused(() => studio.createDraft(as('qs'), { formKey: NEC_ECC, confirmEdition: 'NEC4', title: 'Main contract' }), 'CONTRACT_EDITION_NOT_CONFIRMED');
    refused(() => studio.createDraft(as('qs'), { formKey: 'nec:legacy:legacy', confirmEdition: 'legacy', title: 'Main contract' }), 'CONTRACT_FORM_EDITION_UNPINNED');
    refused(() => studio.createDraft(as('qs'), { formKey: NEC_ECC, confirmEdition: 'NEC4: Jan 2023 revision', title: 'Main contract', currency: 'JPY' }), 'CONTRACT_CURRENCY');
    ecc = studio.createDraft(as('qs'), {
      formKey: NEC_ECC,
      confirmEdition: 'NEC4: Jan 2023 revision',
      title: 'Main contract — trunk main diversion',
      selection: { package: 'MAIN_WORKS', design: 'EMPLOYER', pricing: 'TARGET_COST', valueBand: 'LARGE' },
    });
    assert.equal(ecc.reference, 'CD-001');
    assert.equal(ecc.scheduleId, 'nec4-ecc-2023-v1');
    assert.equal(ecc.revision, 1);
    assert.match(ecc.selection!.reasons.join(' '), /target cost/i);
    const legacy = studio.createDraft(as('qs'), { formKey: 'nec:nec3-april-2013-suite:ecc', confirmEdition: 'NEC3: April 2013 suite', title: 'Legacy framework call-off' });
    assert.equal(legacy.scheduleId, 'general-v1', 'an earlier edition is completed on the general schedule, not the NEC4 one');
  });

  it('normalises each value by its type and refuses what is not one', () => {
    let draft = studio.setField(as('qs'), ecc.id, { key: 'starting_date', value: '01/03/2027', expectedRevision: 1 });
    assert.equal(draft.fields.starting_date!.value, '2027-03-01');
    assert.equal(draft.revision, 2);
    refused(() => studio.setField(as('qs'), ecc.id, { key: 'completion_date', value: '31/02/2028', expectedRevision: 2 }), 'CONTRACT_FIELD_VALUE');
    refused(() => studio.setField(as('qs'), ecc.id, { key: 'fee_percentage', value: 'about ten', expectedRevision: 2 }), 'CONTRACT_FIELD_VALUE');
    refused(() => studio.setField(as('qs'), ecc.id, { key: 'delay_damages', value: '€5,000', expectedRevision: 2 }), 'CONTRACT_FIELD_VALUE');
    refused(() => studio.setField(as('qs'), ecc.id, { key: 'contract_sum', value: '1000000', expectedRevision: 2 }), 'CONTRACT_FIELD_UNKNOWN');
    draft = studio.setField(as('qs'), ecc.id, { key: 'delay_damages', value: '£5,000', expectedRevision: 2 });
    assert.equal(draft.fields.delay_damages!.value, '5000.00');
    const same = studio.setField(as('qs'), ecc.id, { key: 'delay_damages', value: '5k', expectedRevision: 3 });
    assert.equal(same.revision, 3, 'the same amount written another way is no change');
    draft = studio.setField(as('qs'), ecc.id, { key: 'defects_date', value: '52 wks', expectedRevision: 3 });
    assert.equal(draft.fields.defects_date!.value, '52 WEEKS');
    draft = studio.setField(as('qs'), ecc.id, { key: 'main_option', value: 'Option C — target contract with activity schedule', expectedRevision: 4 });
    assert.equal(draft.fields.main_option!.value, 'C');
  });

  it('refuses a change made against a revision that has moved on', () => {
    refused(() => studio.setField(as('pm'), ecc.id, { key: 'supervisor', value: 'A. Supervisor', expectedRevision: 2 }), 'CONTRACT_DRAFT_STALE');
  });

  it('finds what cannot both be true on an NEC4 ECC, before anybody approves it', () => {
    let draft = studio.setField(as('qs'), ecc.id, { key: 'pricing_document_kind', value: 'BILL_OF_QUANTITIES', expectedRevision: 5 });
    draft = studio.setField(as('qs'), ecc.id, { key: 'completion_date', value: '2027-01-01', expectedRevision: draft.revision });
    const view = studio.draftView(draft, names);
    const codes = view.findings.map((finding) => finding.code);
    assert.ok(codes.includes('NEC_PRICING_DOCUMENT_MISMATCH'), 'option C is priced by an activity schedule');
    assert.ok(codes.includes('NEC_X7_NOT_CHOSEN'), 'delay damages without X7');
    assert.ok(codes.includes('DATES_OUT_OF_ORDER'));
    assert.ok(view.findings.some((finding) => finding.fieldKey === 'fee_percentage'), 'a target contract needs the fee');
    assert.ok(view.blocking > 0);
    assert.ok(view.completion.completed < view.completion.required);
    draft = studio.setField(as('qs'), ecc.id, { key: 'pricing_document_kind', value: 'ACTIVITY_SCHEDULE', expectedRevision: draft.revision });
    draft = studio.setField(as('qs'), ecc.id, { key: 'secondary_options', value: 'X2, X7, W2, Y(UK)2', expectedRevision: draft.revision });
    draft = studio.setField(as('qs'), ecc.id, { key: 'completion_date', value: '2028-06-30', expectedRevision: draft.revision });
    const after = studio.draftView(draft, names).findings.map((finding) => finding.code);
    assert.ok(!after.includes('NEC_PRICING_DOCUMENT_MISMATCH'));
    assert.ok(!after.includes('NEC_X7_NOT_CHOSEN'));
    assert.ok(!after.includes('DATES_OUT_OF_ORDER'));
  });

  it('clears a value in a new revision, keeps every revision on the record, and reads the same from nowhere else', () => {
    const before = studio.draftOf(as('pm'), ecc.id);
    const cleared = studio.setField(as('pm'), ecc.id, { key: 'delay_damages', value: null, note: 'Damages to be agreed at negotiation', expectedRevision: before.revision });
    assert.equal(cleared.fields.delay_damages, undefined);
    assert.equal(cleared.revision, before.revision + 1);
    const events = platform.ledger.eventsForEntity({ refType: 'ContractDraft', refId: ecc.id });
    assert.equal(events.length, cleared.revision, 'one event per revision');
    const other = platform.ledger.listByTenant(seed.tenantId, 'Project').find((record) => record.refId !== seed.projectId && !record.refId.endsWith('-governance'))!;
    refused(() => studio.draftOf(as('qs', other.refId), ecc.id), 'CONTRACT_DRAFT_NOT_FOUND');
  });

  it('is withdrawn with its reason and then takes no change', () => {
    const current = studio.draftOf(as('qs'), ecc.id);
    refused(() => studio.withdrawDraft(as('planner'), ecc.id, { reason: 'Not mine to withdraw' }), 'ACCESS_DENIED');
    const withdrawn = studio.withdrawDraft(as('qs'), ecc.id, { reason: 'Superseded by the negotiated draft' });
    assert.equal(withdrawn.status, 'WITHDRAWN');
    refused(() => studio.setField(as('qs'), ecc.id, { key: 'supervisor', value: 'A. Supervisor', expectedRevision: current.revision }), 'CONTRACT_DRAFT_STATE');
  });

  it('publishes every route', () => {
    const paths = new Set(ROUTES.map((route) => `${route.method} ${route.pattern}`));
    for (const path of [
      'GET /v1/projects/:projectId/contract-studio',
      'POST /v1/projects/:projectId/contract-studio/selection',
      'POST /v1/projects/:projectId/contract-studio/drafts',
      'POST /v1/projects/:projectId/contract-studio/drafts/:draftId/fields',
      'POST /v1/projects/:projectId/contract-studio/drafts/:draftId/withdraw',
    ]) {
      assert.ok(paths.has(path), path);
    }
  });
});
