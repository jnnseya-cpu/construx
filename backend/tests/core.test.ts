import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { canonicalize, hashState, stateRootHash, EMPTY_STATE_HASH } from '../src/core/canonical.ts';
import { applyPatch, diffState, orderPatch, validatePatch, type PatchOp } from '../src/core/jsonpatch.ts';
import { isUlid, ulid, formatRef } from '../src/core/ids.ts';
import { validate } from '../src/core/validate.ts';

describe('canonical serialisation and hashing', () => {
  it('sorts keys and omits whitespace so serialisation is reproducible', () => {
    assert.equal(canonicalize({ b: 1, a: { z: 2, y: 1 } }), '{"a":{"y":1,"z":2},"b":1}');
  });

  it('preserves array order, because order is state', () => {
    assert.notEqual(hashState({ items: [1, 2] }), hashState({ items: [2, 1] }));
  });

  it('ignores audit metadata so a re-save does not look like a change', () => {
    const a = { id: 'X', value: 10, audit: { createdAt: '2026-01-01', createdBy: 'alice', version: 1 } };
    const b = { id: 'X', value: 10, audit: { createdAt: '2027-06-30', createdBy: 'bob', version: 9 } };
    assert.equal(hashState(a), hashState(b));
  });

  it('ignores transient and derived fields', () => {
    assert.equal(hashState({ id: 'X', _uiSelected: true, derived: { total: 5 } }), hashState({ id: 'X' }));
  });

  it('detects any change to real state', () => {
    assert.notEqual(hashState({ id: 'X', value: 10 }), hashState({ id: 'X', value: 11 }));
  });

  it('produces a stable project root regardless of entity insertion order', () => {
    const entities = [
      { refType: 'Task', refId: 'B', state: { v: 2 } },
      { refType: 'Task', refId: 'A', state: { v: 1 } },
    ];
    assert.equal(stateRootHash(entities), stateRootHash([...entities].reverse()));
  });

  it('renders hashes in the documented sha256:<hex> form', () => {
    assert.match(EMPTY_STATE_HASH, /^sha256:[0-9a-f]{64}$/);
  });
});

describe('constrained JSON Patch', () => {
  it('rejects move and copy, which make replay ambiguous', () => {
    throwsCode(() => validatePatch([{ op: 'move', path: '/a', from: '/b' } as unknown as PatchOp]), 'PATCH_OP_FORBIDDEN');
    throwsCode(() => validatePatch([{ op: 'copy', path: '/a', from: '/b' } as unknown as PatchOp]), 'PATCH_OP_FORBIDDEN');
  });

  it('rejects the array append token, whose target index depends on apply time', () => {
    assert.throws(() => validatePatch([{ op: 'add', path: '/items/-', value: 1 }]), /explicit indices/);
  });

  it('orders operations remove, then add, then replace', () => {
    const ordered = orderPatch([
      { op: 'replace', path: '/c', value: 3 },
      { op: 'add', path: '/b', value: 2 },
      { op: 'remove', path: '/a' },
    ]);
    assert.deepEqual(ordered.map((op) => op.op), ['remove', 'add', 'replace']);
  });

  it('round-trips: applying a derived diff reproduces the target state', () => {
    const before = { a: 1, b: { c: 2, d: [1, 2, 3] }, e: 'keep' };
    const after = { a: 5, b: { c: 2, d: [1, 2, 3, 4] }, f: 'new' };
    assert.deepEqual(applyPatch(before, diffState(before, after)), after);
  });

  it('leaves the input untouched', () => {
    const before = { a: 1 };
    applyPatch(before, [{ op: 'replace', path: '/a', value: 2 }]);
    assert.deepEqual(before, { a: 1 });
  });

  it('refuses to replace a key that does not exist', () => {
    throwsCode(() => applyPatch({ a: 1 }, [{ op: 'replace', path: '/missing', value: 2 }]), 'PATCH_PATH_NOT_FOUND');
  });
});

describe('identifiers', () => {
  it('mints sortable ULIDs even within the same millisecond', () => {
    const now = Date.now();
    const ids = Array.from({ length: 200 }, () => ulid(now));
    assert.deepEqual(ids, [...ids].sort());
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every(isUlid));
  });

  it('formats human-readable references', () => {
    assert.equal(formatRef('RFI', 7), 'RFI-0007');
    assert.equal(formatRef('WO', 42, 5), 'WO-00042');
  });
});

describe('schema validation', () => {
  const schema = {
    type: 'object',
    required: ['id', 'amount'],
    properties: {
      id: { type: 'string', minLength: 1 },
      amount: { type: 'integer', minimum: 0 },
      status: { type: 'string', enum: ['OPEN', 'CLOSED'] },
    },
    additionalProperties: false,
  };

  it('accepts a conforming object', () => {
    assert.deepEqual(validate({ id: 'A', amount: 5, status: 'OPEN' }, schema), []);
  });

  it('reports every violation at once rather than the first', () => {
    const failures = validate({ amount: -1, status: 'UNKNOWN', extra: true }, schema);
    const fields = failures.map((f) => f.field);
    assert.ok(fields.includes('id'));
    assert.ok(fields.includes('amount'));
    assert.ok(fields.includes('status'));
    assert.ok(fields.includes('extra'));
  });
});
