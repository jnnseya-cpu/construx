import { DomainError } from './errors.ts';

/**
 * Constrained RFC 6902 JSON Patch.
 *
 * The Golden Thread allows only add / remove / replace. move and copy are
 * banned because the same end state can be reached by several op sequences,
 * which makes a replay ambiguous; test is banned because it is an assertion,
 * not a state change.
 */
export type PatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown };

const ALLOWED_OPS = new Set(['add', 'remove', 'replace']);

/** Mandatory op ordering for hash determinism: remove, then add, then replace. */
const OP_RANK: Record<string, number> = { remove: 0, add: 1, replace: 2 };

function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function parsePointer(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw new DomainError('PATCH_INVALID_PATH', `JSON Pointer must start with "/": ${path}`);
  return path.slice(1).split('/').map(unescapeToken);
}

export function validatePatch(patch: PatchOp[]): void {
  for (const op of patch) {
    if (!ALLOWED_OPS.has(op.op)) {
      throw new DomainError('PATCH_OP_FORBIDDEN', `Operation "${op.op}" is not permitted on the Golden Thread`);
    }
    if (typeof op.path !== 'string' || (op.path !== '' && !op.path.startsWith('/'))) {
      throw new DomainError('PATCH_INVALID_PATH', `Invalid JSON Pointer: ${String(op.path)}`);
    }
    if (op.path.includes('*')) {
      throw new DomainError('PATCH_INVALID_PATH', 'Wildcard paths are not permitted');
    }
    for (const token of parsePointer(op.path)) {
      // Array appends via "-" are non-deterministic on replay: the resulting index
      // depends on array length at apply time. Explicit indices only.
      if (token === '-') {
        throw new DomainError('PATCH_INVALID_PATH', 'Array operations must use explicit indices, not "-"');
      }
    }
  }
}

/** Sort into the mandated remove → add → replace order, stable within each group. */
export function orderPatch(patch: PatchOp[]): PatchOp[] {
  return patch
    .map((op, index) => ({ op, index }))
    .sort((a, b) => {
      const rank = (OP_RANK[a.op.op] ?? 9) - (OP_RANK[b.op.op] ?? 9);
      if (rank !== 0) return rank;
      // Deeper paths first within a remove group so parent removals do not
      // invalidate child indices; natural order otherwise.
      if (a.op.op === 'remove') {
        const depth = b.op.path.split('/').length - a.op.path.split('/').length;
        if (depth !== 0) return depth;
        if (a.op.path !== b.op.path) return a.op.path < b.op.path ? 1 : -1;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.op);
}

function clone<T>(value: T): T {
  return value === undefined ? value : (structuredClone(value) as T);
}

function resolveParent(root: unknown, tokens: string[]): { parent: unknown; key: string } {
  let current = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i] as string;
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new DomainError('PATCH_PATH_NOT_FOUND', `Array index out of range at "${token}"`);
      }
      current = current[index];
    } else if (current !== null && typeof current === 'object') {
      const record = current as Record<string, unknown>;
      if (!(token in record)) throw new DomainError('PATCH_PATH_NOT_FOUND', `Missing path segment "${token}"`);
      current = record[token];
    } else {
      throw new DomainError('PATCH_PATH_NOT_FOUND', `Cannot descend into "${token}"`);
    }
  }
  return { parent: current, key: tokens[tokens.length - 1] as string };
}

/** Apply an ordered, validated patch to a state object. Pure — input is not mutated. */
export function applyPatch<T>(state: T, patch: PatchOp[]): T {
  validatePatch(patch);
  let root: unknown = clone(state);

  for (const op of orderPatch(patch)) {
    const tokens = parsePointer(op.path);

    if (tokens.length === 0) {
      if (op.op === 'remove') throw new DomainError('PATCH_INVALID_PATH', 'Cannot remove the document root');
      root = clone((op as { value: unknown }).value);
      continue;
    }

    const { parent, key } = resolveParent(root, tokens);

    if (Array.isArray(parent)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0) {
        throw new DomainError('PATCH_INVALID_PATH', `Array index must be a non-negative integer: "${key}"`);
      }
      if (op.op === 'remove') {
        if (index >= parent.length) throw new DomainError('PATCH_PATH_NOT_FOUND', `Array index ${index} out of range`);
        parent.splice(index, 1);
      } else if (op.op === 'add') {
        if (index > parent.length) throw new DomainError('PATCH_PATH_NOT_FOUND', `Array index ${index} out of range`);
        parent.splice(index, 0, clone(op.value));
      } else {
        if (index >= parent.length) throw new DomainError('PATCH_PATH_NOT_FOUND', `Array index ${index} out of range`);
        parent[index] = clone(op.value);
      }
      continue;
    }

    if (parent === null || typeof parent !== 'object') {
      throw new DomainError('PATCH_PATH_NOT_FOUND', `Cannot apply "${op.op}" at "${op.path}"`);
    }

    const record = parent as Record<string, unknown>;
    if (op.op === 'remove') {
      if (!(key in record)) throw new DomainError('PATCH_PATH_NOT_FOUND', `Cannot remove missing key "${key}"`);
      delete record[key];
    } else if (op.op === 'replace') {
      if (!(key in record)) throw new DomainError('PATCH_PATH_NOT_FOUND', `Cannot replace missing key "${key}"`);
      record[key] = clone(op.value);
    } else {
      record[key] = clone(op.value);
    }
  }

  return root as T;
}

/**
 * Derive a minimal patch between two states. Emits only add/remove/replace and
 * returns them in the mandated order, so a diff can be fed straight into an event.
 */
export function diffState(before: unknown, after: unknown): PatchOp[] {
  const ops: PatchOp[] = [];
  walk(before, after, '', ops);
  return orderPatch(ops);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function walk(before: unknown, after: unknown, pointer: string, ops: PatchOp[]): void {
  if (before === after) return;

  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of Object.keys(before).sort()) {
      const path = `${pointer}/${escapeToken(key)}`;
      if (!(key in after) || after[key] === undefined) {
        ops.push({ op: 'remove', path });
      } else {
        walk(before[key], after[key], path, ops);
      }
    }
    for (const key of Object.keys(after).sort()) {
      if (after[key] === undefined) continue;
      if (!(key in before) || before[key] === undefined) {
        ops.push({ op: 'add', path: `${pointer}/${escapeToken(key)}`, value: after[key] });
      }
    }
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    // Arrays are replaced wholesale when their length changes: element-wise
    // splice inference is where non-deterministic diffs creep in.
    if (before.length !== after.length) {
      ops.push({ op: 'replace', path: pointer === '' ? '' : pointer, value: after });
      return;
    }
    for (let i = 0; i < after.length; i++) {
      walk(before[i], after[i], `${pointer}/${i}`, ops);
    }
    return;
  }

  if (JSON.stringify(before) === JSON.stringify(after)) return;

  if (before === undefined) {
    ops.push({ op: 'add', path: pointer, value: after });
  } else if (after === undefined) {
    ops.push({ op: 'remove', path: pointer });
  } else {
    ops.push({ op: 'replace', path: pointer, value: after });
  }
}
