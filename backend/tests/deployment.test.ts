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
    .map((line) => {
      const entry = /^ {6}([A-Z][A-Z0-9_]*): *(.*)$/.exec(line);
      if (!entry) return undefined;
      const [, name, value] = entry;

      // `NAME: ${NAME:-default}` is a pass-through with a fallback, not a
      // shadow: compose interpolates it from `.env`, so a deployment that sets
      // it still wins and only a deployment that says nothing gets the default.
      //
      // The detector used to treat every line in this block as hardcoded, which
      // made "give this a safe default" indistinguishable from "override
      // whatever they set" — and pushed anything needing a default onto an
      // exemption list, where the difference stopped being visible at all.
      if (new RegExp(`^\\$\\{${name}(:-.*)?\\}$`).test(value!.trim())) return undefined;

      return name;
    })
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

/**
 * Variables the *deployer* supplies, which belong to neither the container nor
 * the deployment.
 *
 * `BUILD_COMMIT` is the only one: it identifies the commit being deployed, so
 * it is different on every deploy and there is no sensible value for it in
 * `.env`. It is still listed in `.env.example` — with an explicit "do not set
 * this" — because the reverse check below is right that a variable nobody can
 * discover is worse than one somebody sets wrongly.
 *
 * The distinction from `CONTAINER_OWNED` matters. Those name a path or a port
 * inside the image, where a `.env` value would be *wrong*. This names something
 * only the thing running the deploy knows. Both shadow `.env` — compose's
 * `environment:` outranks `env_file:` — which is exactly why each has to be
 * declared here and justified rather than simply added to the compose file.
 */
const DEPLOYER_SUPPLIED = new Set(['BUILD_COMMIT']);

describe('the deployed container receives the settings a deployment is told it can set', () => {
  it('passes the whole .env through rather than enumerating part of it', () => {
    // `.dockerignore` excludes `.env` from the image on purpose, so no published
    // layer carries anybody's secrets. env_file is therefore the only way the
    // file reaches the process at all.
    //
    // `../.env` rather than `.env`: compose resolves the path against the
    // project directory, which is the folder holding this compose file. `.env`
    // would mean `deploy/.env`, which nothing creates and nothing documents.
    assert.match(
      compose,
      /\n {4}env_file:\n {6}- \.\.\/\.env\n/,
      'compose must load ../.env with env_file — without it, only the variables listed under environment: reach the container, and a bare .env resolves inside deploy/',
    );
  });

  it('leaves every documented variable settable', () => {
    const shadowed = hardcoded().filter((name) => !CONTAINER_OWNED.has(name) && !DEPLOYER_SUPPLIED.has(name));
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
    for (const name of [...CONTAINER_OWNED, ...DEPLOYER_SUPPLIED]) {
      assert.ok(names.has(name), `${name} is fixed by compose but absent from .env.example`);
    }
  });

  it('names the container deterministically, because the runbook addresses it by name', () => {
    // `docker exec construx …` is how the backup script reads the journal out.
    // Left to compose the name is `<project>-construx-1`, which varies with the
    // directory the repository was cloned into — so the backup script would
    // fail on a name that does not exist, quietly, every hour.
    assert.match(compose, /\n {4}container_name: construx\n/, 'the container must be named construx');
    assert.match(compose, /\nname: construx\n/, 'the compose project must be named, not inherited from the folder');
  });

  it('offers a durable way to join an existing proxy, rather than a manual command', () => {
    // `docker network connect construx-edge construx` works and lasts exactly
    // until the next deploy: `compose up --build` recreates the container, the
    // attachment is not part of the compose definition, and the proxy answers
    // 502 for a site that worked five minutes earlier. The overlay makes the
    // attachment part of the deployment instead of something to remember.
    const overlay = readFileSync(resolve(ROOT, 'deploy/compose.edge.yaml'), 'utf8');

    // Asserted line by line rather than as one block: the file is commented
    // between the entries, and a pattern that demanded adjacency would fail on
    // an explanation rather than on a defect.
    assert.match(overlay, /^ {4}networks:$/m, 'the service declares its networks');
    assert.match(overlay, /^ {6}- edge$/m, 'joins the shared network');
    // `default` must be listed explicitly: a networks key replaces the implicit
    // default rather than adding to it, so omitting it silently cuts the
    // container off from the rest of its own project.
    assert.match(overlay, /^ {6}- default$/m, 'and keeps its own, named explicitly');
    assert.match(overlay, /^ {4}external: true$/m, 'the shared network belongs to the proxy that was here first');
    assert.match(overlay, /name: \$\{CONSTRUX_EDGE_NETWORK:-construx-edge\}/, 'the network name is configurable');
    assert.match(overlay, /^name: construx$/m, 'same project as the base file');
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

/**
 * The problem `type` URL names the domain this deployment answers on.
 *
 * RFC 7807 says the type should be a URI documenting the problem, so it has to
 * be a host the deployment actually lives at. It was a literal, which meant a
 * second domain needed a second source tree — and the only visible difference
 * between the two builds was the string inside their error bodies.
 */
describe('errors name the domain this deployment actually serves', () => {
  const errors = readFileSync(resolve(ROOT, 'backend/src/core/errors.ts'), 'utf8');

  it('does not hardcode a domain', () => {
    const literals = errors.match(/https:\/\/[a-z0-9.-]+\/problems/g) ?? [];
    assert.deepEqual(
      literals,
      [],
      `errors.ts hardcodes ${literals.join(', ')} — one build then cannot serve two domains, and the mismatch is invisible except in error bodies`,
    );
  });

  it('derives the base from PUBLIC_BASE_URL', () => {
    assert.match(errors, /config\.publicBaseUrl/);
  });

  it('renders the configured origin at runtime', async () => {
    const { toProblem } = await import('../src/core/errors.ts');
    const { DomainError } = await import('../src/core/errors.ts');
    const { config } = await import('../src/config.ts');
    const problem = toProblem(new DomainError('NOT_FOUND', 'nope', 404), '/x', 't', 'c');
    assert.equal(problem.type, `${new URL(config.publicBaseUrl).origin}/problems/not-found`);
  });

  it('puts the reference, and never the cause, in the sentence a person sees for an unexpected error', async () => {
    const { toProblem } = await import('../src/core/errors.ts');
    // "The request could not be completed" gave an operator nothing to search
    // the log for. The reference is what they quote; the cause stays in the log.
    const problem = toProblem(new Error('ENOSPC: no space left on /var/lib/construx/journal'), '/v1/users', 'trace-77', 'c');
    assert.equal(problem.status, 500);
    assert.equal(problem.title, 'INTERNAL_ERROR');
    assert.match(problem.detail ?? '', /Reference trace-77/);
    assert.doesNotMatch(problem.detail ?? '', /ENOSPC|journal/);
  });
});

/**
 * The sandbox, as a deployment rather than as a file nobody has run.
 *
 * `deploy/compose.demo.yaml` existed for a fortnight and was never started
 * once. The public demonstration page described a sandbox "kept separately"
 * while `DEMONSTRATION_URL` was empty, so a visitor read that one existed, went
 * looking, and found nothing — reported in exactly those words: *loaded demo
 * accounts are nowhere to be found.*
 *
 * Bringing it up needs three things to agree that live in three different
 * files: the compose stack, the gateway's Caddyfile, and the script that joins
 * them. Nothing checked that they did, which is how the compose file came to
 * name a hostname the gateway had no site block for.
 *
 * Every assertion below is something that, if it drifted, would fail on the
 * host at eleven at night rather than here.
 */
describe('the sandbox deployment', () => {
  const demo = readFileSync(resolve(ROOT, 'deploy/compose.demo.yaml'), 'utf8');
  const caddyfile = readFileSync(resolve(ROOT, 'deploy/Caddyfile'), 'utf8');
  const gateway = readFileSync(resolve(ROOT, 'deploy/compose.gateway.yaml'), 'utf8');
  const script = readFileSync(resolve(ROOT, 'deploy/demo-up.sh'), 'utf8');

  it('is a separate stack, with its own project, container and volume', () => {
    // Not an overlay on compose.yaml. A `docker compose down` in one must not
    // be able to touch the other.
    assert.match(demo, /^name: construx-demo$/m);
    assert.match(demo, /container_name: construx-demo/);
    assert.match(demo, /demo-ledger:\/data/);
  });

  it('cannot inherit a live signing secret by accident', () => {
    /*
     * The failure this refuses is an authentication bypass assembled out of two
     * correct deployments: a session minted for a fictional sandbox identity
     * verifying against the live platform, because both were reading the same
     * GATEWAY_JWT_SECRET.
     *
     * Compose requires it to be set at all; the script refuses it when it is
     * the same string as the live one, which compose cannot know.
     */
    assert.match(demo, /GATEWAY_JWT_SECRET: \$\{GATEWAY_JWT_SECRET:\?/);
    assert.match(script, /DEMO_SECRET" = "\$LIVE_SECRET/);
  });

  it('cuts every rail that reaches the outside world', () => {
    /*
     * `.env.demo` gets copied from somewhere, and the convenient thing to copy
     * is the live `.env` — which carries working credentials for all of these.
     *
     * The object store is the dangerous one: the sandbox would ship its own
     * journal snapshots into the live backup bucket under the same prefix, and
     * the backups of the real record would be overwritten by a fictional one.
     */
    for (const rail of [
      'OBJECT_STORE_ENDPOINT',
      'OBJECT_STORE_BUCKET',
      'OBJECT_STORE_ACCESS_KEY_ID',
      'OBJECT_STORE_SECRET_ACCESS_KEY',
      'SMTP_HOST',
      'SMTP_USER',
      'SMTP_PASS',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'KODA_SECRET_KEY',
      'KODA_WEBHOOK_SECRET',
    ]) {
      assert.match(
        demo,
        new RegExp(`^\\s+${rail}: ''$`, 'm'),
        `${rail} is not cut in the sandbox stack, so an .env.demo copied from a live .env carries it`,
      );
    }
  });

  it('keeps the sandbox on its own paths and its own address', () => {
    // Hard-set rather than interpolated. An inherited path puts a sandbox's
    // writes into the live evidence directory; an inherited PUBLIC_BASE_URL
    // sends every link the sandbox generates to the live platform, carrying a
    // token that does not verify there.
    assert.match(demo, /^\s+LEDGER_JOURNAL_PATH: \/data\/ledger\.jsonl$/m);
    assert.match(demo, /^\s+EVIDENCE_STORE_PATH: \/data\/evidence$/m);
    assert.match(demo, /^\s+SITE_MEDIA_PATH: \/data\/site-media$/m);
    assert.match(demo, /PUBLIC_BASE_URL: https:\/\/\$\{CONSTRUX_DEMO_DOMAIN:\?/);
    // And the script exports the variable that expression reads, or the stack
    // refuses to start with a message about a variable nobody set by hand.
    assert.match(script, /export CONSTRUX_DEMO_DOMAIN=/);
  });

  it('is a sandbox rather than a second live platform', () => {
    assert.match(demo, /DEMO_TENANCY_ENABLED: 'true'/);
    // Local engines, so a visitor on an open sign-in spends nothing.
    assert.match(demo, /AI_MODE: 'local'/);
  });

  it('has a gateway that can actually serve it', () => {
    /*
     * The gap that made the compose file useless on its own: the Caddyfile had
     * a site block for the live domain and for `www.`, and none for a sandbox
     * hostname. A running container the gateway has no route to is a container
     * nobody can reach.
     *
     * The block is not in the Caddyfile, deliberately — a site block for a name
     * with no DNS record makes Caddy ask for a certificate it cannot be issued,
     * on every deployment that never wanted a sandbox. It is imported from a
     * directory instead, and a glob that matches nothing is not an error.
     */
    assert.match(caddyfile, /^import \/etc\/caddy\/conf\.d\/\*\.caddy$/m);
    assert.match(gateway, /\.\/conf\.d:\/etc\/caddy\/conf\.d/);
    // Writable: the script writes the block into it and reloads.
    assert.ok(
      !/\.\/conf\.d:\/etc\/caddy\/conf\.d:ro/.test(gateway),
      'conf.d is mounted read-only, so demo-up.sh cannot write the site block',
    );
    assert.match(script, /conf\.d\/demo\.caddy/);
    assert.match(script, /reverse_proxy construx-demo:8080/);
  });

  it('validates the gateway configuration before reloading it', () => {
    // A reload with a bad file leaves the live site on the old config, which is
    // the safe failure and also a silent one. Checked and reported instead.
    assert.match(script, /caddy validate --config/);
    assert.match(script, /caddy reload --config/);
  });

  it('tells the live platform where the sandbox is', () => {
    /*
     * The step whose absence started this. Without DEMONSTRATION_URL the live
     * site offers the guided session and the trial and does not mention a
     * sandbox — correct when there is none, and not what anybody wants once
     * there is one.
     */
    assert.match(script, /DEMONSTRATION_URL=/);
    assert.match(script, /\.env\.backup\./, 'the script edits .env without taking a backup first');
  });
});
