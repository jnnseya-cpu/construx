import { api, hashFile } from '../lib/api.js';
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
  const [data, evidence] = await Promise.all([
    api.get(`/v1/projects/${projectId}/audit/events`),
    // The other half of the same claim. A chain of hashes proves nothing has
    // been altered; it does not prove anybody still has the documents those
    // hashes describe, and until this screen showed both, that difference was
    // invisible from inside the product.
    api.get(`/v1/projects/${projectId}/evidence`).catch(() => null),
  ]);
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
          ${can('EVIDENCE_AUDIT', 'I') ? html`<button class="btn quiet" id="pdf">Download report PDF</button>` : ''}
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

      <div class="grid g5" style="margin-bottom:14px">
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
          <h3>Files held</h3>
          <div class="metric ${raw(evidence && evidence.coverage.missing === 0 ? 'good' : 'warn')}">
            ${evidence ? `${evidence.coverage.held}/${evidence.coverage.total}` : '—'}
          </div>
          <div class="metric-sub">
            ${
              !evidence
                ? 'not visible to your role'
                : !evidence.storeConfigured
                  ? 'no object store configured on this deployment'
                  : evidence.coverage.missing === 0
                    ? 'every recorded hash has its document behind it'
                    : `${evidence.coverage.missing} depend on somebody outside the platform still holding the original`
            }
          </div>
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

      ${
        evidence
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <div style="padding:15px 17px 0">
                <h3>Evidence register — what the platform actually holds</h3>
                <p class="metric-sub" style="margin-bottom:12px">
                  A hash proves a document has not been altered. It does not produce the document. Everything marked
                  <b>hash only</b> below is a record whose file lives somewhere else — on a phone, in an inbox, with somebody who
                  may have left. Supplying it here stores it against the hash already in the chain; a file that does not match
                  that hash is refused rather than recorded as a correction.
                  ${
                    evidence.storeConfigured
                      ? ''
                      : html`<br><b>This deployment has no object store configured</b>, so nothing can be held yet.`
                  }
                </p>
              </div>
              ${table({
                headers: ['Captured', 'Type', 'Description', 'Hash', 'File'],
                align: ['', '', '', 'mono', ''],
                rows: evidence.entries.slice(0, 40).map((entry) => [
                  time(entry.capturedAt),
                  entry.type,
                  entry.description,
                  shortHash(entry.hash),
                  entry.held
                    ? html`<a class="btn quiet sm" href="#" data-open="${entry.hash}">Open</a>`
                    : evidence.storeConfigured && can('EVIDENCE_AUDIT', 'R')
                      ? html`<label class="btn quiet sm" style="cursor:pointer">
                          Supply file
                          <input type="file" data-supply="${entry.hash}" style="display:none">
                        </label>`
                      : badge('hash only', 'warn'),
                ]),
                empty: 'Nothing in this project has been recorded with evidence yet.',
              })}
            </div>`
          : ''
      }

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

  // Supply the file behind a hash the chain already records. The browser hashes
  // it first and refuses a mismatch locally, so somebody who picked the wrong
  // file is told which file it should be rather than told the server said no.
  // The server hashes it again regardless — the local check is a courtesy, not
  // a control.
  for (const input of document.querySelectorAll('input[data-supply]')) {
    input.addEventListener('change', async (event) => {
      // Held rather than read from the event: `currentTarget` is null once the
      // handler has awaited anything, and on the success path the element is
      // gone entirely because the view re-renders.
      const control = event.target;
      const file = control.files?.[0];
      const expected = control.dataset.supply;
      if (!file) return;

      const label = control.closest('label');
      const original = label?.firstChild?.nodeValue;
      if (label?.firstChild) label.firstChild.nodeValue = ' Checking… ';

      try {
        const actual = await hashFile(file);
        if (actual !== expected) {
          toast(
            'Not this document',
            `"${file.name}" hashes to ${shortHash(actual)}, and the record was taken over ${shortHash(expected)}. ` +
              'Supplying it would put the wrong file behind a hash the chain already relies on.',
            'warn',
          );
          return;
        }

        const stored = await api.upload(`/v1/evidence/${encodeURIComponent(expected)}`, file);
        toast('Evidence stored', `${file.name} — ${Math.max(1, Math.round(stored.bytes / 1024))} KB held against ${shortHash(expected)}`, 'ok');
        // Re-render so the row moves from "hash only" to a file that opens, and
        // the coverage figure at the top moves with it.
        await audit(root);
        return;
      } catch (error) {
        toast('Could not store', error.message, 'err');
      } finally {
        // Only if the row still exists — after a successful store the whole
        // view has been rebuilt and this control is detached.
        if (control.isConnected) {
          if (label?.firstChild && original !== undefined) label.firstChild.nodeValue = original;
          control.value = '';
        }
      }
    });
  }

  for (const link of document.querySelectorAll('a[data-open]')) {
    link.addEventListener('click', async (event) => {
      event.preventDefault();
      const hash = event.target.dataset.open;
      try {
        // An expiring, tenant-bound link rather than the object's own path: the
        // tab that opens has no session, and a URL people paste to each other
        // should stop working.
        const { url } = await api.post(`/v1/evidence/${encodeURIComponent(hash)}/link`);
        window.open(url, '_blank', 'noopener');
      } catch (error) {
        toast('Could not open', error.message, 'err');
      }
    });
  }

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

  document.getElementById('pdf')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Rendering…';
    try {
      // Rendered from the same document the hash was taken over, rather than
      // from whatever a browser's print pipeline makes of the page.
      const { filename } = await api.download(`/v1/projects/${projectId}/exports/report.pdf`, { audience: 'ADJUDICATOR' });
      toast('Report downloaded', `${filename} — branded, hashed and recorded as an export`, 'ok');
    } catch (error) {
      if (error.code === 'EXPORT_NOT_ENTITLED') toast('Not on this plan', error.message, 'warn');
      else toast('Could not render', error.message, 'err');
    }
    button.disabled = false;
    button.textContent = 'Download report PDF';
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
