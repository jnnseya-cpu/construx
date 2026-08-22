import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The deployment surface: what `.env.example` documents must actually reach the
 * running container.
 *
 * This exists because it did not. The compose file enumerated a dozen variables
 * and silently dropped the other thirty-eight, so a deployment could set
 * `NEWSLETTER_FROM_ADDRESS` — the from address on every email the platform
 * sends, including the signup confirmation — see no error, and get the built-in
 * default. The same hole swallowed `ACU_MARKUP_MULTIPLIER`,
 * `STORAGE_BLOCK_PRICE_MINOR` and `FREE_TRIAL_GRANT_MINOR`: the commercial
 * values the operating directive says must never be hardcoded were, in the only
 * environment that charges anybody.
 *
 * Nothing about that failure is visible. The container starts, the log is clean,
 * and the first symptom is a customer who registered and never appeared.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const compose = readFileSync(resolve(ROOT, 'deploy/compose.yaml'), 'utf8');
const example = readFileSync(resolve(ROOT, '.env.example'), 'utf8');

/** Every variable name `.env.example` publishes as settable. */
function documented(): string[] {
  return example
    .split('\n')
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line.trim())?.[1])
    .filter((name): name is string => name !== undefined);
}

/** The keys compose sets itself, which override anything `.env` says. */
function hardcoded(): string[] {
  const block = /\n {4}environment:\n((?: {6}.*\n|\n)*)/.exec(compose)?.[1] ?? '';
  return block
    .split('\n')
    .map((line) => /^ {6}([A-Z][A-Z0-9_]*):/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

/**
 * The only variables compose is allowed to fix itself.
 *
 * Each names something about the container rather than about the deployment — a
 * path inside the image, or the port the process binds behind the published
 * one — so a value from `.env` would be wrong rather than merely different.
 * `GATEWAY_JWT_SECRET` is here for a different reason: it is passed through
 * with a `:?` guard so a missing one fails the command rather than starting a
 * service signing forgeable tokens.
 */
const CONTAINER_OWNED = new Set([
  'NODE_ENV',
  'PORT',
  'LEDGER_JOURNAL_PATH',
  'LEDGER_JOURNAL_FSYNC',
  'EVIDENCE_STORE_PATH',
  'GATEWAY_JWT_SECRET',
]);

describe('the deployed container receives the settings a deployment is told it can set', () => {
  it('passes the whole .env through rather than enumerating part of it', () => {
    // `.dockerignore` excludes `.env` from the image on purpose, so no published
    // layer carries anybody's secrets. env_file is therefore the only way the
    // file reaches the process at all.
    assert.match(
      compose,
      /\n {4}env_file:\n {6}- \.env\n/,
      'compose must load .env with env_file — without it, only the variables listed under environment: reach the container',
    );
  });

  it('leaves every documented variable settable', () => {
    const shadowed = hardcoded().filter((name) => !CONTAINER_OWNED.has(name));
    assert.deepEqual(
      shadowed,
      [],
      `compose hardcodes ${shadowed.join(', ')}, which overrides .env — a deployment would set it, see no error, and get compose's value`,
    );
  });

  it('documents every variable the container fixes for itself', () => {
    // The reverse check. A container-owned name that .env.example does not
    // mention is a setting nobody can discover; one it does mention is a
    // setting somebody will try to change and cannot.
    const names = new Set(documented());
    for (const name of CONTAINER_OWNED) {
      assert.ok(names.has(name), `${name} is fixed by compose but absent from .env.example`);
    }
  });

  it('lets the host port move without exposing the container more widely', () => {
    // A VPS is rarely empty. Another application already holding 8080 stops
    // this container dead on start, and the tempting fix — publishing on
    // 0.0.0.0 — puts the console on the open internet over plain http, because
    // Docker writes its own iptables rules ahead of the firewall's.
    assert.match(
      compose,
      /- '127\.0\.0\.1:\$\{CONSTRUX_HOST_PORT:-8080\}:8080'/,
      'the published port must stay bound to the loopback and the host side must be a variable',
    );
  });
});
