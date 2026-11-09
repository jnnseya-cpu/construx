import { api } from '../lib/api.js';
import { badge, html, render, resolveHtml, table, toast } from '../lib/ui.js';
import { can, state } from '../app.js';

/**
 * Autonomous Consultancy — the engagement workboard.
 *
 * The door onto the stateful consultancy engagement: open one from a decision
 * need, register the required digital work-packages, and watch the workboard
 * report verified coverage, blockers and the next permissible action. The
 * appraisal and the Five Case business case (the deliverables) are produced by
 * the consultancy engine; this is where the work is tracked to done.
 *
 * Every figure here comes from the server. The coverage percentage, the
 * blockers and the workflow state are the server's workboard
 * (`GET …/consultancy/engagements/{id}/workboard`), not a browser computation —
 * a blocked task stays in the denominator exactly as the engine counts it.
 */

const RUN_STATES = ['QUEUED', 'RUNNING', 'WAITING_INPUT', 'WAITING_AUTHORITY', 'RETRYABLE_FAILURE', 'BLOCKED', 'COMPLETE', 'CANCELLED'];

const runTone = (s) =>
  s === 'COMPLETE' ? 'ok' : s === 'BLOCKED' || s === 'RETRYABLE_FAILURE' ? 'bad' : s === 'WAITING_INPUT' || s === 'WAITING_AUTHORITY' ? 'warn' : 'neutral';
const flowTone = (s) => (s === 'ISSUED' || s === 'IN_PROGRESS' ? 'ok' : s === 'CANCELLED' ? 'bad' : 'neutral');

export async function consultancy(root) {
  const projectId = state.session.projectId;
  // Page-local state: the engagement currently open on the board.
  let engagementId = null;
  let board = null;
  let evidence = [];
  let lastClaim = null;
  let planData = null;

  const loadBoard = async () => {
    if (!engagementId) { board = null; evidence = []; return; }
    try {
      board = await api.get(`/v1/projects/${projectId}/consultancy/engagements/${engagementId}/workboard`);
    } catch (error) {
      board = null;
      toast('Workboard unavailable', error.message, 'err');
    }
    try {
      evidence = await api.get(`/v1/projects/${projectId}/consultancy/engagements/${engagementId}/evidence`);
    } catch { evidence = []; }
    try {
      planData = await api.get(`/v1/projects/${projectId}/consultancy/engagements/${engagementId}/plan`);
    } catch { planData = null; }
  };

  const addEvidence = async (form) => {
    try {
      await api.post(`/v1/projects/${projectId}/consultancy/engagements/${engagementId}/evidence`, {
        source: form.source, locator: form.locator, authority: form.authority, confidence: form.confidence,
      });
      toast('Evidence registered', form.source, 'ok');
      await loadBoard();
      draw();
    } catch (error) {
      toast('Could not register evidence', error.message, 'err');
    }
  };

  const recordClaim = async (form) => {
    try {
      const res = await api.post(`/v1/projects/${projectId}/consultancy/engagements/${engagementId}/claims`, {
        statement: form.statement, sourceRefs: form.sourceRef ? [form.sourceRef] : [],
      });
      lastClaim = { id: res.claimId, statement: form.statement };
      toast('Claim recorded', 'traced to its source', 'ok');
      await loadBoard();
      draw();
    } catch (error) {
      toast('Claim refused', error.message, 'err');
    }
  };

  const viewLineage = async (claimId) => {
    try {
      const l = await api.get(`/v1/projects/${projectId}/consultancy/claims/${claimId}/lineage`);
      const cited = l.evidence.map((e) => e.source).join(', ') || '—';
      toast('Lineage', `${l.claim.statement.slice(0, 60)} ← ${cited}${l.supersededSince.length ? ' (a cited source has been superseded)' : ''}`, l.supersededSince.length ? 'warn' : 'ok');
    } catch (error) {
      toast('Lineage unavailable', error.message, 'err');
    }
  };

  const openEngagement = async (form) => {
    try {
      const res = await api.post(`/v1/projects/${projectId}/consultancy/engagements`, {
        route: form.route,
        assignment: form.assignment,
        intake: {
          decisionRequested: form.decisionRequested,
          decisionAuthority: form.decisionAuthority,
          client: form.client,
          partySide: form.partySide,
          assetOrService: form.assetOrService,
          location: form.location,
        },
      });
      engagementId = res.engagementId;
      toast('Engagement opened', `${res.reference} — ${res.blockers.length} intake item(s) outstanding`, res.blockers.length ? 'warn' : 'ok');
      await loadBoard();
      draw();
    } catch (error) {
      toast('Could not open engagement', error.message, 'err');
    }
  };

  const action = async (kind) => {
    try {
      await api.post(`/v1/projects/${projectId}/consultancy/engagements/${engagementId}/actions`, { kind });
      toast('Action recorded', kind, 'ok');
      await loadBoard();
      draw();
    } catch (error) {
      toast('Action refused', error.message, 'err');
    }
  };

  const addTask = async (form) => {
    try {
      await api.post(`/v1/projects/${projectId}/consultancy/engagements/${engagementId}/tasks`, {
        key: form.key, capability: form.capability, title: form.title,
      });
      toast('Task registered', form.title, 'ok');
      await loadBoard();
      draw();
    } catch (error) {
      toast('Could not register task', error.message, 'err');
    }
  };

  const setTaskState = async (taskId, runState, validated) => {
    try {
      await api.post(`/v1/projects/${projectId}/consultancy/tasks/${taskId}`, { runState, validated });
      await loadBoard();
      draw();
    } catch (error) {
      toast('Could not update task', error.message, 'err');
    }
  };

  function draw() {
    const canWrite = can('BUSINESS_DEVELOPMENT', 'C');
    const parts = [];

    parts.push(html`<div class="card pad">
      <h1 style="margin:0 0 4px">Consultancy workboard</h1>
      <p class="muted" style="margin:0">Open a stateful engagement, register the required digital work-packages, and track verified coverage to done. The engagement and every task are recorded on the golden thread.</p>
    </div>`);

    if (!board) {
      parts.push(html`<div class="card pad" style="margin-top:14px">
        <h2 style="margin:0 0 8px">Open an engagement</h2>
        ${canWrite ? html`<form id="open-form" class="grid g-2" style="gap:10px">
          <label class="field"><span>Work route</span>
            <select name="route">${['RESPOND_TO_RFQ', 'COMMISSION_RFQ', 'DELIVER_COMMISSION', 'REAPPRAISE'].map((r) => html`<option value="${r}">${r}</option>`)}</select></label>
          <label class="field"><span>Assignment</span>
            <select name="assignment">${['COMBINED', 'FEASIBILITY_ONLY', 'BUSINESS_CASE_ONLY'].map((a) => html`<option value="${a}">${a}</option>`)}</select></label>
          <label class="field"><span>Client</span><input name="client" value="North Lincolnshire Council"></label>
          <label class="field"><span>Party side</span>
            <select name="partySide">${['BIDDER', 'BUYER', 'CLIENT'].map((p) => html`<option value="${p}">${p}</option>`)}</select></label>
          <label class="field"><span>Decision requested</span><input name="decisionRequested" placeholder="Reinstate an hourly service and add a Sunday service"></label>
          <label class="field"><span>Decision authority</span><input name="decisionAuthority" value="North Lincolnshire Council"></label>
          <label class="field"><span>Asset or service</span><input name="assetOrService" placeholder="Doncaster–Scunthorpe rail service"></label>
          <label class="field"><span>Location</span><input name="location" placeholder="North Lincolnshire"></label>
          <div style="grid-column:1/-1"><button class="btn" type="submit">Open engagement</button></div>
        </form>` : html`<p class="muted">You do not hold the business-development permission needed to open an engagement.</p>`}
      </div>`);
      render(root, html`${parts}`);
      const form = root.querySelector('#open-form');
      if (form) form.addEventListener('submit', (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(form).entries());
        openEngagement(data);
      });
      return;
    }

    const e = board.engagement;
    const c = board.coverage;
    parts.push(html`<div class="card pad" style="margin-top:14px">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <b>${e.reference}</b> ${badge(e.workflowState, flowTone(e.workflowState))} ${badge(e.route, 'neutral')} ${badge(e.assignment, 'neutral')}
        ${e.partySide ? badge(e.partySide, 'info') : ''}
        <span style="margin-left:auto">Scope v${e.scopeVersion}</span>
      </div>
      <div style="margin-top:10px">
        <div style="display:flex;justify-content:space-between;font-size:12px"><span>Verified digital coverage</span><span>${c.coveredAndValidated}/${c.requiredDigital} (${c.percent}%)</span></div>
        <div style="height:8px;background:var(--line);border-radius:4px;overflow:hidden;margin-top:3px"><div style="height:100%;width:${c.percent}%;background:var(--ok)"></div></div>
      </div>
      ${canWrite ? html`<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn quiet sm" data-act="AUTHORISE">Authorise</button>
        <button class="btn quiet sm" data-act="SCOPE_CHANGE">Scope change</button>
        <button class="btn quiet sm" data-act="ISSUE">Issue</button>
        <button class="btn quiet sm" data-act="CANCEL">Cancel</button>
      </div>` : ''}
    </div>`);

    if (board.blockers.length) {
      parts.push(html`<div class="card pad" style="margin-top:14px">
        <h2 style="margin:0 0 8px">Blockers</h2>
        <ul style="margin:0;padding-left:18px">${board.blockers.map((b) => html`<li>${b.detail}${b.owner ? html` <span class="muted">(owner: ${b.owner})</span>` : ''}</li>`)}</ul>
      </div>`);
    }
    if (board.nextActions.length) {
      parts.push(html`<div class="notice" style="margin-top:14px"><b>Next:</b> ${board.nextActions[0]}</div>`);
    }
    if (planData) {
      parts.push(html`<div class="muted" style="margin-top:8px;font-size:12px">Orchestration: ${planData.runnable.length} task(s) runnable now · ${planData.waves.length} wave(s)${planData.cycle ? ' · a dependency cycle was detected' : ''}${planData.complete ? ' · graph complete' : ''}.</div>`);
    }

    parts.push(html`<div class="card pad0" style="margin-top:14px">
      <h2 style="padding:14px 16px 0;margin:0">Required digital tasks</h2>
      ${table({
        headers: ['Task', 'Capability', 'Run state', 'Validated', ''],
        rows: board.tasks.map((t) => [
          t.title,
          t.capability,
          resolveHtml(badge(t.runState, runTone(t.runState))),
          t.validated ? '✓' : '—',
          canWrite ? resolveHtml(html`<button class="btn quiet xs" data-complete="${t.id}">Mark complete & validated</button>`) : '',
        ]),
        empty: 'No tasks registered yet.',
      })}
      ${canWrite ? html`<form id="task-form" class="grid g-3" style="gap:8px;padding:12px 16px">
        <input name="key" placeholder="key (e.g. options)" required>
        <input name="capability" placeholder="capability (e.g. ECONOMICS)" required>
        <input name="title" placeholder="Task title" required>
        <div style="grid-column:1/-1"><button class="btn sm" type="submit">Register task</button></div>
      </form>` : ''}
    </div>`);

    // Evidence & lineage — sources with locators and confidence, and claims that
    // trace to them. A claim can only cite a current source; the lineage button
    // reads the server's lineage so a superseded source is never silently relied on.
    parts.push(html`<div class="card pad0" style="margin-top:14px">
      <h2 style="padding:14px 16px 0;margin:0">Evidence &amp; lineage</h2>
      ${table({
        headers: ['Source', 'Locator', 'Authority', 'Confidence', 'Status'],
        rows: evidence.map((e) => [
          `${e.source}${e.id ? ` (${e.id.slice(-6)})` : ''}`,
          e.locator ?? '—',
          e.authority ?? '—',
          e.confidence,
          resolveHtml(badge(e.status, e.status === 'SUPERSEDED' ? 'warn' : 'ok')),
        ]),
        empty: 'No evidence registered yet.',
      })}
      ${canWrite ? html`<form id="evidence-form" class="grid g-3" style="gap:8px;padding:12px 16px 4px">
        <input name="source" placeholder="Source (e.g. ORR station usage 2024-25)" required>
        <input name="locator" placeholder="Locator (e.g. table 2, p.4)">
        <input name="authority" placeholder="Authority (e.g. ORR)">
        <select name="confidence"><option value="UNVERIFIED">UNVERIFIED</option><option value="LOW">LOW</option><option value="MEDIUM">MEDIUM</option><option value="HIGH">HIGH</option></select>
        <div style="grid-column:1/-1"><button class="btn sm" type="submit">Register evidence</button></div>
      </form>
      <form id="claim-form" class="grid g-3" style="gap:8px;padding:4px 16px 12px">
        <input name="statement" placeholder="Claim (traces to a cited source)" required style="grid-column:1/3">
        <select name="sourceRef"><option value="">cite a source…</option>${evidence.filter((e) => e.status !== 'SUPERSEDED').map((e) => html`<option value="${e.id}">${e.source}</option>`)}</select>
        <div style="grid-column:1/-1"><button class="btn sm" type="submit">Record claim</button></div>
      </form>` : ''}
      ${lastClaim ? html`<div style="padding:0 16px 12px"><button class="btn quiet xs" data-lineage="${lastClaim.id}">View lineage of “${lastClaim.statement.slice(0, 40)}”</button></div>` : ''}
    </div>`);

    render(root, html`${parts}`);

    root.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => action(b.dataset.act)));
    root.querySelectorAll('[data-complete]').forEach((b) => b.addEventListener('click', () => setTaskState(b.dataset.complete, 'COMPLETE', true)));
    root.querySelectorAll('[data-lineage]').forEach((b) => b.addEventListener('click', () => viewLineage(b.dataset.lineage)));
    const tf = root.querySelector('#task-form');
    if (tf) tf.addEventListener('submit', (ev) => {
      ev.preventDefault();
      addTask(Object.fromEntries(new FormData(tf).entries()));
      tf.reset();
    });
    const ef = root.querySelector('#evidence-form');
    if (ef) ef.addEventListener('submit', (ev) => { ev.preventDefault(); addEvidence(Object.fromEntries(new FormData(ef).entries())); ef.reset(); });
    const cf = root.querySelector('#claim-form');
    if (cf) cf.addEventListener('submit', (ev) => { ev.preventDefault(); recordClaim(Object.fromEntries(new FormData(cf).entries())); cf.reset(); });
  }

  draw();
}
