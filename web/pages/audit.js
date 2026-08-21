import { api } from '../lib/api.js';
import { badge, html, raw, render, shortHash, table, time, toast } from '../lib/ui.js';
import { can, state } from '../app.js';

/**
 * Golden Thread.
 *
 * The screen that makes the platform's central claim checkable rather than
 * asserted: replay reconstructs every entity from the event log alone, verifies
 * each event independently, and produces one root hash that any party holding
 * the same log can recompute.
 */

export async function audit(root) {
  const projectId = state.session.projectId;
  const data = await api.get(`/v1/projects/${projectId}/audit/events`);
  const events = data.events;

  const byActor = { User: 0, AI: 0, System: 0 };
  const byGroup = new Map();
  for (const event of events) {
    byActor[event.actor.refType] = (byActor[event.actor.refType] ?? 0) + 1;
    byGroup.set(event.entity.refType, (byGroup.get(event.entity.refType) ?? 0) + 1);
  }
  const withEvidence = events.filter((e) => (e.evidenceRefs ?? []).length > 0).length;

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Golden Thread</h1>
          <p>Every state change, hash-chained. Nothing here can be edited — a correction is a new event, and the original stays visible.</p>
        </div>
        <div class="actions">
          <button class="btn" id="replay">Run verification replay</button>
          ${can('EVIDENCE_AUDIT', 'I') ? html`<button class="btn quiet" id="export">Export audit pack</button>` : ''}
        </div>
      </div>

      <div id="replay-result"></div>

      ${
        data.withheldCount > 0
          ? html`<div class="notice info">
              <div><b>${data.withheldCount} of ${events.length} events have their content withheld from your role.</b><br>
              The envelope stays — actor, time, event type and the hashes that chain it — so you can still verify the record is
              complete and untampered. What changed inside those events is entity content, and the same rules apply to it here
              as anywhere else.</div>
            </div>`
          : ''
      }

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h3>Events recorded</h3>
          <div class="metric orange">${events.length}</div>
          <div class="metric-sub">append-only, none editable</div>
        </div>
        <div class="card">
          <h3>AI-authored</h3>
          <div class="metric">${byActor.AI}</div>
          <div class="metric-sub">attributed to an AI actor, with provider and ACU cost</div>
        </div>
        <div class="card">
          <h3>Evidenced</h3>
          <div class="metric good">${withEvidence}</div>
          <div class="metric-sub">events carrying at least one evidence reference</div>
        </div>
        <div class="card">
          <h3>Chain head</h3>
          <div class="metric" style="font-size:15px;font-family:var(--mono);letter-spacing:0">${shortHash(data.chainHead)}</div>
          <div class="metric-sub">changes with every committed event</div>
        </div>
      </div>

      <div class="grid g-2-1" style="margin-bottom:14px">
        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Event log — most recent first</h3>
          ${table({
            headers: ['Time', 'Event', 'Entity', 'Actor', 'Evidence', 'Chain hash'],
            align: ['', '', '', '', 'num', 'mono'],
            rows: events
              .slice(-60)
              .reverse()
              .map((e) => [
                time(e.timestamp),
                e.eventType,
                `${e.entity.refType} ${e.entity.refId.slice(-6)}`,
                badge(e.actor.refType === 'AI' ? `AI · ${e.ai?.provider ?? ''}` : e.actor.refType, e.actor.refType === 'AI' ? 'ai' : 'neutral'),
                (e.evidenceRefs ?? []).length || '—',
                shortHash(e.chainHash),
              ]),
          })}
        </div>

        <div class="card">
          <h3>Events by entity</h3>
          <div class="split-list">
            ${[...byGroup.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 14)
              .map(([type, count]) => html`<div class="row"><span class="lbl">${type}</span><span class="val">${count}</span></div>`)}
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <h3>Trace a record</h3>
        <p class="metric-sub" style="margin-bottom:12px">
          What caused this, and what was built on it. Walked over the ledger rather than held in a second index — links are
          labelled by how they were established, because a declared piece of evidence and a state field that happens to name
          an id are not the same claim.
        </p>
        <form class="input-zone" id="trace">
          <div class="field">
            <label for="t-entity">Record</label>
            <select id="t-entity" name="entity">
              ${[...new Map(events.slice(-120).reverse().map((e) => [`${e.entity.refType}/${e.entity.refId}`, e])).entries()]
                .slice(0, 60)
                .map(([key, e]) => html`<option value="${key}">${e.entity.refType} · ${e.entity.refId.slice(-6)} · ${e.eventType}</option>`)}
            </select>
          </div>
          <div class="field">
            <label for="t-depth">Steps</label>
            <select id="t-depth" name="depth">
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3" selected>3</option>
              <option value="4">4</option>
            </select>
          </div>
          <div class="actions"><button class="btn" type="submit">Trace</button></div>
        </form>
        <div id="trace-result" style="margin-top:13px"></div>
      </div>

      <div class="card">
        <h3>How to verify this yourself</h3>
        <div class="code">
<span class="d">// Each event carries the hash before, the hash after, and a chain</span>
<span class="d">// hash over its predecessor. Recompute the chain from the first</span>
<span class="d">// event forward — an insertion, deletion or edit anywhere changes</span>
<span class="d">// every chain hash after it, and the state root along with them.</span>

<span class="k">POST</span> /v1/projects/<span class="s">${raw(projectId.slice(0, 10))}…</span>/audit/replay
  <span class="k">"verificationStatus"</span>: <span class="s">"VERIFIED"</span>
  <span class="k">"eventsReplayed"</span>: <span class="n">${raw(String(events.length))}</span>
  <span class="k">"rootHash"</span>: <span class="s">"${raw(shortHash(data.chainHead))}"</span>
        </div>
      </div>
    `,
  );

  document.getElementById('trace')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const host = document.getElementById('trace-result');
    const [refType, refId] = document.getElementById('t-entity').value.split('/');
    const depth = document.getElementById('t-depth').value;

    render(host, html`<div class="notice info">Walking the ledger…</div>`);

    try {
      const graph = await api.get(`/v1/projects/${projectId}/lineage/${refType}/${refId}?depth=${depth}`);
      const byKey = new Map(graph.nodes.map((n) => [`${n.ref.refType}:${n.ref.refId}`, n]));
      // Spelled out rather than title-cased: "Ai input" is not a thing, and
      // these four words carry the whole distinction the panel exists to make.
      const LINK_LABEL = {
        EVIDENCE: 'evidence',
        AI_INPUT: 'AI input',
        SAME_COMMAND: 'same command',
        REFERENCE: 'reference',
      };
      const nameOf = (ref) => {
        const node = byKey.get(`${ref.refType}:${ref.refId}`);
        if (!node) return `${ref.refType} ${ref.refId.slice(-6)}`;
        return node.readable ? `${ref.refType} · ${node.label ?? ref.refId.slice(-6)}` : `${ref.refType} · withheld`;
      };

      render(
        host,
        html`
          <div class="notice ${raw(graph.withheldCount > 0 ? 'warn' : 'info')}">${graph.summary}</div>
          ${table({
            headers: ['From', 'Link', 'To', 'Established by'],
            rows: graph.edges.map((e) => [
              nameOf(e.from),
              badge(LINK_LABEL[e.kind] ?? e.kind, e.kind === 'REFERENCE' ? 'neutral' : 'ok'),
              nameOf(e.to),
              e.kind === 'REFERENCE' ? `state field "${e.via}"` : `${e.eventType} · ${time(e.timestamp)}`,
            ]),
            empty: 'Nothing else in the record refers to this, and it refers to nothing else.',
          })}
          <div class="metric-sub" style="margin-top:9px">
            A <b>reference</b> link was read out of a record's state; every other kind was declared by an event at the time, and
            names it. The difference matters when somebody is relying on the chain.
          </div>
        `,
      );
    } catch (error) {
      render(host, html`<div class="notice err">${error.message}</div>`);
    }
  });

  document.getElementById('replay')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const host = document.getElementById('replay-result');
    button.disabled = true;
    button.textContent = 'Replaying…';
    render(host, html`<div class="notice info">Rebuilding every entity from the event log and verifying each event…</div>`);

    try {
      const report = await api.post(`/v1/projects/${state.session.projectId}/audit/replay`, {});
      const ok = report.verificationStatus === 'VERIFIED';
      render(
        host,
        html`<div class="notice ${raw(ok ? 'ok' : 'err')}">
          <div>
            <b>${report.verificationStatus}</b> — ${report.eventsReplayed} events replayed, ${report.entities.length} entities reconstructed,
            ${report.failures.length} integrity failure${report.failures.length === 1 ? '' : 's'}.<br>
            <span style="font-family:var(--mono);font-size:11.5px">state root ${report.rootHash}</span>
            ${
              report.redactionLog.length > 0
                ? html`<br><span style="opacity:.85">${report.redactionLog.length} record(s) withheld under your access policy. The root hash still covers the complete record.</span>`
                : ''
            }
          </div>
        </div>`,
      );
      toast(report.verificationStatus, `${report.eventsReplayed} events verified`, ok ? 'ok' : 'err');
    } catch (error) {
      render(host, html`<div class="notice err">${error.message}</div>`);
    }
    button.disabled = false;
    button.textContent = 'Run verification replay';
  });

  document.getElementById('export')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Building…';
    try {
      const doc = await api.post(`/v1/projects/${state.session.projectId}/exports/audit`, { audience: 'ADJUDICATOR' });
      toast('Audit pack exported', `${doc.reference} · hash ${shortHash(doc.contentHash)} · branded for ${doc.branding.clientName}`, 'ok');
    } catch (error) {
      // A plan limit is not a fault. Titling it "export failed" sends somebody
      // to their administrator to fix a permission that is working correctly.
      if (error.code === 'EXPORT_NOT_ENTITLED') toast('Not on this plan', error.message, 'warn');
      else toast('Export failed', error.message, 'err');
    }
    button.disabled = false;
    button.textContent = 'Export audit pack';
  });
}
