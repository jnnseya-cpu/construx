import { api, hashFile } from '../lib/api.js';
import { badge, html, notice, positionReport, raw, reference, render, shortHash, table, time, toast } from '../lib/ui.js';
import { donutChart, gauge, kpiCard } from '../lib/charts.js';
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
  const [data, timeline, sync, quote, evidence, graph, changes] = await Promise.all([
    api.get(`/v1/projects/${projectId}/audit/events`),
    // The same events told as a narrative rather than as rows, and the sync
    // cursor a device pulls from. Both had engines and no screen — the timeline
    // is what somebody reads when they are asked what happened, and rows are
    // not that.
    api.get(`/v1/projects/${projectId}/audit/timeline`).catch((error) => ({ error })),
    api.get(`/v1/projects/${projectId}/sync/pull`).catch((error) => ({ error })),
    // What taking the report out will cost, quoted before the control is
    // offered — the same rule an AI command follows.
    api.get('/v1/exports/render-quote').catch(() => null),
    // The other half of the same claim. A chain of hashes proves nothing has
    // been altered; it does not prove anybody still has the documents those
    // hashes describe, and until this screen showed both, that difference was
    // invisible from inside the product.
    api.get(`/v1/projects/${projectId}/evidence`).catch(() => null),
    // The same relationships the lineage walk uses, projected across the whole
    // project rather than out from one record — which is what answers "what is
    // everything hanging off" and "what is floating unconnected", neither of
    // which a walk from a root can see.
    api.get(`/v1/projects/${projectId}/graph`).catch((error) => ({ error })),
    // The feed an integrator's own system reads to stay in step. On this screen
    // it is the honest answer to "what would somebody else see of this", which
    // is a question about the record and belongs beside it.
    api.get('/v1/changes?limit=10').catch((error) => ({ error })),
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
          ${
            can('EVIDENCE_AUDIT', 'I')
              ? html`<label class="field" style="margin:0;min-width:190px">
                    <span>Take the report out as${quote ? ` · ${quote.chargeMinor} ACUs` : ''}</span>
                    <select id="report-format">
                      <option value="PDF">PDF — fixed, to issue</option>
                      <option value="DOCX">Word — editable, to mark up</option>
                    </select>
                  </label>
                  <button class="btn quiet" id="pdf">Download report</button>`
              : ''
          }
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
          <h2>Events recorded</h2>
          <div class="metric orange">${events.length}</div>
          <div class="metric-sub">append-only, none editable</div>
        </div>
        <div class="card">
          <h2>AI-authored</h2>
          <div class="metric">${byActor.AI}</div>
          <div class="metric-sub">attributed to an AI actor, with its ACU cost</div>
        </div>
        <div class="card">
          <h2>Evidenced</h2>
          <div class="metric good">${withEvidence}</div>
          <div class="metric-sub">events carrying at least one evidence reference</div>
        </div>
        <div class="card">
          <h2>Files held</h2>
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
          <h2>Chain head</h2>
          <div class="metric" style="font-size:15px;font-family:var(--mono);letter-spacing:0">${shortHash(data.chainHead)}</div>
          <div class="metric-sub">changes with every committed event</div>
        </div>
      </div>

      <div class="grid g-2-1" style="margin-bottom:14px">
        <div class="card pad0">
          <h2 style="padding:15px 17px 0">Event log — most recent first</h2>
          ${table({
            headers: ['Time', 'Event', 'Entity', 'Actor', 'Evidence', 'Chain hash'],
            align: ['', '', '', '', 'num', 'mono'],
            rows: events
              .slice(-60)
              .reverse()
              .map((e) => [
                time(e.timestamp),
                e.eventType,
                `${e.entity.refType} ${reference(e.entity.refId)}`,
                badge(e.actor.refType === 'AI' ? 'AI' : e.actor.refType, e.actor.refType === 'AI' ? 'ai' : 'neutral'),
                (e.evidenceRefs ?? []).length || '—',
                shortHash(e.chainHash),
              ]),
          })}
        </div>

        <div class="card">
          <h2>Events by entity</h2>
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
                <h2>Evidence register — what the platform actually holds</h2>
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
        <h2>Trace a record</h2>
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
                .map(([key, e]) => html`<option value="${key}">${e.entity.refType} · ${reference(e.entity.refId)} · ${e.eventType}</option>`)}
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
        <h2>How to verify this yourself</h2>
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

      ${positionReport({
        title: 'What happened, in order',
        intent:
          'The same chain told as narrative. Each entry carries the hash it was recorded under, so a printed ' +
          'timeline can still be checked against the ledger it came from.',
        data: timeline,
        error: timeline?.error,
        sections: [
          {
            key: 'timeline',
            label: 'Timeline',
            columns: ['timestamp', 'eventType', 'entity', 'actor', 'narrative'],
            empty: 'Nothing has been recorded against this project.',
          },
        ],
      })}

      ${positionReport({
        title: 'The offline sync cursor',
        intent:
          'What a device would receive if it pulled now. Shown because a field device that has not synced is a ' +
          'record that exists on a handset and nowhere else.',
        data: sync,
        error: sync?.error,
        sections: [{ key: 'events', label: 'Since the cursor', empty: 'A device pulling now would receive nothing new.' }],
      })}

      ${graphPanel(graph)}
      ${feedPanel(changes)}
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
        if (!node) return `${ref.refType} ${reference(ref.refId)}`;
        return node.readable ? `${ref.refType} · ${node.label ?? reference(ref.refId)}` : `${ref.refType} · withheld`;
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
      // from whatever a browser's print pipeline makes of the page. Both forms
      // come off that one document, so the Word file and the PDF carry the same
      // content hash and are the same instrument.
      const format = document.getElementById('report-format')?.value ?? 'PDF';
      const { filename } = await api.download(`/v1/projects/${projectId}/exports/report.pdf`, {
        audience: 'ADJUDICATOR',
        format,
      });
      toast(
        'Report downloaded',
        `${filename} — branded, hashed and recorded as an export${quote ? `. ${quote.chargeMinor} ACUs charged.` : ''}`,
        'ok',
      );
    } catch (error) {
      if (error.code === 'EXPORT_NOT_ENTITLED') toast('Not on this plan', error.message, 'warn');
      else toast('Could not render', error.message, 'err');
    }
    button.disabled = false;
    button.textContent = 'Download report';
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

/**
 * The project's knowledge graph, as a shape rather than as a walk.
 *
 * The lineage control above answers "what caused this record" from a root. This
 * answers the questions that are about the record as a whole and that a walk
 * cannot reach: what everything hangs off, what is floating unconnected, and —
 * the figure that decides whether any of it is worth relying on — how much of
 * the graph somebody actually declared rather than the platform inferring it
 * from a field that happened to contain an id.
 */
function graphPanel(graph) {
  if (!graph || graph.error) {
    return notice('The project graph could not be read with this identity.', 'warn');
  }

  const declared = Math.round(graph.declaredShare * 100);

  return html`
    <section class="card">
      <h2>How this project is connected</h2>

      <div class="chart-row">
        ${kpiCard({
          label: 'Records',
          value: String(graph.counts.nodes),
          sub: `${graph.counts.orphans} connected to nothing`,
          tone: 'neutral',
        })}
        ${kpiCard({
          label: 'Connections',
          value: String(graph.counts.edges),
          sub: `${graph.counts.withheld} records not readable by you`,
          tone: 'neutral',
        })}
        ${gauge({
          label: 'Declared, not inferred',
          value: declared,
          max: 100,
          target: 20,
          footnote:
            'Evidence and AI inputs somebody committed to at the time, as a share of all connections. The rest were ' +
            'inferred by noticing one record’s id inside another — real, but weaker.',
        })}
      </div>

      ${donutChart({
        title: 'Connections by how they were established',
        data: graph.counts.byKind.filter((entry) => entry.edges > 0),
      })}

      ${table({
        headers: ['Record', 'Connections'],
        rows: graph.hubs.map((hub) => [hub.label ?? `${hub.ref.refType} ${reference(hub.ref.refId)}`, String(hub.edges)]),
        empty: 'Nothing in this project is connected to anything else yet.',
        emptyDetail: 'Connections appear as evidence is declared and records begin to name each other.',
      })}

      ${graph.findings.map((finding) => notice(finding, 'info'))}
    </section>
  `;
}

/**
 * What an integrator's own system would see of this project.
 *
 * Shown here because "what does somebody else receive of our record" is a
 * question about the record, and because the feed's contract — ordered, at
 * least once, no state, access checked per entry — is a set of promises the
 * customer should be able to read rather than discover.
 */
function feedPanel(changes) {
  if (!changes || changes.error) {
    return notice('The change feed could not be read with this identity.', 'warn');
  }

  return html`
    <section class="card">
      <h2>What an integration would receive</h2>
      <p class="muted">
        The feed a connected system reads to stay in step with this record. Pull, not push: a webhook that failed
        while their server was down is a hole nobody can fill, and this is how it gets filled without anybody being
        on call.
      </p>

      ${table({
        headers: ['When', 'Event', 'Record', 'Idempotency key'],
        rows: changes.entries.map((entry) => [
          time(entry.occurredAt),
          entry.eventType,
          `${entry.entity.refType} ${reference(entry.entity.refId)}`,
          shortHash(entry.idempotencyKey),
        ]),
        empty: 'Nothing has changed in this tenancy yet.',
        emptyDetail: 'Every committed event appears here, in the order it was committed.',
      })}

      ${changes.withheld > 0
        ? notice(
            `${changes.withheld} changes in this window are not readable by your identity and were left out of the ` +
              'page. They are counted rather than hidden, so a count that does not reconcile has a visible reason.',
            'info',
          )
        : ''}

      <h3>What the feed promises</h3>
      <ul>${raw(changes.contract.map((line) => `<li>${escapeFeedText(line)}</li>`).join(''))}</ul>
    </section>
  `;
}

/** Text into an HTML-safe string, for the list items built as raw markup. */
function escapeFeedText(value) {
  return String(value).replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
}
