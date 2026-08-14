import { ValidationError } from './errors.ts';

/**
 * Dependency-free JSON Schema validator covering the subset the platform's own
 * schemas use: type, required, enum, properties, additionalProperties, items,
 * minimum/maximum, minLength/maxLength, minItems, pattern, format (date-time),
 * const, oneOf, $ref to local $defs.
 *
 * Every command body is validated against a schema before it reaches a handler,
 * and every entity is re-validated after a patch is applied — a patch that
 * produces an invalid entity must be rejected before it can be committed.
 */

export type Schema = Record<string, unknown>;

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type Failure = { field: string; message: string };

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

function resolveRef(ref: string, root: Schema): Schema {
  if (!ref.startsWith('#/')) return {};
  let current: unknown = root;
  for (const segment of ref.slice(2).split('/')) {
    if (current === null || typeof current !== 'object') return {};
    current = (current as Record<string, unknown>)[segment];
  }
  return (current as Schema) ?? {};
}

function check(value: unknown, schema: Schema, path: string, root: Schema, failures: Failure[]): void {
  if (typeof schema.$ref === 'string') {
    check(value, resolveRef(schema.$ref, root), path, root, failures);
    return;
  }

  if (Array.isArray(schema.oneOf)) {
    const branchFailures = (schema.oneOf as Schema[]).map((branch) => {
      const local: Failure[] = [];
      check(value, branch, path, root, local);
      return local;
    });
    if (!branchFailures.some((f) => f.length === 0)) {
      failures.push({ field: path || '(root)', message: 'does not match any permitted variant' });
    }
    return;
  }

  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    failures.push({ field: path, message: `must equal ${JSON.stringify(schema.const)}` });
    return;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => matchesType(value, t))) {
      failures.push({ field: path || '(root)', message: `must be of type ${types.join(' | ')}, received ${typeOf(value)}` });
      return;
    }
  }

  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    failures.push({ field: path, message: `must be one of: ${(schema.enum as unknown[]).join(', ')}` });
    return;
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      failures.push({ field: path, message: `must be at least ${schema.minLength} characters` });
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      failures.push({ field: path, message: `must be at most ${schema.maxLength} characters` });
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      failures.push({ field: path, message: `must match ${schema.pattern}` });
    }
    if (schema.format === 'date-time' && !ISO_DATETIME.test(value)) {
      failures.push({ field: path, message: 'must be an ISO-8601 date-time' });
    }
    if (schema.format === 'date' && !ISO_DATE.test(value)) {
      failures.push({ field: path, message: 'must be an ISO-8601 date (YYYY-MM-DD)' });
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      failures.push({ field: path, message: `must be >= ${schema.minimum}` });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      failures.push({ field: path, message: `must be <= ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      failures.push({ field: path, message: `must contain at least ${schema.minItems} item(s)` });
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => check(item, schema.items as Schema, `${path}[${index}]`, root, failures));
    }
    return;
  }

  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties as Record<string, Schema> | undefined) ?? {};

    for (const required of (schema.required as string[] | undefined) ?? []) {
      if (record[required] === undefined) {
        failures.push({ field: path ? `${path}.${required}` : required, message: 'is required' });
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (properties[key] === undefined) {
          failures.push({ field: path ? `${path}.${key}` : key, message: 'is not a permitted property' });
        }
      }
    }

    for (const [key, propertySchema] of Object.entries(properties)) {
      if (record[key] === undefined) continue;
      check(record[key], propertySchema, path ? `${path}.${key}` : key, root, failures);
    }
  }
}

export function validate(value: unknown, schema: Schema): Failure[] {
  const failures: Failure[] = [];
  check(value, schema, '', schema, failures);
  return failures;
}

/** Validate or throw a 400 carrying every field violation at once. */
export function assertValid(value: unknown, schema: Schema, subject = 'request'): void {
  const failures = validate(value, schema);
  if (failures.length > 0) {
    throw new ValidationError(`${subject} failed schema validation`, failures);
  }
}
