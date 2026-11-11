import { api } from '../lib/api.js';
import { badge, html, render, table, toast } from '../lib/ui.js';
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
  let procurementId = null;
  let procView = null;

  const openProcurement = async (reference) => {
    try {
      const res = await api.post(`/v1/projects/${projectId}/consultancy/procurements`, {
        reference, published: { title: reference, scope: 'Shared procurement', deadline: '' },
      });
      procurementId = res.procurementId;
      toast('Procurement opened', reference, 'ok');
      await loadProcView();
      draw();
    } catch (error) { toast('Could not open procurement', error.message, 'err'); }
  };

  const loadProcView = async () => {
    if (!procurementId) { procView = null; return; }
    try {
      procView = await api.get(`/v1/projects/${projectId}/consultancy/procurements/${procurementId}/view`);
    } catch { procView = null; }
  };

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

  const openEngagement = async (form, confirmPlacement = false) => {
    const intake = {
      decisionRequested: form.decisionRequested,
      decisionAuthority: form.decisionAuthority,
      client: form.client,
      partySide: form.partySide,
      assetOrService: form.assetOrService,
      location: form.location,
      ...(form.clientRequirement && form.clientRequirement.trim() ? { clientRequirement: form.clientRequirement.trim() } : {}),
    };
    try {
      const res = await api.post(`/v1/projects/${projectId}/consultancy/engagements`, {
        route: form.route, assignment: form.assignment, intake, ...(confirmPlacement ? { confirmPlacement: true } : {}),
      });
      engagementId = res.engagementId;
      const briefLen = form.clientRequirement && form.clientRequirement.trim() ? form.clientRequirement.trim().length : 0;
      toast('Engagement opened', `${res.reference} — ${res.blockers.length} intake item(s) outstanding${briefLen ? ` · brief attached (${briefLen.toLocaleString()} characters)` : ''}`, res.blockers.length ? 'warn' : 'ok');
      // A non-blocking placement warning (the brief mentions nothing of this engagement).
      if (res.placement && res.placement.verdict === 'REVIEW') toast('Check the attached brief', res.placement.reason, 'warn');
      await loadBoard();
      draw();
    } catch (error) {
      // Misfile guard: the brief looks like it belongs to another engagement.
      if (error.code === 'MISFILED_DOCUMENT' || /MISFILED_DOCUMENT/.test(error.message || '')) {
        const ok = window.confirm(`${error.message}\n\nAttach it to this engagement anyway?`);
        if (ok) return openEngagement(form, true);
        toast('Not opened', 'The brief looks like it belongs to another engagement — nothing was filed.', 'warn');
        return;
      }
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

  // The usual digital work-packages for a feasibility / business-case engagement,
  // with their dependencies, so the board can be populated in one click rather than
  // the analyst inventing keys. The set follows the assignment: a feasibility-only
  // engagement stops at the technical and risk work; a business-case engagement adds
  // funding/affordability and the Five Case assembly that depends on the rest.
  const standardWorkPackages = (assignment) => {
    const base = [
      { key: 'evidence', capability: 'EVIDENCE', title: 'Evidence base & data register' },
      { key: 'options', capability: 'OPTIONS_APPRAISAL', title: 'Options identification & appraisal', dependsOn: ['evidence'] },
      { key: 'demand', capability: 'DEMAND_ANALYSIS', title: 'Demand & benefits analysis', dependsOn: ['evidence'] },
      { key: 'operations', capability: 'OPERATIONS', title: 'Operational & technical feasibility', dependsOn: ['options'] },
      { key: 'cost', capability: 'COST_ESTIMATE', title: 'Capital & operating cost estimate', dependsOn: ['options'] },
      { key: 'risk', capability: 'RISK', title: 'Risk & sensitivity analysis', dependsOn: ['options'] },
    ];
    const funding = { key: 'funding', capability: 'FINANCE', title: 'Funding & affordability', dependsOn: ['cost'] };
    const businessCase = { key: 'businesscase', capability: 'BUSINESS_CASE', title: 'Five Case business case assembly', dependsOn: ['demand', 'operations', 'cost', 'funding', 'risk'] };
    if (assignment === 'FEASIBILITY_ONLY') return base;
    if (assignment === 'BUSINESS_CASE_ONLY') return [...base.filter((t) => t.key !== 'operations'), funding, businessCase];
    return [...base, funding, businessCase];
  };

  const seedWorkPackages = async () => {
    const set = standardWorkPackages(board?.engagement?.assignment);
    let added = 0;
    try {
      for (const wp of set) {
        await api.post(`/v1/projects/${projectId}/consultancy/engagements/${engagementId}/tasks`, wp);
        added += 1;
      }
      toast('Work-packages registered', `${added} standard task(s) added for this ${board?.engagement?.assignment || 'engagement'}`, 'ok');
    } catch (error) {
      toast(added ? `Registered ${added}, then stopped` : 'Could not register work-packages', error.message, 'err');
    }
    await loadBoard();
    draw();
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

  const runAgentTask = async (taskId) => {
    try {
      const t = await api.post(`/v1/projects/${projectId}/consultancy/tasks/${taskId}/run`, {});
      if (t.runState === 'COMPLETE') toast('Agent ran', `${t.title} — grounded in the client requirement${t.lastRun && t.lastRun.groundedInRequirement ? '' : ' (no brief attached)'}; awaiting validation`, 'ok');
      else toast('Task parked', t.blocker || `${t.title} is ${t.runState}`, 'warn');
      await loadBoard();
      draw();
    } catch (error) {
      toast('Could not run the agent', error.message, 'err');
    }
  };

  // --- Deliverable generators (business case, RFQ issue pack) ----------------
  // Small, real forms over the tenant-level consultancy engine so the two
  // deliverables are produced and downloaded from the screen, not by curl. The
  // appraisal preview and RFQ validation are free (JSON); the branded documents
  // charge the wallet exactly as any other export does.
  const toMinor = (v) => {
    const n = Number.parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && String(v ?? '').trim() !== '' ? Math.round(n * 100) : undefined;
  };
  const lines = (s) => String(s ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const gbp = (minor) => (minor == null ? '—' : `£${(minor / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

  const buildBusinessCase = (form) => {
    const intake = (board && board.engagement.intake) || {};
    const options = lines(form.options).map((l) => {
      const [name, ...rest] = l.split('|');
      const nm = (name || '').trim();
      return { name: nm, summary: rest.join('|').trim() || nm };
    });
    const payload = {
      title: (form.title || '').trim(),
      intake: {
        decisionRequested: intake.decisionRequested || (form.title || '').trim(),
        decisionAuthority: intake.decisionAuthority || '',
        client: intake.client || '',
        partySide: intake.partySide || 'CLIENT',
        assetOrService: intake.assetOrService || '',
        location: intake.location || '',
        // Carry the client's attached brief through so the narrative AI reads it.
        ...(intake.clientRequirement ? { clientRequirement: intake.clientRequirement } : {}),
      },
      objectives: lines(form.objectives),
      options,
    };
    const op = toMinor(form.operatingCost);
    const rec = toMinor(form.receiptPerUse);
    if (op !== undefined && rec !== undefined) {
      payload.serviceCase = { operatingCostMinor: op, netReceiptPerUseMinor: rec };
      const cap = toMinor(form.subsidyCap);
      if (cap !== undefined) payload.serviceCase.subsidyCapMinor = cap;
      const dem = Number.parseInt(form.demandUses, 10);
      if (Number.isFinite(dem)) payload.serviceCase.demandUses = dem;
    }
    const capex = toMinor(form.capitalCost);
    if (capex !== undefined) payload.capitalCostMinor = capex;
    return payload;
  };

  const previewAppraisal = async (form, resultEl) => {
    try {
      const r = await api.post('/v1/consultancy/appraisal', buildBusinessCase(form));
      const m = r.model;
      const tone = r.decision.recommendation === 'STOP' ? 'bad' : r.decision.recommendation === 'HOLD' ? 'warn' : 'ok';
      render(resultEl, html`<div class="notice" style="margin-top:8px">
        ${badge(r.decision.recommendation, tone)} <b style="margin-left:6px">${r.decision.rationale}</b>
        ${m ? html`<div class="muted" style="margin-top:4px">Break-even ${m.breakEvenUses.toLocaleString()} use(s)/yr${m.minUsesWithinCap != null ? `; ${m.minUsesWithinCap.toLocaleString()} within the subsidy cap` : ''}${m.residualGapMinor ? ` · residual funding gap ${gbp(m.residualGapMinor)}` : ''}.</div>` : ''}
        ${r.screened && r.screened.some((o) => !o.eligible) ? html`<div class="muted" style="margin-top:4px">Excluded on a hard constraint: ${r.screened.filter((o) => !o.eligible).map((o) => o.name).join(', ')}.</div>` : ''}
        ${r.decision.conditions && r.decision.conditions.length ? html`<div class="muted" style="margin-top:4px">Conditions: ${r.decision.conditions.join('; ')}</div>` : ''}
        ${r.blockers && r.blockers.length ? html`<div class="muted" style="margin-top:4px">Intake still open: ${r.blockers.join('; ')}</div>` : ''}
      </div>`);
    } catch (error) { toast('Could not appraise', error.message, 'err'); }
  };

  const downloadBusinessCase = async (form, format) => {
    try {
      await api.download('/v1/consultancy/business-case', { ...buildBusinessCase(form), format });
      toast('Business case generated', `Downloaded the branded ${format}`, 'ok');
    } catch (error) { toast('Could not generate the business case', error.message, 'err'); }
  };

  const buildRfq = (form) => ({
    title: (form.title || '').trim(),
    organisation: (form.organisation || '').trim(),
    mandate: (form.mandate || '').trim(),
    scope: (form.scope || '').trim(),
    deadline: (form.deadline || '').trim(),
    evaluation: lines(form.evaluation).map((l) => {
      const [name, weight, type] = l.split('|').map((x) => (x || '').trim());
      return { name, weightPct: Number.parseFloat(weight) || 0, type: type === 'PRICE' ? 'PRICE' : 'QUALITY' };
    }),
    deliverables: lines(form.deliverables).map((l) => {
      const [deliverable, ...rest] = l.split('|');
      return { deliverable: (deliverable || '').trim(), acceptanceTest: rest.join('|').trim() };
    }),
    priceLines: lines(form.priceLines).map((l) => {
      const [item, basis, amount] = l.split('|').map((x) => (x || '').trim());
      const line = { item, basis: basis === 'OPTION' ? 'OPTION' : 'CORE' };
      const minor = toMinor(amount);
      if (minor !== undefined) line.amountMinor = minor;
      return line;
    }),
    instructions: (form.instructions || '').trim() || undefined,
  });

  const validateRfq = async (form, resultEl) => {
    try {
      const { issues } = await api.post('/v1/consultancy/rfq/validate', buildRfq(form));
      if (!issues.length) {
        render(resultEl, html`<div class="notice" style="margin-top:8px">${badge('ISSUABLE', 'ok')} <b style="margin-left:6px">The pack reconciles — mandate, scope, priced core, deliverable acceptance and weights summing to 100%.</b></div>`);
      } else {
        render(resultEl, html`<div class="notice" style="margin-top:8px">${badge('NOT ISSUABLE', 'bad')}<ul style="margin:6px 0 0;padding-left:18px">${issues.map((i) => html`<li>${i.detail}</li>`)}</ul></div>`);
      }
    } catch (error) { toast('Could not validate the RFQ', error.message, 'err'); }
  };

  const downloadRfq = async (form, format) => {
    try {
      await api.download('/v1/consultancy/rfq', { ...buildRfq(form), format });
      toast('RFQ issue pack generated', `Downloaded the branded ${format}`, 'ok');
    } catch (error) { toast('Could not generate the RFQ', error.message, 'err'); }
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
          <label class="field" style="grid-column:1/-1"><span>Client requirement / brief <span class="muted">(optional — paste the RFQ, ITT or instruction; it seeds the deliverables)</span></span>
            <textarea name="clientRequirement" rows="4" placeholder="Paste the client's issued requirement here — e.g. the Request for Quotation for a Feasibility Study and Business Case to assess additional rail services between Doncaster and Scunthorpe…"></textarea></label>
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
      ${e.intake && e.intake.clientRequirement ? html`<details open style="margin-top:10px">
        <summary style="cursor:pointer;font-size:12.5px">${badge('BRIEF ATTACHED', 'ok')} Client requirement / brief (as attached at intake) — ${e.intake.clientRequirement.length.toLocaleString()} characters</summary>
        <div style="white-space:pre-wrap;font-size:12.5px;margin-top:6px;padding:8px 10px;background:var(--line);border-radius:6px;max-height:220px;overflow:auto">${e.intake.clientRequirement}</div>
      </details>` : ''}
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
          `${t.title}${t.lastRun && t.lastRun.groundedInRequirement ? ' ◆' : ''}`,
          t.capability,
          badge(t.runState, runTone(t.runState)),
          t.validated ? '✓' : '—',
          canWrite ? html`<span style="display:inline-flex;gap:4px">
            ${t.runState !== 'COMPLETE' && t.runState !== 'CANCELLED' ? html`<button class="btn quiet xs" data-run="${t.id}">Run agent</button>` : ''}
            <button class="btn quiet xs" data-complete="${t.id}">Mark complete &amp; validated</button>
          </span>` : '',
        ]),
        empty: 'No tasks registered yet.',
      })}
      <p class="muted" style="padding:0 16px;margin:4px 0 0;font-size:11.5px">◆ executed by an agent grounded in the attached client requirement. A run produces the work-package's output; a task counts toward coverage only once it is also independently validated.</p>
      ${canWrite ? html`<div style="padding:12px 16px 0">
        ${board.tasks.length === 0 ? html`<button class="btn sm" type="button" id="seed-wp">Register the standard work-packages</button>
          <span class="muted" style="margin-left:8px;font-size:11.5px">The usual feasibility / business-case set for this ${e.assignment}, with their dependencies — the agents then work each one.</span>` : ''}
      </div>
      <form id="task-form" class="grid g-3" style="gap:8px;padding:10px 16px 6px">
        <label class="field"><span>Key <span class="muted">(short id, e.g. options)</span></span><input name="key" placeholder="options" required></label>
        <label class="field"><span>Capability <span class="muted">(the discipline, e.g. ECONOMICS)</span></span><input name="capability" placeholder="OPTIONS_APPRAISAL" required></label>
        <label class="field"><span>Task title <span class="muted">(what the work-package produces)</span></span><input name="title" placeholder="Options identification & appraisal" required></label>
        <div style="grid-column:1/-1"><button class="btn sm" type="submit">Add one task</button></div>
      </form>
      <p class="muted" style="padding:0 16px 12px;margin:0;font-size:11.5px">A <b>work-package</b> is one unit of the study an agent can run — e.g. the evidence base, the options appraisal, the cost estimate. The <b>key</b> is a short handle other tasks depend on; the <b>capability</b> is the discipline; the <b>title</b> is what it delivers.</p>` : ''}
    </div>`);

    // Agent outputs — the grounded result each executed task produced.
    const ran = board.tasks.filter((t) => t.lastRun && t.lastRun.summary);
    if (ran.length) {
      parts.push(html`<div class="card pad0" style="margin-top:14px">
        <h2 style="padding:14px 16px 0;margin:0">Agent outputs</h2>
        <div style="padding:8px 16px 14px">${ran.map((t) => html`<details style="margin-top:8px">
          <summary style="cursor:pointer;font-size:12.5px"><b>${t.title}</b> — ${t.capability} ${t.lastRun.groundedInRequirement ? badge('GROUNDED IN BRIEF', 'ok') : badge('NO BRIEF', 'warn')}</summary>
          <div style="white-space:pre-wrap;font-size:12.5px;margin-top:6px;padding:8px 10px;background:var(--line);border-radius:6px;max-height:280px;overflow:auto">${t.lastRun.summary}</div>
        </details>`)}</div>
      </div>`);
    }

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
          badge(e.status, e.status === 'SUPERSEDED' ? 'warn' : 'ok'),
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

    // Shared procurement (C03) — the per-party view. Opened here as the buyer;
    // the view the server returns is filtered to who is asking, so a bidder would
    // see only their own submission, never deliberations or another bidder.
    parts.push(html`<div class="card pad" style="margin-top:14px">
      <h2 style="margin:0 0 8px">Shared procurement (buyer/bidder isolation)</h2>
      ${canWrite ? html`<form id="proc-form" style="display:flex;gap:8px;flex-wrap:wrap">
        <input name="reference" placeholder="Procurement reference (e.g. ITT-001)" required>
        <button class="btn sm" type="submit">Open procurement</button>
      </form>` : ''}
      ${procView ? html`<div style="margin-top:8px;font-size:12.5px">
        <div><b>${procView.reference}</b> — ${procView.published.title}</div>
        <div class="muted">Your entitled view: ${procView.submissions.length} submission(s)${procView.deliberations ? `, ${procView.deliberations.length} deliberation(s)` : ''}${procView.evaluations ? `, ${procView.evaluations.length} evaluation(s)` : ' — deliberations and evaluations hidden (bidder view)'}.</div>
      </div>` : ''}
    </div>`);

    // Deliverable generators — seeded from the engagement's intake and the
    // client requirement attached at intake, so the two documents are produced
    // from the screen without re-keying what was captured when it opened.
    const i = e.intake || {};
    const scopeSeed = [i.assetOrService, i.location].filter(Boolean).join(' — ');
    parts.push(html`<div class="card pad0" style="margin-top:14px">
      <h2 style="padding:14px 16px 0;margin:0">Generate deliverables</h2>
      <p class="muted" style="padding:2px 16px 0;margin:0;font-size:12px">Preview and validation are free; the branded PDF/DOCX draws the export charge like any other document.</p>
      <div class="grid g-2" style="gap:0;align-items:start">
        <form id="bc-form" class="grid" style="gap:8px;padding:12px 16px;border-right:1px solid var(--line)">
          <b>Five Case business case</b>
          <label class="field"><span>Title</span><input name="title" value="${i.decisionRequested || i.assetOrService || ''}"></label>
          <label class="field"><span>Objectives <span class="muted">(one per line)</span></span><textarea name="objectives" rows="2">${i.decisionRequested || ''}</textarea></label>
          <label class="field"><span>Options <span class="muted">(Name | summary, one per line)</span></span><textarea name="options" rows="3">Do minimum | Retain the current position
${i.assetOrService || 'Preferred option'} | ${i.decisionRequested || ''}</textarea></label>
          <div class="grid g-2" style="gap:8px">
            <label class="field"><span>Annual operating cost £</span><input name="operatingCost" inputmode="decimal" placeholder="e.g. 450000"></label>
            <label class="field"><span>Net receipt per use £</span><input name="receiptPerUse" inputmode="decimal" placeholder="e.g. 3.00"></label>
            <label class="field"><span>Subsidy cap £ <span class="muted">(opt)</span></span><input name="subsidyCap" inputmode="decimal" placeholder="e.g. 200000"></label>
            <label class="field"><span>Capital cost £ <span class="muted">(opt)</span></span><input name="capitalCost" inputmode="decimal"></label>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn quiet sm" type="button" data-bc="preview">Preview appraisal</button>
            <button class="btn sm" type="button" data-bc="PDF">Download PDF</button>
            <button class="btn sm" type="button" data-bc="DOCX">Download DOCX</button>
          </div>
          <div id="bc-result"></div>
        </form>
        <form id="rfq-form" class="grid" style="gap:8px;padding:12px 16px">
          <b>RFQ issue pack</b>
          <label class="field"><span>Title</span><input name="title" value="${i.decisionRequested || ''}"></label>
          <label class="field"><span>Issuing organisation</span><input name="organisation" value="${i.client || i.decisionAuthority || ''}"></label>
          <label class="field"><span>Mandate</span><textarea name="mandate" rows="2">${i.clientRequirement || i.decisionRequested || ''}</textarea></label>
          <label class="field"><span>Scope</span><textarea name="scope" rows="2">${scopeSeed}</textarea></label>
          <label class="field"><span>Submission deadline</span><input name="deadline" value="${i.deadline || ''}" placeholder="e.g. 2026-12-01"></label>
          <label class="field"><span>Evaluation <span class="muted">(Criterion | weight | QUALITY/PRICE — weights sum to 100)</span></span><textarea name="evaluation" rows="2">Quality | 60 | QUALITY
Price | 40 | PRICE</textarea></label>
          <label class="field"><span>Deliverables <span class="muted">(Deliverable | acceptance test)</span></span><textarea name="deliverables" rows="2">Feasibility study | Meets the agreed scope and evidence standard
Business case (Five Case) | Complete and internally consistent</textarea></label>
          <label class="field"><span>Price lines <span class="muted">(Item | CORE/OPTION | £amount)</span></span><textarea name="priceLines" rows="2">Feasibility study and business case | CORE | </textarea></label>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn quiet sm" type="button" data-rfq="validate">Validate</button>
            <button class="btn sm" type="button" data-rfq="PDF">Download PDF</button>
            <button class="btn sm" type="button" data-rfq="DOCX">Download DOCX</button>
          </div>
          <div id="rfq-result"></div>
        </form>
      </div>
    </div>`);

    render(root, html`${parts}`);

    root.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => action(b.dataset.act)));
    root.querySelectorAll('[data-complete]').forEach((b) => b.addEventListener('click', () => setTaskState(b.dataset.complete, 'COMPLETE', true)));
    root.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', () => runAgentTask(b.dataset.run)));
    const seedBtn = root.querySelector('#seed-wp');
    if (seedBtn) seedBtn.addEventListener('click', () => seedWorkPackages());
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
    const pf = root.querySelector('#proc-form');
    if (pf) pf.addEventListener('submit', (ev) => { ev.preventDefault(); openProcurement(new FormData(pf).get('reference')); pf.reset(); });

    const bcForm = root.querySelector('#bc-form');
    if (bcForm) bcForm.querySelectorAll('[data-bc]').forEach((b) => b.addEventListener('click', () => {
      const data = Object.fromEntries(new FormData(bcForm).entries());
      if (b.dataset.bc === 'preview') previewAppraisal(data, root.querySelector('#bc-result'));
      else downloadBusinessCase(data, b.dataset.bc);
    }));
    const rfqForm = root.querySelector('#rfq-form');
    if (rfqForm) rfqForm.querySelectorAll('[data-rfq]').forEach((b) => b.addEventListener('click', () => {
      const data = Object.fromEntries(new FormData(rfqForm).entries());
      if (b.dataset.rfq === 'validate') validateRfq(data, root.querySelector('#rfq-result'));
      else downloadRfq(data, b.dataset.rfq);
    }));
  }

  draw();
}
