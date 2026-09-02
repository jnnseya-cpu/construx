/**
 * Phase 16 done properly: cause a controlled failure and see whether an alert
 * reaches a person. The audit claimed "no alerting configuration in the
 * repository", which was wrong — `ops/watch.ts` exists and `main.ts` starts
 * it. This finds out whether it works.
 */
const B = 'http://127.0.0.1:8080';
async function j(p, i = {}) { const r = await fetch(B + p, i); const t = await r.text(); let x = null; try { x = JSON.parse(t) } catch {}; return { s: r.status, t, j: x }; }
async function signIn(email) {
  const l = await j('/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  const v = await j('/v1/auth/mfa/verify', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actorId: l.j.actorId, challengeId: l.j.challengeId, code: l.j.devCode }) });
  return v.j.accessToken;
}
const op = await signIn('operator@construx.example');
const H = { authorization: `Bearer ${op}` };

console.log('--- watch rules configured ---');
const pos = await j('/v1/admin/watch', { headers: H });
console.log('GET /v1/admin/watch ->', pos.s);
console.log('rules:', (pos.j?.rules ?? pos.j?.states ?? []).map(r => r.id ?? r.rule).join(', ') || JSON.stringify(pos.j).slice(0, 300));

console.log('\n--- cause a controlled failure: a burst of failed authentications ---');
let refused = 0;
for (let i = 0; i < 60; i += 1) {
  const r = await j('/v1/projects', { headers: { authorization: 'Bearer not-a-real-token' } });
  if (r.s === 401) refused += 1;
}
console.log(`${refused} authentication failures generated`);

console.log('\n--- evaluate the watch ---');
const ev = await j('/v1/admin/watch/evaluate', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: '{}' });
console.log('POST /v1/admin/watch/evaluate ->', ev.s);
const report = ev.j ?? {};
for (const r of report.results ?? report.rules ?? []) {
  console.log(` ${r.id ?? r.rule}: judged=${r.judged} breached=${r.breached} ${r.detail ?? r.because ?? ''}`.slice(0, 160));
}
console.log('alertsSent:', report.sent ?? report.alerts ?? 'not reported');

console.log('\n--- did anything actually reach a person? ---');
const deliveries = await j('/v1/admin/notifications/deliveries', { headers: H });
console.log('deliveries route ->', deliveries.s);
const list = deliveries.j?.deliveries ?? deliveries.j ?? [];
const alerts = (Array.isArray(list) ? list : []).filter(d => String(d.code ?? '').startsWith('system.watch'));
console.log(`${alerts.length} watch alert deliveries`);
for (const a of alerts.slice(0, 3)) console.log(' ', a.code, a.status, a.channel, a.to ?? a.recipient ?? '');
