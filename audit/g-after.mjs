/** The other half of the recovery test: is the record actually there? */
const BASE = 'http://127.0.0.1:8096';
const MARKER = process.env.MARKER;
async function req(path, init = {}) {
  const r = await fetch(`${BASE}${path}`, init);
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, text: t, json: j };
}
async function signIn(email) {
  const l = await req('/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  const v = await req('/v1/auth/mfa/verify', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actorId: l.json.actorId, challengeId: l.json.challengeId, code: l.json.devCode }) });
  return v.json.accessToken;
}
const admin = await signIn('amara.osei@meridian.example');
const pm = await signIn('pm@meridian.example');
const revenue = await req('/v1/admin/transaction-revenue', { headers: { authorization: `Bearer ${admin}` } });
const settlements = revenue.json?.settlements ?? [];
const survived = settlements.filter((s) => (s.externalReference ?? '').startsWith(MARKER ?? 'RECOVERY-MARKER-'));
const changes = await req('/v1/changes?limit=500', { headers: { authorization: `Bearer ${pm}` } });
const health = await req('/readyz');
console.log(JSON.stringify({
  phase: 'AFTER RESTORE',
  processAnswering: health.status === 200,
  eventsReplayed: health.json?.events ?? null,
  tenants: health.json?.tenants ?? null,
  settlementsVisible: settlements.length,
  markerSettlementsSurvived: survived.length,
  markerReferences: survived.map((s) => s.externalReference),
  changeEntries: (changes.json?.entries ?? []).length,
  feeNetInvariantBroken: settlements.filter((s) => s.feeMinor + s.netMinor !== s.amountMinor).length,
  reportedEarned: revenue.json?.revenue?.earnedMinor,
  recomputedEarned: settlements.filter((s) => s.status === 'SETTLED').reduce((t, s) => t + s.feeMinor, 0),
}, null, 1));
