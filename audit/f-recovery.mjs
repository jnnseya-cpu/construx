/** Phase 18 — backup and recovery, proven by restoring rather than asserted. */
import { readFileSync, statSync, copyFileSync } from 'node:fs';

const BASE = process.env.PROBE_BASE ?? 'http://127.0.0.1:8095';
const JOURNAL = process.env.JOURNAL;

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

const s = await req('/v1/console/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
const projectId = s.json.projectId;
const admin = await signIn('amara.osei@meridian.example');
const pm = await signIn('pm@meridian.example');

// Write something identifiable that must survive the restart.
const marker = `RECOVERY-MARKER-${Date.now()}`;
const written = [];
for (let i = 0; i < 5; i += 1) {
  const r = await req(`/v1/projects/${projectId}/platform-settlements`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
    body: JSON.stringify({ againstRefType: 'Project', againstRefId: projectId, amountMinor: 100000 + i, rail: 'FACILITATED', currency: 'GBP', externalReference: `${marker}-${i}` }),
  });
  if (r.json?.settlement?.id) written.push(r.json.settlement.id);
}

const changes = await req('/v1/changes?limit=500', { headers: { authorization: `Bearer ${pm}` } });
const before = {
  settlementsWritten: written.length,
  settlementIds: written,
  changeEntries: (changes.json?.entries ?? []).length,
  lastCursor: changes.json?.nextCursor,
  journalBytes: JOURNAL ? statSync(JOURNAL).size : null,
  journalLines: JOURNAL ? readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean).length : null,
  markerInJournal: JOURNAL ? readFileSync(JOURNAL, 'utf8').includes(marker) : null,
};
console.log(JSON.stringify({ phase: 'BEFORE', marker, ...before }, null, 1));
if (JOURNAL) copyFileSync(JOURNAL, `${JOURNAL}.backup`);
