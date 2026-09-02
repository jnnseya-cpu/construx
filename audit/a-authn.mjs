/** Phase 5 — authentication, session and token attacks. Phase 11 — headers. */
import { BASE, record, req, session, forge, summary } from './probe.mjs';

const s = await session();
const good = s.accessToken;
const [, claimsB64] = good.split('.');
const claims = JSON.parse(Buffer.from(claimsB64, 'base64url').toString());
console.log('# claims:', JSON.stringify(claims));

const PROTECTED = [
  '/v1/projects',
  '/v1/changes',
  '/v1/billing/wallet',
  '/v1/admin/commercial',
  '/v1/admin/data-protection',
  '/v1/admin/tenants',
  '/v1/admin/burn',
  '/v1/admin/transaction-revenue',
];

// A1 — anonymous reads
for (const [i, path] of PROTECTED.entries()) {
  const r = await req(path);
  record(`A1.${i}`, 5, `anonymous GET ${path}`, r.status === 401 ? 'HELD' : 'FAIL',
    `status ${r.status}${r.status !== 401 ? ` body ${r.text.slice(0, 160)}` : ''}`, r.status === 401 ? null : 'P0');
}

// A2 — token tampering
const tampered = [
  ['signature replaced', `${good.split('.').slice(0, 2).join('.')}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`],
  ['alg=none', forge({ ...claims, roles: ['PLATFORM_ADMIN'] }, { alg: 'none' })],
  ['claims edited, signature kept', `${good.split('.')[0]}.${Buffer.from(JSON.stringify({ ...claims, roles: ['PLATFORM_ADMIN'] })).toString('base64url')}.${good.split('.')[2]}`],
  ['empty', ''],
  ['not a jwt', 'aaaa.bbbb.cccc'],
  ['expired', forge({ ...claims, exp: Math.floor(Date.now() / 1000) - 3600 })],
  ['nbf in the future', forge({ ...claims, nbf: Math.floor(Date.now() / 1000) + 86400 })],
];
for (const [name, token] of tampered) {
  const r = await req('/v1/projects', { token });
  record(`A2.${name}`, 5, `forged token: ${name}`, r.status === 401 ? 'HELD' : 'FAIL',
    `status ${r.status}${r.status === 200 ? ` LEAK ${r.text.slice(0, 120)}` : ''}`, r.status === 401 ? null : 'P0');
}

// A3 — privilege escalation by re-signing with the deployment secret
const escalated = forge({ ...claims, roles: ['PLATFORM_ADMIN', 'ENTERPRISE_ADMIN'] });
const r3 = await req('/v1/admin/tenants', { token: escalated });
record('A3', 5, 'escalate roles by re-signing with the deployment secret', r3.status === 200 ? 'FAIL' : 'HELD',
  `status ${r3.status} — models a stolen signing secret; recorded, not a bypass of the secret itself`,
  r3.status === 200 ? 'P2' : null);

// A4 — cross-tenant claim
const crossTenant = forge({ ...claims, tenantId: 'ten_not_yours', partyId: 'party_not_yours' });
const r4 = await req('/v1/changes', { token: crossTenant });
const leaked = r4.json?.entries?.length ?? (Array.isArray(r4.json) ? r4.json.length : null);
record('A4', 5, 'change feed under a forged tenancy claim', leaked === 0 || r4.status >= 400 ? 'HELD' : 'FAIL',
  `status ${r4.status}, entries ${leaked}`, leaked > 0 ? 'P0' : null);

// A5 — account enumeration on login
const known = await req('/v1/auth/login', { method: 'POST', body: { email: 'pm@meridian.example' } });
const unknown = await req('/v1/auth/login', { method: 'POST', body: { email: 'nobody-at-all@example.invalid' } });
const sameShape = known.status === unknown.status
  && JSON.stringify(Object.keys(known.json ?? {}).sort()) === JSON.stringify(Object.keys(unknown.json ?? {}).sort());
record('A5', 5, 'account enumeration through the login response', sameShape ? 'HELD' : 'FAIL',
  `known ${known.status} keys=${Object.keys(known.json ?? {}).sort()}; unknown ${unknown.status} keys=${Object.keys(unknown.json ?? {}).sort()}`,
  sameShape ? null : 'P2');

// A5b — timing oracle
const timings = { known: [], unknown: [] };
for (let i = 0; i < 12; i += 1) {
  timings.known.push((await req('/v1/auth/login', { method: 'POST', body: { email: 'pm@meridian.example' } })).ms);
  timings.unknown.push((await req('/v1/auth/login', { method: 'POST', body: { email: `no${i}@example.invalid` } })).ms);
}
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const gap = Math.abs(med(timings.known) - med(timings.unknown));
record('A5b', 5, 'timing oracle on login', gap < 25 ? 'HELD' : 'PARTIAL',
  `median known ${med(timings.known)}ms vs unknown ${med(timings.unknown)}ms, gap ${gap}ms`, gap < 25 ? null : 'P4');

// A6 — brute force
let limited = 0; let firstLimitAt = null;
for (let i = 0; i < 200; i += 1) {
  const r = await req('/v1/auth/login', { method: 'POST', body: { email: `attack${i}@example.invalid` } });
  if (r.status === 429) { limited += 1; if (firstLimitAt === null) firstLimitAt = i; }
}
record('A6', 5, 'credential-stuffing burst, 200 distinct addresses', limited > 0 ? 'HELD' : 'FAIL',
  `first 429 at attempt ${firstLimitAt}, ${limited} of 200 refused`, limited > 0 ? null : 'P1');

// A7 — MFA replay / unlimited attempts
const chal = await req('/v1/auth/login', { method: 'POST', body: { email: 'pm@meridian.example' } });
let mfaRefused = 0;
for (let i = 0; i < 12; i += 1) {
  const v = await req('/v1/auth/mfa/verify', { method: 'POST', body: { email: 'pm@meridian.example', challengeId: chal.json?.challengeId ?? 'x', code: '000000' } });
  if (v.status === 429 || v.status === 423) mfaRefused += 1;
}
record('A7', 5, 'twelve wrong MFA codes against one challenge', mfaRefused > 0 ? 'HELD' : 'PARTIAL',
  `${mfaRefused} of 12 refused by lockout/rate limit`, mfaRefused > 0 ? null : 'P2');

// A8 — security headers
const surfaces = [['/', 'public site'], ['/app', 'console shell'], ['/v1/projects', 'json api']];
for (const [path, name] of surfaces) {
  const r = await req(path, { token: path.startsWith('/v1') ? good : undefined });
  const h = r.headers;
  const want = {
    'content-security-policy': h.get('content-security-policy'),
    'strict-transport-security': h.get('strict-transport-security'),
    'x-content-type-options': h.get('x-content-type-options'),
    'referrer-policy': h.get('referrer-policy'),
    'permissions-policy': h.get('permissions-policy'),
    'cross-origin-opener-policy': h.get('cross-origin-opener-policy'),
    'cross-origin-resource-policy': h.get('cross-origin-resource-policy'),
    'x-frame-options': h.get('x-frame-options'),
  };
  const missing = Object.entries(want).filter(([, v]) => !v).map(([k]) => k);
  const framed = (want['content-security-policy'] ?? '').includes("frame-ancestors 'none'") || want['x-frame-options'];
  record(`A8.${name}`, 11, `security headers on ${name}`, missing.length === 0 ? 'PASS' : 'PARTIAL',
    `missing: ${missing.join(', ') || 'none'}; frame-refusal: ${framed ? 'yes' : 'NO'}`,
    framed ? (missing.length ? 'P4' : null) : 'P3');
}

// A9 — correlation id on every response
const r9 = await req('/v1/projects', { token: good });
record('A9', 16, 'every response carries a correlation id', r9.headers.get('x-correlation-id') ? 'PASS' : 'FAIL',
  `x-correlation-id=${r9.headers.get('x-correlation-id')} x-trace-id=${r9.headers.get('x-trace-id')}`,
  r9.headers.get('x-correlation-id') ? null : 'P2');

summary();
