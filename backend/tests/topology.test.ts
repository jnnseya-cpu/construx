import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * The deployment topology, held to the properties that make it safe.
 *
 * `docker compose config` is what proves these files parse and merge, and it
 * has been run against all four combinations. It cannot run in `npm test` —
 * there is no Docker in every environment that runs the suite — so what is
 * enforced here is the layer above syntax: the handful of decisions that, if
 * quietly reversed, produce a deployment that starts perfectly and is wrong.
 *
 * Every assertion below corresponds to a specific way a real deployment gets
 * hurt, and each one names it. This is the same discipline as `runbook.test.ts`:
 * a claim nobody checks is a claim that drifts.
 */

const DEPLOY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy');
const read = (name: string): string => readFileSync(join(DEPLOY, name), 'utf8');

const base = read('compose.yaml');
const telemetry = read('compose.telemetry.yaml');
const gateway = read('compose.gateway.yaml');
const edge = read('compose.edge.yaml');
const caddyfile = read('Caddyfile');
const collector = read('otel-collector.yaml');

describe('every overlay is an overlay', () => {
  for (const [name, file] of [['telemetry', telemetry], ['gateway', gateway], ['edge', edge]] as const) {
    it(`${name} declares the same compose project as the base, so both describe one deployment`, () => {
      // A `name:` that differs makes compose treat the overlay as a second
      // project: `docker compose down` from one file then leaves the other
      // half of the deployment running, and the runbook's `docker exec
      // construx …` reaches a container nobody meant.
      assert.match(file, /^name: construx$/m, `${name} does not name the construx project`);
    });
  }
});

describe('the record survives the container', () => {
  it('keeps the journal on a named volume, never in the container’s writable layer', () => {
    // The failure the whole journal exists to prevent, reintroduced by the
    // orchestration: a container that is writable and ephemeral.
    assert.match(base, /volumes:\s*\n\s*- ledger:\/data/);
    assert.match(base, /LEDGER_JOURNAL_PATH: \/data\/ledger\.jsonl/);
  });

  it('keeps evidence and site media on the same volume as the journal', () => {
    // Both were bugs once. Evidence unset means the platform records hashes
    // and holds no files; site media unset writes uploads into the image's own
    // layer, where they survive exactly until the next deploy.
    assert.match(base, /EVIDENCE_STORE_PATH: \/data\/evidence/);
    assert.match(base, /SITE_MEDIA_PATH: \$\{SITE_MEDIA_PATH:-\/data\/site-media\}/);
  });

  it('never turns fsync off, which would acknowledge an event that has not reached the disk', () => {
    assert.match(base, /LEDGER_JOURNAL_FSYNC: 'true'/);
  });
});

describe('nothing is exposed that does not have to be', () => {
  it('binds the base file’s published port to loopback', () => {
    // Docker writes its own iptables rules, evaluated before ufw's. A bare
    // '8080:8080' reaches the internet on a host whose firewall allows only 80
    // and 443, serving the console over plain http beside the https one.
    assert.match(base, /- '127\.0\.0\.1:\$\{CONSTRUX_HOST_PORT:-8080\}:8080'/);
  });

  it('publishes nothing at all once the gateway owns the front door', () => {
    // `!reset []` rather than an override: compose merges list keys by
    // concatenation, so `ports: []` in an overlay leaves the base file's entry
    // in place and the platform stays reachable beside the gateway.
    assert.match(gateway, /ports: !reset \[\]/);
    assert.match(gateway, /expose:\s*\n\s*- '8080'/);
  });

  it('gives the collector no published port', () => {
    // An OTLP endpoint on the internet is one anybody can write metrics into,
    // and metrics somebody else wrote are worse than none: they are wrong and
    // they look right.
    const service = telemetry.slice(telemetry.indexOf('otel-collector:'));
    assert.ok(!/^\s+ports:/m.test(service), 'the collector publishes a port to the host');
  });

  it('opens only 80 and 443 on the gateway, and says why 80 is there', () => {
    assert.match(gateway, /- '80:80'/);
    assert.match(gateway, /- '443:443'/);
    // 80 is not a courtesy redirect: it is how the certificate is issued and
    // renewed, and closing it breaks renewal ninety days later.
    assert.match(gateway, /how the certificate is issued and renewed/);
  });
});

describe('the settings a deployment cannot be allowed to forget', () => {
  it('refuses to start without a signing secret', () => {
    // `:?` rather than a default. A default here is a platform that starts and
    // signs tokens anybody can forge.
    assert.match(base, /GATEWAY_JWT_SECRET: \$\{GATEWAY_JWT_SECRET:\?[^}]+\}/);
  });

  it('refuses to start the gateway without a domain', () => {
    // Without one Caddy serves a self-signed certificate every browser
    // refuses, which reads to everybody as an outage rather than as a missing
    // setting.
    assert.match(gateway, /CONSTRUX_DOMAIN: \$\{CONSTRUX_DOMAIN:\?[^}]+\}/);
  });

  it('passes the whole env file through rather than enumerating settings', () => {
    // This was a real defect: a dozen variables were listed and the other
    // thirty-eight were silently ignored in the only environment that runs in
    // production.
    assert.match(base, /env_file:\s*\n\s*- \.\.\/\.env/);
  });
});

describe('the gateway hands the platform what it needs to be correct', () => {
  it('forwards the real client address, without which one abuser rate-limits everybody', () => {
    for (const header of ['X-Forwarded-For', 'X-Forwarded-Proto', 'X-Real-IP']) {
      assert.ok(caddyfile.includes(header), `the gateway does not forward ${header}`);
    }
  });

  it('reaches the platform by container name, not by address', () => {
    // A container's address changes on every recreate, and a deploy that
    // silently 502s afterwards is the failure this avoids.
    assert.match(caddyfile, /reverse_proxy construx:8080/);
  });

  it('waits long enough for a journal replay before giving up on a request', () => {
    assert.match(caddyfile, /response_header_timeout \d+s/);
  });

  it('does not advertise its own version', () => {
    assert.match(caddyfile, /-Server/);
  });
});

describe('the collector is a pipe, and a bounded one', () => {
  it('accepts only the protocol the platform actually ships', () => {
    // The platform ships JSON over HTTP. A gRPC listener nothing sends to is a
    // listener nobody watches.
    assert.match(collector, /http:\s*\n\s*# [^\n]*\n\s*# [^\n]*\n\s*endpoint: 0\.0\.0\.0:4318/);
    assert.ok(!/grpc:/.test(collector), 'the collector opens a protocol nothing uses');
  });

  it('bounds its own memory, so it does not become the reason the host is unhealthy', () => {
    // A collector that OOMs during an incident takes the record of the
    // incident with it.
    assert.match(collector, /memory_limiter:/);
    assert.match(collector, /limit_mib: \d+/);
  });

  it('rotates what it writes, because it shares a disk with the journal', () => {
    assert.match(collector, /rotation:\s*\n\s*max_megabytes: \d+/);
  });

  it('is pinned to a version rather than following latest', () => {
    // A config schema that changes under a deployment nobody touched, first
    // noticed on the morning of an incident.
    assert.match(telemetry, /image: otel\/opentelemetry-collector-contrib:\d+\.\d+\.\d+/);
    assert.ok(!/image:[^\n]*:latest/.test(telemetry), 'the collector follows a moving tag');
  });

  it('points the platform at the collector by service name', () => {
    assert.match(telemetry, /OPS_OTLP_ENDPOINT: http:\/\/otel-collector:4318/);
  });
});

describe('the two front-door overlays are alternatives, and say so', () => {
  it('warns that the gateway and the edge overlay cannot both be used', () => {
    // Two things cannot own 443. Without the warning the failure is a
    // container that will not start, discovered on the day of a deploy.
    assert.match(gateway, /never both|or `?compose\.edge/i);
  });
});
