/** Phases 5/6/11 — authorisation, IDOR, injection, adversarial input. */
import { record, req, session, summary } from './probe.mjs';

/** Sign in properly as a seeded identity: login -> devCode -> verify. */
async function signIn(email) {
  const l = await req('/v1/auth/login', { method: 'POST', body: { email } });
  const code = l.json?.devCode;
  if (!code) throw new Error(`no devCode for ${email}: ${l.status} ${l.text.slice(0, 200)}`);
  const v = await req('/v1/auth/mfa/verify', {
    method: 'POST',
    body: { actorId: l.json.actorId, challengeId: l.json.challengeId, code },
  });
  if (!v.json?.accessToken) throw new Error(`verify failed for ${email}: ${v.status} ${v.text.slice(0, 300)}`);
  return v.json.accessToken;
}

const s = await session();
const projectId = s.projectId;
const tokens = {};
const IDENTITIES = [
  'pm@meridian.example',
  'site@meridian.example',
  'qs@meridian.example',
  'amara.osei@meridian.example',
  'operator@construx.example',
  'regulator@meridian.example',
];
for (const email of IDENTITIES) {
  try {
    tokens[email] = await signIn(email);
  } catch (error) {
    console.log(`# could not sign in ${email}: ${error.message}`);
  }
}
console.log('# signed in:', Object.keys(tokens).join(', '));

// B1 - vertical escalation: a low-privilege role against privileged reads
const PRIVILEGED = [
  ['/v1/admin/commercial', 'the tenancy commercial position'],
  ['/v1/admin/transaction-revenue', 'platform revenue'],
  ['/v1/admin/data-protection', 'the data-protection posture'],
  ['/v1/admin/readiness', 'the deployment readiness map'],
  ['/v1/admin/tenants', 'every tenancy on the platform'],
  ['/v1/admin/burn', 'cross-tenant AI spend'],
  ['/v1/admin/logs', 'server logs'],
];
for (const [path, what] of PRIVILEGED) {
  const r = await req(path, { token: tokens['site@meridian.example'] });
  const held = r.status === 403 || r.status === 404 || r.status === 401;
  record(`B1 ${path}`, 5, `site supervisor reads ${what}`, held ? 'HELD' : 'FAIL',
    `status ${r.status} ${held ? (r.json?.title ?? '') : `LEAK ${r.text.slice(0, 200)}`}`,
    held ? null : 'P0');
}

// B1b - the operator must not reach delivery data (a stated product boundary)
for (const path of ['/v1/projects', `/v1/projects/${projectId}/entities/Project/${projectId}`]) {
  const r = await req(path, { token: tokens['operator@construx.example'] });
  const empty = r.status >= 400 || r.text === '[]' || r.json?.length === 0 || r.json?.projects?.length === 0;
  record(`B1b ${path}`, 5, `platform operator reads customer delivery data at ${path}`,
    empty ? 'HELD' : 'PARTIAL', `status ${r.status} len ${r.text.length} :: ${r.text.slice(0, 150)}`, null);
}

// B2 - write escalation: a role without the mandate attempting a write
const WRITES = [
  ['POST', '/v1/admin/benchmark-consent', { granted: true }, 'consent to share the company figures with competitors'],
  ['POST', `/v1/projects/${projectId}/payments/certify`, { applicationId: 'x', certifiedMinor: 1 }, 'certify a payment'],
];
for (const [method, path, payload, what] of WRITES) {
  for (const who of ['site@meridian.example', 'regulator@meridian.example']) {
    if (!tokens[who]) continue;
    const r = await req(path, { method, token: tokens[who], body: payload });
    const held = r.status >= 400;
    record(`B2 ${who.split('@')[0]} ${path}`, 5, `${who.split('@')[0]} attempts to ${what}`,
      held ? 'HELD' : 'FAIL', `status ${r.status} ${r.json?.title ?? ''}`, held ? null : 'P0');
  }
}

// B3 - IDOR and traversal in a path a PM legitimately holds
const IDOR = [
  `/v1/projects/00000000000000000000000000/entities/Project/${projectId}`,
  `/v1/projects/${projectId}/entities/Project/00000000000000000000000000`,
  '/v1/projects/../../v1/admin/tenants',
  `/v1/projects/${projectId}%2F..%2F..%2Fadmin%2Ftenants`,
  '/v1/projects/%2e%2e%2f%2e%2e%2fadmin%2ftenants',
];
for (const [index, path] of IDOR.entries()) {
  const r = await req(path, { token: tokens['pm@meridian.example'] });
  const leaked = r.status === 200 && /"tenants"|"subscription"|"seats"/.test(r.text);
  record(`B3.${index}`, 5, `tampered identifier: ${path.slice(0, 66)}`, leaked ? 'FAIL' : 'HELD',
    `status ${r.status} len ${r.text.length}`, leaked ? 'P0' : null);
}

// B4 - injection payloads through a field a route accepts
const INJECT = [
  ["' OR '1'='1", 'sql'],
  ['{{7*7}}', 'template'],
  ['${7*7}', 'template literal'],
  ['<script>alert(1)</script>', 'stored xss'],
  ['../../../../etc/passwd', 'path traversal'],
  ['$(id)', 'command'],
  [String.fromCharCode(0) + 'truncate', 'null byte'],
  ['a'.repeat(200000), 'oversized string'],
  ['\u202e\u0000\ufeff', 'control characters: bidi override, NUL and a BOM'],
];
for (const [payload, kind] of INJECT) {
  const r = await req('/v1/auth/login', { method: 'POST', body: { email: payload } });
  const leaked = r.text.includes('<script>') || /at .*\.ts:\d+/.test(r.text) || /node_modules|\/home\//.test(r.text);
  record(`B4 ${kind}`, 6, `injection payload (${kind}) through a validated field`, leaked ? 'FAIL' : 'HELD',
    `status ${r.status}, reflected or stack-traced: ${leaked}`, leaked ? 'P1' : null);
}

// B5 - prototype pollution
const r5 = await req('/v1/auth/login', {
  method: 'POST',
  raw: '{"email":"pm@meridian.example","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
  headers: { 'content-type': 'application/json' },
});
const polluted = {}.polluted === true;
record('B5', 11, 'prototype pollution through a JSON body', polluted ? 'FAIL' : 'HELD',
  `status ${r5.status}, Object.prototype.polluted=${{}.polluted}`, polluted ? 'P0' : null);

// B6 - malformed bodies and wrong content types
const MALFORMED = [
  ['not json at all', 'application/json', 'plain text as json'],
  ['{"email":', 'application/json', 'truncated json'],
  ['{"email":"a@b.c","email":"d@e.f"}', 'application/json', 'duplicate key'],
  ['<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>', 'application/xml', 'XXE'],
  ['email=pm@meridian.example', 'application/x-www-form-urlencoded', 'form body on a json route'],
  ['[1,2,3]', 'application/json', 'array where an object is required'],
  ['null', 'application/json', 'literal null'],
];
for (const [raw, type, name] of MALFORMED) {
  const r = await req('/v1/auth/login', { method: 'POST', raw, headers: { 'content-type': type } });
  const leaky = /at .*\.ts:\d+|node_modules|\/home\/|SyntaxError:.*position/.test(r.text);
  const passwd = /root:x:0:0/.test(r.text);
  const clean = r.status >= 400 && r.status < 500 && !leaky && !passwd;
  record(`B6 ${name}`, 6, `malformed body: ${name}`, clean ? 'HELD' : leaky || passwd ? 'FAIL' : 'PARTIAL',
    `status ${r.status} stackleak=${leaky} fileread=${passwd} :: ${r.text.slice(0, 110)}`,
    passwd ? 'P0' : leaky ? 'P2' : null);
}

// B7 - oversized payload
const r7 = await req('/v1/auth/login', {
  method: 'POST',
  raw: JSON.stringify({ email: 'a@b.c', pad: 'x'.repeat(12000000) }),
  headers: { 'content-type': 'application/json' },
});
record('B7', 6, 'a 12MB request body', r7.status === 413 || r7.status === 400 ? 'HELD' : 'PARTIAL',
  `status ${r7.status} ${r7.json?.title ?? r7.text.slice(0, 90)}`,
  r7.status === 413 || r7.status === 400 ? null : 'P3');

// B8 - error schema stability and leakage
let stackLeaks = 0;
let nonProblem = 0;
const PROBES = ['/v1/nope', '/v1/projects/%00', '/v1/projects/x/entities/Y/Z', '/v1/admin/logs', '/v1/projects/x/rfi/exposure'];
for (const path of PROBES) {
  const r = await req(path, { token: tokens['site@meridian.example'] });
  if (/at .*\.ts:\d+|node_modules|\/home\//.test(r.text)) stackLeaks += 1;
  if (r.status >= 400 && !(r.headers.get('content-type') ?? '').includes('problem+json')) nonProblem += 1;
}
record('B8', 6, 'error responses are problem+json and carry no stack',
  stackLeaks === 0 && nonProblem === 0 ? 'PASS' : 'FAIL',
  `${stackLeaks} stack leaks, ${nonProblem} non-problem+json errors across ${PROBES.length} probes`,
  stackLeaks ? 'P2' : nonProblem ? 'P3' : null);

// B9 - CORS
const r9 = await req('/v1/projects', {
  token: tokens['pm@meridian.example'],
  headers: { origin: 'https://evil.example' },
});
const acao = r9.headers.get('access-control-allow-origin');
const badCors = acao === '*' || acao === 'https://evil.example';
record('B9', 11, 'CORS reflects a hostile origin', badCors ? 'FAIL' : 'HELD',
  `access-control-allow-origin=${acao ?? 'absent'}`, badCors ? 'P1' : null);

// B10 - host header poisoning
const r10 = await req('/', { headers: { host: 'evil.example' } });
const poisoned = /evil\.example/.test(r10.text);
record('B10', 11, 'host header poisoning into absolute links', poisoned ? 'FAIL' : 'HELD',
  `evil.example appears in the body: ${poisoned}`, poisoned ? 'P2' : null);

// B11 - open redirect
for (const path of ['/?next=https://evil.example', '/app?redirect=//evil.example', '/unsubscribe?token=x&return=https://evil.example']) {
  const r = await req(path);
  const loc = r.headers.get('location') ?? '';
  const open = /evil\.example/.test(loc);
  record(`B11 ${path.slice(0, 26)}`, 11, 'open redirect', open ? 'FAIL' : 'HELD',
    `status ${r.status} location=${loc || 'none'}`, open ? 'P2' : null);
}

// B12 - method confusion: a GET against a write route and the reverse
for (const [method, path] of [['GET', '/v1/admin/benchmark-consent'], ['DELETE', '/v1/projects'], ['PUT', '/v1/auth/login']]) {
  const r = await req(path, { method, token: tokens['amara.osei@meridian.example'] });
  const held = r.status === 404 || r.status === 405 || r.status === 403;
  record(`B12 ${method} ${path}`, 6, `${method} against a route that does not offer it`, held ? 'HELD' : 'PARTIAL',
    `status ${r.status}`, null);
}

summary();
