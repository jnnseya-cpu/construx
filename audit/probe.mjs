/**
 * Adversarial probe harness. Runs against a live server; records evidence.
 * Not a test suite: it exists to find what the suite does not assert.
 */
import { createHmac } from 'node:crypto';

export const BASE = process.env.PROBE_BASE ?? 'http://127.0.0.1:8080';
export const results = [];

export function record(id, phase, title, status, evidence, severity = null) {
  results.push({ id, phase, title, status, evidence, severity });
  const flag = status === 'HELD' || status === 'PASS' ? ' ' : '!';
  console.log(`${flag} [${id}] ${status.padEnd(8)} ${title}  ::  ${evidence}`);
}

export async function req(path, { method = 'GET', token, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
  const init = { method, headers: h };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${BASE}${path}`, init);
  } catch (error) {
    return { status: 0, ms: Date.now() - started, text: String(error), json: null, headers: new Headers() };
  }
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, ms: Date.now() - started, text, json, headers: response.headers };
}

/** A console session: the only anonymous route that hands out a token. */
export async function session() {
  const r = await req('/v1/console/session', { method: 'POST', body: {} });
  if (r.status !== 200 && r.status !== 201) throw new Error(`no session: ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
}

/** Sign a JWT with the deployment secret — models an attacker who stole it. */
export function forge(payload, { secret = process.env.JWT_SECRET ?? 'dev-secret-change-me', alg = 'HS256' } = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg, typ: 'JWT' });
  const claims = b64(payload);
  if (alg === 'none') return `${head}.${claims}.`;
  const sig = createHmac('sha256', secret).update(`${head}.${claims}`).digest('base64url');
  return `${head}.${claims}.${sig}`;
}

export function summary() {
  const by = {};
  for (const r of results) by[r.status] = (by[r.status] ?? 0) + 1;
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(by));
  const bad = results.filter((r) => r.status === 'FAIL');
  if (bad.length) {
    console.log('\n=== FINDINGS ===');
    for (const r of bad) console.log(`${r.severity ?? 'P?'} [${r.id}] ${r.title}\n    ${r.evidence}`);
  }
  return results;
}
