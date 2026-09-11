import { api } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { badge, date, html, humanise, money, notice, pct, positionReport, raw, render, table, toast } from '../lib/ui.js';
import { donutChart } from '../lib/charts.js';
import { insightPanel } from '../lib/insight.js';
import { blockedReason, can, draw, openProject, phaseGates, state } from '../app.js';

/**
 * Business development — the pipeline, and the discipline of refusing work.
 *
 * The scoring half of this screen is ordinary: ten weighted factors, a number,
 * a band. The half that matters is underneath it.
 *
 * A bid/no-bid algorithm nobody declines against is a form. So the no-bid rate
 * is the headline figure rather than a footnote, every override is named with
 * who took it and how it turned out, and the bands are reported against actual
 * outcomes — because weights that do not predict are a slower way of having the
 * same opinion, and the only way to find that out is to look.
 */

const BAND_TONE = { BID: 'ok', DIRECTOR_REVIEW: 'warn', NO_BID: 'bad' };
const BAND_LABEL = { BID: 'BID', DIRECTOR_REVIEW: 'Director review', NO_BID: 'NO BID' };

const STAGE_TONE = {
  IDENTIFIED: '',
  QUALIFIED: 'info',
  BID: 'ok',
  NO_BID: 'bad',
  CONVERTED: 'ok',
  LOST: 'warn',
};

/**
 * The whole IANA list, from the runtime rather than from a hand-kept copy.
 *
 * A short curated list of "common" zones is the obvious shortcut and it is
 * wrong the first time somebody bids in a country nobody thought of. The
 * browser already holds the current database; the server validates the same
 * way. Sorted with the zones a UK contractor reads most often at the top,
 * because ordering is an affordance and does not narrow what is accepted.
 */
const NEAR_THE_TOP = ['Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin', 'UTC'];

function timeZoneOptions() {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const rest = all.filter((zone) => !NEAR_THE_TOP.includes(zone));
  return [...NEAR_THE_TOP, ...rest].map((zone) => ({ value: zone, label: zone.replace(/_/g, ' ') }));
}

const SEVERITY_TONE = { CRITICAL: 'bad', MAJOR: 'warn', MINOR: '' };

/**
 * The compliance matrix, read back.
 *
 * Producing the analysis wrote it to the ledger and put it in a response body,
 * and that was the only time anybody saw it. The matrix that says which
 * mandatory requirement has nothing behind it is the thing a bid manager opens
 * on the Monday, so it is a screen rather than a return value — and rerunning
 * the analysis to see it again would spend ACUs re-deriving a record the
 * platform already holds.
 */
const TERM_TONE = { BAR: 'bad', SEVERE: 'bad', MATERIAL: 'warn', ROUTINE: '' };
const MATRIX_TONE = { SATISFIED: 'ok', GAP: 'bad', UNKNOWN: 'warn' };
// Expired is worse than pending, not merely different: a pending claim is
// waiting for somebody, and an expired one has been relied on since it stopped
// being true.
const CLAIM_TONE = { APPROVED: 'ok', PENDING: 'warn', EXPIRED: 'bad', REJECTED: 'bad' };

/**
 * A status is not a verdict.
 *
 * `UNKNOWN` means the platform holds no probe for this requirement, which is
 * different from holding a probe that found nothing. Collapsing the two would
 * bury the real gaps under everything nobody automated, so the distinction is
 * carried through to the screen rather than flattened into a tick or a cross.
 */
const MATRIX_MEANING = {
  SATISFIED: 'Evidenced from the company record',
  GAP: 'Nothing on file satisfies this',
  UNKNOWN: 'Not something the platform can check — somebody must',
};

/**
 * The AI reading of an invitation, which had an engine and no door.
 *
 * `ITT_REQUIREMENTS` was built end to end on the platform side — the prompt
 * that tells the model to quote rather than summarise, the response schema, a
 * route, a confirm branch that runs `analyseITT` and `extractRequirements`, and
 * tests over all of it. No page in the console called it. It was reachable only
 * through the generated command catalogue, whose form asks for an evidence
 * hash in a text box, which is not a door a bid manager can open.
 *
 * So the whole of "an ITT arrived, read it" was present in the platform and
 * absent from the product. This is the door.
 *
 * **A reading is a draft, and stays one.** Confirming runs the same commands a
 * person typing the requirements in by hand would reach — same authorisation,
 * same ACU cost, same events. Rejecting keeps the reading in the record with
 * the reason. Neither is a shortcut around the analyst.
 */
/** The formats the multimodal reader can be shown. A model that can see needs a picture. */
const LOOKABLE = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

/**
 * Every held file, and which road reads it as an invitation.
 *
 * An ITT arrives in whatever the buyer's portal produces — Word, a spreadsheet,
 * a CSV of return deliverables, a PDF, a scan. Two roads read it, and which one
 * applies is a fact about the file rather than a preference:
 *
 * - `TEXT` — ingestion got the words out of the bytes. Read on a reasoning
 *   provider, which most deployments have and which costs less than vision.
 * - `LOOK` — a scan, or a PDF with no text layer. Only a model that can see.
 * - `UNREAD` — the bytes are here and nothing has looked at them yet. Ingestion
 *   is free, deterministic and says what the file actually is, so it goes first
 *   rather than sending a possibly-renamed executable to a paid model.
 * - `QUARANTINED` / `UNREADABLE` — no button, and the platform's own reason.
 *
 * The decision is made from what the API published about each file. Nothing
 * here duplicates a rule: `LOOKABLE` is the perception pipeline's own input
 * list, and every other branch reads the ingestion record's verdict.
 */
function heldTenderFiles(evidence, ingestion) {
  const ingested = new Map((ingestion?.files ?? []).map((file) => [file.hash, file]));

  return (evidence?.entries ?? [])
    .filter((entry) => entry.held)
    .map((entry) => {
      const file = ingested.get(entry.hash);
      if (!file) return { entry, road: 'UNREAD', says: 'held, not yet looked at' };
      if (file.status === 'QUARANTINED') {
        return { entry, file, road: 'QUARANTINED', says: 'quarantined — nothing downstream reads it' };
      }
      if (file.extraction?.text) {
        return {
          entry,
          file,
          road: 'TEXT',
          says: `${humanise(String(file.kind ?? 'document')).toLowerCase()}, text read from the file itself`,
        };
      }
      if (LOOKABLE.includes(entry.contentType ?? '')) {
        return { entry, file, road: 'LOOK', says: file.extraction?.reason ?? 'no text layer — a model has to look at it' };
      }
      return { entry, file, road: 'UNREADABLE', says: file.extraction?.reason ?? 'nothing here reads this format' };
    });
}

function ittReadingPanel({ perception, evidence, ingestion, projectId, projectName, blocked, tenderProjects, invitationOptions }) {
  // Three separate reasons this cannot run, and they need different sentences.
  // Collapsing them into one "unavailable" is how somebody spends an afternoon
  // fixing the wrong thing.
  if (!projectId) {
    return html`<div class="card" style="margin-bottom:14px">
      <h2>Read an invitation with AI</h2>
      <p class="metric-sub">
        A reading is filed against a project, and no project is open. Open the one this tender is being bid from and
        the reader appears here.
      </p>
    </div>`;
  }

  const available = perception?.capability?.available === true;
  const published = new Map((perception?.capability?.tasks ?? []).map((entry) => [entry.task, entry]));
  const ittTask = published.get('ITT_REQUIREMENTS');
  const drafts = (perception?.drafts ?? []).filter((d) => d.task === 'ITT_REQUIREMENTS' && d.status === 'DRAFT');
  const readable = heldTenderFiles(evidence, ingestion);

  return html`
    <div class="card pad0" style="margin-bottom:14px">
      <div style="padding:15px 17px 0">
        <h2>Read an invitation with AI</h2>
        <p class="metric-sub" style="margin-bottom:12px">
          The invitation as the buyer sent it — a Word instruction document, a spreadsheet of return deliverables, a
          CSV out of a portal, a PDF, a scan — read into a compliance matrix, a return register and a commercial
          assessment. Where the words are in the bytes the platform reads them itself and the model reasons over the
          text; where they are a picture of a page, a model that can see is needed. Either way it is told to quote the
          document rather than summarise it, to omit anything it does not state rather than infer it, and to list what
          it left out and why. Nothing it reads reaches the record on its own: a reading is a draft until somebody
          confirms it, and confirming runs the same commands as typing it in by hand. Filed against
          <b>${projectName || projectId}</b>.
        </p>

        ${
          !blocked
            ? html`<div class="actions" style="margin-bottom:12px">
                <button class="btn" data-upload-tender>Upload a tender document</button>
                <button class="btn quiet" data-paste-tender>Paste the invitation instead</button>
              </div>`
            : ''
        }

        ${
          blocked
            ? html`<div class="notice warn" style="margin-bottom:12px">
                <div>
                  <b>Not here.</b> ${blocked}
                  ${
                    tenderProjects.length > 0
                      ? html`<div style="margin-top:6px">
                          Open a project the platform will accept a tender analysis on:
                          ${tenderProjects.map(
                            (p) => html`<button class="btn quiet sm" data-open-project="${p.id}" style="margin:3px 4px 0 0">${p.name}</button>`,
                          )}
                        </div>`
                      : html`<div style="margin-top:6px">
                          No project in this tenancy is at a phase where a tender may be analysed.
                        </div>`
                  }
                </div>
              </div>`
            : ''
        }

        ${
          !blocked && !available
            ? html`<div class="notice warn" style="margin-bottom:12px">
                <div>
                  <b>Not available on this deployment.</b><br />${perception?.capability?.reason ?? ''}
                  An invitation is not read here at all, rather than read badly and filed as fact — a fabricated
                  requirement is a bid disqualified.
                </div>
              </div>`
            : ''
        }

        ${
          !blocked && available && ittTask && ittTask.available === false
            ? html`<div class="notice warn" style="margin-bottom:12px">
                <div><b>The reader is off for invitations on this deployment.</b><br />${ittTask.reason ?? ''}</div>
              </div>`
            : ''
        }
      </div>

      ${
        !blocked && available
          ? table({
              headers: ['The document', 'Type', 'What the platform has read', 'Held since', ''],
              rows: readable.slice(0, 20).map(({ entry, file, road, says }) => [
                entry.description,
                html`<span style="font-size:11.5px;color:var(--text-3)">${entry.contentType}</span>`,
                html`<span style="font-size:12px;color:var(--text-3)">${says}</span>`,
                entry.recordedAt ? date(entry.recordedAt) : '—',
                road === 'TEXT'
                  ? html`<button class="btn sm" data-read-itt-text="${file.ingestionId}">Read this invitation</button>`
                  : road === 'LOOK'
                    ? html`<button class="btn sm" data-read-itt="${entry.hash}">Read it with a model that can see</button>`
                    : road === 'UNREAD'
                      ? html`<button class="btn quiet sm" data-ingest-tender="${entry.hash}" data-name="${entry.description}">
                          Look at the file first
                        </button>`
                      : '',
              ]),
              empty: evidence?.storeConfigured
                ? 'No tender document is held against this project yet. Upload one above and it appears here — a hash on its own cannot be read.'
                : 'This deployment holds no evidence files, so there is nothing to read. Paste the invitation instead.',
            })
          : ''
      }

      ${
        drafts.length > 0
          ? html`<div style="padding:0 17px 15px">
              <h2 style="margin-top:14px">What the AI read, awaiting a person</h2>
              <p class="metric-sub" style="margin-bottom:10px">
                Check it against the document before confirming. Confirming produces the compliance matrix and the
                return register; rejecting keeps the reading and your reason in the record, because a reading that was
                wrong is evidence about the reader.
              </p>
              ${drafts.map((draft) => {
                const read = draft.extraction ?? {};
                const requirements = read.requirements ?? [];
                const deliverables = read.deliverables ?? [];
                const omitted = read.omitted ?? read.omissions ?? [];
                return html`<div class="card" style="margin-bottom:10px">
                  <div class="split-list">
                    <div class="row">
                      <span class="lbl">Reference it read</span>
                      <span class="val">${read.reference ?? html`<i style="color:var(--text-3)">not stated in the document</i>`}</span>
                    </div>
                    <div class="row">
                      <span class="lbl">Client</span>
                      <span class="val">${read.clientName ?? html`<i style="color:var(--text-3)">not stated</i>`}</span>
                    </div>
                    <div class="row">
                      <span class="lbl">Returns by</span>
                      <span class="val">${read.returnBy ?? html`<i style="color:var(--text-3)">not stated</i>`}</span>
                    </div>
                    <div class="row">
                      <span class="lbl">Found</span>
                      <span class="val">${requirements.length} requirement(s), ${deliverables.length} deliverable(s)</span>
                    </div>
                    <div class="row">
                      <span class="lbl">Confidence</span>
                      <span class="val">
                        ${draft.confidence === undefined || draft.confidence === null ? '—' : pct(draft.confidence * 100)}
                        ${draft.model ? badge(draft.model, '') : ''}
                      </span>
                    </div>
                    ${
                      Array.isArray(omitted) && omitted.length > 0
                        ? html`<div class="row">
                            <span class="lbl">It says it left out</span>
                            <span class="val" style="font-size:12px;color:var(--text-3)">${omitted.map(String).join('; ')}</span>
                          </div>`
                        : ''
                    }
                  </div>
                  ${
                    requirements.length > 0
                      ? table({
                          headers: ['Ref', 'Category', 'Requirement', 'Mandatory', 'Weight', 'Evidence demanded'],
                          align: ['', '', '', '', 'num', ''],
                          rows: requirements.slice(0, 40).map((r) => [
                            r.reference ?? '—',
                            html`<span style="font-size:12px;color:var(--text-3)">${humanise(String(r.category ?? ''))}</span>`,
                            r.requirement ?? '',
                            r.mandatory === true ? badge('pass/fail', 'warn') : 'scored',
                            r.weightingPercent === undefined || r.weightingPercent === null ? '—' : `${r.weightingPercent}%`,
                            html`<span style="font-size:12px;color:var(--text-3)">${r.evidenceRequired ?? ''}</span>`,
                          ]),
                        })
                      : ''
                  }
                  <div class="actions" style="margin-top:11px">
                    <button class="btn" data-confirm-itt="${draft.id}"
                      ${raw(invitationOptions.length === 0 ? 'disabled title="Record the invitation first — a reading is filed against one"' : '')}>
                      Confirm and build the matrix
                    </button>
                    <button class="btn quiet" data-reject-itt="${draft.id}">Reject this reading</button>
                  </div>
                </div>`;
              })}
            </div>`
          : ''
      }
    </div>
  `;
}

function matrixDetail(analysis, waivers, addenda) {
  const gapRefs = new Set(analysis.mandatoryGaps.map((line) => line.reference));
  // A waiver is read live, so a line waived after the matrix was analysed reads
  // as waived here without the analysis being rerun.
  const waivedBy = new Map((waivers?.live ?? []).map((waiver) => [waiver.reference, waiver]));

  return html`
    <div class="card pad0">
      <h2 style="padding:15px 17px 0">
        ${analysis.reference} · ${analysis.clientName}
        ${analysis.readyToPrice ? badge('ready to price', 'ok') : badge('not ready to price', 'bad')}
      </h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        Returns ${date(analysis.returnBy)}. Analysed ${date(analysis.analysedAt)} against
        ${money(analysis.estimatedValueMinor)} over ${analysis.durationWeeks} weeks — every exposure below is computed
        against those two figures, so a matrix read months later still shows what it was judged on.
      </p>

      <div class="grid g4" style="padding:13px 17px 0">
        <div class="card">
          <h2>Requirements</h2>
          <div class="metric">${analysis.matrix.length}</div>
          <div class="metric-sub">${analysis.matrix.filter((l) => l.mandatory).length} pass/fail, the rest scored.</div>
        </div>
        <div class="card">
          <h2>Mandatory gaps</h2>
          <div class="metric ${raw(analysis.mandatoryGaps.length === 0 ? 'good' : 'bad')}">${analysis.mandatoryGaps.length}</div>
          <div class="metric-sub">Requirements that end the bid if they are still open on the day.</div>
        </div>
        <div class="card">
          <h2>Quantified exposure</h2>
          <div class="metric orange">${money(analysis.quantifiedExposureMinor)}</div>
          <div class="metric-sub">
            Money at risk: damages and retention. Bonding is shown per term as facility committed rather than loss, so
            the column below can total more than this.
          </div>
        </div>
        <div class="card">
          <h2>To ask the buyer</h2>
          <div class="metric ${raw(analysis.clarifications.length === 0 ? 'good' : 'warn')}">${analysis.clarifications.length}</div>
          <div class="metric-sub">Questions that have to go before the clarification deadline, not after.</div>
        </div>
      </div>

      ${
        analysis.bars.length > 0
          ? html`<div class="notice bad" style="margin:13px 17px 0">
              <div>
                <b>This invitation carries a bar, not a negotiation.</b>
                ${analysis.bars.map((bar) => html`<div style="margin-top:4px">${bar}</div>`)}
              </div>
            </div>`
          : ''
      }

      <h2 style="padding:15px 17px 0">Commercial terms, assessed against this business</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        Not transcribed. Each term is judged against the company's own margin, cover and balance sheet — which is why
        the same clause is routine on one tender and severe on another.
      </p>
      ${table({
        headers: ['Term', 'As stated', 'Severity', 'Exposure', 'What it means here'],
        align: ['', '', '', 'num', ''],
        rows: analysis.terms.map((t) => [
          t.term,
          t.stated,
          badge(humanise(t.severity), TERM_TONE[t.severity] ?? ''),
          t.exposureMinor === undefined ? '—' : money(t.exposureMinor),
          html`<span style="font-size:12px;color:var(--text-3)">${t.assessment}</span>`,
        ]),
        empty: 'No commercial term was recorded on this invitation',
      })}

      <h2 style="padding:15px 17px 0">Every requirement, with an owner</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        A matrix without an owner is a list, and a list is what reaches the day before return with three items nobody
        claimed. Bids are lost over one missing certificate on a price that was right.
      </p>
      ${table({
        headers: ['Ref', 'Category', 'Requirement', 'Owner', 'Evidence required', 'On file', 'Weight', 'Due', 'Status'],
        align: ['', '', '', '', '', '', 'num', '', ''],
        rows: analysis.matrix.map((line) => [
          html`${line.reference}${line.mandatory ? badge('mandatory', gapRefs.has(line.reference) ? 'bad' : '') : ''}`,
          html`<span style="font-size:12px;color:var(--text-3)">${humanise(line.category)}</span>`,
          line.requirement,
          humanise(line.owner),
          html`<span style="font-size:12px;color:var(--text-3)">${line.evidenceRequired}</span>`,
          line.evidenceHeld
            ? html`<span style="font-size:12px;color:var(--text-3)">${line.evidenceHeld}</span>`
            : '—',
          line.weightingPercent === undefined ? '—' : `${line.weightingPercent}%`,
          line.dueBy ? date(line.dueBy) : '—',
          waivedBy.has(line.reference)
            ? html`${badge('waived', 'warn')}<br><span style="font-size:11px;color:var(--text-3)">Not answered on purpose, to ${date(waivedBy.get(line.reference).expiresOn)}</span>`
            : html`${badge(humanise(line.status), MATRIX_TONE[line.status] ?? '')}<br><span style="font-size:11px;color:var(--text-3)">${MATRIX_MEANING[line.status] ?? ''}</span>`,
        ]),
        empty: 'This analysis carries no requirements',
      })}

      ${
        (addenda?.impacts ?? []).length > 0
          ? html`<h2 style="padding:15px 17px 0">What the addenda changed</h2>
              <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                ${addenda.summary} Only the requirements that actually moved are marked — a response written against one
                that did not change stays good, which is why this is not a re-analysis. A reworded mandatory question is
                the case a response answers perfectly and scores nothing, because it answers the old one.
              </p>
              <div style="padding:11px 17px 0">
                ${commandBar([
                  { id: 'assess-addendum', label: 'Assess an addendum',
                    permitted: can('ESTIMATE_TENDER', 'U'), reason: blockedReason('ESTIMATE_TENDER', 'U') },
                  { id: 'review-impact', label: 'Record what was done', tone: 'quiet',
                    permitted: can('ESTIMATE_TENDER', 'U'), reason: blockedReason('ESTIMATE_TENDER', 'U') },
                ])}
              </div>
              ${table({
                headers: ['Addendum', 'Ref', 'What moved', 'Detail', 'Weight', 'State'],
                rows: addenda.impacts.map((impact) => [
                  impact.addendum,
                  impact.reference,
                  badge(humanise(impact.kind), impact.material ? 'bad' : 'warn'),
                  html`<span style="font-size:12px;color:var(--text-3)">${impact.detail}</span>`,
                  impact.material ? badge('material', 'bad') : badge('minor', ''),
                  impact.status === 'REVIEWED'
                    ? html`${badge('reviewed', 'ok')}<br><span style="font-size:11px;color:var(--text-3)">${impact.reviewNote ?? ''}</span>`
                    : badge('nobody has looked', 'bad'),
                ]),
                empty: 'No addendum has been assessed against this matrix.',
              })}`
          : html`<h2 style="padding:15px 17px 0">Addenda</h2>
              <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                Nothing has been assessed against this matrix. An addendum is compared line by line against what was read
                on the day, so only the requirements that actually moved are marked stale.
              </p>
              <div style="padding:11px 17px 15px">
                ${commandBar([
                  { id: 'assess-addendum', label: 'Assess an addendum',
                    permitted: can('ESTIMATE_TENDER', 'U'), reason: blockedReason('ESTIMATE_TENDER', 'U') },
                ])}
              </div>`
      }

      <h2 style="padding:15px 17px 0">Requirements nobody is answering, on purpose</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        ${waivers?.summary ?? 'Waivers could not be read.'} A requirement not answered because somebody decided so and one
        not answered because nobody got to it look identical on every list. This is the difference, and it carries a name,
        a reason and a date it stops.
      </p>
      <div style="padding:11px 17px 0">
        ${commandBar([
          { id: 'waive-requirement', label: 'Waive a requirement',
            permitted: can('ESTIMATE_TENDER', 'A'), reason: blockedReason('ESTIMATE_TENDER', 'A') },
          { id: 'revoke-waiver', label: 'Take a waiver back', tone: 'quiet',
            permitted: can('ESTIMATE_TENDER', 'A'), reason: blockedReason('ESTIMATE_TENDER', 'A') },
        ])}
      </div>
      ${table({
        headers: ['Ref', 'Requirement', 'Mandatory', 'Reason', 'Holds until', 'Granted', 'State'],
        rows: [...(waivers?.live ?? []), ...(waivers?.past ?? [])].map((waiver) => [
          waiver.reference,
          waiver.requirement,
          waiver.mandatory ? badge('mandatory', 'bad') : '—',
          html`<span style="font-size:12px;color:var(--text-3)">${waiver.reason}</span>`,
          date(waiver.expiresOn),
          date(waiver.grantedAt),
          waiver.revokedAt
            ? html`${badge('revoked', 'neutral')}<br><span style="font-size:11px;color:var(--text-3)">${waiver.revokedReason ?? ''}</span>`
            : waiver.expiresOn >= new Date().toISOString().slice(0, 10)
              ? badge('in force', 'warn')
              : badge('expired', 'neutral'),
        ]),
        empty: 'Nothing waived. Every requirement on this matrix is being answered.',
      })}

      <div class="grid g2" style="padding:13px 17px 15px">
        <div>
          <h2 style="margin-bottom:6px">The buyer's marking scheme</h2>
          <p style="font-size:12.5px;color:var(--text-3);margin:0 0 8px">
            ${
              analysis.weightings.stated === 0
                ? 'The invitation stated no weightings. Ask for the breakdown before pricing — an evaluation nobody can see is one nobody can bid to.'
                : analysis.weightings.complete
                  ? 'The stated weightings total 100%. The full breakdown is published.'
                  : `The stated weightings total ${analysis.weightings.stated}%, not 100%. Part of how this is being marked has not been disclosed.`
            }
          </p>
          <div class="split-list">
            ${analysis.weightings.declared.map(
              (w) => html`<div class="row"><span class="lbl">${humanise(w.category)}</span><span class="val">${w.percent}%</span></div>`,
            )}
            <div class="row">
              <span class="lbl"><b>Stated total</b></span>
              <span class="val">${badge(`${analysis.weightings.stated}%`, analysis.weightings.complete ? 'ok' : 'warn')}</span>
            </div>
          </div>
        </div>
        <div>
          <h2 style="margin-bottom:6px">Questions for the buyer</h2>
          <p style="font-size:12.5px;color:var(--text-3);margin:0 0 8px">
            Raised by the analysis rather than typed by somebody. These go through the clarification process and are
            answered to every bidder, so asking late is asking the competition's question for them.
          </p>
          ${
            analysis.clarifications.length === 0
              ? html`<div class="empty"><b>Nothing to ask</b>The invitation is internally consistent and insurable as written.</div>`
              : html`<div class="split-list">
                  ${analysis.clarifications.map((c) => html`<div class="row"><span class="lbl">${c}</span></div>`)}
                </div>`
          }
        </div>
      </div>
    </div>
  `;
}

/** Every command on this screen runs before a project exists. */
const TENANT = { tenantScoped: true };

export async function pipeline(root) {
  const [criteria, summary, discipline, profile, radar, tenders, permissions, matrices, claimRegister] = await Promise.all([
    api.get('/v1/pipeline/criteria'),
    api.get('/v1/pipeline'),
    api.get('/v1/pipeline/discipline'),
    // The company's own verified facts — everything the radar is allowed to
    // assert on a bid. Held here rather than on a settings page because this is
    // where somebody discovers the radar filtered them out of a job.
    api.get('/v1/company/profile').catch((error) => ({ error })),
    api.get('/v1/radar/latest').catch(() => ({ run: null })),
    api.get('/v1/pipeline/tenders'),
    api.get('/v1/permissions/matrix'),
    // Every matrix the tenancy holds, not only one produced in this session.
    api.get('/v1/pipeline/analyses'),
    // The company's verified claims. Tenant-scoped, because a certificate is a
    // company fact rather than a project one — the same insurance schedule
    // evidences a claim on every bid the business makes.
    api.read('/v1/evidence/claims', 'ESTIMATE_TENDER', 'COMMERCIAL_L3').catch((error) => ({ error })),
  ]);

  // The reader is project-scoped: a reading is filed against the project the
  // tender is bid from, and it costs ACUs against that project's tenancy.
  const projectId = state.session?.projectId;
  const [perception, evidence, ingestion, bidPacks] = projectId
    ? await Promise.all([
        api.get(`/v1/projects/${projectId}/perception`).catch(() => null),
        api.get(`/v1/projects/${projectId}/evidence`).catch(() => null),
        // What has been read out of each held file. It decides which road reads
        // an invitation, and a screen that guessed instead would offer a
        // vision model a Word document it cannot see.
        api.get(`/v1/projects/${projectId}/ingestion`).catch(() => null),
        // The submissions being written against the matrices above. Project
        // scoped for the same reason the reader is: writing a section spends
        // this project's tenancy's ACUs, and the cost is quoted from a project.
        api.read(`/v1/projects/${projectId}/bid-responses`, 'ESTIMATE_TENDER', 'COMMERCIAL_L3').catch((error) => ({ error })),
      ])
    : [null, null, null, null];

  // Why the reader cannot run here, in the platform's own words rather than a
  // rule copied into the browser: `blockedReason` reads the published
  // permission matrix and the published phase gates. Not tenant-scoped —
  // unlike the commands on this screen, an analysis is written to a project and
  // is gated by that project's lifecycle phase.
  const readBlocked = blockedReason('ESTIMATE_TENDER', 'C');
  const tenderPhases = phaseGates().ESTIMATE_TENDER ?? [];
  const tenderProjects = (state.projects ?? []).filter(
    (p) => tenderPhases.includes(p.phase) && p.id !== projectId,
  );

  const run = radar?.run ?? null;
  const board = tenders.tenders ?? [];
  // The role list comes from the published matrix rather than a second copy in
  // the browser: an owner on a deliverable has to be a role the platform knows.
  const roleOptions = Object.keys(permissions.matrix ?? {}).sort().map((role) => ({ value: role, label: humanise(role) }));
  const invitationOptions = board.map((t) => ({ value: t.invitationId, label: `${t.reference} · ${t.title}` }));
  const biddableOptions = board
    .filter((t) => t.stage === 'BID')
    .map((t) => ({ value: t.invitationId, label: `${t.reference} · closes ${t.deadline.local}` }));

  const thresholds = criteria.thresholds;
  const opportunities = summary.opportunities ?? [];

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Pipeline &amp; Bid Decisions</h1>
          <p>
            Ten weighted factors, one score, and a published rule. The platform recommends; a person decides. What it
            will not do is let an override pass unremarked.
          </p>
        </div>
        <div class="actions cmd-bar">
          ${raw(
            commandBar([
              // Tenant-scoped: the bid pipeline exists before there is a
              // project, so no project's lifecycle phase gates it. The API
              // runs these against the tenant governance scope.
              { id: 'invitation', label: 'Record an ITT', tone: '',
                permitted: can('ESTIMATE_TENDER', 'C', TENANT), reason: blockedReason('ESTIMATE_TENDER', 'C', TENANT) },
              { id: 'deliverable', label: 'Add a deliverable',
                permitted: can('ESTIMATE_TENDER', 'U', TENANT), reason: blockedReason('ESTIMATE_TENDER', 'U', TENANT) },
              { id: 'addendum', label: 'Record an addendum',
                permitted: can('ESTIMATE_TENDER', 'U', TENANT), reason: blockedReason('ESTIMATE_TENDER', 'U', TENANT) },
              { id: 'programme', label: 'Build tender programme',
                permitted: can('ESTIMATE_TENDER', 'C', TENANT), reason: blockedReason('ESTIMATE_TENDER', 'C', TENANT) },
            ]),
          )}
        </div>
      </div>
      <!--
        The agents that watch this area, at the point somebody is looking at the
        number they are about. The machinery was built and reachable only from
        the autopilot queue — the screen a person opens once they have already
        decided to look at what the fleet found, which is exactly backwards.
      -->
      <div id="pipeline-insight" style="margin-bottom:14px"></div>

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Invitations in hand</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          ${tenders.summary} The deadline is recorded in the zone it is read in and resolved to one instant — a portal
          that closes at noon in Dublin has closed an hour before noon here.
        </p>
        ${table({
          headers: ['Reference', 'Client', 'Closes', 'Zone', 'Left', 'Deliverables', 'Addenda', 'Stage', 'Ready to bid', 'Matrix'],
          align: ['', '', '', '', 'num', 'num', 'num', '', '', ''],
          rows: board.map((t) => [
            html`${t.reference}<br><span style="font-size:11.5px;color:var(--text-3)">${t.title}</span>`,
            t.clientName,
            t.deadline.local.replace('T', ' '),
            html`<span style="font-size:11.5px;color:var(--text-3)">${t.deadline.timeZone}</span>${
              t.deadline.anomaly ? badge(humanise(t.deadline.anomaly), 'bad') : ''
            }`,
            html`<span style="${raw(t.businessDaysRemaining <= 10 ? 'color:var(--orange)' : '')}">${t.businessDaysRemaining}d</span>`,
            `${t.deliverables.mandatory}/${t.deliverables.total}`,
            t.addenda,
            badge(BAND_LABEL[t.stage] ?? humanise(t.stage), STAGE_TONE[t.stage] ?? ''),
            t.reReviewReasons.length > 0
              ? badge('re-review', 'warn')
              : t.blockers.length > 0
                ? badge(`${t.blockers.length} blocking`, 'bad')
                : badge('ready', 'ok'),
            // The route from the invitation to the analysis of it. Without
            // this the matrix is a record with nothing pointing at it from the
            // thing it describes.
            t.analysisId
              ? html`<button class="btn sm" data-matrix="${t.analysisId}">Open</button>`
              : html`<span style="font-size:11.5px;color:var(--text-3)">Not analysed</span>`,
          ]),
          empty: 'No invitation recorded',
        })}
        ${
          board.some((t) => t.blockers.length > 0 || t.reReviewReasons.length > 0 || t.clarifications.length > 0)
            ? html`<div class="split-list" style="padding:0 17px 15px">
                ${board.flatMap((t) => [
                  ...t.reReviewReasons.map(
                    (reason) => html`<div class="row"><span class="lbl">${t.reference} ${badge('re-review', 'warn')} ${reason}</span></div>`,
                  ),
                  ...t.blockers.map(
                    (blocker) => html`<div class="row"><span class="lbl">${t.reference} ${badge('blocks the bid', 'bad')} ${blocker}</span></div>`,
                  ),
                  ...t.clarifications.map(
                    (c) => html`<div class="row">
                      <span class="lbl">${t.reference} ${badge(humanise(c.severity), SEVERITY_TONE[c.severity] ?? '')} ${c.subject}</span>
                      <span class="val" style="font-size:12px;color:var(--text-3)">${c.question}</span>
                    </div>`,
                  ),
                ])}
              </div>`
            : ''
        }
      </div>

      ${ittReadingPanel({
        perception,
        evidence,
        ingestion,
        projectId,
        projectName: state.project?.name ?? '',
        blocked: readBlocked,
        tenderProjects,
        invitationOptions,
      })}

      <section class="card" style="margin-bottom:14px" aria-labelledby="pl-bid-h">
        <h2 id="pl-bid-h">Bid response packs</h2>
        <p class="metric-sub">
          The submission itself, written against a matrix above rather than beside it. One section per deliverable that
          needs prose, written one pass at a time — so the size of the tender decides how many passes run, never how
          much of the submission fits in one. A pass that dies leaves its section unwritten and the next pass writes
          exactly that one. It will not issue a pack that leaves a deliverable unanswered or a stated deadline undated:
          a submission missing a mandatory response is rejected, not marked down.
        </p>
        ${!projectId
          ? notice('Choose a project first. A pack is written against one, and writing a section spends that tenancy’s AI budget.', 'warn')
          : bidPacks?.error
            ? notice(bidPacks.error.detail ?? 'The bid response register could not be read.', 'bad')
            : html`
                <div class="actions cmd-bar" style="margin:10px 0">
                  ${raw(
                    commandBar([
                      { id: 'bid-plan', label: 'Plan a response pack', tone: '',
                        permitted: can('ESTIMATE_TENDER', 'C'), reason: blockedReason('ESTIMATE_TENDER', 'C') },
                      { id: 'bid-section', label: 'Write the next section',
                        permitted: can('ESTIMATE_TENDER', 'U'), reason: blockedReason('ESTIMATE_TENDER', 'U') },
                      { id: 'bid-issue', label: 'Issue the pack',
                        permitted: can('ESTIMATE_TENDER', 'A'), reason: blockedReason('ESTIMATE_TENDER', 'A') },
                    ]),
                  )}
                </div>
                <p class="metric-sub">${(bidPacks.summary ?? '')}</p>
                ${table({
                  headers: ['Pack', 'Client', 'Return by', 'Written', 'Outstanding', 'Passes', 'State'],
                  rows: (bidPacks.packs ?? []).map((pack) => [
                    pack.reference,
                    pack.clientName,
                    pack.returnBy ? date(pack.returnBy) : '—',
                    `${pack.completeness?.written ?? 0} of ${pack.completeness?.total ?? 0}`,
                    (pack.completeness?.unanswered ?? []).length === 0
                      ? badge('none', 'good')
                      : badge(`${pack.completeness.unanswered.length} deliverable(s)`, 'warn'),
                    String(pack.passes ?? 0),
                    pack.status === 'ISSUED'
                      ? badge('issued', 'good')
                      : pack.completeness?.ready
                        ? badge('ready to issue', 'good')
                        : badge('drafting', 'neutral'),
                  ]),
                  empty: 'No response pack yet. Plan one from a compliance matrix below.',
                })}
              `}
      </section>

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Compliance matrices on file</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          ${matrices.summary} Every analysis stays readable after the session that produced it — rerunning one to see it
          again would spend AI budget re-deriving a record the platform already holds, and would write a second analysis
          of the same invitation into the record.
        </p>
        ${table({
          headers: ['Reference', 'Client', 'Returns', 'Requirements', 'Mandatory gaps', 'Bars', 'To ask', 'Exposure', 'Worst term', 'Verdict', ''],
          align: ['', '', '', 'num', 'num', 'num', 'num', 'num', '', '', ''],
          rows: (matrices.analyses ?? []).map((a) => [
            a.reference,
            a.clientName,
            date(a.returnBy),
            a.requirements,
            html`<span style="${raw(a.mandatoryGaps > 0 ? 'color:var(--critical)' : '')}">${a.mandatoryGaps}</span>`,
            html`<span style="${raw(a.bars > 0 ? 'color:var(--critical)' : '')}">${a.bars}</span>`,
            a.clarifications,
            money(a.quantifiedExposureMinor),
            a.worstTerm ? badge(humanise(a.worstTerm), TERM_TONE[a.worstTerm] ?? '') : '—',
            a.readyToPrice ? badge('ready to price', 'ok') : badge('not ready', 'bad'),
            html`<button class="btn sm" data-matrix="${a.analysisId}">Open</button>`,
          ]),
          empty: 'No invitation has been analysed yet',
        })}
      </div>

      <!-- The topbar is 54px and sticky, so scrolling this into view without a
           margin puts the matrix's own heading underneath it. -->
      <div id="matrix-detail" style="margin-bottom:14px;scroll-margin-top:68px"></div>

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Claims the submission can make</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          ${claimRegister?.error ? 'The evidence registry could not be read.' : (claimRegister?.summary ?? '')}
          A submission is a stack of sentences somebody will score, and one that turns out to be untrue is not marked
          down — it is thrown out, with everything else in the submission spent for nothing. Each claim here names the
          document that proves it, who checked, and the day it stops being current. Whoever asserts a claim may not be
          the one who verifies it.
        </p>
        <div style="padding:11px 17px 0">
          ${commandBar([
            { id: 'assert-claim', label: 'Assert a claim',
              permitted: can('ESTIMATE_TENDER', 'C'), reason: blockedReason('ESTIMATE_TENDER', 'C') },
            { id: 'verify-claim', label: 'Verify a claim',
              permitted: can('ESTIMATE_TENDER', 'A'), reason: blockedReason('ESTIMATE_TENDER', 'A') },
            { id: 'reject-claim', label: 'Refuse a claim', tone: 'quiet',
              permitted: can('ESTIMATE_TENDER', 'A'), reason: blockedReason('ESTIMATE_TENDER', 'A') },
          ])}
        </div>
        ${table({
          headers: ['Ref', 'Kind', 'Claim', 'Issued by', 'Expires', 'Checked by', 'Standing'],
          rows: (claimRegister?.claims ?? []).map((claim) => [
            claim.reference,
            humanise(claim.kind),
            claim.claim,
            claim.issuedBy ?? '—',
            claim.expiresAt ? date(claim.expiresAt) : html`<span style="font-size:12px;color:var(--text-3)">does not lapse</span>`,
            claim.verifiedBy ?? '—',
            badge(humanise(claim.standing), CLAIM_TONE[claim.standing] ?? ''),
          ]),
          empty: 'Nothing is registered. A claim in a submission with no evidence behind it is the one that loses the tender.',
        })}
        ${
          (claimRegister?.lapsingSoon ?? []).length > 0
            ? html`<div class="notice warn" style="margin:11px 17px 15px">
                <div>
                  <b>${claimRegister.lapsingSoon.length} claim(s) lapse soon.</b>
                  ${claimRegister.lapsingSoon.map(
                    (entry) => html`<div style="margin-top:4px">${entry.reference} — ${entry.claim} · ${entry.daysLeft} day(s) left</div>`,
                  )}
                </div>
              </div>`
            : ''
        }
      </div>

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Declined</h2>
          <div class="metric ${raw(discipline.noBid > 0 ? 'good' : 'warn')}">${pct(discipline.noBidRatePercent, 1)}</div>
          <div class="metric-sub">
            ${discipline.noBid} of ${discipline.decided} decided. Refusing bad work is the point of scoring it.
          </div>
        </div>
        <div class="card">
          <h2>Bid effort released</h2>
          <div class="metric">${money(discipline.declinedValueMinor)}</div>
          <div class="metric-sub">Value walked away from — pursuits the bid team did not spend a month on.</div>
        </div>
        <div class="card">
          <h2>Overrides</h2>
          <div class="metric ${raw(discipline.overrides.length === 0 ? 'good' : 'warn')}">${discipline.overrides.length}</div>
          <div class="metric-sub">Decisions taken against the algorithm. Permitted, recorded, never silent.</div>
        </div>
        <div class="card">
          <h2>Live pipeline</h2>
          <div class="metric orange">${money(summary.liveValueMinor)}</div>
          <div class="metric-sub">${money(summary.wonValueMinor)} converted to projects.</div>
        </div>
      </div>

      ${
        Object.keys(summary.byStage ?? {}).length > 0
          ? html`<div class="card" style="margin-bottom:14px">
              <h2>Every opportunity that reached a decision</h2>
              <p class="metric-sub" style="margin-bottom:10px">
                A split, not a funnel. Bid and no-bid are two outcomes of one decision rather than stages an
                opportunity passes through, and drawing them as a narrowing funnel would imply a sequence that
                does not exist.
              </p>
              ${donutChart({
                title: 'Bid decisions',
                data: Object.entries(summary.byStage).map(([stage, count]) => ({
                  label: humanise(stage),
                  value: count,
                })),
                footnote:
                  'A high no-bid share is not a failure. Declining work that does not fit is the discipline this ' +
                  'screen exists to hold; the observations below say whether it is being held.',
              })}
            </div>`
          : ''
      }

      ${
        discipline.observations.length > 0
          ? html`<div class="notice ${raw(discipline.noBid === 0 && discipline.decided > 0 ? 'warn' : 'info')}" style="margin-bottom:14px">
              <div>
                ${discipline.observations.map((o) => html`<div style="margin-bottom:4px">${o}</div>`)}
              </div>
            </div>`
          : ''
      }

      ${
        run
          ? html`
            <div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">
                Tender radar — ${run.ranOn}
                ${badge(`${run.shortlisted} of ${run.screened} worth reading`, run.shortlisted > 0 ? 'ok' : '')}
              </h2>
              <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                Screened against the company's own recorded facts. It never claims a capability that is not on file — an
                invented reference is what a bid gets disqualified for.
              </p>
              ${table({
                headers: ['Opportunity', 'Value', 'Region', 'Closes', 'Competition', 'Score', 'Verdict'],
                align: ['', 'num', '', 'num', '', 'num', ''],
                rows: (run.results ?? []).map((r) => [
                  html`${r.title}<br><span style="font-size:11.5px;color:var(--text-3)">${r.reference} · ${r.clientName}</span>`,
                  money(r.estimatedValueMinor),
                  r.region,
                  html`<span style="${raw(r.daysToDeadline <= 14 ? 'color:var(--orange)' : '')}">${r.daysToDeadline}d</span>`,
                  badge(humanise(r.competition), r.competition === 'LOW' ? 'ok' : r.competition === 'HIGH' ? 'bad' : ''),
                  r.qualification.score,
                  r.eligible
                    ? badge(BAND_LABEL[r.qualification.recommendation], BAND_TONE[r.qualification.recommendation])
                    : badge('INELIGIBLE', 'bad'),
                ]),
                empty: 'Nothing screened',
              })}
              <div class="split-list" style="padding:0 17px 15px">
                ${(run.observations ?? []).map((o) => html`<div class="row"><span class="lbl">${o}</span></div>`)}
              </div>
            </div>

            ${(run.results ?? [])
              .filter((r) => !r.eligible || r.mitigations.length > 0)
              .map(
                (r) => html`<div class="card" style="margin-bottom:14px">
                  <h2>${r.title} ${r.eligible ? '' : badge('ineligible', 'bad')}</h2>
                  <div class="split-list">
                    ${r.eligibilityFailures.map(
                      (f) => html`<div class="row"><span class="lbl">✗ ${f.requirement}</span><span class="val">${f.reason}</span></div>`,
                    )}
                    ${r.strengths.map((x) => html`<div class="row"><span class="lbl">+ ${x}</span></div>`)}
                    ${r.risks.map((x) => html`<div class="row"><span class="lbl">! ${x}</span></div>`)}
                    ${r.mitigations.map((x) => html`<div class="row"><span class="lbl">→ ${x}</span></div>`)}
                    <div class="row"><span class="lbl">Margin target</span><span class="val">${r.marginTargetPercent.min}–${r.marginTargetPercent.max}%</span></div>
                  </div>
                </div>`,
              )}
          `
          : ''
      }

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Do the bands predict?</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          If jobs above ${thresholds.bidAbove} do not convert better than jobs pushed through from the review band, the
          weights are wrong. An algorithm nobody checks against outcomes is an opinion with arithmetic on it.
        </p>
        ${table({
          headers: ['Band', 'Score', 'Decided', 'Bid', 'Declined', 'Won', 'Lost', 'Win rate'],
          align: ['', '', 'num', 'num', 'num', 'num', 'num', 'num'],
          rows: discipline.byBand.map((b) => [
            badge(BAND_LABEL[b.band], BAND_TONE[b.band]),
            b.range,
            b.decided,
            b.bid,
            b.noBid,
            b.converted,
            b.lost,
            b.winRatePercent === null ? '—' : pct(b.winRatePercent, 1),
          ]),
          empty: 'No decisions recorded',
        })}
      </div>

      ${
        discipline.overrides.length > 0
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">Decisions taken against the score</h2>
              <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                The tool advises and the business decides. This is the list a post-mortem asks for and nobody writes down
                at the time.
              </p>
              ${table({
                headers: ['Opportunity', 'Score', 'Recommended', 'Decided', 'Outcome', 'Rationale'],
                align: ['', 'num', '', '', '', ''],
                rows: discipline.overrides.map((o) => [
                  o.title,
                  o.score,
                  badge(BAND_LABEL[o.recommendation], BAND_TONE[o.recommendation]),
                  badge(BAND_LABEL[o.decision] ?? o.decision, o.decision === 'BID' ? 'warn' : ''),
                  o.outcome,
                  html`<span style="font-size:12px;color:var(--text-3)">${o.rationale}</span>`,
                ]),
              })}
            </div>`
          : ''
      }

      <div class="grid g2" style="margin-bottom:14px">
        <div class="card pad0">
          <h2 style="padding:15px 17px 0">The algorithm</h2>
          <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
            Five is always good for us — including on the two factors named as risks, where reading the heading the other
            way round inverts the result.
          </p>
          ${table({
            headers: ['Factor', 'Weight', '5 means', '1 means'],
            align: ['', 'num', '', ''],
            rows: criteria.criteria.map((c) => [
              c.label,
              c.weight,
              html`<span style="font-size:12px;color:var(--text-3)">${c.good}</span>`,
              html`<span style="font-size:12px;color:var(--text-3)">${c.bad}</span>`,
            ]),
          })}
          <div class="split-list" style="padding:0 17px 15px">
            <div class="row"><span class="lbl">Below ${thresholds.noBidBelow}</span><span class="val">${badge('NO BID', 'bad')}</span></div>
            <div class="row"><span class="lbl">${thresholds.noBidBelow} to ${thresholds.bidAbove}</span><span class="val">${badge('Director review', 'warn')}</span></div>
            <div class="row"><span class="lbl">Above ${thresholds.bidAbove}</span><span class="val">${badge('BID', 'ok')}</span></div>
            <div class="row"><span class="lbl">Any factor at 1/5</span><span class="val">${badge('Held for review', 'warn')}</span></div>
          </div>
        </div>

        <div class="card">
          <h2>Where we keep scoring badly</h2>
          <p style="font-size:12.5px;color:var(--text-3);margin-bottom:11px">
            Factors scoring 2 or below across the pipeline. A recurring weakness is a business problem, not a run of bad
            opportunities.
          </p>
          ${
            discipline.recurringConcerns.length === 0
              ? html`<div class="empty"><b>Nothing recurring</b>No factor is repeatedly scoring badly.</div>`
              : html`<div class="split-list">
                  ${discipline.recurringConcerns.map(
                    (c) => html`<div class="row"><span class="lbl">${c.factor}</span><span class="val">${c.count}</span></div>`,
                  )}
                </div>`
          }
        </div>
      </div>

      <div class="card pad0">
        <h2 style="padding:15px 17px 0">Opportunities</h2>
        ${table({
          headers: ['Opportunity', 'Client', 'Value', 'Score', 'Recommended', 'Stage', 'Due'],
          align: ['', '', 'num', 'num', '', '', ''],
          rows: opportunities.map((o) => {
            const q = o.qualification;
            return [
              o.title,
              o.clientName,
              money(o.estimatedValueMinor),
              q ? q.score : '—',
              q
                ? html`${badge(BAND_LABEL[q.recommendation], BAND_TONE[q.recommendation])}${
                    q.cappedBy ? badge('capped', 'warn') : ''
                  }`
                : '—',
              badge(BAND_LABEL[o.stage] ?? o.stage, STAGE_TONE[o.stage] ?? ''),
              o.submissionDueAt ? date(o.submissionDueAt) : '—',
            ];
          }),
          empty: 'No opportunities registered',
        })}
      </div>

      ${positionReport({
        title: 'What this company can claim',
        intent:
          'Turnover, insurances, accreditations, references and capacity. The radar may assert none of it unless it ' +
          'is here, which is why an opportunity is sometimes filtered out for a fact nobody has recorded yet.',
        data: profile,
        error: profile?.error,
        sections: [
          { key: 'accreditations', label: 'Accreditations', empty: 'No accreditation is recorded.' },
          { key: 'insurances', label: 'Insurances', empty: 'No insurance is recorded.' },
          { key: 'references', label: 'References', empty: 'No reference is recorded.' },
          { key: 'sectors', label: 'Sectors', empty: 'No sector is claimed.' },
          { key: 'regions', label: 'Regions', empty: 'No region is claimed.' },
          { key: 'selfDeliveredTrades', label: 'Self-delivered trades', empty: 'Nothing is self-delivered.' },
          { key: 'capacity', label: 'Capacity' },
        ],
      })}
    `,
  );

  const COMMANDS = {
    /*
     * The bid response pipeline: plan it, write it a section at a time, issue
     * it against a check that refuses an incomplete one.
     *
     * Three doors rather than one "generate the submission" button, because the
     * middle one is the whole design. A single button would have to produce the
     * entire pack in one call, which is where a token ceiling truncates a large
     * tender into something that looks finished at section forty-one.
     */
    'bid-plan': {
      title: 'Plan a response pack',
      intent:
        'Reads a compliance matrix already on file and plans one section per deliverable that needs prose. A ' +
        'requirement the platform can already evidence from its own records is a certificate to attach, not a method ' +
        'statement to write, and is left out of the drafting queue. The pack takes a BID-nnnn reference at this point ' +
        'so it can be quoted in a clarification before a word of it exists.',
      path: `/v1/projects/${projectId}/bid-responses`,
      submitLabel: 'Plan',
      fields: [
        { name: 'analysisId', label: 'Compliance matrix', type: 'select',
          options: (matrices.analyses ?? []).map((a) => ({ value: a.analysisId, label: `${a.reference} · ${a.clientName}` })) },
      ],
    },
    'bid-section': {
      title: 'Write the next section',
      intent:
        'One pass, one section. Press it until nothing remains — the size of the tender decides how many passes run, ' +
        'never how much of the submission fits into one. A pass that is cut off leaves its section unwritten, and the ' +
        'next press writes exactly that one, so there is no resume to get wrong. The cost of this pass is quoted ' +
        'before it runs.',
      path: (v) => `/v1/projects/${projectId}/bid-responses/${v.packId}/sections`,
      submitLabel: 'Write',
      ai: true,
      fields: [
        { name: 'packId', label: 'Pack', type: 'select',
          options: (bidPacks?.packs ?? [])
            .filter((pack) => pack.status !== 'ISSUED')
            .map((pack) => ({ value: pack.id, label: `${pack.reference} — ${pack.completeness?.written ?? 0} of ${pack.completeness?.total ?? 0} written` })) },
      ],
      transform: ({ packId: _packId }) => ({}),
    },
    'bid-issue': {
      title: 'Issue the pack',
      intent:
        'Refused unless every deliverable has a response and every stated deadline carries a date. A submission ' +
        'missing a mandatory response is not marked down, it is rejected, and everything else in it is spent for ' +
        'nothing — so this refuses rather than warns, and names every outstanding item at once.',
      path: (v) => `/v1/projects/${projectId}/bid-responses/${v.packId}/issue`,
      submitLabel: 'Issue',
      fields: [
        { name: 'packId', label: 'Pack', type: 'select',
          options: (bidPacks?.packs ?? [])
            .filter((pack) => pack.status !== 'ISSUED')
            .map((pack) => ({ value: pack.id, label: `${pack.reference} — ${pack.completeness?.summary ?? ''}` })) },
      ],
      transform: ({ packId: _packId }) => ({}),
    },
    invitation: {
      title: 'Record an invitation to tender',
      intent:
        'The deadline is registered before anybody reads the documents, because a countdown that starts when somebody ' +
        'gets round to it is not a countdown. The time zone is part of the deadline, not a detail — where the invitation ' +
        'did not state one, say so and the platform raises it as a question for the buyer.',
      path: (v) => `/v1/pipeline/opportunities/${v.opportunityId}/tenders`,
      submitLabel: 'Record',
      fields: [
        { name: 'opportunityId', label: 'Opportunity', type: 'select',
          options: opportunities.map((o) => ({ value: o.id, label: `${o.title} · ${o.clientName}` })) },
        { name: 'reference', label: 'The buyer’s reference', type: 'text', placeholder: 'ITT/2027/014' },
        { name: 'issuedAt', label: 'Issued', type: 'datetime-local',
          hint: 'When the invitation landed. Immutable — addenda append to it and never rewrite it.' },
        { name: 'returnLocal', label: 'Returns by (as the invitation states it)', type: 'datetime-local',
          hint: 'The wall-clock time printed in the ITT, not converted' },
        { name: 'timeZone', label: 'Read in', type: 'select', options: timeZoneOptions(), value: 'Europe/London' },
        { name: 'timeZoneStated', label: 'Did the invitation state the zone?', type: 'select',
          options: [{ value: 'true', label: 'Yes — it says so in the documents' }, { value: 'false', label: 'No — the zone above is our assumption' }],
          hint: 'An assumed deadline is a critical clarification, not a default' },
        { name: 'channel', label: 'Returned through', type: 'select',
          options: ['PORTAL', 'EMAIL', 'PHYSICAL', 'HAND_DELIVERY'].map((c) => ({ value: c, label: humanise(c) })) },
        { name: 'clarificationLocal', label: 'Last date for questions', type: 'datetime-local', required: false },
        { name: 'siteVisitLocal', label: 'Site visit', type: 'datetime-local', required: false },
      ],
      transform: (v) => ({
        reference: v.reference,
        issuedAt: new Date(v.issuedAt).toISOString(),
        returnLocal: v.returnLocal,
        timeZone: v.timeZone,
        timeZoneStated: v.timeZoneStated === 'true',
        channel: v.channel,
        ...(v.clarificationLocal ? { clarificationLocal: v.clarificationLocal } : {}),
        ...(v.siteVisitLocal ? { siteVisitLocal: v.siteVisitLocal } : {}),
      }),
    },

    deliverable: {
      title: 'Add a return deliverable',
      intent:
        'A mandatory deliverable needs a source in the invitation, an owner, and our own date — all three, before a bid ' +
        'can be approved. A bid disqualified for a missing certificate was priced correctly and lost anyway.',
      path: (v) => `/v1/pipeline/tenders/${v.invitationId}/deliverables`,
      submitLabel: 'Add',
      fields: [
        { name: 'invitationId', label: 'Invitation', type: 'select', options: invitationOptions },
        { name: 'reference', label: 'Reference', type: 'text', placeholder: 'D-01' },
        { name: 'title', label: 'What has to be returned', type: 'text', placeholder: 'Priced pricing schedule' },
        { name: 'mandatory', label: 'Pass / fail?', type: 'select',
          options: [{ value: 'true', label: 'Mandatory — failing it ends the bid' }, { value: 'false', label: 'Optional' }] },
        { name: 'owner', label: 'Owner', type: 'select', options: roleOptions, required: false,
          hint: 'Required on anything mandatory' },
        { name: 'internalDueBy', label: 'Our date', type: 'date', required: false,
          hint: 'Earlier than the buyer’s, and the one that actually binds' },
        { name: 'sourceDocument', label: 'Source document', type: 'text', required: false,
          placeholder: 'Instructions to Tenderers' },
        { name: 'sourceClause', label: 'Clause', type: 'text', required: false },
        { name: 'sourcePage', label: 'Page', type: 'number', required: false, min: 1 },
        { name: 'pageLimit', label: 'Page limit', type: 'number', required: false, min: 1 },
        { name: 'signatureRequired', label: 'Needs a signature?', type: 'select', required: false,
          options: [{ value: '', label: '—' }, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }],
          hint: 'A wet signature is a lead time, not a task' },
      ],
      transform: (v) => ({
        reference: v.reference,
        title: v.title,
        mandatory: v.mandatory === 'true',
        ...(v.owner ? { owner: v.owner } : {}),
        ...(v.internalDueBy ? { internalDueBy: v.internalDueBy } : {}),
        ...(v.pageLimit ? { pageLimit: Number(v.pageLimit) } : {}),
        ...(v.signatureRequired ? { signatureRequired: v.signatureRequired === 'true' } : {}),
        ...(v.sourceDocument
          ? {
              source: {
                document: v.sourceDocument,
                ...(v.sourceClause ? { clause: v.sourceClause } : {}),
                ...(v.sourcePage ? { page: Number(v.sourcePage) } : {}),
              },
            }
          : {}),
      }),
    },

    addendum: {
      title: 'Record an addendum',
      intent:
        'It appends. The original issue stays exactly as it was recorded, because "what was the deadline when we planned ' +
        'the bid" is what a late submission turns into a dispute about.',
      path: (v) => `/v1/pipeline/tenders/${v.invitationId}/addenda`,
      submitLabel: 'Record',
      fields: [
        { name: 'invitationId', label: 'Invitation', type: 'select', options: invitationOptions },
        { name: 'reference', label: 'Addendum reference', type: 'text', placeholder: 'ADD-01' },
        { name: 'issuedAt', label: 'Issued', type: 'datetime-local' },
        { name: 'summary', label: 'What it changed', type: 'textarea', rows: 3 },
        { name: 'returnLocal', label: 'Revised return time', type: 'datetime-local', required: false,
          hint: 'Leave blank where the addendum does not move the date. Moving it forces the bid decision to be taken again.' },
      ],
      transform: (v) => ({
        reference: v.reference,
        issuedAt: new Date(v.issuedAt).toISOString(),
        summary: v.summary,
        ...(v.returnLocal ? { returnLocal: v.returnLocal } : {}),
      }),
    },

    programme: {
      title: 'Build the tender programme',
      intent:
        'Back-planned from the return deadline across the working calendar, bank holidays included. Where the window ' +
        'cannot hold the eight stages, the platform refuses and shows the arithmetic rather than compressing them silently.',
      path: (v) => `/v1/pipeline/tenders/${v.invitationId}/programme`,
      submitLabel: 'Build',
      fields: [
        { name: 'invitationId', label: 'Invitation', type: 'select', options: biddableOptions,
          hint: biddableOptions.length === 0 ? 'Nothing has been decided as a bid yet' : 'Only invitations decided as a bid appear here' },
      ],
      transform: () => ({}),
    },
  };

  // Opening a matrix, from either the invitation it belongs to or the list of
  // every matrix on file. One handler, because both buttons are asking for the
  // same thing and a second path to it would be a second thing to keep right.
  // The AI reading of an invitation: read it, then confirm or reject what it
  // read. Written out per action rather than assembled from a variable, so each
  // path is a quotable route the door invariant can see.
  root.addEventListener('click', async (event) => {
    const uploadTender = event.target.closest('[data-upload-tender]');
    if (uploadTender) {
      const filed = await command({
        title: 'Upload a tender document',
        intent:
          'A tender pack arrives in whatever the buyer’s portal produces — Word, a spreadsheet, a CSV, a PDF, a ' +
          'scan. This files the document against the project so its bytes may be stored: it records that a file ' +
          'with this content arrived as part of this tender, and nothing more. What the document says is read ' +
          'afterwards, and a person confirms it.',
        path: `/v1/projects/${projectId}/tender/document`,
        submitLabel: 'File it',
        fields: [
          {
            name: 'hash',
            label: 'The document',
            type: 'file',
            // The file picker is not the place to argue about formats: the
            // platform takes the bytes whatever they are, says what it found,
            // and refuses to *read* what it cannot read — with the reason.
            voice: false,
            nameInto: 'filename',
            hint: 'Hashed in your browser. The hash goes on the record first; the file follows it.',
          },
        ],
      });
      if (!filed) return;
      toast(
        'Filed',
        `${filed.description}. The file is being stored — refresh in a moment and it can be looked at.`,
        'ok',
      );
      await draw();
      return;
    }

    const pasteTender = event.target.closest('[data-paste-tender]');
    if (pasteTender) {
      const read = await command({
        title: 'Paste the invitation',
        intent:
          'For the invitation that never arrives as a file: the body of an email, a portal page, a requirements ' +
          'schedule somebody copied out. The text is read exactly as a document would be, by the same model under ' +
          'the same instruction to quote rather than summarise, and it produces the same draft for the same person ' +
          'to confirm. What it does not have is a document behind it, so the reading names where it came from ' +
          'instead of a file hash — say where, because in three years that sentence is the only provenance there is.',
        path: `/v1/projects/${projectId}/tender/invitation-text`,
        submitLabel: 'Read it',
        aiCost: true,
        fields: [
          {
            name: 'label',
            label: 'Where this came from',
            type: 'text',
            required: false,
            placeholder: 'Email from the buyer, 4 September',
            hint: 'Left blank, the record says only that it was pasted.',
          },
          {
            name: 'text',
            label: 'The invitation',
            type: 'textarea',
            rows: 12,
            hint: 'The requirements as the buyer wrote them. A summary in your own words is a reading, not a document.',
          },
        ],
      });
      if (!read) return;
      toast('Read', 'The reading is below, awaiting a person. Nothing is on the record until it is confirmed.', 'ok');
      await draw();
      return;
    }

    const ingestTender = event.target.closest('[data-ingest-tender]');
    if (ingestTender) {
      // Free, deterministic and no model involved: what the bytes actually are,
      // whether their text can be read, and whether they are a renamed
      // executable. It runs before anything is sent to a provider, which is
      // both cheaper and the only order in which the quarantine is worth having.
      ingestTender.disabled = true;
      ingestTender.textContent = 'Looking…';
      try {
        const result = await api.post(`/v1/projects/${projectId}/ingestion`, {
          hash: ingestTender.dataset.ingestTender,
          filename: ingestTender.dataset.name,
        });
        toast(
          result.status === 'QUARANTINED' ? 'File quarantined' : 'File read',
          result.status === 'QUARANTINED'
            ? `${result.findings} finding(s). The bytes are kept; nothing downstream should use them.`
            : `Read as ${humanise(result.kind).toLowerCase()}.`,
          result.status === 'QUARANTINED' ? 'bad' : 'ok',
        );
        await draw();
      } catch (error) {
        toast('Not read', error.message, 'err');
        ingestTender.disabled = false;
        ingestTender.textContent = 'Look at the file first';
      }
      return;
    }

    const readText = event.target.closest('[data-read-itt-text]');
    if (readText) {
      readText.disabled = true;
      readText.textContent = 'Reading…';
      try {
        await api.post(`/v1/projects/${projectId}/ingestion/${readText.dataset.readIttText}/itt`, {});
        await draw();
      } catch (error) {
        toast('Not read', error.message, error.code === 'PERCEPTION_PROVIDER_UNAVAILABLE' ? 'warn' : 'err');
        readText.disabled = false;
        readText.textContent = 'Read this invitation';
      }
      return;
    }

    const readIt = event.target.closest('[data-read-itt]');
    if (readIt) {
      readIt.disabled = true;
      readIt.textContent = 'Reading…';
      try {
        await api.post(`/v1/projects/${projectId}/perception/itt`, { hash: readIt.dataset.readItt });
        await draw();
      } catch (error) {
        // A refusal here is usually a true statement about the file, the
        // deployment or the wallet, so it is shown as it was given.
        toast('Not read', error.message, error.code === 'PERCEPTION_PROVIDER_UNAVAILABLE' ? 'warn' : 'err');
        readIt.disabled = false;
        readIt.textContent = 'Read it with a model that can see';
      }
      return;
    }

    const confirmIt = event.target.closest('[data-confirm-itt]');
    if (confirmIt) {
      // Three figures the analyst needs and no invitation states, because none
      // of them is about the buyer: what this business expects to price, over
      // how long, and at what margin. Asked here rather than guessed, because
      // every exposure figure in the matrix is computed against them.
      const accepted = await command({
        title: 'Confirm what the AI read',
        intent:
          'Confirming files the reading through the same commands as typing the requirements in by hand — the ' +
          'analyst, its authorisation and its ACU cost are unchanged. The three figures below are not in the ' +
          'invitation: an ITT states what the buyer wants, not what this business expects to price it at, and ' +
          'every exposure in the matrix is set against them.',
        path: () => `/v1/projects/${projectId}/perception/${confirmIt.dataset.confirmItt}/confirm`,
        submitLabel: 'Confirm and build the matrix',
        fields: [
          {
            name: 'invitationId',
            label: 'Against which invitation',
            type: 'select',
            options: invitationOptions,
            hint: 'The reading is filed against the invitation it came from.',
          },
          {
            name: 'estimatedValue',
            label: 'What we expect to price (£)',
            type: 'number',
            step: '1',
            hint: 'The contract value this business is bidding, not the buyer’s published budget.',
          },
          { name: 'durationWeeks', label: 'Priced over (weeks)', type: 'number', step: '1' },
          {
            name: 'targetMarginPercent',
            label: 'Target margin (%)',
            type: 'number',
            step: '0.1',
            required: false,
            hint: 'Left blank, the company profile’s own minimum is used.',
          },
        ],
        transform: (v) => ({
          invitationId: v.invitationId,
          // Pounds in the form, minor units on the wire. Asking a bid manager
          // for pennies is how a value lands two orders of magnitude out.
          estimatedValueMinor: Math.round(Number(v.estimatedValue) * 100),
          durationWeeks: Number(v.durationWeeks),
          ...(v.targetMarginPercent ? { targetMarginPercent: Number(v.targetMarginPercent) } : {}),
        }),
      });
      if (accepted) {
        toast('Filed', 'The compliance matrix and the return register are on the record', 'ok');
        await draw();
      }
      return;
    }

    const rejectIt = event.target.closest('[data-reject-itt]');
    if (rejectIt) {
      const reason = window.prompt('Why is this reading wrong? It stays in the record either way.');
      if (!reason) return;
      try {
        await api.post(`/v1/projects/${projectId}/perception/${rejectIt.dataset.rejectItt}/discard`, { reason });
        await draw();
      } catch (error) {
        toast('Not rejected', error.message, 'err');
      }
      return;
    }

    // Switching to a project the platform will accept a tender analysis on,
    // through the console's own project switcher rather than a second one.
    const openProjectButton = event.target.closest('[data-open-project]');
    if (openProjectButton) {
      await openProject(openProjectButton.dataset.openProject);
      return;
    }
  });

  const detail = root.querySelector('#matrix-detail');
  root.addEventListener('click', async (event) => {
    const open = event.target.closest('[data-matrix]');
    if (!open || !detail) return;

    const analysisId = open.dataset.matrix;
    open.disabled = true;
    open.textContent = 'Opening…';
    try {
      const [analysis, waivers, addenda] = await Promise.all([
        api.get(`/v1/pipeline/analyses/${analysisId}`),
        // Read separately rather than folded into the analysis: a waiver is a
        // decision made after the invitation was read, and putting it inside the
        // analysis record would mean rewriting a committed analysis every time
        // somebody granted one.
        api.read(`/v1/pipeline/analyses/${analysisId}/waivers`, 'ESTIMATE_TENDER', 'COMMERCIAL_L3').catch(() => null),
        api.read(`/v1/pipeline/analyses/${analysisId}/addenda`, 'ESTIMATE_TENDER', 'COMMERCIAL_L3').catch(() => null),
      ]);
      render(detail, matrixDetail(analysis, waivers, addenda));
      detail.dataset.analysis = analysisId;
      detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      // Shown as a denial rather than as an empty panel. A matrix that failed
      // to load and a matrix with nothing in it must not look the same.
      render(detail, notice(`This compliance matrix could not be opened: ${error.message}`, 'err'));
    } finally {
      open.disabled = false;
      open.textContent = 'Open';
    }
  });

  void insightPanel(root.querySelector('#pipeline-insight'), {
    projectId,
    areas: ['BUSINESS_DEVELOPMENT', 'ESTIMATE_TENDER'],
    subject: 'the pipeline and what to bid',
    onChange: draw,
  });

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const spec = COMMANDS[button.dataset.command];
    if (!spec) return;
    if (await command(spec)) await draw();
  });

  const pendingClaims = (claimRegister?.claims ?? []).filter((claim) => claim.standing === 'PENDING');
  const EVIDENCE_COMMANDS = {
    'assert-claim': {
      title: 'Assert a claim',
      intent:
        'Name the sentence a submission will make and the document that proves it. Nothing here counts for anything until ' +
        'somebody else verifies it, and an expiry is what stops a certificate being relied on after it lapses.',
      path: '/v1/evidence/claims',
      submitLabel: 'Assert',
      fields: [
        { name: 'kind', label: 'Kind', type: 'select',
          options: ['CERTIFICATE', 'CASE_STUDY', 'KPI', 'CV', 'POLICY', 'ACCREDITATION', 'INSURANCE', 'FINANCIAL',
            'TEST_RESULT', 'REFERENCE', 'METHOD', 'CALCULATION'].map((kind) => ({ value: kind, label: humanise(kind) })) },
        { name: 'claim', label: 'The sentence this proves', type: 'textarea', rows: 2,
          hint: 'As it would appear in a submission — "We achieved 98% on-time delivery across 14 schemes in 2026".' },
        { name: 'sourceHash', label: 'Document hash', type: 'text',
          hint: 'The hash of the file already registered as evidence.' },
        { name: 'issuedBy', label: 'Issued by', type: 'text', required: false },
        { name: 'issuedAt', label: 'Issued on', type: 'date', required: false },
        { name: 'expiresAt', label: 'Current until', type: 'date', required: false,
          hint: 'Leave blank for something that does not lapse. A certificate always lapses.' },
      ],
      transform: (v) => Object.fromEntries(Object.entries(v).filter(([, value]) => String(value ?? '').trim())),
    },
    'verify-claim': {
      title: 'Verify a claim',
      intent:
        'Say the document proves the sentence, and how it was checked. Refused if you were the one who asserted it, and ' +
        'refused over a document that has already lapsed — an approved claim nobody can stand behind is worse than none.',
      path: (v) => `/v1/evidence/claims/${v.claimId}/verify`,
      submitLabel: 'Verify',
      fields: [
        { name: 'claimId', label: 'Claim', type: 'select',
          options: pendingClaims.map((claim) => ({ value: claim.id, label: `${claim.reference} — ${claim.claim.slice(0, 60)}` })) },
        { name: 'method', label: 'How it was checked', type: 'text',
          hint: '"Compared against the insurer\u2019s schedule" is a method. "Yes" is a signature on nothing.' },
      ],
      transform: ({ claimId, ...rest }) => rest,
    },
    'reject-claim': {
      title: 'Refuse a claim',
      intent:
        'The refusal stays on the record. Without it the next person attaches the same document and the same reviewer ' +
        'refuses it again.',
      path: (v) => `/v1/evidence/claims/${v.claimId}/reject`,
      submitLabel: 'Refuse',
      fields: [
        { name: 'claimId', label: 'Claim', type: 'select',
          options: pendingClaims.map((claim) => ({ value: claim.id, label: `${claim.reference} — ${claim.claim.slice(0, 60)}` })) },
        { name: 'reason', label: 'Why', type: 'text' },
      ],
      transform: ({ claimId, ...rest }) => rest,
    },
  };

  // The evidence doors sit in their own panel rather than on the page command
  // bar, because they act on the registry rather than on the pipeline.
  for (const bar of root.querySelectorAll('.cmd-bar')) {
    bar.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-command]');
      if (!button) return;
      const spec = EVIDENCE_COMMANDS[button.dataset.command];
      if (!spec) return;
      if (await command(spec)) await draw();
    });
  }

  // The waiver doors live inside the matrix panel, which is rendered on demand,
  // so the listener is on the container rather than on the buttons.
  detail.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const analysisId = detail.dataset.analysis;
    if (!analysisId) return;

    const analysis = await api.get(`/v1/pipeline/analyses/${analysisId}`).catch(() => null);
    const waivers = await api
      .read(`/v1/pipeline/analyses/${analysisId}/waivers`, 'ESTIMATE_TENDER', 'COMMERCIAL_L3')
      .catch(() => null);
    const addenda = await api
      .read(`/v1/pipeline/analyses/${analysisId}/addenda`, 'ESTIMATE_TENDER', 'COMMERCIAL_L3')
      .catch(() => null);
    if (!analysis) return;

    const specs = {
      'waive-requirement': {
        title: 'Waive a requirement',
        intent:
          'Record that this requirement is not being answered, and why. The deliverable leaves the drafting queue and is ' +
          'named on the response pack as waived, so whoever signs the submission sees what was left out on purpose rather ' +
          'than a checklist that quietly got shorter. It stops on the date given, never later than the tender returns.',
        path: `/v1/pipeline/analyses/${analysisId}/waivers`,
        submitLabel: 'Waive',
        fields: [
          { name: 'reference', label: 'Requirement', type: 'select',
            options: analysis.matrix
              .filter((line) => line.status !== 'SATISFIED')
              .filter((line) => !(waivers?.live ?? []).some((waiver) => waiver.reference === line.reference))
              .map((line) => ({
                value: line.reference,
                label: `${line.reference} — ${line.requirement.slice(0, 60)}${line.mandatory ? ' (mandatory)' : ''}`,
              })) },
          { name: 'reason', label: 'Why', type: 'textarea', rows: 3,
            hint: 'At least 20 characters. The question after a lost tender is always why question 14 was not answered.' },
          { name: 'expiresOn', label: 'Holds until', type: 'date',
            hint: `On or before ${analysis.returnBy.slice(0, 10)}, when this tender returns.` },
        ],
      },
      'revoke-waiver': {
        title: 'Take a waiver back',
        intent:
          'The deliverable becomes outstanding again immediately, on this pack and on any response pack planned from this ' +
          'matrix. The waiver stays on the record with who reversed it and why.',
        path: `/v1/pipeline/analyses/${analysisId}/waivers/revoke`,
        submitLabel: 'Revoke',
        fields: [
          { name: 'reference', label: 'Waiver', type: 'select',
            options: (waivers?.live ?? []).map((waiver) => ({
              value: waiver.reference,
              label: `${waiver.reference} — ${waiver.requirement.slice(0, 60)}`,
            })) },
          { name: 'reason', label: 'What changed', type: 'text' },
        ],
      },
    };

    specs['assess-addendum'] = {
      title: 'Assess an addendum',
      intent:
        'Compare the revised requirement set against the matrix on file. Only what actually moved is marked, so a ' +
        'response written against a requirement that did not change stays good — this is not a re-analysis, and it ' +
        'costs nothing and resets nothing. A material change blocks the submission until somebody has looked at it.',
      path: `/v1/pipeline/analyses/${analysisId}/addenda`,
      submitLabel: 'Assess',
      fields: [
        { name: 'reference', label: 'Addendum reference', type: 'text', hint: 'The reference the buyer gave it.' },
        { name: 'issuedOn', label: 'Issued on', type: 'date' },
        { name: 'summary', label: 'What the buyer says it changed', type: 'textarea', rows: 2 },
        { name: 'requirements', label: 'The revised requirement set', type: 'textarea', rows: 8,
          hint: 'One per line: reference | requirement | mandatory (yes/no) | weight % | due date. Every requirement ' +
            'still in force, not only the changed ones — an absent reference reads as withdrawn.' },
      ],
      transform: (v) => ({
        reference: v.reference,
        issuedOn: v.issuedOn,
        summary: v.summary,
        requirements: String(v.requirements ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [reference, requirement, mandatory, weight, due] = line.split('|').map((part) => part.trim());
            return {
              reference,
              requirement,
              mandatory: /^(y|yes|true|mandatory)$/i.test(mandatory ?? ''),
              ...(weight ? { weightingPercent: Number(weight) } : {}),
              ...(due ? { dueBy: due } : {}),
            };
          }),
      }),
    };
    specs['review-impact'] = {
      title: 'Record what was done about an impact',
      intent:
        'The section rewritten, the price revisited, or why neither was needed. A tick is not a review, and the question ' +
        'three weeks later is what somebody concluded.',
      path: `/v1/pipeline/analyses/${analysisId}/addenda/review`,
      submitLabel: 'Record',
      fields: [
        { name: 'impact', label: 'Impact', type: 'select',
          options: (addenda?.impacts ?? [])
            .filter((impact) => impact.status === 'OPEN')
            .map((impact) => ({
              value: `${impact.addendum}::${impact.reference}`,
              label: `${impact.addendum} · ${impact.reference} — ${impact.detail.slice(0, 60)}`,
            })) },
        { name: 'note', label: 'What was done', type: 'textarea', rows: 2 },
      ],
      transform: (v) => ({
        addendum: String(v.impact ?? '').split('::')[0],
        reference: String(v.impact ?? '').split('::')[1],
        note: v.note,
      }),
    };

    const spec = specs[button.dataset.command];
    if (!spec) return;
    if (await command(spec)) {
      const [fresh, freshWaivers, freshAddenda] = await Promise.all([
        api.get(`/v1/pipeline/analyses/${analysisId}`),
        api.read(`/v1/pipeline/analyses/${analysisId}/waivers`, 'ESTIMATE_TENDER', 'COMMERCIAL_L3').catch(() => null),
        api.read(`/v1/pipeline/analyses/${analysisId}/addenda`, 'ESTIMATE_TENDER', 'COMMERCIAL_L3').catch(() => null),
      ]);
      render(detail, matrixDetail(fresh, freshWaivers, freshAddenda));
      detail.dataset.analysis = analysisId;
    }
  });
}
