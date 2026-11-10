import { api } from '../lib/api.js';
import { badge, html, render, resolveHtml, table, toast } from '../lib/ui.js';
import { can, state } from '../app.js';

/**
 * Grid Connection AI — the HV grid-connection delivery workboard.
 *
 * The 42-step, eight-gate playbook on a project: open an engagement, watch each gate
 * G0–G7 move from PENDING through its digital steps to CANDIDATE_READY, and record
 * the gate decision. An electrical gate (G4–G7) never advances on digital readiness
 * alone — it asks for a verified authority record, and the server enforces it. Every
 * figure is the server's workboard, not a browser computation.
 */

const RUN_STATES = ['PLANNED', 'WORKING', 'WAITING_EVIDENCE', 'WAITING_AUTHORITY', 'VALIDATED', 'RELEASED', 'STALE', 'BLOCKED'];
const runTone = (s) =>
  s === 'VALIDATED' || s === 'RELEASED' ? 'ok' : s === 'BLOCKED' ? 'bad' : s === 'WAITING_EVIDENCE' || s === 'WAITING_AUTHORITY' || s === 'STALE' ? 'warn' : 'neutral';
const gateTone = (s) =>
  s === 'APPROVED' ? 'ok' : s === 'BLOCKED' || s === 'EXPIRED' || s === 'SUPERSEDED' ? 'bad' : s === 'AWAITING_AUTHORITY' ? 'warn' : s === 'CANDIDATE_READY' ? 'info' : 'neutral';

export async function grid(root) {
  const projectId = state.session.projectId;
  let engagements = [];
  let engagementId = null;
  let board = null;

  const loadList = async () => {
    try { engagements = (await api.get(`/v1/projects/${projectId}/grid/engagements`)).engagements ?? []; } catch { engagements = []; }
  };
  const loadBoard = async () => {
    if (!engagementId) { board = null; return; }
    try { board = await api.get(`/v1/projects/${projectId}/grid/engagements/${engagementId}/workboard`); }
    catch (error) { board = null; toast('Workboard unavailable', error.message, 'err'); }
  };

  const openEngagement = async (form) => {
    try {
      const res = await api.post(`/v1/projects/${projectId}/grid/engagements`, {
        connection: form.connection, route: form.route,
        ...(form.pointOfConnection ? { pointOfConnection: form.pointOfConnection } : {}),
        ...(form.capacityNote ? { capacityNote: form.capacityNote } : {}),
      });
      engagementId = res.engagementId;
      toast('Engagement opened', `${res.reference} — 42 steps across G0–G7`, 'ok');
      await loadList(); await loadBoard(); draw();
    } catch (error) { toast('Could not open engagement', error.message, 'err'); }
  };

  const setStep = async (stepId, patch) => {
    try {
      await api.post(`/v1/projects/${projectId}/grid/engagements/${engagementId}/steps/${stepId}`, patch);
      await loadBoard(); draw();
    } catch (error) { toast('Could not update step', error.message, 'err'); }
  };

  const decideGate = async (gateId, authorityRef) => {
    try {
      await api.post(`/v1/projects/${projectId}/grid/engagements/${engagementId}/gates/${gateId}/decision`, {
        decisionApproved: true, ...(authorityRef ? { authorityRef } : {}),
      });
      toast('Gate decided', `${gateId} recorded`, 'ok');
      await loadBoard(); draw();
    } catch (error) { toast('Gate decision refused', `${error.code ? `${error.code} — ` : ''}${error.message}`, 'warn'); }
  };

  function draw() {
    const canWrite = can('QUALITY_COMMISSIONING', 'C');
    const parts = [];

    parts.push(html`<div class="card pad">
      <h1 style="margin:0 0 4px">Grid Connection AI</h1>
      <p class="muted" style="margin:0">The HV grid-connection delivery playbook — 42 agent-run steps across eight gates (G0 Agreement → G7 Handover). An electrical gate (G4–G7) advances only on a verified authority record; agents never switch, set points or operate plant.</p>
    </div>`);

    // Engagement picker + open form.
    parts.push(html`<div class="card pad" style="margin-top:14px">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label class="field" style="min-width:260px"><span>Engagement</span>
          <select id="eng-pick">
            <option value="">— choose a connection —</option>
            ${engagements.map((e) => html`<option value="${e.engagementId}" ${engagementId === e.engagementId ? 'selected' : ''}>${e.reference} · ${e.connection} (${e.percent}%)</option>`)}
          </select></label>
      </div>
      ${canWrite ? html`<form id="open-form" class="grid g-2" style="gap:10px;margin-top:10px">
        <label class="field"><span>Connection</span><input name="connection" placeholder="Bay 1 HV intake" required></label>
        <label class="field"><span>Route</span>
          <select name="route">${['DIRECT_TRANSMISSION', 'DISTRIBUTION', 'SELF_BUILD', 'SUPPLY'].map((r) => html`<option value="${r}">${r}</option>`)}</select></label>
        <label class="field"><span>Point of connection</span><input name="pointOfConnection" placeholder="Primary 33kV busbar"></label>
        <label class="field"><span>Capacity note</span><input name="capacityNote" placeholder="12 MW import, PF basis to confirm"></label>
        <div style="grid-column:1/-1"><button class="btn" type="submit">Open engagement</button></div>
      </form>` : html`<p class="muted" style="margin:8px 0 0">You do not hold the commissioning permission needed to open an engagement.</p>`}
    </div>`);

    if (board) {
      const c = board.coverage;
      parts.push(html`<div class="card pad" style="margin-top:14px">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <b>${board.engagement.reference}</b> ${badge(board.engagement.route, 'neutral')}
          <span>${board.engagement.connection}${board.engagement.pointOfConnection ? ` · ${board.engagement.pointOfConnection}` : ''}</span>
          <span style="margin-left:auto">Verified digital coverage ${c.validated}/${c.requiredDigital} (${c.percent}%)</span>
        </div>
        <div style="height:8px;background:var(--line);border-radius:4px;overflow:hidden;margin-top:8px"><div style="height:100%;width:${c.percent}%;background:var(--ok)"></div></div>
        ${board.nextActions.length ? html`<div class="notice" style="margin-top:10px"><b>Next:</b> ${board.nextActions[0]}</div>` : ''}
      </div>`);

      // One card per gate (the delivery tabs), each with its state and its steps.
      for (const g of board.gates) {
        const steps = board.steps.filter((s) => s.gate === g.id);
        parts.push(html`<div class="card pad0" style="margin-top:14px">
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:12px 16px 0">
            <b>${g.id} — ${g.title}</b> ${badge(g.state, gateTone(g.state))} ${g.electricalAuthority ? badge('ELECTRICAL AUTHORITY', 'warn') : ''}
            ${canWrite && (g.state === 'CANDIDATE_READY' || g.state === 'AWAITING_AUTHORITY') ? html`<span style="margin-left:auto">
              ${g.electricalAuthority
                ? html`<form class="gate-auth" data-gate="${g.id}" style="display:inline-flex;gap:6px">
                    <input name="authorityRef" placeholder="Verified authority record (e.g. EON-2026-114)" required style="min-width:240px">
                    <button class="btn sm" type="submit">Record authority & approve</button>
                  </form>`
                : html`<button class="btn sm" data-approve="${g.id}">Approve gate</button>`}
            </span>` : ''}
          </div>
          ${table({
            headers: ['#', 'Agent', 'What the agent executes', 'Run state', 'Validated', canWrite ? '' : null].filter((h) => h !== null),
            rows: steps.map((s) => [
              `${s.id}${s.validated ? ' ◆' : ''}`,
              s.capability,
              s.executes,
              resolveHtml(badge(s.runState, runTone(s.runState))),
              s.validated ? '✓' : '—',
              ...(canWrite ? [resolveHtml(html`<span style="display:inline-flex;gap:4px">
                ${s.validated ? '' : html`<button class="btn quiet xs" data-validate="${s.id}">Validate</button>`}
                ${s.runState === 'BLOCKED' ? '' : html`<button class="btn quiet xs" data-block="${s.id}">Block</button>`}
              </span>`)] : []),
            ]),
            empty: 'No steps.',
          })}
        </div>`);
      }
    }

    render(root, html`${parts}`);

    const pick = root.querySelector('#eng-pick');
    if (pick) pick.addEventListener('change', async () => { engagementId = pick.value || null; await loadBoard(); draw(); });
    const of = root.querySelector('#open-form');
    if (of) of.addEventListener('submit', (ev) => { ev.preventDefault(); openEngagement(Object.fromEntries(new FormData(of).entries())); });
    root.querySelectorAll('[data-validate]').forEach((b) => b.addEventListener('click', () => setStep(b.dataset.validate, { runState: 'VALIDATED', validated: true })));
    root.querySelectorAll('[data-block]').forEach((b) => b.addEventListener('click', () => setStep(b.dataset.block, { runState: 'BLOCKED' })));
    root.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', () => decideGate(b.dataset.approve)));
    root.querySelectorAll('.gate-auth').forEach((f) => f.addEventListener('submit', (ev) => {
      ev.preventDefault();
      decideGate(f.dataset.gate, new FormData(f).get('authorityRef'));
    }));
  }

  await loadList();
  draw();
}
