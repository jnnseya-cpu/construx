import { api, isRoleDenial } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { badge, date, html, humanise, money, notice, pct, positionReport, raw, render, resolveHtml, table, time, toast } from '../lib/ui.js';
import { donutChart } from '../lib/charts.js';
import { flowPanel, loadFlow } from '../lib/flow.js';
import { insightPanel } from '../lib/insight.js';
import { CONTINENT, COUNTRY, METHOD_OF_MEASUREMENT, REQUIREMENT_CATEGORY, SECTOR_GROUPED, today } from '../lib/enums.js';
import { lookupPanel, wireLookups } from '../lib/lookup.js';
import { blockedReason, can, closeProject, draw, goTo, openProject, phaseGates, state } from '../app.js';

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

// Two vocabularies, one map. The commercial-term reading grades CRITICAL,
// MAJOR and MINOR; the assurance review grades CRITICAL, HIGH, MEDIUM and LOW.
// They agree about CRITICAL and never collide elsewhere, so one map keeps a
// severity looking the same colour wherever it appears on this screen.
const SEVERITY_TONE = { CRITICAL: 'bad', MAJOR: 'warn', MINOR: '', HIGH: 'warn', MEDIUM: 'neutral', LOW: '' };

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

/*
 * A superseded answer is not a failed one.
 *
 * It is the version that went out before a better one was written, and it is
 * kept because the version a buyer read is a promise this business made. So it
 * reads as neutral rather than as a warning: the only answer anybody needs to
 * act on is one captured and still waiting for a second person to approve it.
 */
const ANSWER_TONE = { APPROVED: 'ok', DRAFT: 'warn', SUPERSEDED: '', RETIRED: 'bad' };

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
  /*
   * `classification.kind`, not `kind`.
   *
   * The register publishes an ingested file as the pipeline recorded it —
   * `inspection`, `classification`, `extraction` — and every read of `file.kind`
   * on this screen was `undefined`. It failed silently in the worst possible
   * way: the drawing row fell through to the text path, so the one button that
   * measures a drawing never rendered, on the one screen holding the drawings.
   * Reported as "I cannot see the take-off". Normalised once, here, so the rest
   * of the screen reads one field name.
   */
  const ingested = new Map(
    (ingestion?.files ?? []).map((file) => [file.hash, { ...file, kind: file.classification?.kind }]),
  );

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

/**
 * Document kinds that state no tender requirements, whatever else they carry.
 *
 * A drawing's words are its title block; a calculation proves a design; a
 * schedule lists quantities; a photograph shows a place. Requirements live in
 * the invitation letter, the instructions to tenderers and the specification.
 */
const CANNOT_BE_AN_INVITATION = ['DRAWING', 'CALCULATION', 'SCHEDULE', 'PHOTOGRAPH', 'MODEL', 'CERTIFICATE'];

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
  /*
   * Measured quantities waiting for a person, which is the other half of
   * reading a tender pack. A drawing is measured, not read: the numbers are in
   * the geometry. The confirmation is what puts them in the bill, and until
   * somebody has checked them nothing downstream can price anything — the same
   * rule the requirements reading follows.
   */
  const takeoffDrafts = (perception?.drafts ?? []).filter(
    (d) => (d.task === 'DRAWING_TAKEOFF' || d.task === 'PRICE_LIST_BOQ') && d.status === 'DRAFT',
  );
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
                /*
                 * An invitation states requirements. A drawing, a calculation
                 * sheet and a schedule do not, and offering the same button
                 * against all of them is how a tender pack of five produced
                 * five readings and five refusals — including a 101,572
                 * character structural calculation read in full, correctly
                 * found to contain no requirements, and reported as a failure.
                 *
                 * The classifier already knows: ISO 19650 types the document in
                 * its own reference, and these filenames carry it. So the row
                 * offers the reading where it can work, and says what the
                 * document is where it cannot — rather than hiding the button,
                 * because a classifier is a rule and the person holding the
                 * file knows better than it does.
                 */
                /*
                 * A drawing is offered the thing a drawing is for.
                 *
                 * Measuring a drawing means *seeing* it — the quantities are in
                 * the geometry, not in the text layer. The road here is chosen
                 * by "does this file have text?", so a drawing with a title
                 * block was routed to the text path and the take-off was never
                 * offered at all. Every quantity in a tender pack sat behind a
                 * button that did not exist on the screen holding the drawings.
                 */
                /*
                 * A held file nobody has looked at yet has no `file` at all —
                 * `heldTenderFiles` returns the UNREAD road with the entry
                 * alone, because there is no ingestion record to read a kind
                 * off. Reading `file.kind` before the road is known crashed the
                 * whole screen on any tender project carrying an uploaded pack
                 * document that had not been ingested. The guard lets UNREAD
                 * fall through to its own branch below, which the file-less row
                 * was always meant to reach; every `file.*` read past here is
                 * on a road (DRAWING/TEXT/LOOK) that carries one.
                 */
                html`${
                  file && String(file.kind ?? '') === 'DRAWING'
                  ? html`<button class="btn sm" data-take-off="${entry.hash}">Measure quantities</button>
                      <button class="btn quiet sm" data-read-itt-text="${file.ingestionId}"
                        title="A drawing states no tender requirements. This will run and will almost certainly find none.">
                        Read as an invitation
                      </button>`
                  : road === 'TEXT'
                  ? CANNOT_BE_AN_INVITATION.includes(String(file.kind ?? ''))
                    ? html`<button class="btn quiet sm" data-read-itt-text="${file.ingestionId}"
                          title="This is ${humanise(String(file.kind)).toLowerCase()}, which states no tender requirements. Read the invitation letter or the instructions to tenderers instead — this will run, and will almost certainly find none.">
                          Read anyway — this is ${humanise(String(file.kind)).toLowerCase()}
                        </button>`
                    : html`<button class="btn sm" data-read-itt-text="${file.ingestionId}">Read this invitation</button>`
                  : road === 'LOOK'
                    ? html`<button class="btn sm" data-read-itt="${entry.hash}">Read it with a model that can see</button>`
                    : road === 'UNREAD'
                      ? html`<button class="btn quiet sm" data-ingest-tender="${entry.hash}" data-name="${entry.description}">
                          Look at the file first
                        </button>`
                      : ''
                }
                ${
                  // The civils door: read the buyer's priced Bill of Quantities
                  // straight into the bill. Offered on any readable tender
                  // document, because the pricing schedule arrives as a Word
                  // file, a PDF or a scan and the person holding it is on this
                  // screen. Quantities only — the reader returns no rate.
                  file && (road === 'TEXT' || road === 'LOOK' || String(file.kind ?? '') === 'DRAWING')
                    ? html`<button class="btn quiet sm" data-read-boq="${entry.hash}"
                        title="Read this as the buyer's priced Bill of Quantities — the AI extracts every item, unit and quantity into the bill for you to price. It reads quantities only, never a rate.">
                          Read as a pricing schedule
                        </button>`
                    : ''
                }
                ${
                  /*
                   * Read it again, under the rules as they are now.
                   *
                   * A classification is recorded at ingestion and the record is
                   * append-only, so a file filed before a rule existed keeps
                   * the answer the old rules gave it. After the ISO 19650
                   * reference rules shipped, drawings already on a project
                   * stayed typed "unknown" — offered no take-off, counted past
                   * by the pack run — and the only remedy was to upload the
                   * file again. The rules improving is not a reason to make
                   * somebody re-file their pack.
                   */
                  file
                    ? html`<button class="btn quiet sm" data-reclassify="${file.ingestionId}"
                        title="Read this file again under the current classification rules. A file filed before a rule existed keeps the old answer until something re-reads it.">
                          Re-read
                        </button>`
                    : ''
                }`,
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

      ${
        /*
         * Measured quantities, awaiting a person.
         *
         * A drawing is measured rather than read, and until somebody has
         * checked the measurement nothing is in the bill. Confirming writes the
         * BoQ items that `buildEstimate` prices — which is the whole bridge
         * from a set of drawings to a quotation, and it had no screen.
         */
        takeoffDrafts.length > 0
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <div style="padding:15px 17px">
                <h2>Quantities measured off the drawings, or read from a pricing schedule, awaiting a person</h2>
                <p class="metric-sub" style="margin-bottom:10px">
                  Check them against the source before confirming — the drawing a quantity was measured off, or the
                  buyer’s Bill of Quantities it was read from. Confirming writes them into the bill, which is what an
                  estimate is priced from. Nothing here is a price — a quantity is not a rate, and the reader never
                  returns one.
                </p>
                ${takeoffDrafts.map((draft) => {
                  const items = draft.extraction?.items ?? [];
                  const omitted = draft.extraction?.omitted ?? [];
                  const fromSchedule = draft.task === 'PRICE_LIST_BOQ';
                  return html`<div class="card" style="margin-bottom:10px">
                    <div class="metric-sub" style="margin-bottom:8px">
                      ${items.length} item${items.length === 1 ? '' : 's'} ${fromSchedule ? 'read from the buyer’s schedule' : 'measured'}${
                        draft.extraction?.scale ? html` · scale ${draft.extraction.scale}` : ''
                      }${draft.confidence !== undefined ? html` · confidence ${Math.round(Number(draft.confidence) * 100)}%` : ''}
                    </div>
                    ${items.length > 0
                      ? table({
                          headers: ['Description', 'Unit', 'Quantity', 'Measured from', 'Rule'],
                          align: ['', '', 'num', '', ''],
                          rows: items.slice(0, 40).map((item) => [
                            item.description,
                            item.unit,
                            Number(item.quantity).toLocaleString('en-GB'),
                            item.sourceSheet ?? '—',
                            item.measurementRule ?? (fromSchedule ? 'As scheduled' : 'NRM2'),
                          ]),
                        })
                      : html`<div class="notice warn"><div>
                          This reading measured nothing. A drawing with no dimensioned or scalable quantity on it is
                          not a failure of the reader — check the sheet before confirming anything.
                        </div></div>`}
                    ${omitted.length > 0
                      ? html`<div class="metric-sub" style="margin-top:9px">
                          <b>Left out deliberately:</b> ${omitted.join('; ')}. A quantity that needed an assumption is
                          omitted and named rather than guessed at.
                        </div>`
                      : ''}
                    <div class="actions" style="margin-top:11px">
                      <button class="btn" data-confirm-takeoff="${draft.id}" data-method="${draft.extraction?.methodOfMeasurement ?? ''}" ${raw(items.length === 0 ? 'disabled' : '')}>
                        Confirm and write the bill
                      </button>
                      <button class="btn quiet" data-reject-itt="${draft.id}">Reject this measurement</button>
                    </div>
                  </div>`;
                })}
              </div>
            </div>`
          : ''
      }
    </div>
  `;
}

const COVERAGE_TONE = { COVERED: 'ok', PROFILE: 'ok', LINK_SUGGESTED: 'warn', ATTENTION: 'warn', MISSING: 'bad', NO_EVIDENCE_ASKED: '' };
const COVERAGE_LABEL = {
  COVERED: 'covered',
  PROFILE: 'from the profile',
  LINK_SUGGESTED: 'evidence to link',
  ATTENTION: 'needs attention',
  MISSING: 'nothing on file',
  NO_EVIDENCE_ASKED: 'no evidence asked',
};

/**
 * The tender programme: drafted from the measured bill, checked by the
 * platform's own critical-path engine, confirmed by a person into the project's
 * programme, and downloaded as a Gantt chart for the portal.
 *
 * A denial is shown as a denial, never as "no programme".
 */
function tenderProgrammePanel(tenderDrafts) {
  const intro = html`<h2 style="font-size:14px;margin:0 0 4px">Tender programme</h2>
    <p class="metric-sub" style="margin:0 0 11px">
      The programme a buyer asks for with the return. Drafted from your measured bill — activities, working-day
      durations, the logic between them, who does each, and a risk allowance — and checked by the platform’s own
      critical-path engine against your period and the bank holidays. Nothing goes into the programme until you
      confirm it; after that it is the project’s programme, editable on the Programme screen, and the download
      always shows it as it now is.
    </p>`;
  if (tenderDrafts?.error) {
    return html`<div style="margin:16px 17px 4px">${intro}${notice(
      isRoleDenial(tenderDrafts.error)
        ? 'Your role cannot see this project’s programme.'
        : `The tender programme could not be read: ${tenderDrafts.error.message ?? 'unknown error'}.`,
      isRoleDenial(tenderDrafts.error) ? 'warn' : 'bad',
    )}</div>`;
  }
  const drafts = tenderDrafts?.drafts ?? [];
  const confirmed = drafts.find((d) => d.status === 'CONFIRMED');
  const waiting = drafts.find((d) => d.status === 'DRAFT');
  const draftButton = html`<button class="btn ${confirmed ? 'quiet' : ''} sm" data-tp-draft>${
    waiting || confirmed ? 'Draft it again' : 'Draft the tender programme from the bill'
  }</button>`;

  const confirmedBlock = confirmed
    ? html`<div class="card" style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap">
          <span>
            ${badge('confirmed', 'ok')} Starts ${date(confirmed.startDate)} · completion date
            ${date(confirmed.forecast.completionBy)} · ${confirmed.activities.length} activities ·
            ${confirmed.calendar?.name ?? 'five-day week'}
          </span>
          <span style="flex:none;display:flex;gap:7px;flex-wrap:wrap">
            <button class="btn sm" data-tp-download="PDF">Download programme (PDF)</button>
            <button class="btn quiet sm" data-tp-download="DOCX">Word</button>
          </span>
        </div>
      </div>`
    : '';

  const waitingBlock = waiting
    ? html`<div class="card" style="margin-bottom:10px">
        <div class="metric-sub" style="margin-bottom:8px">
          ${waiting.forecast.fits
            ? badge('fits the period', 'ok')
            : badge('overruns the period', 'bad')}
          Draft finishes ${date(waiting.forecast.finishDate)} against a completion date of
          ${date(waiting.forecast.completionBy)} — computed by the critical-path engine on
          ${waiting.calendar?.name ?? 'a five-day week'}, not claimed by the drafter.
          Critical path: ${waiting.forecast.criticalRefs.join(' → ') || 'none'}.
        </div>
        ${table({
          headers: ['Ref', 'Activity', 'Days', 'Follows', 'Resource / subcontract', 'Bill items'],
          align: ['', '', 'num', '', '', ''],
          rows: waiting.activities.map((a) => [
            a.ref,
            a.riskAllowance ? `${a.name} (risk allowance)` : a.name,
            a.milestone ? 'Milestone' : String(a.durationDays),
            a.predecessors.map((l) => `${l.ref}${l.type === 'FS' ? '' : ` ${l.type}`}${l.lagDays ? ` +${l.lagDays}d` : ''}`).join(', ') || '—',
            [a.resource, a.subcontract ? `Subcontract: ${a.subcontract}` : ''].filter(Boolean).join(' · ') || '—',
            (a.boqRefs ?? []).join(', ') || '—',
          ]),
        })}
        ${waiting.corrections.length > 0
          ? html`<div class="notice warn" style="margin-top:9px"><div>
              <b>Corrected before you saw it:</b> ${waiting.corrections.join(' ')}
            </div></div>`
          : ''}
        ${waiting.assumptions.length > 0
          ? html`<div class="metric-sub" style="margin-top:9px">
              <b>Assumptions behind the durations — check each against your own outputs:</b>
              <ul style="margin:4px 0 0 18px">${waiting.assumptions.map((line) => html`<li>${line}</li>`)}</ul>
            </div>`
          : ''}
        <div class="actions" style="margin-top:11px">
          <button class="btn" data-tp-confirm="${waiting.id}" ${raw(confirmed ? 'disabled' : '')}>Confirm as the programme</button>
          ${draftButton}
        </div>
        ${confirmed
          ? html`<div class="metric-sub" style="margin-top:6px">
              The project already has its programme. Change it on the Programme screen; a draft is not written over it.
            </div>`
          : ''}
      </div>`
    : '';

  return html`<div style="margin:16px 17px 4px">
    ${intro}
    ${confirmedBlock}
    ${waitingBlock}
    ${waiting ? '' : html`<div class="actions">${draftButton}</div>`}
  </div>`;
}

function matrixDetail(analysis, waivers, addenda, coverage) {
  const gapRefs = new Set(analysis.mandatoryGaps.map((line) => line.reference));
  // A waiver is read live, so a line waived after the matrix was analysed reads
  // as waived here without the analysis being rerun.
  const waivedBy = new Map((waivers?.live ?? []).map((waiver) => [waiver.reference, waiver]));

  // The next-actions panel: everything still outstanding, grouped by how it
  // clears, so the reader is told the route per line rather than inferring it
  // from the status column. It reuses exactly what the backend already computed
  // — there is one source of truth, not a second:
  //  - GAP lines are profile-backed (a probe matched but nothing is on file), so
  //    recording the company fact clears them. Every GAP is one of insurance,
  //    accreditation, turnover, DBS or references.
  //  - `coverage.toObtain` is the evidence gates with nothing (or nothing
  //    current) on file — a document to attach and assert a claim against. A ref
  //    already in the record-a-fact group is not repeated here; recording the
  //    fact is its primary clear, and the evidence tables below still show it.
  //  - `clarifications` are the questions the analysis raised for the buyer.
  //  - UNKNOWN lines the platform cannot check and that need no document are
  //    answered in the response pack when it is written, not here.
  const recordFacts = analysis.matrix.filter((line) => line.status === 'GAP');
  const recordFactRefs = new Set(recordFacts.map((line) => line.reference));
  const fileDocs = (coverage?.toObtain ?? []).filter((o) => !recordFactRefs.has(o.reference));
  const fileDocRefs = new Set(fileDocs.map((o) => o.reference));
  const raiseClars = analysis.clarifications ?? [];
  const unknownToAnswer = analysis.matrix.filter(
    (line) => line.status === 'UNKNOWN' && !fileDocRefs.has(line.reference),
  );
  const nothingOutstanding = recordFacts.length === 0 && fileDocs.length === 0 && raiseClars.length === 0;

  return html`
    <div class="card pad0">
      <h2 style="padding:15px 17px 0">
        ${analysis.reference} · ${analysis.clientName}
        ${analysis.readyToPrice ? badge('ready to price', 'ok') : badge('not ready to price', 'bad')}
      </h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        Returns ${date(analysis.returnBy)}. Analysed ${date(analysis.analysedAt)}${
          analysis.estimatedValueMinor === undefined
            ? ' — no contract value or programme set yet, so the commercial-term risk below is carried but not yet sized. ' +
              'It sizes itself from your take-off estimate as soon as you price the job.'
            : analysis.sizedFrom === 'ESTIMATE'
              ? ` — commercial-term risk sized against your take-off estimate of ${money(analysis.estimatedValueMinor)}` +
                `${analysis.durationWeeks === undefined ? '' : ` over ${analysis.durationWeeks} weeks`}. It updates as the estimate firms up.`
              : ` against ${money(analysis.estimatedValueMinor)}${analysis.durationWeeks === undefined ? '' : ` over ${analysis.durationWeeks} weeks`} — every exposure below ` +
                'is computed against those figures, so a matrix read months later still shows what it was judged on.'
        }
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

      <div class="card" style="margin:13px 17px 0">
        <h2 style="margin:0 0 2px">What’s needed, and how to add each</h2>
        <p style="font-size:12.5px;color:var(--text-3);margin:0 0 10px">
          Everything still outstanding on this tender, grouped by how you clear it — so each line tells you the route,
          rather than leaving you to read it off the status column. Clear what you can here; the full matrix and evidence
          tables are below.
        </p>
        ${
          nothingOutstanding
            ? html`<div class="notice ok"><div>
                <b>Nothing outstanding that the platform can check.</b> Every pass/fail requirement is evidenced and no
                question is waiting for the buyer. The scored sections are answered when you write the response pack.
              </div></div>`
            : html`
                ${
                  recordFacts.length > 0
                    ? html`<div style="margin-bottom:13px">
                        <div style="font-weight:600;font-size:13px">Record a company fact
                          <span style="color:var(--text-3);font-weight:400">— clears the moment you save it</span></div>
                        <div style="font-size:12px;color:var(--text-3);margin:2px 0 6px">
                          Insurances, accreditations, turnover, DBS and references. Saving the fact flips these to
                          Satisfied — the matrix re-checks your record every time it is read.
                        </div>
                        ${table({
                          headers: ['Ref', 'Requirement', 'What to record'],
                          rows: recordFacts.map((line) => [
                            html`${line.reference}${line.mandatory ? badge('mandatory', 'bad') : ''}`,
                            html`<span style="font-size:12px">${line.requirement}</span>`,
                            html`<span style="font-size:12px;color:var(--text-3)">${line.evidenceRequired}</span>`,
                          ]),
                        })}
                        <button class="btn sm" data-command="company-facts" style="margin-top:6px">Record the company’s facts</button>
                      </div>`
                    : ''
                }
                ${
                  fileDocs.length > 0
                    ? html`<div style="margin-bottom:13px">
                        <div style="font-weight:600;font-size:13px">File a document &amp; assert a claim
                          <span style="color:var(--text-3);font-weight:400">— the buyer wants to see it</span></div>
                        <div style="font-size:12px;color:var(--text-3);margin:2px 0 6px">
                          A certificate or policy the register does not hold yet. File it, then assert a claim against it so
                          it is traceable — and have someone other than the asserter verify it before you submit.
                        </div>
                        ${table({
                          headers: ['Ref', 'Requirement', 'Evidence needed'],
                          rows: fileDocs.map((o) => [
                            html`${o.reference}${o.mandatory ? badge('mandatory', 'bad') : ''}`,
                            html`<span style="font-size:12px">${o.requirement}</span>`,
                            html`<span style="font-size:12px;color:var(--text-3)">${o.evidenceRequired}</span>`,
                          ]),
                        })}
                        <button class="btn sm" data-command="assert-claim" style="margin-top:6px">Assert a claim</button>
                      </div>`
                    : ''
                }
                ${
                  raiseClars.length > 0
                    ? html`<div style="margin-bottom:13px">
                        <div style="font-weight:600;font-size:13px">Raise a clarification
                          <span style="color:var(--text-3);font-weight:400">— only the buyer can answer these</span></div>
                        <div style="font-size:12px;color:var(--text-3);margin:2px 0 6px">
                          The analysis raised these itself. One press puts them on the clarification register as a TQ; you
                          then send them from Tender &amp; Procurement — paste into the buyer’s portal before their
                          clarification deadline, as the platform does not transmit to the portal itself.
                        </div>
                        ${raiseClars.map((c) => html`<div style="font-size:12px;margin:2px 0">• ${c}</div>`)}
                        <button class="btn sm" data-raise-clars="${analysis.analysisId}" data-raise-project="${analysis.projectId}" style="margin-top:6px">Raise these to the client</button>
                      </div>`
                    : ''
                }
                ${
                  unknownToAnswer.length > 0
                    ? html`<div class="notice" style="margin-top:4px"><div style="font-size:12px">
                        <b>${unknownToAnswer.length} requirement${unknownToAnswer.length === 1 ? '' : 's'}</b> the platform
                        cannot check for you — these are answered in the response pack when you write it
                        (“Write the next section”), not by a fact or a document.
                      </div></div>`
                    : ''
                }
              `
        }
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
        coverage
          ? html`<h2 style="padding:15px 17px 0">Evidence you already hold, matched to the matrix</h2>
              <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                ${coverage.summary} The platform proposes which held evidence could cover each requirement — linking it is
                still your decision, and it never invents a document you do not have. Only the lines that need action are
                listed; the rest are covered.
              </p>

              ${
                coverage.toAttach.length > 0
                  ? html`<h2 style="padding:13px 17px 0">Attach these when you submit to the client portal</h2>
                      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                        The distinct documents the register already holds that answer this matrix — one line per document,
                        however many requirements it covers. A proposed match (${'?'}) is yours to confirm; a pending
                        document is yours to verify before it is sent.
                      </p>
                      ${table({
                        headers: ['Document', 'Answers', 'Standing'],
                        rows: coverage.toAttach.map((a) => [
                          html`${a.reference} — <span style="font-size:12px;color:var(--text-3)">${a.claim}</span>`,
                          html`${a.linkedRefs.map((r) => badge(r, 'ok'))}${a.suggestedRefs.map((r) => badge(`${r}?`, 'warn'))}${
                            a.suggestedRefs.length > 0
                              ? html`<br><span style="font-size:11px;color:var(--text-3)">? proposed — confirm it answers the requirement</span>`
                              : ''
                          }`,
                          badge(humanise(a.standing), a.standing === 'APPROVED' ? 'ok' : a.standing === 'PENDING' ? 'warn' : 'bad'),
                        ]),
                      })}`
                  : ''
              }

              ${
                coverage.toObtain.length > 0
                  ? html`<h2 style="padding:13px 17px 0">Add these to your library before you submit</h2>
                      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                        The pass/fail evidence gates nothing on file answers — the documents to go and get (insurances,
                        accreditations, checks, policies, references), not the scored questions, which are answered in the
                        submission itself. The mandatory ones end the bid if still open on the day, so they are first. File
                        the document and assert a claim against it, or raise a clarification if the buyer should not be asking.
                      </p>
                      ${table({
                        headers: ['Ref', 'Requirement', 'Evidence needed', 'Why'],
                        rows: coverage.toObtain.map((o) => [
                          html`${o.reference}${o.mandatory ? badge('mandatory', 'bad') : ''}`,
                          html`<span style="font-size:12px">${o.requirement}</span>`,
                          html`<span style="font-size:12px;color:var(--text-3)">${o.evidenceRequired}</span>`,
                          o.reason === 'MISSING' ? badge('nothing on file', 'bad') : badge('expired or not current', 'warn'),
                        ]),
                      })}`
                  : ''
              }

              ${
                (coverage.undertakings ?? []).length > 0
                  ? html`<h2 style="padding:13px 17px 0">Compliance undertakings — the platform drafted these; confirm each is true</h2>
                      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                        These lines are answered by a statement, not a document. The agent has written each confirmation
                        from the requirement; confirming is <b>you declaring it true</b> — the platform never confirms on
                        your behalf. ${coverage.undertakings.filter((u) => !u.confirmed).length} of ${coverage.undertakings.length} still to confirm.
                        ${
                          can('ESTIMATE_TENDER', 'A') && coverage.undertakings.some((u) => !u.confirmed)
                            ? html`<br><button class="btn sm" data-confirm-undertakings="${analysis.analysisId}" style="margin-top:8px">Confirm all as true</button>`
                            : ''
                        }
                      </p>
                      ${table({
                        headers: ['Ref', 'Drafted confirmation', 'Status'],
                        rows: coverage.undertakings.map((u) => [
                          html`<span style="font-size:12px">${u.requirement}</span>`,
                          html`<span style="font-size:12px;color:var(--text-3)">${u.statement}</span>`,
                          u.confirmed ? badge('confirmed', 'ok') : badge('draft — confirm', 'warn'),
                        ]),
                      })}`
                  : ''
              }

              <h2 style="padding:15px 17px 0">Every requirement that needs action</h2>
              ${table({
                headers: ['Ref', 'Requirement', 'Standing', 'Held evidence and suggestions'],
                rows: coverage.requirements
                  .filter((r) => !['NO_EVIDENCE_ASKED', 'COVERED', 'PROFILE'].includes(r.disposition))
                  .map((r) => [
                    r.reference,
                    html`<span style="font-size:12px">${r.requirement}</span>`,
                    badge(COVERAGE_LABEL[r.disposition] ?? r.disposition, COVERAGE_TONE[r.disposition] ?? ''),
                    html`${[
                      ...r.linked.map(
                        (c) =>
                          html`<div style="font-size:12px">Linked: ${c.reference} — ${c.claim} ${badge(
                            humanise(c.standing),
                            c.standing === 'APPROVED' ? 'ok' : c.standing === 'PENDING' ? 'warn' : 'bad',
                          )}</div>`,
                      ),
                      ...r.suggested.map(
                        (c) =>
                          html`<div style="font-size:12px;color:var(--text-3)">Consider linking: ${c.reference} — ${c.claim}${
                            c.because === 'NAMED_CERTIFICATE' ? ' (names the same certificate)' : ''
                          }</div>`,
                      ),
                      r.disposition === 'MISSING'
                        ? html`<div style="font-size:12px;color:var(--text-3)">Nothing held answers this — file the document and assert a claim, or raise a clarification.</div>`
                        : '',
                    ]}`,
                  ]),
                empty: 'Every requirement that needs evidence is covered or proven from the profile.',
              })}`
          : ''
      }

      ${
        (addenda?.impacts ?? []).length > 0
          ? html`<h2 style="padding:15px 17px 0">What the addenda changed</h2>
              <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                ${addenda.summary} Only the requirements that actually moved are marked — a response written against one
                that did not change stays good, which is why this is not a re-analysis. A reworded mandatory question is
                the case a response answers perfectly and scores nothing, because it answers the old one.
              </p>
              <div style="padding:11px 17px 0">
                ${raw(commandBar([
                  { id: 'assess-addendum', label: 'Assess an addendum',
                    permitted: can('ESTIMATE_TENDER', 'U'), reason: blockedReason('ESTIMATE_TENDER', 'U') },
                  { id: 'review-impact', label: 'Record what was done', tone: 'quiet',
                    permitted: can('ESTIMATE_TENDER', 'U'), reason: blockedReason('ESTIMATE_TENDER', 'U') },
                ]))}
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
                ${raw(commandBar([
                  { id: 'assess-addendum', label: 'Assess an addendum',
                    permitted: can('ESTIMATE_TENDER', 'U'), reason: blockedReason('ESTIMATE_TENDER', 'U') },
                ]))}
              </div>`
      }

      <h2 style="padding:15px 17px 0">Requirements nobody is answering, on purpose</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        ${waivers?.summary ?? 'Waivers could not be read.'} A requirement not answered because somebody decided so and one
        not answered because nobody got to it look identical on every list. This is the difference, and it carries a name,
        a reason and a date it stops.
      </p>
      <div style="padding:11px 17px 0">
        ${raw(commandBar([
          { id: 'waive-requirement', label: 'Waive a requirement',
            permitted: can('ESTIMATE_TENDER', 'A'), reason: blockedReason('ESTIMATE_TENDER', 'A') },
          { id: 'revoke-waiver', label: 'Take a waiver back', tone: 'quiet',
            permitted: can('ESTIMATE_TENDER', 'A'), reason: blockedReason('ESTIMATE_TENDER', 'A') },
        ]))}
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
          ${(() => {
            const w = analysis.weightings;
            const st = w.status ?? (w.complete ? 'COMPLETE' : w.stated === 0 ? 'NONE' : w.stated > 100 ? 'NESTED' : 'SHORT');
            const note =
              st === 'NONE'
                ? 'The invitation stated no weightings. Ask for the breakdown before pricing — an evaluation nobody can see is one nobody can bid to.'
                : st === 'COMPLETE'
                  ? 'The stated weightings total 100%. The full breakdown is published.'
                  : st === 'NESTED'
                    ? 'The criteria are nested — the sub-weightings are percentages of a section, not of the whole, so they do not add to a single total. The top-level split (typically a price / quality share) is set out in the ITT; do not read the sub-weightings as shares of the whole mark.'
                    : `The stated weightings total ${w.stated}%, under 100%. Part of how this is being marked has not been disclosed.`;
            return html`
              <p style="font-size:12.5px;color:var(--text-3);margin:0 0 8px">${note}</p>
              ${
                st === 'NESTED'
                  ? html`<p style="font-size:12px;color:var(--text-3);margin:0"><b>Scored on:</b> ${w.declared.map((d) => humanise(d.category)).join(', ')}. The ITT carries the exact split.</p>`
                  : html`<div class="split-list">
                      ${w.declared.map((d) => html`<div class="row"><span class="lbl">${humanise(d.category)}</span><span class="val">${d.percent}%</span></div>`)}
                      <div class="row">
                        <span class="lbl"><b>Stated total</b></span>
                        <span class="val">${badge(`${w.stated}%`, w.complete ? 'ok' : 'warn')}</span>
                      </div>
                    </div>`
              }`;
          })()}
        </div>
        <div>
          <h2 style="margin-bottom:6px">Questions for the buyer</h2>
          <p style="font-size:12.5px;color:var(--text-3);margin:0 0 8px">
            Raised by the analysis rather than typed by somebody. These go through the clarification process and are
            answered to every bidder, so asking late is asking the competition's question for them.
          </p>
          <button class="btn quiet sm" data-ai-review="${analysis.projectId}" style="margin:0 0 8px"
            title="A bid-manager read of the tender for genuine clarification questions — contradictions, missing information, ambiguous scope — each quoting the passage it comes from. It proposes; you verify and raise.">
            Ask the AI to review the tender (expert clarifications)
          </button>
          <div data-ai-review-results="${analysis.projectId}" style="margin-bottom:8px"></div>
          ${
            analysis.clarifications.length === 0
              ? html`<div class="empty"><b>No question the analysis can prove</b>
                  The invitation is internally consistent and insurable as written, so there is nothing to ask on its
                  behalf — a clarification nobody needs is one the competition reads too. If you need to put a question
                  to the buyer yourself, raise it on <b>Tender &amp; Procurement → “Raise clarification”</b>: it then
                  appears on the clarification register with a <b>“Copy all questions to send”</b> button, to paste into
                  the buyer’s portal before the clarification deadline.</div>`
              : html`
                  ${
                    can('PROCUREMENT_AWARD', 'C')
                      ? html`<button class="btn sm" data-raise-clars="${analysis.analysisId}" data-raise-project="${analysis.projectId}" style="margin-bottom:8px">
                          Raise these to the client
                        </button>
                        <p style="font-size:11.5px;color:var(--text-3);margin:0 0 8px">
                          One press puts every question above on the clarification register as a TQ, to the client — no retyping.
                          Already-raised ones are skipped. Send and record the answers on Tender &amp; Procurement.
                        </p>`
                      : ''
                  }
                  <div class="split-list">
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

/**
 * A reading across the live tenders — what needs attention, before a tender is
 * picked to work.
 *
 * This is the insight surface the tenant-wide pipeline had none of: the AI
 * Insight panel reads one project's proposals, so with no project selected it
 * could only error. This is arithmetic over the board already on screen —
 * nothing is fetched and no model is called — so it is always there. It names
 * what is closing, what is not ready to bid, what has a critical clarification
 * outstanding and what mandatory return has no owner, each the thing that stops
 * a bid going in, and offers the way straight to the tender that carries it.
 */
function tenderAttention(board) {
  const TERMINAL = ['NO_BID', 'CONVERTED', 'LOST'];
  const live = board.filter((t) => !TERMINAL.includes(t.stage));

  const closing = live
    .filter((t) => typeof t.businessDaysRemaining === 'number' && t.businessDaysRemaining <= 10)
    .sort((a, b) => a.businessDaysRemaining - b.businessDaysRemaining);
  const notReady = live.filter((t) => (t.blockers ?? []).length > 0);
  const reReview = live.filter((t) => (t.reReviewReasons ?? []).length > 0);
  const criticalClar = live.filter((t) => (t.clarifications ?? []).some((c) => c.severity === 'CRITICAL'));
  const unowned = live.flatMap((t) =>
    (t.returns ?? [])
      .filter((d) => d.mandatory && !d.owner)
      .map((d) => ({ tender: t, deliverable: d })),
  );

  const metrics = [
    { n: live.length, k: 'Live tenders', tone: '' },
    { n: closing.length, k: 'Closing within 10 days', tone: closing.length > 0 ? 'warn' : '' },
    { n: notReady.length, k: 'Not ready to bid', tone: notReady.length > 0 ? 'bad' : '' },
    { n: unowned.length, k: 'Mandatory returns unowned', tone: unowned.length > 0 ? 'warn' : '' },
  ];

  // The tender's row-level entry point, where it carries the project the focus
  // keys on. Without one there is nothing to focus onto, so the reference is
  // shown plain rather than as a button that would land nowhere.
  const go = (t, text) =>
    t.projectId
      ? html`<button class="btn quiet sm" data-focus-tender="${t.projectId}">${text}</button>`
      : html`<span>${text}</span>`;

  const rows = [
    ...closing.slice(0, 5).map(
      (t) => html`<div class="row">
        <span class="lbl">${raw(badge(`${t.businessDaysRemaining}d`, t.businessDaysRemaining <= 5 ? 'bad' : 'warn'))} ${t.reference} · ${t.clientName} — closing</span>
        <span class="val">${go(t, 'Work on this')}</span>
      </div>`,
    ),
    ...reReview.slice(0, 3).map(
      (t) => html`<div class="row">
        <span class="lbl">${raw(badge('re-review', 'warn'))} ${t.reference} — an addendum changed it</span>
        <span class="val">${go(t, 'Work on this')}</span>
      </div>`,
    ),
    ...criticalClar.slice(0, 3).map(
      (t) => html`<div class="row">
        <span class="lbl">${raw(badge('critical', 'bad'))} ${t.reference} — a clarification is outstanding</span>
        <span class="val">${go(t, 'Work on this')}</span>
      </div>`,
    ),
    ...unowned.slice(0, 5).map(
      ({ tender, deliverable }) => html`<div class="row">
        <span class="lbl">${raw(badge('no owner', 'warn'))} ${tender.reference} · ${deliverable.reference} — ${deliverable.title}</span>
        <span class="val">${go(tender, 'Work on this')}</span>
      </div>`,
    ),
  ];

  return html`<div class="card pad0">
    <h3 style="padding:15px 17px 0">Where your tenders need attention</h3>
    <div class="metric-sub" style="padding:4px 17px 0">
      ${live.length === 0
        ? 'No live tender is in play. Register an opportunity and record its ITT to start one.'
        : 'Read across every live tender — what is closing, what is not ready, and what is blocking a bid. Press “Work on this” to take one on.'}
    </div>
    <div class="figure-strip" style="padding:11px 17px 4px">
      ${metrics.map(
        (m) => html`<div>
          <div class="fig-k">${m.k}</div>
          <div class="metric ${raw(m.tone)}">${m.n}</div>
        </div>`,
      )}
    </div>
    ${rows.length > 0
      ? html`<div class="split-list" style="padding:6px 17px 15px">${rows}</div>`
      : live.length > 0
        ? html`<div class="metric-sub" style="padding:9px 17px 15px">Every live tender is on track — nothing closing inside ten days, and no blocker, critical clarification or unowned mandatory return.</div>`
        : html`<div style="padding:0 0 6px"></div>`}
  </div>`;
}

export async function pipeline(root) {
  const [criteria, summary, discipline, winRate, library, profile, radar, tenders, permissions, matrices, claimRegister, projectList, portfolioList, tradeCatalogue] = await Promise.all([
    api.get('/v1/pipeline/criteria'),
    api.get('/v1/pipeline'),
    api.get('/v1/pipeline/discipline'),
    // Whether the business is actually winning, and whether that is changing.
    // Tenant-scoped and read-only: a projection over the outcomes already
    // recorded against each opportunity, computed on every request.
    api.get('/v1/pipeline/win-rate').catch((error) => ({ error })),
    // The answer library: what this business says about itself, kept across
    // bids. Tenant-scoped, because an answer is a company fact rather than a
    // project one — the same social-value commitment answers every bid.
    api.read('/v1/pipeline/answers', 'ESTIMATE_TENDER', 'COMMERCIAL_L3').catch((error) => ({ error })),
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
    // The tenancy's live projects, so a pursuit can name the job it is for
    // rather than asking somebody to type a project they already have into a
    // second record nothing connects to the first.
    api.get('/v1/projects').catch(() => ({ projects: [] })),
    // Where a won pursuit becomes a project. A portfolio is required by project
    // creation, so without this the conversion below could only offer somebody
    // a box to type an id into.
    api.get('/v1/portfolios').catch(() => ({ portfolios: [] })),
    // The trade catalogue, so the one factor of the ten the platform can answer
    // from evidence can be asked about the trades this register actually knows
    // rather than typed into a box.
    api.get('/v1/supply-chain/trades').catch(() => ({ trades: [] })),
  ]);

  // The reader is project-scoped: a reading is filed against the project the
  // tender is bid from, and it costs ACUs against that project's tenancy.
  const projectId = state.session?.projectId;
  const [perception, evidence, ingestion, bidPacks, assurance, portalPort, submissions, flow, tenderDrafts] = projectId
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
        // What the red team found against those submissions. Loaded beside the
        // packs rather than behind a click, because a review that found a
        // critical problem is the reason the issue button is refusing.
        api.read(`/v1/projects/${projectId}/assurance`, 'ESTIMATE_TENDER', 'COMMERCIAL_L3').catch((error) => ({ error })),
        // The port, and what has gone out through it. The adapter register is
        // loaded so the screen says what can actually be done rather than
        // offering an upload control that would silently do nothing.
        api.get('/v1/portal/adapters').catch((error) => ({ error })),
        api.read(`/v1/projects/${projectId}/submissions`, 'PROCUREMENT_AWARD', 'COMMERCIAL_L3').catch((error) => ({ error })),
        // Where this job is on the road from an enquiry to a price or a
        // submission, and the one thing to do next. Computed server-side.
        loadFlow(projectId),
        // The programme the buyer asks for with the return, drafted from the
        // measured bill and confirmed into the project's programme.
        api.read(`/v1/projects/${projectId}/programme/tender-drafts`, 'WORKPACKAGES_TASKS').catch((error) => ({ error })),
      ])
    : [null, null, null, null, null, null, null, null, null];

  // The register carries counts; the findings themselves are what somebody acts
  // on, so the newest review is opened in full rather than left behind a click.
  const latestReviewId = (assurance?.reviews ?? [])[0]?.id;
  const latestReview =
    projectId && latestReviewId
      ? await api
          .get(`/v1/projects/${projectId}/assurance/${latestReviewId}`)
          .catch(() => null)
      : null;

  // The full pack, sections and all, fetched once and kept — so the submission
  // can be read, edited and downloaded on this screen rather than only counted.
  // The register above carries counts; this carries the prose.
  //
  // **Issued packs are included here, deliberately.** They used to be excluded,
  // and that made the whole workflow a dead-end at its last step: the moment the
  // record was frozen — which is exactly when somebody needs the clean PDF of
  // what was sent — the pack dropped out of this list and the "Download
  // submission (PDF)" button vanished with it. An issued pack is read-only
  // below (the Edit button is withheld; the backend refuses an edit either way),
  // but it can still be read, copied and downloaded.
  const fullPacks = projectId
    ? (
        await Promise.all(
          (bidPacks?.packs ?? []).map((pack) =>
            api
              .get(`/v1/projects/${projectId}/bid-responses/${pack.id}`)
              .then((full) => ({ pack, sections: full.sections ?? [] }))
              // A pack that will not open is carried with no sections rather than
              // dropped, so the register and the reader agree on what exists.
              .catch(() => ({ pack, sections: [] })),
          ),
        )
      )
    : [];
  /*
   * The sections a library answer can be recorded against, or the next one to
   * write — the chooser the two command forms below read from.
   *
   * An issued pack is excluded: an answer cannot first go out on a submission
   * that has already gone, so its sections are not offered to write to or record
   * a use against. That is the chooser's rule, not the reader's — the reader
   * above shows an issued pack so it can be downloaded; this does not offer its
   * sections for editing.
   */
  const packSections = fullPacks
    .filter(({ pack }) => pack.status !== 'ISSUED')
    .flatMap(({ pack, sections }) =>
    sections.map((section) => ({
      value: `${pack.id}::${section.key}`,
      label: `${pack.reference} · ${section.key} — ${section.title}`,
    })),
  );

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
  // Only the invitations still in play are offered as a target to confirm a
  // reading against, add a deliverable to, assign a return on or record an
  // addendum for. A tender that was declined, won-and-converted or lost is not
  // one you file a fresh matrix or a new return against — and leaving them in
  // the list is how a reading for one tender gets confirmed onto another by a
  // single wrong click, which is exactly what happened: a North Lincolnshire
  // reading built onto a closed job because every tender the account ever had
  // was in one flat dropdown. The terminal stages match the backend's own
  // definition (NO_BID, CONVERTED, LOST); everything else — a live or
  // not-yet-decided pursuit — stays.
  const TERMINAL_STAGES = ['NO_BID', 'CONVERTED', 'LOST'];
  const invitationOptions = board
    .filter((t) => !TERMINAL_STAGES.includes(t.stage))
    .map((t) => ({ value: t.invitationId, label: `${t.reference} · ${t.title}` }));
  const biddableOptions = board
    .filter((t) => t.stage === 'BID')
    .map((t) => ({ value: t.invitationId, label: `${t.reference} · closes ${t.deadline.local}` }));
  // One matrix per tender, and only for a tender still in play. A tender's
  // requirements merge into a single analysis as its documents are read, but
  // every superseded fragment stays on the append-only ledger — so a tender read
  // one document at a time had a dozen analyses on file, all mixed together. The
  // list and the pickers show only the matrix each *live* invitation currently
  // points to.
  //
  // A matrix bound to a tender that is **closed, won or lost** drops out too —
  // a reading confirmed onto a tender by mistake (the "it went to an old closed
  // project" that could not be cleared) stops cluttering the live list the
  // moment that tender is terminal, which is also what "when an opportunity is
  // closed it must be closed" means for its matrix. It stays on the record,
  // counted among the superseded, reachable by focusing that tender.
  //
  // Where nothing is bound to any tender yet, nothing is hidden, so a first
  // analysis is never swallowed.
  const allAnalyses = matrices.analyses ?? [];
  const boundAnalysisIds = new Set(board.map((t) => t.analysisId).filter(Boolean));
  const liveAnalysisIds = new Set(
    board.filter((t) => !TERMINAL_STAGES.includes(t.stage)).map((t) => t.analysisId).filter(Boolean),
  );
  const liveAnalyses =
    boundAnalysisIds.size === 0 ? allAnalyses : allAnalyses.filter((a) => liveAnalysisIds.has(a.analysisId));
  const supersededAnalyses = allAnalyses.length - liveAnalyses.length;
  // The matrices not shown in the live list — superseded fragments, and matrices
  // bound to a closed, won or lost tender. Kept so a person can still open and
  // read one (the reading confirmed onto the wrong tender by mistake is in here),
  // rather than it being hidden with no way back to it.
  const liveAnalysisSet = new Set(liveAnalyses.map((a) => a.analysisId));
  const hiddenAnalyses = allAnalyses.filter((a) => !liveAnalysisSet.has(a.analysisId));

  /*
   * One tender per page.
   *
   * The reader, the response packs and the red team on the lower half of this
   * screen are already scoped to the project selected in the session — writing
   * a section spends that project's ACUs, so it could never be anything else.
   * The procurement half above them was not: "Invitations in hand" and
   * "Compliance matrices on file" listed every tender the tenancy holds at
   * once, so a bid manager working one job read it against the backdrop of
   * every other — "it is mixing everything regardless of the selected project."
   *
   * The focus is the project already selected, because that is the one the
   * lower half is working. A tender carries the project it is bid from
   * (`t.projectId`), so when the selected project owns an invitation on the
   * board, the board and the matrices narrow to it and a bar at the top says
   * which tender is in focus and offers the way back out. The analytics further
   * down — the win rate, the decided pipeline — stay tenant-wide, because they
   * are a reading *across* bids and narrowing them to one would be a lie.
   *
   * Focus engages only when the selected project actually has a tender here.
   * A delivery project opened to look at its costs selects a project too, and
   * it has no invitation on this board; focusing on nothing would blank the
   * board behind a bar nobody could clear usefully, so that case shows
   * everything, exactly as before.
   */
  const focusTenders = projectId ? board.filter((t) => t.projectId === projectId) : [];
  const focused = focusTenders.length > 0;
  const visibleBoard = focused ? focusTenders : board;
  const focusAnalysisIds = new Set(focusTenders.map((t) => t.analysisId).filter(Boolean));
  // Focused, the matrix is drawn from every analysis, not only the live ones, so
  // a won or lost tender opened on purpose still shows its own matrix — the
  // exclusion above is about the unfocused list, not about what you asked to see.
  const shownAnalyses = focused
    ? allAnalyses.filter((a) => focusAnalysisIds.has(a.analysisId))
    : liveAnalyses;
  const focusLabel = focusTenders.map((t) => t.reference).join(', ');
  const hiddenTenders = board.length - visibleBoard.length;
  /*
   * The trades the register knows, grouped the way it groups them.
   *
   * This is why `POST /v1/pipeline/supply-chain-evidence` had no door for so
   * long: the objection was that a panel would be a box asking somebody to type
   * trade names, and a typed trade is one the catalogue cannot match. It was
   * the wrong conclusion — the catalogue is published, so the panel can offer
   * the real trades and the answer comes back off the register.
   */
  // Flat, with the group in each label. A multiple-select renders no option
  // groups — only the single chooser does — so grouping here would have put
  // `undefined` in every row of the list somebody picks from.
  const tradeOptions = (tradeCatalogue?.trades ?? []).map((trade) => ({
    value: trade.code,
    label: `${humanise(String(trade.group ?? ''))} · ${trade.label}${trade.accreditationRequired ? ' (accredited)' : ''}`,
  }));

  /** Where a converted win lands. A project sits in a portfolio, always. */
  const portfolios = (portfolioList?.portfolios ?? []).map((p) => ({ value: p.portfolioId ?? p.id, label: p.name }));

  /*
   * Every return on every invitation, as one choice.
   *
   * Two dependent pickers — the invitation, then its returns — is the obvious
   * shape and it does not work in a panel that is built once when it opens: the
   * second would have to be rebuilt when the first changed. One list, with the
   * invitation in the value, is both simpler and better to read, because what
   * somebody is looking for is the line the gate named, not the invitation it
   * belongs to.
   *
   * Incomplete mandatory returns first, and each labelled with what it is
   * missing, so the list is ordered by what is actually blocking the bid.
   */
  const whatIsMissing = (d) => {
    const missing = [];
    if (!d.owner) missing.push('no owner');
    if (!d.internalDueBy) missing.push('no internal date');
    if (!d.source?.document) missing.push('no source');
    return missing;
  };
  /** The invitation and the reference back out of one chooser's value. */
  const splitReturnTarget = (target) => {
    const [invitationId, ...rest] = String(target ?? '').split('::');
    return { invitationId: invitationId ?? '', reference: rest.join('::') };
  };
  const returnOptions = board
    .flatMap((t) => (t.returns ?? []).map((d) => ({ tender: t, deliverable: d, missing: whatIsMissing(d) })))
    .sort((a, b) => {
      const weight = (entry) => (entry.deliverable.mandatory && entry.missing.length > 0 ? 0 : entry.missing.length > 0 ? 1 : 2);
      return weight(a) - weight(b);
    })
    .map(({ tender, deliverable, missing }) => ({
      value: `${tender.invitationId}::${deliverable.reference}`,
      label:
        `${tender.reference} · ${deliverable.reference} — ${deliverable.title}` +
        `${deliverable.mandatory ? ' · mandatory' : ''}` +
        `${missing.length > 0 ? ` · ${missing.join(', ')}` : ' · complete'}`,
    }));

  /*
   * The live actions, scoped to the tender in focus.
   *
   * The focus narrows what the page *shows*; this narrows what it *does*. When
   * the page is focused on one tender, a command that takes an invitation, a
   * return or a matrix offers only that tender's — so a focused page acts on
   * nothing but the job in hand, and the wrong-tender slip a tenant-wide
   * dropdown invites (confirming a reading onto the wrong invitation, the
   * mistake that started this) cannot happen from here. Off focus, every live
   * tender is offered, exactly as before — the lists are the same objects.
   *
   * A return's chooser carries the invitation in its value (`id::ref`), so it
   * is filtered on the invitation split back out of it, not on the value whole.
   */
  const focusInvitationIds = new Set(focusTenders.map((t) => t.invitationId));
  const scopedInvitationOptions = focused
    ? invitationOptions.filter((o) => focusInvitationIds.has(o.value))
    : invitationOptions;
  const scopedBiddableOptions = focused
    ? biddableOptions.filter((o) => focusInvitationIds.has(o.value))
    : biddableOptions;
  const scopedReturnOptions = focused
    ? returnOptions.filter((o) => focusInvitationIds.has(splitReturnTarget(o.value).invitationId))
    : returnOptions;
  // Why a focused command is empty, in place of the tenant-wide "record one
  // first": the invitation is not missing, it is the focus — it is simply not
  // live to this action (a won or closed tender opened for its costs). Only
  // reached when focused and the scoped list came back empty.
  const focusEmptyReason = `The tender in focus (${focusLabel}) has no live invitation to act on here — use “Show all tenders” to act on another.`;

  const thresholds = criteria.thresholds;
  const opportunities = summary.opportunities ?? [];
  /*
   * Under focus, the opportunities list narrows to the one tender in focus, the
   * same way the board and the matrices do — "why is everything listed in score
   * an opportunity" was this table showing every pursuit in the tenancy while a
   * bid manager was working one job. An opportunity belongs to the focus when it
   * is tied to the focused project (as a pursuit or once converted), or carries
   * the same reference as a tender in focus. With nothing in focus, the whole
   * list shows, exactly as before.
   */
  const focusReferences = new Set(focusTenders.map((t) => t.reference).filter(Boolean));
  const shownOpportunities = focused
    ? opportunities.filter(
        (o) =>
          o.projectId === projectId ||
          o.convertedProjectId === projectId ||
          (o.reference && focusReferences.has(o.reference)),
      )
    : opportunities;

  /*
   * The two halves of the decision this screen is named after, and which of
   * this tenancy's pursuits each one can act on.
   *
   * Both had routes, tests and a published algorithm and **no door anywhere in
   * the console**. The consequence was not that scoring was awkward: an
   * opportunity could only ever sit at `IDENTIFIED`, so "Record how a bid
   * ended" was permanently padlocked with "Nothing has reached a decision to
   * bid", and a business that had registered a real tender could not record
   * that it had decided to bid for it. The screen described a ten-factor
   * algorithm it gave nobody any way to run.
   *
   * The engine's own gates, so the pickers cannot offer a refusal: a converted
   * or declined pursuit cannot be re-scored, and a decision needs a score.
   */
  const scorable = opportunities.filter((o) => o.stage !== 'CONVERTED' && o.stage !== 'NO_BID');
  const decidable = opportunities.filter((o) => o.qualification);
  /*
   * And what a win turns into, which had no door either.
   *
   * A pursuit that was registered before any project existed — which is the
   * normal case, and the reason the pipeline is tenant-scoped — had nowhere to
   * become one. The business won the work and then created a project by hand on
   * Enterprise & Portfolio, so nothing on the delivery project pointed back at
   * the opportunity, the score, the decision or the invitation that produced it.
   * `originOpportunityId` is how the thread carries forward, and it can only be
   * set by converting.
   *
   * A pursuit already linked to a project is not offered: it has one.
   */
  const convertible = opportunities.filter(
    (o) => o.stage === 'BID' && !o.projectId && o.outcome?.outcome !== 'LOST',
  );

  /*
   * Every opportunity picker on this screen obeys the focus the board and the
   * table already obey. Under focus it defaults to the one tender in focus
   * rather than to whatever happens to sit first in the tenancy list — the
   * report that drove this was "Record how a bid ended" opening with a
   * different council than the one on screen, which, against a write-once
   * outcome, is how a loss lands on the wrong bid. `focusDefault` returns the
   * focused pursuit's id for a picker to pre-select, or '' (no forced default,
   * browser picks the first option) when nothing is in focus or the focused
   * pursuit is not eligible for that action. With nothing in focus every picker
   * behaves exactly as before.
   */
  const focusDefault = (eligible) =>
    focused ? (shownOpportunities.find(eligible)?.id ?? '') : '';
  const outcomePending = (o) => (o.stage === 'BID' || o.stage === 'CONVERTED') && !o.outcome;

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
              // First, because everything after it acts against one.
              { id: 'opportunity', label: 'Register an opportunity', tone: '',
                permitted: can('BUSINESS_DEVELOPMENT', 'C', TENANT), reason: blockedReason('BUSINESS_DEVELOPMENT', 'C', TENANT) },
              { id: 'invitation', label: 'Record an ITT', tone: '',
                permitted: can('ESTIMATE_TENDER', 'C', TENANT), reason: blockedReason('ESTIMATE_TENDER', 'C', TENANT) },
              { id: 'quote-only', label: 'It only asks for a price',
                permitted: can('ESTIMATE_TENDER', 'U') && scopedInvitationOptions.length > 0,
                reason: scopedInvitationOptions.length === 0
                  ? (focused ? focusEmptyReason : 'No invitation is recorded, so there is nothing to record a return against.')
                  : blockedReason('ESTIMATE_TENDER', 'U', TENANT) },
              /*
               * The step everything after it needs, and the one that had no
               * door at all.
               *
               * `Plan a response pack`, the submission rules, the waivers and
               * the addenda review all take an `analysisId`, and the only two
               * routes that mint one — this and the project-scoped
               * `/tender/itt` — were reachable from nowhere in the console. So
               * an opportunity and an invitation could be recorded and the
               * entire response-pack half of the tender was unreachable: every
               * picker downstream permanently empty, with nothing on any screen
               * saying what to do about it.
               */
              { id: 'requirements', label: 'Read the invitation into a matrix', tone: '',
                permitted: can('ESTIMATE_TENDER', 'C', TENANT) && scopedInvitationOptions.length > 0,
                reason: scopedInvitationOptions.length === 0
                  ? (focused ? focusEmptyReason : 'Record the ITT first — a compliance matrix is bound to the invitation it was read from.')
                  : blockedReason('ESTIMATE_TENDER', 'C', TENANT) },
              { id: 'deliverable', label: 'Add a deliverable',
                permitted: can('ESTIMATE_TENDER', 'U', TENANT), reason: blockedReason('ESTIMATE_TENDER', 'U', TENANT) },
              /*
               * The door the reading above made necessary and nothing
               * provided. A reading files what the buyer asked for; it cannot
               * file who here owns it or by when, because neither is in the
               * buyer's document. Without this, every mandatory return the
               * reading filed blocked the decision to bid for ever.
               */
              { id: 'assign-deliverable', label: 'Assign a return',
                permitted: can('ESTIMATE_TENDER', 'U', TENANT) && scopedReturnOptions.length > 0,
                reason: scopedReturnOptions.length === 0
                  ? (focused ? focusEmptyReason : 'No invitation has a return register yet. Read one, or add the return items one at a time.')
                  : blockedReason('ESTIMATE_TENDER', 'U', TENANT) },
              { id: 'addendum', label: 'Record an addendum',
                permitted: can('ESTIMATE_TENDER', 'U', TENANT), reason: blockedReason('ESTIMATE_TENDER', 'U', TENANT) },
              { id: 'programme', label: 'Build tender programme',
                permitted: can('ESTIMATE_TENDER', 'C', TENANT), reason: blockedReason('ESTIMATE_TENDER', 'C', TENANT) },
              { id: 'record-external-submission', label: 'Record a portal submission', tone: 'quiet',
                permitted: Boolean(projectId) && can('PROCUREMENT_AWARD', 'I'),
                reason: !projectId
                  ? 'Open one tender first (focus it), then record that it was submitted on the buyer’s portal.'
                  : blockedReason('PROCUREMENT_AWARD', 'I') },
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
      ${raw(flowPanel(flow, { here: 'pipeline' }))}

      ${
        /*
         * The focus bar. It only appears once a tender is in focus — when it is
         * not, the "Work on this" button on each board row is the way in, so an
         * empty bar would be noise. It names the tender being worked and the way
         * back out, and it carries the client so the reference alone is not the
         * only thing telling one tender from another.
         */
        focused
          ? html`<div class="card" style="margin-bottom:14px;border-left:3px solid var(--info)">
              <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
                <div style="flex:1 1 auto;min-width:220px">
                  <div style="font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3)">
                    Working on one tender
                  </div>
                  <div style="font-size:15px;font-weight:600;margin-top:2px">
                    ${focusLabel}${focusTenders[0]?.clientName ? html` · <span style="font-weight:400;color:var(--text-2)">${focusTenders[0].clientName}</span>` : ''}
                  </div>
                  <div style="font-size:12.5px;color:var(--text-3);margin-top:3px">
                    The invitations board and the compliance matrices below show only this tender${
                      hiddenTenders > 0
                        ? ` — ${hiddenTenders} other invitation${hiddenTenders === 1 ? '' : 's'} ${hiddenTenders === 1 ? 'is' : 'are'} hidden while you work it`
                        : ''
                    }. The reader, the response packs and the red team were already this tender's.
                  </div>
                </div>
                <button class="btn quiet" data-close-focus>Show all tenders</button>
              </div>
            </div>`
          : ''
      }

      <div id="pipeline-insight" style="margin-bottom:14px"></div>

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Invitations in hand</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          ${focused
            ? html`Showing the one tender you are working on. ${hiddenTenders > 0 ? html`Use <b>Show all tenders</b> above to see the other ${hiddenTenders}.` : ''}`
            : tenders.summary} The deadline is recorded in the zone it is read in and resolved to one instant — a portal
          that closes at noon in Dublin has closed an hour before noon here.
        </p>
        ${table({
          headers: ['Reference', 'Client', 'Closes', 'Zone', 'Left', 'Deliverables', 'Addenda', 'Stage', 'Ready to bid', 'Matrix'],
          align: ['', '', '', '', 'num', 'num', 'num', '', '', ''],
          rows: visibleBoard.map((t) => [
            html`${t.reference}<br><span style="font-size:11.5px;color:var(--text-3)">${t.title}</span>${
              /*
               * The way into one tender's page. Shown only when the board is
               * showing every tender and this one carries the project its bid
               * is written against — focusing keys on that project, so a
               * pursuit that names none has nothing to focus onto and says so
               * through its site-visit row rather than a button that would land
               * on nobody's job.
               */
              !focused && t.projectId
                ? html`<br><button class="btn quiet sm" data-focus-tender="${t.projectId}" style="margin-top:4px">Work on this</button>`
                : ''
            }`,
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
          visibleBoard.some((t) => t.blockers.length > 0 || t.reReviewReasons.length > 0 || t.clarifications.length > 0)
            ? html`<div class="split-list" style="padding:0 17px 15px">
                ${visibleBoard.flatMap((t) => [
                  ...t.reReviewReasons.map(
                    (reason) => html`<div class="row"><span class="lbl">${t.reference} ${badge('re-review', 'warn')} ${reason}</span></div>`,
                  ),
                  ...t.blockers.map(
                    (blocker) => html`<div class="row"><span class="lbl">${t.reference} ${badge('needed to submit', 'bad')} ${blocker}</span></div>`,
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
        ${
          /*
           * The two other dates on an invitation, and the one somebody has to
           * be in a van for.
           *
           * Both were recorded at intake and neither was ever read back: the
           * position published the return deadline and nothing else, so a bid
           * manager could enter the date of the site visit that is part of
           * their tender and never see it again anywhere in the product.
           *
           * And a date on its own is not enough. The walk produces findings
           * that price, sequence and need permissions, and those are written to
           * a project while the pipeline is tenant-scoped — so the row carries
           * the route to the register that takes them. Where the pursuit names
           * no project there is nowhere for them to go, and it says so rather
           * than offering a button that would land on somebody else's job.
           */
          visibleBoard.some((t) => t.siteVisit || t.clarificationDeadline)
            ? html`<div class="split-list" style="padding:0 17px 15px">
                ${visibleBoard.flatMap((t) => [
                  ...(t.clarificationDeadline
                    ? [
                        html`<div class="row">
                          <span class="lbl">${t.reference} · questions close</span>
                          <span class="val">${t.clarificationDeadline.local.replace('T', ' ')} ${t.clarificationDeadline.timeZone}</span>
                        </div>`,
                      ]
                    : []),
                  ...(t.siteVisit
                    ? [
                        html`<div class="row">
                          <span class="lbl">${t.reference} · site visit</span>
                          <span class="val">
                            ${t.siteVisit.local.replace('T', ' ')} ${t.siteVisit.timeZone}
                            ${t.projectId
                              ? html`<button class="btn quiet sm" data-site-visit="${t.projectId}" style="margin-left:8px">
                                  Record what the walk found
                                </button>`
                              : html`<span style="font-size:11.5px;color:var(--text-3)">
                                  — this pursuit names no project, so there is nowhere to file the findings yet. Link
                                  one when you register the opportunity, or convert the win.
                                </span>`}
                          </span>
                        </div>`,
                      ]
                    : []),
                ])}
              </div>`
            : ''
        }
        ${
          /*
           * What actually has to go back, and who here owns each of it.
           *
           * The board above counted the register — "3/3" — and the count is
           * the one thing about it nobody needs. This is the list a bid
           * manager works from for the fortnight before a return, and it was
           * not readable anywhere in the product: the gate would name `APP5`
           * as missing an owner while no screen said what `APP5` was.
           */
          visibleBoard.some((t) => (t.returns ?? []).length > 0)
            ? html`<div style="padding:0 17px 15px">
                <h3 style="font-size:13px;margin:4px 0 7px">What has to go back</h3>
                ${table({
                  headers: ['Invitation', 'Ref', 'What it is', 'Pass/fail', 'Owner', 'Our date', 'Source', 'Format'],
                  rows: visibleBoard.flatMap((t) =>
                    (t.returns ?? []).map((d) => [
                      t.reference,
                      d.reference,
                      d.title,
                      d.mandatory ? badge('mandatory', 'bad') : badge('optional', ''),
                      d.owner ? humanise(d.owner) : badge('none', d.mandatory ? 'warn' : ''),
                      d.internalDueBy ? date(d.internalDueBy) : badge('none', d.mandatory ? 'warn' : ''),
                      d.source?.document
                        ? html`<span style="font-size:11.5px;color:var(--text-3)">${d.source.document}${
                            d.source.clause ? `, ${d.source.clause}` : ''
                          }</span>`
                        : badge('none', d.mandatory ? 'warn' : ''),
                      html`<span style="font-size:11.5px;color:var(--text-3)">${d.format ?? '—'}${
                        d.signatureRequired ? ' · signed' : ''
                      }${d.pageLimit ? ` · ${d.pageLimit}pp` : ''}</span>`,
                    ]),
                  ),
                })}
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
        invitationOptions: scopedInvitationOptions,
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
                ${
                  /*
                   * The dead end the reader above already escapes, one section
                   * further down — and the one that mattered more.
                   *
                   * A compliance matrix is written to the tenancy; a response
                   * pack is written to a project, and the platform refuses one
                   * on a project past tender. That refusal is right: a
                   * submission for work already under construction is not a
                   * submission. What was wrong is what the screen did with it.
                   * The bar showed three padlocks naming the phase of whatever
                   * project the shell happened to have open, with nothing to
                   * press and no hint that another project on the same tenancy
                   * would take the pack. Somebody holding an invitation, a
                   * matrix and a return date reads that as the feature being
                   * broken — which is precisely how a day was lost on the
                   * module that does the same job.
                   *
                   * A role refusal is left to the bar, which collapses it into
                   * one line to the Permissions screen. This is for the
                   * refusal that has a remedy, and it reuses the reader's own
                   * `tenderProjects` rather than forming a second opinion
                   * about which phases qualify.
                   */
                  readBlocked && !isRoleDenial(readBlocked)
                    ? html`<div class="notice warn" style="margin:10px 0">
                        <div>
                          <b>Not on this project.</b> ${readBlocked}
                          ${tenderProjects.length > 0
                            ? html`<div style="margin-top:6px">
                                The matrix belongs to the company, so it stays on file whichever project is open. Open
                                one the platform will write a pack against:
                                ${tenderProjects.map(
                                  (p) =>
                                    html`<button class="btn quiet sm" data-open-project="${p.id}" style="margin:3px 4px 0 0">
                                      ${p.name} · ${humanise(p.phase)}
                                    </button>`,
                                )}
                              </div>`
                            : html`<div style="margin-top:6px">
                                No project in this tenancy is at a phase a response pack may be written in
                                (${tenderPhases.map((phase) => humanise(phase)).join(', ')}). Set one up on Enterprise
                                &amp; Portfolio, or move this one back on Project Control.
                              </div>`}
                        </div>
                      </div>`
                    : ''
                }
                <div class="actions cmd-bar" style="margin:10px 0">
                  ${raw(
                    commandBar([
                      { id: 'bid-plan', label: 'Plan a response pack', tone: '',
                        permitted: can('ESTIMATE_TENDER', 'C'), reason: blockedReason('ESTIMATE_TENDER', 'C') },
                      { id: 'bid-replan', label: 'Re-plan from the scored questions',
                        permitted: can('ESTIMATE_TENDER', 'U'), reason: blockedReason('ESTIMATE_TENDER', 'U') },
                      { id: 'bid-section', label: 'Write the next section',
                        permitted: can('ESTIMATE_TENDER', 'U'), reason: blockedReason('ESTIMATE_TENDER', 'U') },
                      { id: 'bid-issue', label: 'Issue the pack',
                        permitted: can('ESTIMATE_TENDER', 'A'), reason: blockedReason('ESTIMATE_TENDER', 'A') },
                    ]),
                  )}
                </div>
                <p class="metric-sub">${(bidPacks.summary ?? '')}</p>
                ${(() => {
                  // A pack planned from every written requirement, not from the
                  // questions the buyer marks. Shown so a pack of ninety-six
                  // sections against a seven-question tender is caught before
                  // it is paid for, not after.
                  const unscored = (bidPacks.packs ?? []).filter(
                    (pack) => pack.status !== 'ISSUED' && pack.basis !== 'SCORED_QUESTIONS',
                  );
                  if (unscored.length === 0) return '';
                  return html`<div class="notice info" style="margin-top:11px"><div>
                    <b>${unscored
                      .map((pack) => {
                        const total = pack.completeness?.total ?? 0;
                        return `${pack.reference} (${total} section${total === 1 ? '' : 's'})`;
                      })
                      .join(', ')}
                    ${unscored.length === 1 ? 'answers' : 'answer'} every written requirement, not only the scored questions.</b>
                    That is right where the buyer marks no questionnaire. Where it does — “Quality Questionnaire”,
                    “Q1 (30%)”, a word limit per answer — the evaluator marks only those answers. Read the questionnaire
                    above and confirm the reading, then use <i>Re-plan from the scored questions</i> with the tender’s
                    current matrix.
                  </div></div>`;
                })()}
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
                ${
                  /*
                   * The stated limit, and the two different things it can mean.
                   *
                   * A word limit is checked and refuses the issue, so it is
                   * shown as a refusal with the door that fixes it beside it —
                   * a gate with nothing on the screen that can clear it is a
                   * dead end on the return date.
                   *
                   * A page limit is not checked, because words per page depends
                   * on a template this platform does not hold and a limit
                   * enforced against an invented conversion would refuse a
                   * submission that fits. It is put in front of whoever lays
                   * the pack out, and it says plainly that nothing verified it.
                   */
                  (() => {
                    const over = (bidPacks.packs ?? []).flatMap((pack) =>
                      (pack.completeness?.overLimit ?? []).map((entry) => ({ pack, entry })),
                    );
                    const paged = (bidPacks.packs ?? []).flatMap((pack) =>
                      (pack.completeness?.pageLimited ?? []).map((entry) => ({ pack, entry })),
                    );
                    // Answers still holding a note to the bid team. The buyer
                    // reads the note as written, so the pack will not issue.
                    const unfinished = (bidPacks.packs ?? []).flatMap((pack) =>
                      (pack.completeness?.unfinished ?? []).map((entry) => ({ pack, entry })),
                    );
                    // Staff a one-person firm does not have, and what a reviewer
                    // would raise but the pack can still go out with.
                    const staff = (bidPacks.packs ?? []).flatMap((pack) =>
                      (pack.completeness?.unsupportedStaff ?? []).map((entry) => ({ pack, entry })),
                    );
                    const advised = (bidPacks.packs ?? []).flatMap((pack) =>
                      (pack.completeness?.advisories ?? []).map((entry) => ({ pack, entry })),
                    );
                    if (
                      over.length === 0 && paged.length === 0 && unfinished.length === 0 &&
                      staff.length === 0 && advised.length === 0
                    ) return '';
                    return html`
                      ${staff.length === 0
                        ? ''
                        : html`<div class="notice bad" style="margin-top:11px"><div>
                            <b>${staff.length} section(s) claim staff your firm does not have.</b>
                            Your company facts say every bid is yours alone, so a “Bid Manager”, “Quality Manager” or
                            “Planning Lead” in an answer is a claim an evaluator can test at interview. Redraft the
                            section — the drafter now names who actually does the work. The pack will not issue until
                            none are left.
                            ${staff.map(
                              ({ pack, entry }) => html`<div style="margin-top:6px">
                                ${pack.reference} · ${entry.key} — ${entry.roles.join(', ')}.
                                <button class="btn sm" data-redraft="${entry.key}" data-pack="${pack.id}">
                                  Redraft this section
                                </button>
                              </div>`,
                            )}
                          </div></div>`}
                      ${advised.length === 0
                        ? ''
                        : html`<div class="notice warn" style="margin-top:11px"><div>
                            <b>${advised.length} thing(s) a reviewer would raise.</b>
                            None of these stops the pack issuing; each is worth a minute before it goes.
                            ${advised.map(
                              ({ pack, entry }) => html`<div style="margin-top:6px">
                                ${pack.reference} · ${entry.key} — ${entry.detail}
                              </div>`,
                            )}
                          </div></div>`}
                      ${unfinished.length === 0
                        ? ''
                        : html`<div class="notice bad" style="margin-top:11px"><div>
                            <b>${unfinished.length} section(s) still hold a note to the bid team instead of an answer.</b>
                            Wording like “the bid team will insert…” or “(to be inserted)” goes to the buyer exactly as
                            written, and an evaluator scores it as a gap. Redraft the section — the drafter now commits
                            to a method, a timing and a named person instead — or edit it yourself. The pack will not
                            issue until none are left.
                            ${unfinished.map(
                              ({ pack, entry }) => html`<div style="margin-top:6px">
                                ${pack.reference} · ${entry.key}${entry.mandatory ? ' (mandatory)' : ''} —
                                <i>${entry.phrases[0]}</i>${entry.phrases.length > 1 ? ` and ${entry.phrases.length - 1} more` : ''}.
                                <button class="btn sm" data-redraft="${entry.key}" data-pack="${pack.id}">
                                  Redraft this section
                                </button>
                              </div>`,
                            )}
                          </div></div>`}
                      ${over.length === 0
                        ? ''
                        : html`<div class="notice bad" style="margin-top:11px"><div>
                            <b>${over.length} section(s) are longer than the buyer allows.</b>
                            An evaluator does not mark the extra words down — the standard instruction is that
                            anything past the limit is not read, so the answer is scored on wherever it happens to
                            stop. The pack will not issue until they fit.
                            ${over.map(
                              ({ pack, entry }) => html`<div style="margin-top:6px">
                                ${pack.reference} · ${entry.key} — ${entry.words} words against ${entry.limitWords}
                                (${entry.statedAs}), ${entry.overBy} over${entry.mandatory ? ', mandatory' : ''}.
                                <button class="btn sm" data-shorten="${entry.key}" data-pack="${pack.id}">
                                  Cut it to length
                                </button>
                              </div>`,
                            )}
                          </div></div>`}
                      ${paged.length === 0
                        ? ''
                        : html`<div class="notice info" style="margin-top:11px"><div>
                            <b>${paged.length} section(s) carry a page limit nothing here can count.</b>
                            Words per page depends on the template the pack is laid out in, which this platform does
                            not hold — so this is the buyer's limit put in front of whoever lays it out, and it is
                            not checked. Nobody should read it as having been verified.
                            ${paged.map(
                              ({ pack, entry }) => html`<div style="margin-top:6px">
                                ${pack.reference} · ${entry.key} — ${entry.statedAs}, currently ${entry.words} words.
                              </div>`,
                            )}
                          </div></div>`}
                    `;
                  })()
                }
              `}
              ${projectId ? tenderProgrammePanel(tenderDrafts) : ''}
              ${
                /*
                 * The submission, read back and made editable. Until this, a
                 * section could be drafted and counted but never seen — so the
                 * real project names an experience answer needs, and the named
                 * site manager a team answer needs, had nowhere to go. Each
                 * drafted section shows in full, with Edit (rewrite it as yours)
                 * and Copy. An edited section is marked yours, not the model's.
                 */
                fullPacks.some((fp) => fp.sections.length > 0)
                  ? html`<div style="margin:16px 17px 4px">
                      <h2 style="font-size:14px;margin:0 0 4px">Read and edit the drafted answers</h2>
                      <p class="metric-sub" style="margin:0 0 11px">
                        Every section the drafter has written, in full. Edit one to put your real project names, your team
                        or your figures in — the drafter writes the method and leaves those for you, because it will not
                        invent them. An edited section is recorded as yours, not the model’s.
                      </p>
                      ${fullPacks
                        .filter((fp) => fp.sections.length > 0)
                        .map(
                          ({ pack, sections }) => html`<div class="card pad0" style="margin-bottom:10px">
                            <div style="padding:11px 14px;display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap">
                              <span>
                                <b>${pack.reference}</b> · ${pack.clientName} —
                                ${sections.filter((s) => s.status === 'DRAFTED').length} of ${sections.length} written
                                ${pack.status === 'ISSUED' ? badge('issued · read-only', 'good') : ''}
                              </span>
                              ${
                                sections.some((s) => s.status === 'DRAFTED' && (s.body ?? []).length > 0)
                                  ? html`<span style="flex:none;display:flex;gap:7px;flex-wrap:wrap">
                                      <button class="btn sm" data-download-pack="${pack.id}">Download submission (PDF)</button>
                                      <button class="btn quiet sm" data-copy-pack="${pack.id}">Copy all answers</button>
                                    </span>`
                                  : ''
                              }
                            </div>
                            ${sections.map(
                              (section) => html`<div style="border-top:1px solid var(--line);padding:11px 14px">
                                <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap">
                                  <b style="font-size:13px">${section.key} — ${section.deliverable || section.title}</b>
                                  <span style="flex:none">${
                                    section.status === 'DRAFTED'
                                      ? badge(
                                          `${section.words ?? 0} words · ${section.authorship === 'HUMAN' ? 'yours' : 'AI draft'}`,
                                          section.authorship === 'HUMAN' ? 'ok' : 'info',
                                        )
                                      : badge('not written', '')
                                  }</span>
                                </div>
                                ${section.status === 'DRAFTED' && (section.body ?? []).length > 0
                                  ? html`<div style="margin-top:7px;font-size:13px;line-height:1.55;white-space:pre-wrap">${(section.body ?? []).join('\n\n')}</div>
                                      <div style="margin-top:9px;display:flex;gap:7px">
                                        ${pack.status === 'ISSUED'
                                          ? ''
                                          : html`<button class="btn quiet sm" data-revise="${pack.id}::${section.key}">Edit this answer</button>`}
                                        <button class="btn quiet sm" data-copy-section="${pack.id}::${section.key}">Copy</button>
                                      </div>`
                                  : // A section nobody has written yet can be written by a
                                    // person. The only way in used to be the drafter, so an
                                    // answer written elsewhere — or a deployment with no model —
                                    // had nowhere to go. Same door as an edit: recorded as
                                    // yours, and no provider is called.
                                    html`<div class="metric-sub" style="margin-top:6px">
                                      Not written yet — write it yourself, or use “Write the next section” above to have the drafter write it.
                                    </div>
                                    ${pack.status === 'ISSUED'
                                      ? ''
                                      : html`<div style="margin-top:8px">
                                          <button class="btn quiet sm" data-revise="${pack.id}::${section.key}">Write it yourself</button>
                                        </div>`}`}
                              </div>`,
                            )}
                          </div>`,
                        )}
                    </div>`
                  : ''
              }
      </section>

      ${!projectId || assurance?.error
        ? ''
        : html`<section class="card" style="margin-bottom:14px" aria-labelledby="pl-asr-h">
            <h2 id="pl-asr-h">The red team</h2>
            <p class="metric-sub">
              Every other check on this screen runs for the submission: is each deliverable answered, is each deadline
              dated. This one runs against it. A pack that passes every completeness rule can still score nothing,
              because completeness is not the question a scorer asks — they ask whether they can find the answer and
              award the mark without inferring anything. A critical finding is a hard block nobody can wave through; a
              high one blocks until somebody records what they decided. A scored requirement whose findable marks fall
              below the pack's <b>quality floor</b> (80% by default, settable per pack) is raised as a high finding for
              exactly that reason — it blocks the issue until the answer reaches the floor or a named person records a
              reason to go out below it. The floor is the findable mark this review can measure, not the buyer's own
              mark, which no check can promise.
            </p>
            <div class="actions cmd-bar" style="margin:10px 0">
              ${raw(
                commandBar([
                  { id: 'bid-challenge', label: 'Attack the pack',
                    permitted: can('ESTIMATE_TENDER', 'C'), reason: blockedReason('ESTIMATE_TENDER', 'C') },
                  { id: 'bid-floor', label: 'Set the quality floor', tone: 'quiet',
                    permitted: can('ESTIMATE_TENDER', 'U'), reason: blockedReason('ESTIMATE_TENDER', 'U') },
                  { id: 'finding-dispose', label: 'Record a decision on a finding',
                    permitted: can('ESTIMATE_TENDER', 'A'), reason: blockedReason('ESTIMATE_TENDER', 'A') },
                  // Issue the pack, repeated here where the findings are decided.
                  // It is the step after the last decision, and it lived only in
                  // the pack bar two sections up — so a bidder who had just
                  // cleared the red team could not find it from where they were.
                  // Same command id, same gate; it refuses unless the pack is
                  // complete and the review clears.
                  { id: 'bid-issue', label: 'Issue the pack',
                    permitted: can('ESTIMATE_TENDER', 'A'), reason: blockedReason('ESTIMATE_TENDER', 'A') },
                ]),
              )}
            </div>
            <p class="metric-sub">${assurance?.summary ?? ''}</p>
            ${table({
              headers: ['Review', 'Findable marks', 'Floor', 'Below floor', 'Critical', 'High', 'Undecided', 'Judgement lens', 'Ran'],
              align: ['', 'num', 'num', 'num', 'num', 'num', 'num', '', ''],
              rows: (assurance?.reviews ?? []).map((review) => [
                review.reference,
                `${review.findableScorePercent}%`,
                review.qualityFloorPercent === undefined ? '—' : `${review.qualityFloorPercent}%`,
                (review.belowFloor ?? 0) > 0 ? badge(`${review.belowFloor} open`, 'warn') : badge('none', 'good'),
                review.critical > 0 ? badge(String(review.critical), 'bad') : '0',
                String(review.high),
                review.openHigh > 0 ? badge(`${review.openHigh} open`, 'warn') : badge('none', 'good'),
                review.modelRan ? badge('model challenged', 'ok') : badge('checks only', 'neutral'),
                time(review.runAt),
              ]),
              empty: 'No submission has been attacked yet. A pack nothing has challenged is not a pack nothing is wrong with.',
            })}
            ${latestReview
              ? html`
                  <h3 style="margin:15px 0 4px;font-size:13px">${latestReview.reference} — every finding</h3>
                  <p class="metric-sub" style="margin-bottom:8px">${latestReview.summary}</p>
                  ${table({
                    headers: ['Severity', 'Lens', 'Against', 'Finding', 'Raised by', 'Decision'],
                    rows: (latestReview.findings ?? []).map((f) => [
                      badge(f.severity.toLowerCase(), SEVERITY_TONE[f.severity] ?? 'neutral'),
                      humanise(f.lens),
                      f.sectionKey ?? f.reference ?? '—',
                      html`<b>${f.title}</b><br><span class="metric-sub">${f.detail} <i>${f.remedy}</i></span>`,
                      f.raisedBy === 'MODEL' ? badge('model', 'ok') : badge('check', 'neutral'),
                      f.disposition
                        ? html`${badge(humanise(f.disposition.decision), 'good')}<br><span class="metric-sub">${f.disposition.note}</span>`
                        : f.severity === 'CRITICAL'
                          ? badge('cannot be disposed of', 'bad')
                          : '—',
                    ]),
                    empty: 'Nothing was found against it.',
                  })}
                  ${(latestReview.limits ?? []).length > 0
                    ? html`<div class="notice warn" style="margin-top:10px">
                        <b>What this review cannot tell you.</b>
                        <ul style="margin:6px 0 0 16px">${(latestReview.limits ?? []).map((limit) => html`<li>${limit}</li>`)}</ul>
                      </div>`
                    : ''}
                `
              : ''}
          </section>`}

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Compliance matrices on file</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          ${focused
            ? html`The matrix for the tender you are working on.`
            : html`One matrix per tender: each live invitation’s current matrix, the one its documents merge into as they are read.
          ${supersededAnalyses > 0
            ? `${supersededAnalyses} superseded ${supersededAnalyses === 1 ? 'matrix is' : 'matrices are'} kept on the record behind them but not listed here.`
            : ''}`}
        </p>
        ${table({
          headers: ['Reference', 'Client', 'Returns', 'Requirements', 'Mandatory gaps', 'Bars', 'To ask', 'Exposure', 'Worst term', 'Verdict', ''],
          align: ['', '', '', 'num', 'num', 'num', 'num', 'num', '', '', ''],
          rows: shownAnalyses.map((a) => [
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
          empty: focused
            ? 'This tender has not been read into a matrix yet. Read the invitation above, and its matrix appears here.'
            : 'No invitation has been analysed yet',
        })}
        ${
          /*
           * The way back to a matrix that is not in the live list — a superseded
           * fragment, or one bound to a closed, won or lost tender, including a
           * reading confirmed onto the wrong tender by mistake. Collapsed by
           * default so it does not clutter, but it is here, and each one opens
           * into the same matrix detail as a live one, so nothing read is lost.
           */
          hiddenAnalyses.length > 0
            ? (() => {
                /*
                 * Two different things were being hidden under one misleading
                 * label. `a.bound` is the backend's truth: it is true only for
                 * the matrix a tender's invitation currently points at.
                 *
                 *  - `!a.bound` — an *earlier reading* of a tender. Reading a
                 *    second document merges into the tender's matrix and leaves
                 *    the previous one behind; it is not a separate tender and was
                 *    never "sent to the wrong project". It is history of a live
                 *    matrix, kept on the append-only ledger.
                 *  - `a.bound` but hidden — a matrix bound to a tender that is
                 *    closed, won or lost (or another project's, when you are not
                 *    focused on it). This is the one that could have been read
                 *    onto the wrong tender by mistake.
                 */
                const earlierReadings = hiddenAnalyses.filter((a) => !a.bound);
                const otherTenderMatrices = hiddenAnalyses.filter((a) => a.bound);
                const panelTable = (list) =>
                  table({
                    headers: ['Reference', 'Client', 'Returns', 'Requirements', 'Mandatory gaps', 'Bars', ''],
                    align: ['', '', '', 'num', 'num', 'num', ''],
                    rows: list.map((a) => [
                      a.reference,
                      a.clientName,
                      date(a.returnBy),
                      a.requirements,
                      html`<span style="${raw(a.mandatoryGaps > 0 ? 'color:var(--critical)' : '')}">${a.mandatoryGaps}</span>`,
                      html`<span style="${raw(a.bars > 0 ? 'color:var(--critical)' : '')}">${a.bars}</span>`,
                      html`<button class="btn sm" data-matrix="${a.analysisId}">Open</button>`,
                    ]),
                    empty: 'None',
                  });
                return html`<details style="padding:4px 17px 15px">
                <summary style="cursor:pointer;font-size:12.5px;color:var(--text-2)">
                  Show ${hiddenAnalyses.length} earlier and closed-tender ${hiddenAnalyses.length === 1 ? 'matrix' : 'matrices'}
                </summary>
                <div style="padding-top:8px">
                  ${earlierReadings.length > 0
                    ? html`<p style="font-size:12px;color:var(--text-3);margin:0 0 6px">
                        <strong>Earlier readings of a live tender (${earlierReadings.length}).</strong>
                        Each is a previous version of a tender’s matrix, from before the next document was read and merged in. The current matrix for the tender is in the list above — these are kept only so nothing read is ever lost.
                      </p>
                      ${panelTable(earlierReadings)}`
                    : ''}
                  ${otherTenderMatrices.length > 0
                    ? html`<p style="font-size:12px;color:var(--text-3);margin:${earlierReadings.length > 0 ? '14px' : '0'} 0 6px">
                        <strong>Bound to a closed, won or lost tender (${otherTenderMatrices.length}).</strong>
                        A matrix read onto the wrong tender shows up here. Open it, then re-read the invitation against the right tender above to move its requirements across.
                      </p>
                      ${panelTable(otherTenderMatrices)}`
                    : ''}
                </div>
              </details>`;
              })()
            : ''
        }
      </div>

      ${
        /*
         * The returnables matrix — the day-one control, as one table.
         *
         * Everything here is already on the record (the return register bound to
         * each invitation); what was missing was the single list a bid manager
         * works from — every return, what it is, who owns it, by when, where in
         * the invitation it comes from, and whether it still blocks the
         * submission. Focus-aware, like the board and the matrices above it.
         */
        (() => {
          const returnTenders = visibleBoard.filter((t) => (t.returns ?? []).length > 0);
          const total = returnTenders.reduce((n, t) => n + (t.returns ?? []).length, 0);
          if (total === 0) return '';
          const rows = returnTenders.flatMap((t) =>
            (t.returns ?? []).map((d) => {
              const missing = whatIsMissing(d);
              const blocking = d.mandatory && missing.length > 0;
              const dash = (v) => (v ? v : html`<span style="color:var(--critical)">—</span>`);
              return [
                focused ? d.reference : `${t.reference} · ${d.reference}`,
                d.title,
                d.mandatory ? badge('mandatory', 'bad') : badge('optional', ''),
                d.format ? d.format : '—',
                dash(d.owner ? humanise(d.owner) : ''),
                dash(d.internalDueBy ? date(d.internalDueBy) : ''),
                dash(d.source?.document ?? ''),
                blocking
                  ? badge(`blocks submission — ${missing.join(', ')}`, 'bad')
                  : missing.length > 0
                    ? badge(missing.join(', '), 'warn')
                    : badge('ready', 'ok'),
              ];
            }),
          );
          const blocking = returnTenders.reduce(
            (n, t) => n + (t.returns ?? []).filter((d) => d.mandatory && whatIsMissing(d).length > 0).length,
            0,
          );
          return html`<div class="card pad0" style="margin-bottom:14px">
            <h2 style="padding:15px 17px 0">Returnables — everything that has to go back</h2>
            <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
              ${focused
                ? 'Every return on the tender you are working on'
                : 'Every return across the live tenders'} — what it is, who owns it, your internal date, where in the
              invitation it comes from, and whether it still blocks the submission.
              ${blocking > 0
                ? html`${blocking} still ${blocking === 1 ? 'blocks' : 'block'} the submission — clear them all at once below, or one at a time with <b>Assign a return</b> above.`
                : 'Every mandatory return is owned, dated and sourced.'}
            </p>
            <div style="padding:8px 0 4px">
              ${table({
                headers: ['Return', 'What it is', 'Type', 'Format', 'Owner', 'Our date', 'Source', 'Status'],
                align: ['', '', '', '', '', '', '', ''],
                rows,
                empty: 'No returns recorded yet',
              })}
            </div>
            ${blocking > 0
              ? html`<div class="actions" style="padding:0 17px 15px">
                  ${raw(
                    commandBar([
                      {
                        id: 'assign-all-returns',
                        label: `Clear all ${blocking} blocking ${blocking === 1 ? 'return' : 'returns'}`,
                        tone: 'primary',
                        permitted: can('ESTIMATE_TENDER', 'U'),
                        reason: blockedReason('ESTIMATE_TENDER', 'U'),
                      },
                    ]),
                  )}
                </div>`
              : ''}
          </div>`;
        })()
      }

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
          ${raw(commandBar([
            { id: 'assert-claim', label: 'Assert a claim',
              permitted: can('ESTIMATE_TENDER', 'C'), reason: blockedReason('ESTIMATE_TENDER', 'C') },
            { id: 'link-claim', label: 'Link held evidence',
              permitted: can('ESTIMATE_TENDER', 'C'), reason: blockedReason('ESTIMATE_TENDER', 'C') },
            { id: 'verify-claim', label: 'Verify a claim',
              permitted: can('ESTIMATE_TENDER', 'A'), reason: blockedReason('ESTIMATE_TENDER', 'A') },
            { id: 'reject-claim', label: 'Refuse a claim', tone: 'quiet',
              permitted: can('ESTIMATE_TENDER', 'A'), reason: blockedReason('ESTIMATE_TENDER', 'A') },
          ]))}
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

      <!--
        The answer library.

        The qualitative half of a public bid carries 40–60% of the score, and
        the answers that earned it are thrown away after every submission — so
        the next bid writes the same social-value commitment from nothing, and
        nobody can say which version of it scored.

        Nothing on this panel writes an answer into a bid. Pressing "What do we
        have" returns candidates and the mark each one earned, and the section
        is still written by a person. That absence is the design: an answer
        pasted unchanged into forty bids is boilerplate, a buyer reading their
        fourth identical submission marks it as such, and the library converges
        on a permanent 3/5 — which is the failure it was built to fix.
      -->
      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">The answer library</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          ${library?.error ? 'The answer library could not be read.' : (library?.summary ?? '')}
          What this business says about itself, kept between bids with the mark each version earned where the buyer
          disclosed one. An answer is approved by somebody other than whoever captured it, because what sits here is
          what the company claims on every bid that takes it. Nothing is offered until it is approved, nothing is
          deleted, and nothing is pasted into a submission — a buyer reading their fourth identical answer marks it as
          their fourth identical answer.
        </p>
        <div style="padding:11px 17px 0">
          ${raw(commandBar([
            { id: 'capture-answer', label: 'Capture an answer',
              permitted: can('ESTIMATE_TENDER', 'C'), reason: blockedReason('ESTIMATE_TENDER', 'C') },
            { id: 'approve-answer', label: 'Approve for reuse',
              permitted: can('ESTIMATE_TENDER', 'A'), reason: blockedReason('ESTIMATE_TENDER', 'A') },
            // A revision creates a record rather than editing one, so it is
            // gated on C exactly as the capture is — the same verb the server
            // authorises it under.
            { id: 'revise-answer', label: 'Revise', tone: 'quiet',
              permitted: can('ESTIMATE_TENDER', 'C'), reason: blockedReason('ESTIMATE_TENDER', 'C') },
            { id: 'record-answer-use', label: 'Record a use and its mark', tone: 'quiet',
              permitted: can('ESTIMATE_TENDER', 'U'), reason: blockedReason('ESTIMATE_TENDER', 'U') },
            { id: 'retire-answer', label: 'Retire', tone: 'quiet',
              permitted: can('ESTIMATE_TENDER', 'A'), reason: blockedReason('ESTIMATE_TENDER', 'A') },
          ]))}
        </div>

        <!--
          A lookup, not a position: the library cannot say what it has until
          somebody says which requirement they are answering. The options are
          the categories the compliance matrix itself classifies requirements
          onto, read from the shared vocabulary, so this can never offer a
          category no requirement could carry.
        -->
        <div class="actions" style="padding:11px 17px 0;align-items:flex-end">
          <div class="field" style="margin:0;min-width:240px">
            <label for="answer-category">Answering which requirement?</label>
            <select id="answer-category">
              ${REQUIREMENT_CATEGORY.map((option) => html`<option value="${option.value}">${option.label}</option>`)}
            </select>
          </div>
          <button class="btn sm" id="answer-offer-go">What do we have</button>
        </div>
        <div id="answer-offer" style="padding:0 17px"></div>

        ${table({
          headers: ['Ref', 'Category', 'Answer', 'Words', 'Used', 'Median mark', 'Version', 'Standing'],
          align: ['', '', '', 'num', 'num', 'num', 'num', ''],
          rows: (library?.answers ?? []).map((answer) => [
            answer.reference,
            humanise(answer.category),
            answer.title,
            String(answer.words),
            String(answer.useCount),
            answer.medianScorePercent === null
              ? html`<span style="font-size:12px;color:var(--text-3)">no mark given</span>`
              : pct(answer.medianScorePercent, 0),
            `v${answer.version}`,
            badge(humanise(answer.status), ANSWER_TONE[answer.status] ?? ''),
          ]),
          empty: 'Nothing in the library yet',
          emptyDetail:
            'Capture the answers that worked while somebody still remembers they worked. The submission that scored ' +
            '92 last month is the one worth keeping, and it is already written.',
        })}

        ${
          (library?.limits ?? []).length > 0
            ? html`<div class="notice info" style="margin:11px 17px 15px"><div>
                ${library.limits.map((line) => html`<div>${line}</div>`)}
              </div></div>`
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
        // The win rate, and only where the record can carry one. A percentage
        // from three bids is noise, and the position withholds it rather than
        // printing it with a caveat nobody reads — so this panel shows the
        // count and the reason instead.
        winRate && !winRate.error
          ? html`<div class="card" style="margin-bottom:14px">
              <h2>Win rate ${winRate.overall.rate === null ? badge('not enough yet', 'neutral') : badge(`${winRate.overall.rate}%`, winRate.overall.rate >= 25 ? 'ok' : 'warn')}</h2>
              <p class="metric-sub" style="margin-bottom:10px">${winRate.summary}</p>
              <div class="grid g4">
                <div class="card">
                  <h2>Settled bids</h2>
                  <div class="metric">${winRate.overall.settled}</div>
                  <div class="metric-sub">${winRate.overall.won} won, ${winRate.overall.lost} lost. A no-bid never competed and is not counted.</div>
                </div>
                <div class="card">
                  <h2>Value won</h2>
                  <div class="metric good">${money(winRate.overall.valueWonMinor)}</div>
                  <div class="metric-sub">Of ${money(winRate.overall.valueBidMinor)} bid.</div>
                </div>
                ${
                  winRate.baseline
                    ? html`<div class="card">
                        <h2>Since ${winRate.baseline.on}</h2>
                        <div class="metric ${raw(winRate.baseline.movementPoints === null ? '' : winRate.baseline.movementPoints >= 0 ? 'good' : 'bad')}">
                          ${winRate.baseline.movementPoints === null ? '—' : `${winRate.baseline.movementPoints >= 0 ? '+' : ''}${winRate.baseline.movementPoints} pts`}
                        </div>
                        <div class="metric-sub">
                          ${winRate.baseline.before.settled} before, ${winRate.baseline.after.settled} after.
                        </div>
                      </div>`
                    : ''
                }
              </div>
              ${
                /*
                 * All four segments, not just the client.
                 *
                 * The position computes by client, sector, value band and
                 * source, and the first version of this panel rendered only
                 * the client — so three of the four were computed on every
                 * request and visible to nobody. The source one is the
                 * framework view: "lifted framework win rate from 17% to 28%"
                 * is the sentence this breakdown exists to let somebody say,
                 * and it was the one missing.
                 *
                 * Each is shown only where the record carries it. A business
                 * that never filled in a sector sees no sector table rather
                 * than an empty one.
                 */
                [
                  ['By client', winRate.byClient, 'Client'],
                  ['By framework, portal or introduction', winRate.bySource, 'Where it came from'],
                  ['By sector', winRate.bySector, 'Sector'],
                  ['By value', winRate.byValueBand, 'Value band'],
                ]
                  .filter(([, rows]) => rows.length > 0)
                  .map(
                    ([heading, rows, keyLabel]) => html`<div style="margin-top:12px">
                      <h2 style="font-size:13px">${heading}</h2>
                      ${table({
                        headers: [keyLabel, 'Settled', 'Won', 'Rate', 'Value won'],
                        align: ['', 'num', 'num', 'num', 'num'],
                        rows: rows.slice(0, 8).map((entry) => [
                          entry.key,
                          String(entry.settled),
                          String(entry.won),
                          entry.rate === null ? badge('withheld', 'neutral') : `${entry.rate}%`,
                          money(entry.valueWonMinor),
                        ]),
                      })}
                    </div>`,
                  )
              }
              ${
                winRate.limits.length > 0
                  ? html`<div class="notice info" style="margin-top:12px"><div>
                      ${winRate.limits.map((line) => html`<div>${line}</div>`)}
                    </div></div>`
                  : ''
              }
            </div>`
          : ''
      }

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
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          Score it against the ten factors, decide bid or no bid against what they come to, and record how it ended.
          Each is the gate in front of the next: a decision needs a score, and an outcome needs a decision. How a bid
          ended is the signal the calibration reads from. A loss had nowhere to go before this: it sat at <b>bid</b>
          for ever, so the pipeline could not tell a live tender from a dead one and the record learned nothing from
          it.
        </p>
        <div style="padding:11px 17px 0">
          ${raw(commandBar([
            // Score it, decide it, then record how it ended — in that order,
            // because each is the gate in front of the next and the first two
            // had no door on the screen that publishes the algorithm.
            /*
             * The one factor of the ten the platform can answer from evidence.
             *
             * Supply-chain capacity is a guess everywhere else: somebody
             * remembers roughly how many firms they have for groundworks. The
             * register knows exactly, and knows which trades have too few to
             * run a competitive enquiry — so this asks it, and suggests the
             * score rather than setting one. The register knows the count; it
             * does not know whether those firms would want the job.
             */
            { id: 'supply-chain-evidence', label: 'Ask the register about the trades', tone: 'quiet',
              permitted: can('BUSINESS_DEVELOPMENT', 'R') && tradeOptions.length > 0,
              reason: blockedReason('BUSINESS_DEVELOPMENT', 'R')
                ?? 'The trade catalogue could not be read, so there is nothing to ask about.' },
            { id: 'qualify', label: 'Score an opportunity', tone: '',
              permitted: can('BUSINESS_DEVELOPMENT', 'U') && scorable.length > 0,
              reason: blockedReason('BUSINESS_DEVELOPMENT', 'U')
                ?? 'Nothing is open to score. Register an opportunity above first.' },
            { id: 'decide', label: 'Decide bid or no bid', tone: '',
              permitted: can('BUSINESS_DEVELOPMENT', 'A') && decidable.length > 0,
              reason: blockedReason('BUSINESS_DEVELOPMENT', 'A')
                ?? 'Nothing is scored yet. A decision without a score is the habit this screen replaces.' },
            { id: 'bid-outcome', label: 'Record how a bid ended',
              permitted: can('BUSINESS_DEVELOPMENT', 'U') && opportunities.some((o) => o.stage === 'BID' || o.stage === 'CONVERTED'),
              reason: blockedReason('BUSINESS_DEVELOPMENT', 'U') ?? 'Nothing has reached a decision to bid' },
            { id: 'correct-outcome', label: 'Correct an outcome', tone: 'quiet',
              permitted: can('BUSINESS_DEVELOPMENT', 'A') && opportunities.some((o) => o.outcome),
              reason: blockedReason('BUSINESS_DEVELOPMENT', 'A')
                ?? 'No recorded outcome to correct. A correction reverses an outcome filed in error — a director-level act.' },
            { id: 'convert', label: 'Turn a win into a project',
              permitted: can('BUSINESS_DEVELOPMENT', 'A') && convertible.length > 0 && portfolios.length > 0,
              reason: blockedReason('BUSINESS_DEVELOPMENT', 'A')
                ?? (portfolios.length === 0
                  ? 'This tenancy holds no portfolio, and a project sits in one. Create one on Enterprise & Portfolio first.'
                  : 'Nothing is at a decision to bid and waiting for a project. A pursuit already linked to one is not converted twice.') },
          ]))}
        </div>
        ${table({
          headers: ['Opportunity', 'Client', 'Value', 'Score', 'Recommended', 'Stage', 'Outcome', 'Due'],
          align: ['', '', 'num', 'num', '', '', '', ''],
          rows: shownOpportunities.map((o) => {
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
              o.outcome
                ? badge(o.outcome.outcome === 'WON' ? 'won' : 'lost', o.outcome.outcome === 'WON' ? 'good' : 'bad')
                : '—',
              o.submissionDueAt ? date(o.submissionDueAt) : '—',
            ];
          }),
          empty: focused
            ? 'No opportunity is tied to the tender in focus. Show all tenders to see every pursuit.'
            : 'No opportunities registered',
        })}
      </div>

      <div class="card pad0" style="margin-bottom:14px">
        <div style="padding:15px 17px">
          <h2>The company's own facts</h2>
          <div class="metric-sub" style="margin-bottom:11px">
            Every screen above reads these. The radar will not screen an opportunity, and a bid cannot be scored,
            until the business has said what it is: what it turns over, where it works, what it is accredited for
            and how many jobs it can run at once. The platform asserts none of it on the company's behalf.
          </div>
          <div data-company-facts>
          ${raw(commandBar([
            {
              // The door that did not exist. `PUT /v1/company/profile` is what
              // the whole bid pipeline reads from, and there was no way to call
              // it from anywhere in the console — so the panel below reported
              // "This could not be read" to every company that had not somehow
              // set it through the API, with nothing on the screen to press.
              id: 'company-facts',
              label: profile?.error ? 'Record the company’s facts' : 'Update the company’s facts',
              permitted: can('BUSINESS_DEVELOPMENT', 'U'),
              reason: blockedReason('BUSINESS_DEVELOPMENT', 'U'),
            },
          ]))}
          </div>
        </div>
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
        {
          name: 'analysisId',
          label: 'Compliance matrix',
          type: 'select',
          options: shownAnalyses.map((a) => ({ value: a.analysisId, label: `${a.reference} · ${a.clientName}` })),
          /*
           * Why there is none, not merely that there is none.
           *
           * "This project holds no compliance matrix" is true and leaves
           * somebody with nowhere to go — and there are two quite different
           * reasons for it, with different remedies. A matrix is the buyer's
           * requirements set against this company's own facts, so with no
           * facts recorded it cannot be built at all; with facts recorded, it
           * is produced by reading an invitation and confirming the reading.
           */
          hint: profile?.error
            ? 'A matrix sets the buyer’s requirements against what this business holds, and this company’s facts are ' +
              'not recorded yet — so there is nothing to set them against. Record them at the bottom of this screen ' +
              'first; most of the form is already filled in from your own projects. Then read the invitation and ' +
              'confirm the reading.'
            : 'A matrix is produced by reading an invitation and confirming that reading. Read one above, confirm ' +
              'what it found, and it appears here. An enquiry that arrived as a letter asking for a price needs no ' +
              'matrix and no response pack — price it on Tender & Procurement and send the quotation.',
        },
      ],
    },
    'bid-replan': {
      title: 'Re-plan a pack from the scored questions',
      intent:
        'Plans the pack’s sections again under the current rule: where the buyer marks a questionnaire, the pack ' +
        'answers those questions and nothing else, and the scope, hazards and drawing notes stay on the compliance ' +
        'matrix as obligations the drafter writes from. Choose the tender’s current matrix — if you have since read ' +
        'its questionnaire, that is the newer one. A section whose question is still asked word for word keeps what ' +
        'was written; the dropped sections stay on the record. Nothing is charged.',
      path: (v) => `/v1/projects/${projectId}/bid-responses/${v.packId}/replan`,
      submitLabel: 'Re-plan',
      fields: [
        { name: 'packId', label: 'Pack', type: 'select',
          options: (bidPacks?.packs ?? [])
            .filter((pack) => pack.status !== 'ISSUED')
            .map((pack) => ({ value: pack.id, label: `${pack.reference} — ${pack.completeness?.total ?? 0} section(s)` })),
          emptyHint: 'Only a pack that has not been issued can be re-planned. Issuing is final.' },
        { name: 'analysisId', label: 'Compliance matrix', type: 'select',
          options: shownAnalyses.map((a) => ({ value: a.analysisId, label: `${a.reference} · ${a.clientName}` })) },
      ],
      transform: ({ packId: _packId, analysisId }) => ({ analysisId }),
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
            .map((pack) => ({ value: pack.id, label: `${pack.reference} — ${pack.completeness?.written ?? 0} of ${pack.completeness?.total ?? 0} written` })),
          emptyHint:
            'Only a pack that has not been issued can still be written. If every pack is off this list, they have all ' +
            'been issued — issuing is final. Plan a new response pack above to start another.' },
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
            .map((pack) => ({ value: pack.id, label: `${pack.reference} — ${pack.completeness?.summary ?? ''}` })),
          emptyHint:
            'Only a pack not yet issued can be issued, and issuing happens once. If the list is empty, every pack has ' +
            'already been issued — there is nothing left to send.' },
      ],
      transform: ({ packId: _packId }) => ({}),
    },
    /*
     * The red team — L7.3.
     *
     * Two doors, and the second is why the first is a gate rather than a
     * report. Attacking the pack produces findings; recording what was decided
     * about a high one is what lets the submission go out. A critical finding
     * has no door at all, because a hard block with a way round it is a
     * warning.
     */
    'bid-challenge': {
      title: 'Attack the pack',
      intent:
        'Scores the submission as the employer’s evaluator would, and reports what a scorer cannot award: a section ' +
        'that does not use the buyer’s own words, a placeholder nobody removed, a certificate that lapses before the ' +
        'return date, prose answering a requirement an addendum has since changed. Where a reasoning provider ' +
        'answers, a second model attacks the prose under a different prompt from the one that wrote it — and where ' +
        'one does not, the review says the judgement lens did not run rather than reporting an empty list.',
      path: (v) => `/v1/projects/${projectId}/bid-responses/${v.packId}/challenge`,
      submitLabel: 'Attack',
      ai: true,
      fields: [
        { name: 'packId', label: 'Pack', type: 'select',
          options: (bidPacks?.packs ?? [])
            .filter((pack) => pack.status !== 'ISSUED')
            .map((pack) => ({ value: pack.id, label: `${pack.reference} — ${pack.completeness?.summary ?? ''}` })),
          emptyHint:
            'The red team runs before a pack is issued, not after. If the list is empty, every pack has already been ' +
            'issued and can no longer be attacked — attack the next one before you issue it.' },
      ],
      transform: ({ packId: _packId }) => ({}),
    },
    'finding-dispose': {
      title: 'Record a decision on a finding',
      intent:
        'A high finding blocks the submission until a named person says what they decided about it. Fixed, accepted ' +
        'or waived, with the reasoning — the question three weeks later is never whether somebody clicked it, it is ' +
        'what they concluded and on what basis. A critical finding cannot be disposed of and is not offered here.',
      path: (v) =>
        `/v1/projects/${projectId}/assurance/${latestReviewId}/findings/${v.findingId}/disposition`,
      submitLabel: 'Record',
      fields: [
        { name: 'findingId', label: 'Finding', type: 'select',
          options: (latestReview?.findings ?? [])
            .filter((f) => f.severity !== 'CRITICAL' && !f.disposition)
            .map((f) => ({ value: f.id, label: `${f.severity} · ${f.title}` })),
          emptyHint:
            'This disposes of an open finding that is not critical. A critical finding is a hard block with no ' +
            'disposition — it is fixed, not decided — and one already decided is settled. An empty list means every ' +
            'high finding has a recorded decision, and only critical ones (if any) remain to fix.' },
        { name: 'decision', label: 'What was decided', type: 'select',
          options: [
            { value: 'FIXED', label: 'Fixed — the section has been rewritten' },
            { value: 'ACCEPTED', label: 'Accepted — we are going out with it as it stands' },
            { value: 'WAIVED', label: 'Waived — it does not apply to this submission' },
          ] },
        { name: 'note', label: 'On what basis', type: 'textarea',
          hint: 'At least 12 characters. What you concluded, not that you looked.' },
      ],
      transform: ({ findingId: _findingId, ...rest }) => rest,
    },
    'bid-floor': {
      title: 'Set the quality floor',
      intent:
        'The proportion of a scored requirement’s marks a scorer must be able to find before the pack may issue — ' +
        '80% (4/5) by default, settable per pack. A requirement answered below it is raised as a high finding and ' +
        'blocks the issue until the answer reaches the floor or a named person records a reason to go out below it. ' +
        'Changing the floor means the red team must be run again, because which requirements sit below it has moved.',
      path: (v) => `/v1/projects/${projectId}/bid-responses/${v.packId}/quality-floor`,
      submitLabel: 'Set',
      fields: [
        { name: 'packId', label: 'Pack', type: 'select',
          options: (bidPacks?.packs ?? [])
            .filter((pack) => pack.status !== 'ISSUED')
            .map((pack) => ({ value: pack.id, label: `${pack.reference} — floor ${pack.qualityFloorPercent ?? 80}%` })),
          emptyHint:
            'The quality floor is set before a pack is issued. If the list is empty, every pack has already been ' +
            'issued and its floor is fixed — the floor only governs a pack still being worked on.' },
        { name: 'floorPercent', label: 'Quality floor (%)', type: 'number', min: 0, max: 100,
          hint: 'The findable mark this review can measure, not the buyer’s own mark. 80 is the product’s 4/5.' },
      ],
      transform: ({ packId: _packId, floorPercent }) => ({ floorPercent: Number(floorPercent) }),
    },
    /*
     * The tender portal port — §4.8.1.
     *
     * The rules come from the invitation and are recorded against it; starting
     * the upload is a separate act with its own gate, because the check that
     * matters happens before anybody opens the portal.
     */
    'submission-rules': {
      title: 'Record the buyer’s submission rules',
      intent:
        'What the invitation said about filenames, formats, page and word limits and which documents are mandatory. ' +
        'Quote the buyer’s own words on each one — a rule with nothing behind it cannot be argued from when the ' +
        'submission is challenged. Mark a rule hard where failing it loses the bid.',
      path: (v) => `/v1/projects/${projectId}/tender/${v.analysisId}/submission-rules`,
      submitLabel: 'Record',
      fields: [
        { name: 'analysisId', label: 'Compliance matrix', type: 'select',
          options: shownAnalyses.map((a) => ({ value: a.analysisId, label: `${a.reference} · ${a.clientName}` })) },
        { name: 'kind', label: 'What kind of rule', type: 'select',
          options: [
            { value: 'REQUIRED_DOCUMENT', label: 'A document that must be in the submission' },
            { value: 'FILENAME', label: 'A naming convention every file must follow' },
            { value: 'FORMAT', label: 'The formats the buyer permits' },
            { value: 'WORD_LIMIT', label: 'A word limit on a response' },
            { value: 'PAGE_LIMIT', label: 'A page limit (recorded, and checked by a person)' },
            { value: 'FILE_SIZE', label: 'A file size limit (recorded, and checked by a person)' },
          ] },
        { name: 'stated', label: 'What the buyer said', type: 'textarea', rows: 2,
          hint: 'Their words, at least 8 characters. This is what gets quoted back.' },
        { name: 'hard', label: 'Does failing it lose the bid?', type: 'select',
          options: [
            { value: 'true', label: 'Yes — a hard rule, and readiness cannot reach 100 without it' },
            { value: 'false', label: 'No — reported, and does not block' },
          ] },
        { name: 'documentName', label: 'Document name', type: 'text', required: false,
          hint: 'For a required document' },
        { name: 'pattern', label: 'Naming pattern', type: 'text', required: false,
          hint: 'For a filename rule, as an expression — for example ^ABC-[0-9]{4}' },
        { name: 'formats', label: 'Permitted formats', type: 'text', required: false,
          hint: 'For a format rule. Comma separated, for example pdf, docx' },
        { name: 'maxWords', label: 'Word limit', type: 'number', required: false, min: 1 },
        { name: 'sectionKey', label: 'Which response section', type: 'text', required: false,
          hint: 'Leave blank to apply the limit to every section' },
        { name: 'maxPages', label: 'Page limit', type: 'number', required: false, min: 1 },
        { name: 'maxBytes', label: 'File size limit (bytes)', type: 'number', required: false, min: 1 },
      ],
      transform: ({ analysisId: _analysisId, kind, stated, hard, formats, ...rest }) => ({
        rules: [
          {
            kind,
            stated,
            hard: hard === 'true' || hard === true,
            ...(formats ? { formats: String(formats).split(',').map((x) => x.trim()).filter(Boolean) } : {}),
            ...Object.fromEntries(
              Object.entries(rest).filter(([, value]) => value !== undefined && value !== '' && value !== null),
            ),
          },
        ],
      }),
    },
    'submission-start': {
      title: 'Start the upload',
      intent:
        'A person works the buyer’s portal; this records that they started, what was checked first and how long was ' +
        'left. Refused unless the pack is locked and every hard rule the record can check is satisfied — and a hard ' +
        'rule the record cannot check, a page count or a file size, blocks too, because a check that could not run is ' +
        'not a check that passed. Inside the deadline buffer it needs a named director’s authorisation, and the ' +
        'authorisation is recorded with its reason.',
      path: (v) => `/v1/projects/${projectId}/bid-packs/${v.packId}/submission-start`,
      submitLabel: 'Start',
      fields: [
        { name: 'packId', label: 'Locked bid pack', type: 'text',
          hint: 'The pack the receipt will be bound to. Only a locked pack has a hash to bind to.' },
        { name: 'analysisId', label: 'Compliance matrix', type: 'select',
          options: shownAnalyses.map((a) => ({ value: a.analysisId, label: `${a.reference} · ${a.clientName}` })) },
        { name: 'adapterId', label: 'Through', type: 'select',
          options: (portalPort?.adapters ?? []).filter((adapter) => adapter.live).map((adapter) => ({ value: adapter.id, label: adapter.name })) },
        { name: 'returnBy', label: 'Returns by', type: 'datetime-local',
          hint: 'The buyer’s own deadline, which the buffer is measured back from' },
        { name: 'authorisedBy', label: 'Authorised by', type: 'text', required: false,
          hint: 'Only needed inside the deadline buffer. Name the director.' },
        { name: 'reason', label: 'Why so late', type: 'textarea', rows: 2, required: false,
          hint: 'At least 20 characters. Recorded, because the question afterwards is never whether somebody was in a hurry.' },
      ],
      transform: ({ packId: _packId, authorisedBy, reason, ...rest }) => ({
        ...rest,
        ...(String(authorisedBy ?? '').trim()
          ? { override: { authorisedBy: String(authorisedBy).trim(), reason: String(reason ?? '').trim() } }
          : {}),
      }),
    },
    /*
     * Score it, then decide it. Two doors the console never had.
     *
     * The factors are not listed here. They come from `/v1/pipeline/criteria`,
     * which is the same list the weighted total is computed from and the same
     * one the algorithm table above renders — so a factor added to the engine
     * appears in this panel without anybody remembering to add it, and a panel
     * that scored nine of ten factors is not a state this can reach. The scale
     * and its meaning come from the same place: the engine refuses anything
     * outside 1–5, and each field says what 5 and what 1 mean on that factor
     * rather than leaving somebody to guess which end is good.
     */
    /*
     * What the register says about the trades a job needs.
     *
     * A reading, not a record: it writes nothing and suggests a score rather
     * than setting one, because the register knows how many prequalified firms
     * cover each trade and does not know whether any of them would want this
     * job. The person scoring can disagree, and the panel says so.
     */
    'supply-chain-evidence': {
      title: 'Ask the register about the trades',
      intent:
        'Supply-chain capacity is the one factor of the ten the platform can answer from evidence rather than from ' +
        'memory. Pick the trades this job needs and the register says how many prequalified firms cover each, which ' +
        'have too few to run a competitive enquiry, and which are not on the register at all. It suggests a score; ' +
        'it does not set one — the register knows the count, not whether those firms would want the work.',
      path: '/v1/pipeline/supply-chain-evidence',
      submitLabel: 'Ask it',
      fields: [
        { name: 'trades', label: 'Trades this job needs', type: 'multiselect', options: tradeOptions,
          hint: 'The catalogue’s own trades, so the answer comes off the register rather than off a typed name ' +
            'nothing can match.' },
      ],
    },
    qualify: {
      title: 'Score an opportunity',
      intent:
        'The ten weighted factors, scored 1 to 5, where 5 is always the good end — including on the two named as ' +
        'risks, where reading the heading the other way round inverts the answer. The total, the band and the ' +
        'recommendation are computed from the published weights; nothing here is a judgement the platform makes. A ' +
        'single factor at 1 holds the job at a director’s desk however well the rest of it scored.',
      path: (v) => `/v1/pipeline/opportunities/${v.opportunityId}/qualify`,
      submitLabel: 'Score',
      fields: [
        { name: 'opportunityId', label: 'Opportunity', type: 'select',
          value: focusDefault((o) => o.stage !== 'CONVERTED' && o.stage !== 'NO_BID'),
          options: scorable.map((o) => ({
            value: o.id,
            label: `${o.title} · ${o.clientName}${o.qualification ? ` · scored ${o.qualification.score}` : ''}`,
          })),
          hint: 'A converted or declined pursuit cannot be re-scored and is not offered. Re-scoring a live one is ' +
            'recorded as a new qualification rather than an edit of the old.' },
        ...(criteria.criteria ?? []).map((c) => ({
          name: c.key,
          label: `${c.label} (weight ${c.weight})`,
          type: 'number',
          min: 1,
          max: 5,
          step: 1,
          hint: `${c.prompt} 5 — ${c.good}. 1 — ${c.bad}.`,
        })),
      ],
      // Whole numbers, because the engine takes integers and a browser that
      // accepted 3.5 would refuse the whole form on the tenth factor rather
      // than at the field that caused it.
      transform: (collected) => {
        const scores = {};
        for (const c of criteria.criteria ?? []) scores[c.key] = Math.round(Number(collected[c.key]));
        return scores;
      },
    },
    decide: {
      title: 'Decide bid or no bid',
      intent:
        'The decision, its rationale, and the authority it is taken under where it goes against the algorithm. ' +
        'Declining is always available and is never gated. Deciding to bid is a commercial call you make from the ' +
        'score — it needs the invitation read, but not every return assigned yet. Returns still without an owner, a ' +
        'source or a date are carried on the decision as outstanding and must be cleared before the submission goes out.',
      path: (v) => `/v1/pipeline/opportunities/${v.opportunityId}/decide`,
      submitLabel: 'Record the decision',
      fields: [
        { name: 'opportunityId', label: 'Opportunity', type: 'select',
          value: focusDefault((o) => Boolean(o.qualification)),
          options: decidable.map((o) => ({
            value: o.id,
            label: `${o.title} · ${o.qualification.score} · ${BAND_LABEL[o.qualification.recommendation] ?? o.qualification.recommendation}`,
          })),
          hint: 'The score and what the algorithm recommends on it are on each line, so the override is visible ' +
            'before it is taken rather than after.' },
        { name: 'bid', label: 'We are bidding', type: 'checkbox',
          hint: 'Unticked records a no-bid. A no-bid is a decision with a rationale, not an absence of one.' },
        { name: 'rationale', label: 'Why', type: 'textarea', rows: 3,
          hint: 'Required whichever way it goes. This is what the calibration is read against when the outcome comes ' +
            'back, so "the numbers said so" is not an answer.' },
        { name: 'conditionalBid', label: 'Conditional — authorise limited work to a condition', type: 'checkbox', required: false,
          hint: 'Tick with "we are bidding" when the go-ahead is limited: a named question must be answered before a full commitment. Fill the four fields below. Leave unticked for a full bid.' },
        { name: 'condition', label: 'The condition to resolve', type: 'textarea', rows: 2, required: false,
          hint: 'What limited work will answer — "can an approved HV switching contractor meet the outage dates?".' },
        { name: 'conditionOwner', label: 'Owner of the limited work', type: 'text', required: false,
          hint: 'Who runs the investigation. The person or office, not the system.' },
        { name: 'spendCap', label: 'Spend cap on it (£)', type: 'number', money: true, required: false,
          hint: 'The most this pursuit may cost before a full decision. An open-ended "look into it" is what this replaces.' },
        { name: 'killDate', label: 'Kill date', type: 'date', required: false,
          hint: 'The date the condition must be answered by, or the pursuit stops.' },
        { name: 'conditions', label: 'Conditions', type: 'textarea', rows: 2, required: false,
          hint: 'One per line — "provided the liquidated damages are capped". Recorded with the decision and reported ' +
            'against it.' },
        { name: 'delegatedTo', label: 'Authority delegated to', type: 'text', required: false,
          hint: 'Only needed where the decision goes against the recommendation, and then it is refused without it. ' +
            'The person or the office, not the system.' },
        { name: 'authorityReference', label: 'Under what authority', type: 'text', required: false,
          hint: 'The scheme of delegation, board minute or policy it comes from.' },
        { name: 'limitMinor', label: 'The limit that authority carries', type: 'number', money: true, required: false },
      ],
      transform: ({ bid, rationale, conditions, delegatedTo, authorityReference, limitMinor, conditionalBid, condition, conditionOwner, spendCap, killDate }) => ({
        bid: bid === true,
        rationale: String(rationale ?? '').trim(),
        ...(String(conditions ?? '').trim()
          ? { conditions: String(conditions).split('\n').map((line) => line.trim()).filter(Boolean) }
          : {}),
        ...(conditionalBid === true
          ? {
              conditional: {
                condition: String(condition ?? '').trim(),
                owner: String(conditionOwner ?? '').trim(),
                spendCapMinor: Math.round(Number(spendCap ?? 0)),
                killDate: String(killDate ?? '').trim(),
              },
            }
          : {}),
        ...(String(delegatedTo ?? '').trim()
          ? {
              authority: {
                delegatedTo: String(delegatedTo).trim(),
                ...(String(authorityReference ?? '').trim() ? { reference: String(authorityReference).trim() } : {}),
                ...(limitMinor === undefined || limitMinor === '' ? {} : { limitMinor: Number(limitMinor) }),
              },
            }
          : {}),
      }),
    },
    /*
     * The win, carried forward rather than re-keyed.
     *
     * This had no door, so a business that won a tender it had registered as a
     * pursuit created the delivery project by hand somewhere else — and the
     * project then pointed at nothing. The opportunity, its score, the decision
     * taken on it and the invitation behind it were all on the thread and all
     * unreachable from the job they produced. `originOpportunityId` is what
     * joins them, and converting is the only thing that sets it.
     *
     * The sector is not asked for: it is the pursuit's own, and asking again is
     * how one record says UTILITIES and the next says WATER.
     */
    convert: {
      title: 'Turn a win into a project',
      intent:
        'The pursuit becomes a delivery project carrying its own thread — the score, the decision, the invitation and ' +
        'the return register all stay reachable from the job. The estimate carries forward as the contract value ' +
        'unless a negotiated figure replaces it. Refused on anything not at a decision to bid.',
      path: (v) => `/v1/pipeline/opportunities/${v.opportunityId}/convert`,
      submitLabel: 'Create the project',
      fields: [
        { name: 'opportunityId', label: 'Which pursuit', type: 'select',
          value: focusDefault((o) => o.stage === 'BID' && !o.projectId && o.outcome?.outcome !== 'LOST'),
          options: convertible.map((o) => ({
            value: o.id,
            label: `${o.title} · ${o.clientName}${o.outcome?.outcome === 'WON' ? ' · recorded as won' : ' · no outcome recorded yet'}`,
          })),
          hint: 'A pursuit already linked to a project, and one recorded as lost, are not offered. Recording the ' +
            'outcome first is the better order — the calibration reads from it — but it is not required here.' },
        { name: 'projectName', label: 'Project name', type: 'text',
          hint: 'What it will be called in delivery. Often the pursuit’s title, and not always.' },
        { name: 'portfolioId', label: 'Portfolio', type: 'select', options: portfolios },
        { name: 'assetType', label: 'Asset type', type: 'text',
          hint: 'What is being built or serviced — "Reservoir spillway", "Domestic EPC assessments".' },
        { name: 'continentCode', label: 'Region', type: 'select', options: CONTINENT },
        { name: 'countryCode', label: 'Country', type: 'select', options: COUNTRY,
          hint: 'Where the works are. Stored as its ISO 3166-1 alpha-2 code.' },
        { name: 'city', label: 'City', type: 'text' },
        { name: 'currency', label: 'Currency', type: 'select',
          options: [
            { value: 'GBP', label: 'GBP — pound sterling' },
            { value: 'EUR', label: 'EUR — euro' },
            { value: 'USD', label: 'USD — US dollar' },
            { value: 'AED', label: 'AED — UAE dirham' },
          ] },
        { name: 'contractValue', label: 'Contract value (£)', type: 'number', money: true, required: false,
          hint: 'As it is written on the award. Left blank, the pursuit’s own estimate carries forward.' },
        { name: 'plannedStart', label: 'Planned start', type: 'date', value: today() },
        { name: 'plannedCompletion', label: 'Planned completion', type: 'date' },
      ],
      transform: (v) => ({
        projectName: v.projectName,
        portfolioId: v.portfolioId,
        assetType: v.assetType,
        location: { continentCode: v.continentCode, countryCode: v.countryCode, city: v.city },
        currency: v.currency,
        ...(v.contractValue === undefined || v.contractValue === '' ? {} : { contractValueMinor: Number(v.contractValue) }),
        plannedStart: v.plannedStart,
        plannedCompletion: v.plannedCompletion,
      }),
    },
    'bid-outcome': {
      title: 'Record how a bid ended',
      intent:
        'The outcome, the buyer’s marks where they gave any, the winning price where they disclosed it, and what the ' +
        'evaluator said. This is the signal the calibration reads from — without it the business loses the same money ' +
        'twice, because the next tender is priced by somebody who never saw what happened to the last one. Recorded ' +
        'once and not rewritten: an outcome that can be edited is one nothing can rely on.',
      path: (v) => `/v1/pipeline/opportunities/${v.opportunityId}/outcome`,
      submitLabel: 'Record',
      fields: [
        { name: 'opportunityId', label: 'Opportunity', type: 'select',
          value: focusDefault(outcomePending),
          options: (focused ? shownOpportunities : opportunities)
            .filter(outcomePending)
            .map((o) => ({ value: o.id, label: `${o.title} · ${o.clientName}` })),
          emptyHint: focused
            ? 'The tender in focus has no bid outcome left to record — it either carries one already (an outcome is ' +
              'written once and not rewritten) or has not reached a decision to bid. Show all tenders to record ' +
              'another pursuit’s outcome.'
            : 'This records the outcome of a bid that reached a decision to bid and has none yet. If the list is empty, ' +
              'every such bid already has its outcome on record — an outcome is written once and not rewritten.' },
        { name: 'outcome', label: 'How it ended', type: 'select',
          options: [{ value: 'WON', label: 'Won' }, { value: 'LOST', label: 'Lost' }] },
        { name: 'decidedOn', label: 'Decided on', type: 'date' },
        { name: 'ourPriceMinor', label: 'What we tendered', type: 'number', money: true, required: false,
          hint: 'Left blank, the opportunity’s own value is used' },
        { name: 'winningPriceMinor', label: 'The winning price', type: 'number', money: true, required: false,
          hint: 'Only on a loss, and only where the buyer disclosed it' },
        { name: 'winnerName', label: 'Who won', type: 'text', required: false },
        { name: 'qualityScorePercent', label: 'Quality mark (%)', type: 'number', required: false, min: 0, max: 100 },
        { name: 'commercialScorePercent', label: 'Commercial mark (%)', type: 'number', required: false, min: 0, max: 100 },
        { name: 'rank', label: 'Ranked', type: 'number', required: false, min: 1 },
        { name: 'tenderers', label: 'Out of', type: 'number', required: false, min: 1 },
        { name: 'reviewId', label: 'Assurance review of the submission', type: 'select', required: false,
          options: (assurance?.reviews ?? []).map((review) => ({
            value: review.id,
            label: `${review.reference} · ${review.findableScorePercent}% findable`,
          })),
          hint: 'Naming it is what lets the platform check the findable score against the mark the buyer actually gave' },
        { name: 'reasonClass', label: 'If lost, why (the class)', type: 'select', required: false,
          options: [
            { value: '', label: '—' },
            { value: 'UNCOMPETITIVE_PRICE', label: 'Price — we were too high' },
            { value: 'WEAK_QUALITY', label: 'Quality — the answers scored poorly' },
            { value: 'COMPLIANCE_FAILURE', label: 'Compliance — rejected, not marked down' },
            { value: 'POOR_FIT', label: 'Fit — the wrong job to chase' },
            { value: 'NO_FEEDBACK', label: 'No feedback given' },
            { value: 'OTHER', label: 'Other' },
          ],
          hint: 'The marks say how it scored; this says what to do differently. The calibration separates "we price too high" from "we write poor answers".' },
        { name: 'feedback', label: 'What the evaluator said', type: 'textarea', rows: 3, required: false,
          hint: 'One point per line. Kept verbatim — it is the most useful thing here.' },
      ],
      transform: ({ opportunityId: _opportunityId, feedback, reasonClass, ...rest }) => ({
        ...rest,
        ...(reasonClass ? { reasonClass } : {}),
        feedback: String(feedback ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
      }),
    },
    'correct-outcome': {
      title: 'Correct an outcome recorded in error',
      intent:
        'Reverses a bid outcome that was recorded against the wrong tender or by mistake — the one way back from a ' +
        'write-once result. The original stays on the record (this is a logged correction, not a quiet rewrite), and ' +
        'the pursuit returns to live so its true outcome can be recorded. A director-level act, kept with its reason.',
      path: (v) => `/v1/pipeline/opportunities/${v.opportunityId}/outcome/correction`,
      submitLabel: 'Correct it',
      fields: [
        { name: 'opportunityId', label: 'Opportunity', type: 'select',
          value: focusDefault((o) => Boolean(o.outcome)),
          options: (focused ? shownOpportunities : opportunities)
            .filter((o) => o.outcome)
            .map((o) => ({ value: o.id, label: `${o.title} · ${o.clientName} · recorded ${String(o.outcome.outcome).toLowerCase()}` })),
          emptyHint: 'No opportunity carries a recorded outcome to correct.' },
        { name: 'reason', label: 'Why the recorded outcome was wrong', type: 'textarea', rows: 2,
          hint: 'Kept on the record for the auditor. e.g. "Recorded as lost against the wrong tender — this bid is live and awaiting the result."' },
      ],
      transform: ({ opportunityId: _opportunityId, reason }) => ({ reason: String(reason ?? '').trim() }),
    },
    opportunity: {
      /*
       * The head of the delivery chain, and it had no door.
       *
       * `POST /v1/pipeline/opportunities` describes itself as "the head of the
       * delivery chain" and nothing in the console called it. Every command on
       * this screen needs one to act against — Record an ITT answers "this
       * needs an opportunity to act against, and this project holds none", the
       * scoring has nothing to score, the bands have nothing to calibrate
       * from — so a business with a live tender to bid opened Pipeline & Bids
       * and found no way to begin. The chain was complete except for its first
       * link.
       */
      title: 'Register an opportunity',
      intent:
        'A job worth pursuing, before anything is decided about it. Everything else on this screen acts against one: ' +
        'the invitation and its deadline, the ten-factor score, the bid or no-bid decision and the submission. ' +
        'Registering it is not deciding to bid — that is a separate, recorded decision.',
      path: '/v1/pipeline/opportunities',
      submitLabel: 'Register it',
      fields: [
        {
          /*
           * The job this pursuit is for, where it already exists.
           *
           * A business that joins an asset's lifecycle at tender opens the
           * project first — that is where its involvement begins — and then has
           * a tender to bid. With nothing to say so, the pipeline could not see
           * the project, and somebody with a live tender on the record was
           * asked to type its name, client, sector and value in again. What
           * that produces is two records of one job that nothing connects.
           *
           * Choosing one fills the rest of this form from it, so the two say
           * the same thing rather than nearly the same thing.
           */
          name: 'projectId',
          label: 'Is this for a project you already have?',
          type: 'select',
          required: false,
          options: [
            { value: '', label: '— No, this is a new pursuit —' },
            ...(projectList?.projects ?? []).map((project) => ({
              value: project.id,
              label: `${project.name} · ${humanise(String(project.phase ?? ''))}`,
            })),
          ],
          hint: 'A project opened at Tender is the usual case. Leave it as "no" for a job that is not on the record yet.',
        },
        // The three the project already answers. Optional, and left blank they
        // are taken from it — the platform refuses a different answer rather
        // than keeping two. Required only for a pursuit with no project behind
        // it, which the API enforces and says so.
        {
          name: 'title',
          label: 'What the job is',
          required: false,
          hint: 'Leave blank when a project is chosen — its name is used. Needed only for a pursuit with no project yet.',
        },
        { name: 'clientName', label: 'Client', hint: 'Always asked: a project does not record who is buying.' },
        {
          name: 'sectorType',
          label: 'Sector',
          type: 'select',
          required: false,
          options: [
            { value: '', label: '— From the project —' },
            ...SECTOR_GROUPED.flatMap((group) => group.options ?? [group]).map((o) => ({ value: o.value, label: o.label })),
          ],
        },
        {
          name: 'estimatedValue',
          label: 'Estimated value (£)',
          type: 'number',
          required: false,
          hint: 'Leave blank when a project is chosen — its contract value is used, and correcting the project corrects this.',
        },
        {
          name: 'source',
          label: 'Where it came from',
          /*
           * Suggestions from this tenancy's own prior answers, not a curated
           * list of UK frameworks — which would be wrong the first time
           * somebody bids through one nobody thought of, and wrong everywhere
           * outside the UK.
           *
           * It matters because this field is the framework breakdown on the
           * win-rate position. Typed freely, "SCAPE", "Scape framework" and
           * "SCAPE NPS" are three segments, each under the five-bid floor, so
           * each withholds its rate and the business can never say what its
           * framework win rate is — which is the one number a buyer of bid
           * support asks for. Offering what was typed last time makes the
           * second bid pick it rather than retype it.
           *
           * A datalist and not a select: a source nobody has used before has
           * to be enterable, and this is the platform's own distinction
           * between offering the recognised set and refusing the rest.
           */
          suggestions: [...new Set(opportunities.map((o) => String(o.source ?? '').trim()).filter(Boolean))].sort(),
          hint:
            'The portal, the framework, the person who told you. Pick the same words as last time where it is the ' +
            'same framework — the win rate is reported per source, and two spellings are two segments neither of ' +
            'which has enough bids to report.',
        },
        { name: 'submissionDueAt', label: 'Submission due', type: 'datetime-local', required: false, hint: 'The deadline as stated. It can be recorded precisely with the invitation afterwards.' },
        { name: 'countryCode', label: 'Country code', required: false, placeholder: 'GB' },
        { name: 'city', label: 'Town or city', required: false },
        { name: 'notes', label: 'Anything worth knowing', type: 'textarea', required: false },
      ],
      // Only what was actually answered. Sending an empty title or a zero value
      // would be the browser inventing an answer the person did not give, and
      // the platform would then have to decide which of two to believe.
      transform: (v) => ({
        ...(v.projectId ? { projectId: v.projectId } : {}),
        ...(v.title ? { title: v.title } : {}),
        clientName: v.clientName,
        ...(v.sectorType ? { sectorType: v.sectorType } : {}),
        ...(v.estimatedValue !== '' && v.estimatedValue !== undefined
          ? { estimatedValueMinor: Math.round(Number(v.estimatedValue) * 100) }
          : {}),
        source: v.source,
        ...(v.submissionDueAt ? { submissionDueAt: new Date(v.submissionDueAt).toISOString() } : {}),
        ...(v.countryCode ? { countryCode: String(v.countryCode).toUpperCase() } : {}),
        ...(v.city ? { city: v.city } : {}),
        ...(v.notes ? { notes: v.notes } : {}),
      }),
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

    /*
     * The enquiry that is a letter, not a tender pack.
     *
     * Most small works arrive this way: an architect writes, attaches the
     * drawings, and asks for a price by a date. There is no instructions-to-
     * tenderers document, no numbered return register, and nothing for the
     * invitation reader to find — it says so correctly, quoting the character
     * count, and then the bid sits blocked on "this invitation has not been
     * read" for ever.
     *
     * The gate is not asking for an AI reading. It is asking whether anybody
     * has written down what has to go back, and on a job like this the answer
     * is one line: a priced quotation, by a date. So this says exactly that, in
     * one press, rather than making somebody fill eleven fields to record the
     * least surprising fact in construction.
     *
     * It is a person stating it, not the platform inferring it. The gate stays
     * exactly as strict — the deliverable it files carries the owner, the
     * source and the internal date that every mandatory return needs.
     */
    'quote-only': {
      title: 'This enquiry asks only for a price',
      intent:
        'For an enquiry that arrived as a letter rather than a tender pack. It records one mandatory return — a ' +
        'priced quotation — with an owner, a date of our own and the document it came from, which is what the bid ' +
        'gate is actually asking for. Nothing is inferred: you are stating that this buyer asked for a price and ' +
        'nothing else, and anything else they turn out to want is added the same way.',
      path: (v) => `/v1/pipeline/tenders/${v.invitationId}/deliverables`,
      submitLabel: 'Record it',
      fields: [
        { name: 'invitationId', label: 'Invitation', type: 'select', options: scopedInvitationOptions },
        {
          name: 'owner',
          label: 'Who produces it',
          type: 'select',
          options: roleOptions,
          value: 'QS',
          hint: 'A mandatory return needs an owner before a bid can be approved.',
        },
        {
          name: 'internalDueBy',
          label: 'Our own date',
          type: 'date',
          min: today(),
          ...(board.length === 1 && board[0]?.deadline?.local
            ? { value: new Date(Date.parse(board[0].deadline.local) - 3 * 86_400_000).toISOString().slice(0, 10) }
            : {}),
          hint: 'Earlier than the buyer’s, and the one that actually binds. Suggested three days before the close.',
        },
        {
          name: 'sourceDocument',
          label: 'The document that asked',
          type: 'text',
          placeholder: 'The enquiry letter',
          hint: 'What it is traceable to. A mandatory return with no source is a promise nobody can check.',
        },
      ],
      transform: (v) => ({
        reference: 'Q-01',
        title: 'A priced quotation',
        mandatory: true,
        owner: v.owner,
        internalDueBy: v.internalDueBy,
        source: { document: v.sourceDocument },
      }),
    },
    /*
     * Reading an invitation into a compliance matrix.
     *
     * The grammar is the one this console already uses for structured input —
     * a line per row, fields separated by pipes — rather than a form with a
     * nested array in it. A matrix has a dozen requirements and a dozen
     * returns, and nobody fills twenty-four modals.
     *
     * Bound to the invitation rather than to a project, because that is what
     * `Plan a response pack` reads and because the matrix is about the buyer's
     * document, not about a job that may not exist yet.
     */
    requirements: {
      title: 'Read the invitation into a compliance matrix',
      intent:
        'The buyer’s requirements and the returns they ask for, set against this company’s own facts. Everything ' +
        'after this point takes the matrix it produces: planning a response pack, recording the submission rules, ' +
        'waiving a requirement, assessing an addendum. Every line carries where in the invitation it came from, so a ' +
        'requirement nobody can source is one somebody invented.',
      path: (v) => `/v1/pipeline/tenders/${v.invitationId}/requirements`,
      submitLabel: 'Read it',
      fields: [
        { name: 'invitationId', label: 'Invitation', type: 'select', options: scopedInvitationOptions },
        { name: 'reference', label: 'Their reference', type: 'text', hint: 'As the invitation prints it.' },
        { name: 'clientName', label: 'Client', type: 'text' },
        { name: 'returnBy', label: 'Return by', type: 'date', iso: true },
        { name: 'estimatedValue', label: 'Estimated value', type: 'number', money: true,
          hint: 'In whole currency units. What the work is worth, not what we will price it at.' },
        { name: 'durationWeeks', label: 'Duration (weeks)', type: 'number', min: 1 },
        { name: 'contractForm', label: 'Contract form', type: 'text', placeholder: 'JCT Measured Term Contract 2024' },
        { name: 'requirements', label: 'What they require', type: 'textarea', rows: 10,
          hint:
            'One per line as "ref | category | what they require | M or O | evidence needed | weight % | word limit". ' +
            'Only the first five matter. The category is theirs — Quality, Health and safety, Commercial.' },
        { name: 'deliverables', label: 'What has to be returned', type: 'textarea', rows: 8,
          hint:
            'One per line as "ref | what it is | M or O | format | page limit | SIG". A submission missing a required ' +
            'return is rejected exactly as completely as one missing an answer.' },
        { name: 'sourceDocument', label: 'Read from', type: 'text',
          hint: 'The document every line above was read out of — "Invitation to Tender, section 4".' },
        { name: 'paymentDays', label: 'Payment period (days)', type: 'number', required: false },
        { name: 'retentionPercent', label: 'Retention (%)', type: 'number', required: false },
        { name: 'targetMarginPercent', label: 'Target margin (%)', type: 'number', required: false },
        { name: 'confirmPlacement', label: 'This really belongs to the tender above (tick only if the misfile check wrongly flagged it)', type: 'checkbox', required: false,
          hint: 'Leave unticked. If the platform refuses because the client looks like another tender’s, read the message, make sure you picked the right invitation, then tick this to record it anyway.' },
      ],
      transform: (v) => {
        const lines = (value) =>
          String(value ?? '')
            .split('\n')
            .map((line) => line.split('|').map((part) => part.trim()))
            .filter((parts) => parts.length >= 3 && parts[0] && parts[1]);
        const source = { document: String(v.sourceDocument ?? '').trim() || 'Invitation to tender' };
        return {
          analysis: {
            reference: v.reference,
            clientName: v.clientName,
            returnBy: v.returnBy,
            estimatedValueMinor: Math.round(Number(v.estimatedValue)),
            durationWeeks: Number(v.durationWeeks),
            requirements: lines(v.requirements).map((parts) => ({
              reference: parts[0],
              category: parts[1] || 'General',
              requirement: parts[2] ?? '',
              mandatory: String(parts[3] ?? 'M').toUpperCase().startsWith('M'),
              evidenceRequired: parts[4] || 'Stated in the submission',
              ...(parts[5] ? { weightingPercent: Number(parts[5]) } : {}),
              ...(parts[6]
                ? { responseLimit: { words: Number(parts[6]), statedAs: `${parts[6]} words, as the invitation states` } }
                : {}),
            })),
            terms: {
              contractForm: v.contractForm,
              ...(String(v.paymentDays ?? '').trim() === '' ? {} : { paymentDays: Number(v.paymentDays) }),
              ...(String(v.retentionPercent ?? '').trim() === '' ? {} : { retentionPercent: Number(v.retentionPercent) }),
            },
            ...(String(v.targetMarginPercent ?? '').trim() === '' ? {} : { targetMarginPercent: Number(v.targetMarginPercent) }),
            ...(v.confirmPlacement ? { confirmPlacement: true } : {}),
          },
          deliverables: lines(v.deliverables).map((parts) => ({
            reference: parts[0],
            title: parts[1],
            mandatory: String(parts[2] ?? 'M').toUpperCase().startsWith('M'),
            ...(parts[3] ? { format: parts[3] } : {}),
            ...(parts[4] ? { pageLimit: Number(parts[4]) } : {}),
            ...(String(parts[5] ?? '').toUpperCase().includes('SIG') ? { signatureRequired: true } : {}),
            source,
          })),
        };
      },
    },
    deliverable: {
      title: 'Add a return deliverable',
      intent:
        'A mandatory deliverable needs a source in the invitation, an owner, and our own date — all three, before a bid ' +
        'can be approved. A bid disqualified for a missing certificate was priced correctly and lost anyway.',
      path: (v) => `/v1/pipeline/tenders/${v.invitationId}/deliverables`,
      submitLabel: 'Add',
      fields: [
        { name: 'invitationId', label: 'Invitation', type: 'select', options: scopedInvitationOptions },
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

    /*
     * Who here owns a return, and by when.
     *
     * Separate from "Add a deliverable" because the two acts are different and
     * the platform treats them differently: adding records what the buyer asked
     * for and refuses a reference already on the invitation; this commits this
     * company's own people against one that is already there. It cannot rename
     * a return, make a mandatory one optional, or move a limit the buyer set —
     * those come out of the invitation, and correcting them is a re-reading or
     * an addendum.
     */
    'assign-deliverable': {
      title: 'Assign a return',
      intent:
        'A mandatory return needs an owner, our own internal date and a source in the invitation before the submission ' +
        'can go out — the decision to bid is a commercial call you make from the score, and this planning follows it. ' +
        'Reading an invitation files what the buyer asked for and cannot file the first two, because neither is in the ' +
        'buyer’s document — they are this business committing its people. This is where they are committed.',
      path: (v) => `/v1/pipeline/tenders/${splitReturnTarget(v.target).invitationId}/deliverables/assign`,
      submitLabel: 'Assign',
      fields: [
        { name: 'target', label: 'Which return', type: 'select', options: scopedReturnOptions,
          hint: 'The ones blocking a bid are at the top, each with what it is missing.' },
        { name: 'owner', label: 'Owner', type: 'select', options: roleOptions, required: false,
          hint: 'The role that owns producing it. Required on anything mandatory.' },
        { name: 'internalDueBy', label: 'Our date', type: 'date', required: false,
          hint: 'Earlier than the buyer’s, and the one that actually binds. A date after the return raises a critical ' +
            'clarification rather than being silently accepted.' },
        { name: 'sourceDocument', label: 'Source document', type: 'text', required: false,
          placeholder: 'Instructions to Tenderers',
          hint: 'Only where the return has none. A return nobody can source is one somebody invented.' },
        { name: 'sourceClause', label: 'Clause', type: 'text', required: false },
        { name: 'sourcePage', label: 'Page', type: 'number', required: false, min: 1 },
      ],
      transform: (v) => ({
        reference: splitReturnTarget(v.target).reference,
        ...(v.owner ? { owner: v.owner } : {}),
        ...(v.internalDueBy ? { internalDueBy: v.internalDueBy } : {}),
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

    'assign-all-returns': {
      title: 'Assign every blocking return',
      intent:
        'Fills the owner, our internal date and the source on every mandatory return still missing one — in a single ' +
        'act rather than a form each. It touches only what is missing, so a return you deliberately gave a different ' +
        'owner or date is left as it is. The source defaults to the invitation itself: these returns were read out of ' +
        'it, so "where in the invitation it comes from" is the invitation — never yours to invent.',
      path: (v) => `/v1/pipeline/tenders/${v.invitationId}/deliverables/assign-all`,
      submitLabel: 'Assign them all',
      fields: [
        { name: 'invitationId', label: 'Tender', type: 'select', options: scopedInvitationOptions },
        { name: 'owner', label: 'Owner for all of them', type: 'select', options: roleOptions, value: 'OWNER',
          hint: 'For a one-director business this is you. Any return that already has an owner keeps it.' },
        { name: 'internalDueBy', label: 'Our internal date for all of them', type: 'date', required: true,
          hint: 'Required: a return with no date still blocks the submission. Earlier than the buyer’s return. ' +
            'Any return that already has its own date keeps it.' },
        { name: 'sourceDocument', label: 'Source document', type: 'text', required: false,
          placeholder: 'Leave blank to use the invitation',
          hint: 'Left blank, the source is the invitation these returns were read from — which is the honest answer.' },
      ],
      transform: (v) => ({
        ...(v.owner ? { owner: v.owner } : {}),
        ...(v.internalDueBy ? { internalDueBy: v.internalDueBy } : {}),
        ...(String(v.sourceDocument ?? '').trim() ? { source: { document: String(v.sourceDocument).trim() } } : {}),
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
        { name: 'invitationId', label: 'Invitation', type: 'select', options: scopedInvitationOptions },
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
        { name: 'invitationId', label: 'Invitation', type: 'select', options: scopedBiddableOptions,
          hint: 'Only tenders you have recorded a decision to bid on appear here — a programme is back-planned from that decision.',
          emptyHint: focused
            ? 'This tender has no recorded decision to bid yet, and a programme follows that decision (not the reading or the matrix — those do not decide the bid). On this screen: "Score an opportunity", then "Decide bid or no bid" and record the decision to bid. The programme then builds against it.'
            : 'No tender has a recorded decision to bid yet, and a programme follows that decision. On this screen: "Score an opportunity", then "Decide bid or no bid" for the tender you want a programme for, and record the decision to bid.' },
      ],
      transform: () => ({}),
    },
    'record-external-submission': {
      title: 'Record a submission made on the portal',
      intent:
        'For a bid you submitted on the buyer’s own portal (In-Tend, PSPS, a council site) rather than assembling it in ' +
        'here. Give the date it went in and the reference the portal returned, and the tender reads as submitted and ' +
        'awaiting its outcome — the guide stops asking you to prepare a bid that is already in. It records only that the ' +
        'bid was submitted; it makes no claim the platform built or checked it.',
      path: `/v1/projects/${projectId}/bid/external-submission`,
      submitLabel: 'Record it',
      fields: [
        { name: 'submittedOn', label: 'Date it was submitted', type: 'date',
          hint: 'The day the bid went in on the portal.' },
        { name: 'portalReference', label: 'Portal reference', type: 'text',
          placeholder: 'e.g. the In-Tend submission ID or receipt number',
          hint: 'The reference the portal gave back when you submitted. It is what proves the bid was in.' },
        { name: 'channel', label: 'Where it went', type: 'select', required: false, value: 'PORTAL',
          options: [
            { value: 'PORTAL', label: 'A tender portal (In-Tend, PSPS, a council site)' },
            { value: 'EMAIL', label: 'By email' },
            { value: 'PHYSICAL', label: 'Posted / courier' },
            { value: 'HAND_DELIVERY', label: 'Hand delivered' },
          ] },
      ],
      transform: (v) => ({
        submittedOn: String(v.submittedOn ?? '').trim(),
        portalReference: String(v.portalReference ?? '').trim(),
        ...(v.channel ? { channel: v.channel } : {}),
      }),
    },
  };

  // Opening a matrix, from either the invitation it belongs to or the list of
  // every matrix on file. One handler, because both buttons are asking for the
  // same thing and a second path to it would be a second thing to keep right.
  // The AI reading of an invitation: read it, then confirm or reject what it
  // read. Written out per action rather than assembled from a variable, so each
  // path is a quotable route the door invariant can see.
  root.addEventListener('click', async (event) => {
    // Focus the page on one tender. `openProject` is the same mechanism the
    // menu and the briefing use to select a project, so the reader, packs and
    // red team below follow to this tender without a second call, and the board
    // and matrices above narrow to it on the redraw.
    const focusTender = event.target.closest('[data-focus-tender]');
    if (focusTender) {
      await openProject(focusTender.getAttribute('data-focus-tender'));
      return;
    }
    // Step back out to every tender. `closeProject` clears the selection the
    // focus reads from and redraws; the lower half returns to its zero-state,
    // which is correct — there is no one tender's work to show any more.
    if (event.target.closest('[data-close-focus]')) {
      await closeProject();
      return;
    }

    const uploadTender = event.target.closest('[data-upload-tender]');
    if (uploadTender) {
      const filed = await command({
        title: 'Upload tender documents',
        intent:
          'A tender pack arrives in whatever the buyer’s portal produces — Word, a spreadsheet, a CSV, a PDF, a ' +
          'scan, a drawing set, a model, photographs of the site. Choose as many as the pack contains: each is ' +
          'filed as its own document with its own hash, because one document is one record. This records that a ' +
          'file with this content arrived as part of this tender, and nothing more. What the documents say is ' +
          'read afterwards, and a person confirms it.',
        path: `/v1/projects/${projectId}/tender/document`,
        submitLabel: 'File them',
        fields: [
          {
            name: 'hash',
            label: 'The documents',
            type: 'file',
            // Many, because a tender pack is many. Filing a twelve-file pack
            // one modal at a time is not something anybody does twelve times.
            multiple: true,
            // The file picker is not the place to argue about formats: the
            // platform takes the bytes whatever they are, says what it found,
            // and refuses to *read* what it cannot read — with the reason.
            voice: false,
            nameInto: 'filename',
            hint:
              'Select several at once — hold Ctrl, or ⌘ on a Mac. Each is hashed in your browser; the hash goes on ' +
              'the record first and the file follows it. A file over the platform’s per-file limit is refused here, ' +
              'before anything is written.',
          },
        ],
      });
      if (!filed) return;
      toast(
        'Filed',
        `${filed.description}. Each file is being stored in the background and appears as it finishes — a refresh will not lose any of them.`,
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

    const reclassify = event.target.closest('[data-reclassify]');
    if (reclassify) {
      reclassify.disabled = true;
      reclassify.textContent = 'Re-reading…';
      try {
        const result = await api.post(`/v1/projects/${projectId}/ingestion/${reclassify.dataset.reclassify}/reclassify`, {});
        toast(
          result.changed ? 'Read again' : 'Unchanged',
          result.changed
            ? `It reads as ${humanise(result.kind).toLowerCase()} now; it was ${humanise(result.previousKind).toLowerCase()}.`
            : `It still reads as ${humanise(result.kind).toLowerCase()}. The rules have not changed their answer for this file.`,
          result.changed ? 'ok' : 'info',
        );
      } catch (error) {
        toast('Not re-read', error.message, 'err');
      }
      await draw();
      return;
    }

    const takeOff = event.target.closest('[data-take-off]');
    if (takeOff) {
      takeOff.disabled = true;
      takeOff.textContent = 'Measuring…';
      try {
        await api.post(`/v1/projects/${projectId}/perception/take-off`, { hash: takeOff.dataset.takeOff });
        toast(
          'Measured',
          'The quantities are below, awaiting a person. Nothing reaches the bill until somebody confirms them.',
          'ok',
        );
      } catch (error) {
        toast('Not measured', error.message, error.code === 'PERCEPTION_PROVIDER_UNAVAILABLE' ? 'warn' : 'err');
      }
      // Either way: a reading that returned too little still files its draft,
      // and the draft is the evidence.
      await draw();
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
        // A file that read fine and simply holds no requirements — a streets
        // schedule, a drawing register — is not a read failure, and titling it
        // "Not read" over a body that says "the text came through" is the exact
        // contradiction that makes a bidder think the reader is broken when it
        // is telling the truth. Said as what it is instead.
        toast(
          error.code === 'PERCEPTION_NOT_LEGIBLE' ? 'No requirements in this file' : 'Not read',
          error.message,
          error.code === 'PERCEPTION_NOT_LEGIBLE' || error.code === 'PERCEPTION_PROVIDER_UNAVAILABLE' ? 'warn' : 'err',
        );
        /*
         * Redrawn on the failure too, because the failure wrote something.
         *
         * A reading that returns too little to confirm still files its draft —
         * that is deliberate, and the refusal says so: "Draft 01M2W… records
         * exactly what the reading returned, so it can be checked rather than
         * guessed at". Only `draw()` was on the success path, so the draft the
         * message pointed at did not appear until somebody reloaded the page by
         * hand. The platform told five people in a row that the evidence
         * existed and then did not put it on the screen.
         *
         * Now the reading appears below either way, with what it read and what
         * it found, which is the difference between "it failed" and "here is
         * what came back and why it was not enough".
         */
        await draw();
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
        // A file that read fine and simply holds no requirements — a streets
        // schedule, a drawing register — is not a read failure, and titling it
        // "Not read" over a body that says "the text came through" is the exact
        // contradiction that makes a bidder think the reader is broken when it
        // is telling the truth. Said as what it is instead.
        toast(
          error.code === 'PERCEPTION_NOT_LEGIBLE' ? 'No requirements in this file' : 'Not read',
          error.message,
          error.code === 'PERCEPTION_NOT_LEGIBLE' || error.code === 'PERCEPTION_PROVIDER_UNAVAILABLE' ? 'warn' : 'err',
        );
        readIt.disabled = false;
        readIt.textContent = 'Read it with a model that can see';
      }
      return;
    }

    const readBoq = event.target.closest('[data-read-boq]');
    if (readBoq) {
      readBoq.disabled = true;
      readBoq.textContent = 'Reading the schedule…';
      try {
        await api.post(`/v1/projects/${projectId}/perception/price-list-boq`, { hash: readBoq.dataset.readBoq });
        toast(
          'Read',
          'The bill of quantities is below, awaiting a person. Confirm it to write the bill — the reader returns ' +
            'quantities only, never a rate, so every line is yours to price.',
          'ok',
        );
        await draw();
      } catch (error) {
        toast(
          error.code === 'PERCEPTION_NOT_LEGIBLE' ? 'No priceable items in this file' : 'Not read',
          error.message,
          error.code === 'PERCEPTION_NOT_LEGIBLE' || error.code === 'PERCEPTION_PROVIDER_UNAVAILABLE' ? 'warn' : 'err',
        );
        readBoq.disabled = false;
        readBoq.textContent = 'Read as a pricing schedule';
      }
      return;
    }

    /*
     * Confirming a measurement writes the bill.
     *
     * `perception.confirm` runs `runTakeoff`, which needs the package the items
     * belong to and the cost-code prefix they are numbered under. Neither is on
     * the drawing — a package is how this business organises its work, and a
     * cost code is its own numbering — so both are asked rather than invented.
     */
    const confirmTakeoff = event.target.closest('[data-confirm-takeoff]');
    if (confirmTakeoff) {
      // The method of measurement the bill is drawn to. NRM2 is the building
      // default; a civils bill measured to the Highway Works method or CESMM is
      // tagged as such rather than mislabelled NRM2. The reader quotes what the
      // document states — pre-selected below — and the person confirms or
      // changes it. The backend normalises whatever is sent to a short tag.
      const METHODS = METHOD_OF_MEASUREMENT;
      const stated = (confirmTakeoff.dataset.method || '').trim();
      const matched = METHODS.find((m) => m.value.toLowerCase() === stated.toLowerCase());
      const methodOptions = [...METHODS];
      let methodValue = 'NRM2';
      if (stated && !matched) {
        methodOptions.unshift({ value: stated, label: `${stated} — as the document states it` });
        methodValue = stated;
      } else if (matched) {
        methodValue = matched.value;
      }
      const filed = await command({
        title: 'Confirm the measured quantities',
        intent:
          'Writes the measured items into the bill of quantities, each with the sheet it was measured from and the ' +
          'rule it was measured under. Confirming runs the same command as entering them by hand — the analyst, its ' +
          'authorisation and its ACU cost are unchanged. A quantity is not a rate: nothing here prices anything.',
        path: `/v1/projects/${projectId}/perception/${confirmTakeoff.dataset.confirmTakeoff}/confirm`,
        submitLabel: 'Confirm and write the bill',
        fields: [
          {
            name: 'packageId',
            label: 'Work package',
            hint: 'How this business organises the work — the package these items are measured against.',
          },
          {
            name: 'costCodePrefix',
            label: 'Cost code prefix',
            placeholder: 'E20',
            hint: 'Items are numbered from it — E20.001, E20.002. Your own numbering; the platform invents none.',
          },
          {
            name: 'measurementRule',
            label: 'Method of measurement',
            type: 'select',
            options: methodOptions,
            value: methodValue,
            hint:
              stated
                ? `The document names “${stated}”. Confirm it, or choose the method the bill is actually drawn to.`
                : 'The rule the bill is drawn to. NRM2 is building work; a civils bill measured to the Highway Works method (MMHW) or CESMM is tagged as such.',
          },
        ],
      });
      if (filed) {
        toast(
          'Written to the bill',
          `${filed.result?.boqItemIds?.length ?? 0} item(s) are now priceable. Build the estimate on Tender & Procurement.`,
          'ok',
        );
        await draw();
      }
      return;
    }

    const confirmIt = event.target.closest('[data-confirm-itt]');
    if (confirmIt) {
      /*
       * Refused before the form, not after it.
       *
       * Confirming builds the compliance matrix, and the matrix is the
       * company's own facts set against the buyer's requirements — which
       * accreditation is held, which insurance, what the business turns over.
       * Without them every line is UNKNOWN and there is no matrix, so
       * `analyseITT` refuses with COMPANY_PROFILE_NOT_SET.
       *
       * That refusal arrived *after* somebody had read an invitation, opened
       * this form, typed the value they expect to price and pressed the button
       * — naming a thing with no route to it. The door is on this very screen,
       * a panel further down. Said here, before the work, with the button that
       * fixes it.
       */
      if (profile?.error) {
        toast(
          'The company’s own facts are needed first',
          'The compliance matrix sets the buyer’s requirements against what this business actually holds — its ' +
            'accreditations, its insurances, what it turns over. None of that is recorded yet, so there is nothing to ' +
            'set them against. The form is open; most of it is already filled in from your own projects.',
          'warn',
        );
        // Opened, not pointed at. Scrolling somebody to a button is still
        // asking them to go and find it, and this is the third refusal in a
        // row somebody has met while trying to price one wall.
        await recordCompanyFacts();
        return;
      }
      // Only the invitation is required. The value, duration and margin are
      // optional: the matrix needs none of them, and an estimator cannot give a
      // contract value before the take-off. Left blank, the commercial-term risk
      // (damages, retention, bond) is sized later once the job is priced; filled
      // in, it is sized now.
      const accepted = await command({
        title: 'Confirm what the AI read',
        intent:
          'Confirming files the reading through the same commands as typing the requirements in by hand — the ' +
          'analyst, its authorisation and its ACU cost are unchanged. Only the invitation is needed. The three ' +
          'figures below are optional and are not in the invitation — leave them blank if you have not priced the ' +
          'job yet, and the contract-term risk is sized once you have.',
        path: () => `/v1/projects/${projectId}/perception/${confirmIt.dataset.confirmItt}/confirm`,
        submitLabel: 'Confirm and build the matrix',
        fields: [
          {
            name: 'invitationId',
            label: 'Against which invitation',
            type: 'select',
            options: scopedInvitationOptions,
            hint: 'The reading is filed against the invitation it came from.',
          },
          {
            name: 'estimatedValue',
            label: 'What we expect to price (£) — optional',
            type: 'number',
            step: '1',
            required: false,
            hint: 'Leave blank until you have priced the job. Only used to size damages, retention and bond risk.',
          },
          { name: 'durationWeeks', label: 'Priced over (weeks) — optional', type: 'number', step: '1', required: false,
            hint: 'Leave blank until the programme is set.' },
          {
            name: 'targetMarginPercent',
            label: 'Target margin (%) — optional',
            type: 'number',
            step: '0.1',
            required: false,
            hint: 'Left blank, the company profile’s own minimum is used.',
          },
        ],
        transform: (v) => ({
          invitationId: v.invitationId,
          // Pounds in the form, minor units on the wire. Omitted when blank, so a
          // value nobody has yet is absent rather than a misleading zero.
          ...(v.estimatedValue !== '' && v.estimatedValue !== undefined
            ? { estimatedValueMinor: Math.round(Number(v.estimatedValue) * 100) }
            : {}),
          ...(v.durationWeeks !== '' && v.durationWeeks !== undefined ? { durationWeeks: Number(v.durationWeeks) } : {}),
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

    /*
     * From the site visit date to the register that records what it found.
     *
     * Through the shell's own `goTo`, which switches project and navigates in
     * one act — the pipeline is tenant-scoped and a site visit is written to a
     * project, so arriving on the right screen looking at the wrong job would
     * be worse than not offering the button.
     */
    const visitButton = event.target.closest('[data-site-visit]');
    if (visitButton) {
      await goTo('field', visitButton.dataset.siteVisit);
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
      const [analysis, waivers, addenda, coverage] = await Promise.all([
        api.get(`/v1/pipeline/analyses/${analysisId}`),
        // Read separately rather than folded into the analysis: a waiver is a
        // decision made after the invitation was read, and putting it inside the
        // analysis record would mean rewriting a committed analysis every time
        // somebody granted one.
        api.read(`/v1/pipeline/analyses/${analysisId}/waivers`, 'ESTIMATE_TENDER', 'COMMERCIAL_L3').catch(() => null),
        api.read(`/v1/pipeline/analyses/${analysisId}/addenda`, 'ESTIMATE_TENDER', 'COMMERCIAL_L3').catch(() => null),
        // The held evidence read against this matrix, live, for the same reason:
        // a claim filed after the analysis still shows here without a re-analysis.
        api.read(`/v1/pipeline/analyses/${analysisId}/evidence-coverage`, 'ESTIMATE_TENDER', 'COMMERCIAL_L3').catch(() => null),
      ]);
      render(detail, matrixDetail(analysis, waivers, addenda, coverage));
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

  // One press raises the analysis's own "Questions for the buyer" onto the
  // clarification register, to the client — the structured form of that list,
  // so nobody retypes the AI's questions into a delimited box. Idempotent: the
  // backend skips a question already raised.
  // The AI expert review: a bid-manager read of the tender for genuine
  // clarification questions. It proposes; nothing is raised until a person
  // presses "Raise this" on one, which puts it on the register where it can be
  // sent. The whole result is advice, re-fetched each press — nothing is stored.
  root.addEventListener('click', async (event) => {
    const reviewBtn = event.target.closest('[data-ai-review]');
    if (!reviewBtn) return;
    const reviewProjectId = reviewBtn.dataset.aiReview;
    const results = root.querySelector(`[data-ai-review-results="${reviewProjectId}"]`);
    reviewBtn.disabled = true;
    reviewBtn.textContent = 'Reading the tender…';
    try {
      const review = await api.post(`/v1/projects/${reviewProjectId}/tender-clarifications/ai-review`, {});
      const proposed = review.proposed ?? [];
      if (!review.available) {
        if (results) results.innerHTML = '';
        toast('Review unavailable', review.note ?? 'The expert review could not run on this deployment.', 'warn');
      } else if (proposed.length === 0) {
        if (results) results.innerHTML = resolveHtml(html`<div class="empty" style="margin:0"><b>Nothing to ask</b>${review.note ?? ''}</div>`);
        toast('Reviewed', review.note ?? 'Nothing needs asking.', 'ok');
      } else if (results) {
        results.innerHTML = resolveHtml(html`
          <div class="notice" style="margin:0 0 8px"><div style="font-size:12px">${review.note ?? ''} Each proposal quotes the passage it comes from — verify it, then raise the ones worth sending.</div></div>
          ${proposed.map(
            (p) => html`<div class="card pad" style="margin-bottom:8px">
              <div style="font-weight:600;font-size:13px;margin-bottom:3px">${p.subject}</div>
              <div style="font-size:12.5px;margin-bottom:5px">${p.question}</div>
              <div style="font-size:11.5px;color:var(--text-3);margin-bottom:6px"><b>Basis:</b> ${p.basis}</div>
              <button class="btn quiet sm" data-raise-one="1" data-rp="${reviewProjectId}" data-subject="${p.subject}" data-question="${p.question}">Raise this to the client</button>
            </div>`,
          )}`);
        toast('Reviewed', `${proposed.length} question${proposed.length === 1 ? '' : 's'} proposed. Verify each against the tender before raising.`, 'ok');
      }
    } catch (error) {
      toast('Review failed', error.message, isRoleDenial(error) ? 'warn' : 'err');
    } finally {
      reviewBtn.disabled = false;
      reviewBtn.textContent = 'Ask the AI to review the tender (expert clarifications)';
    }
    return;
  });

  // Raise one AI-proposed question onto the clarification register, verbatim.
  // From here it follows the ordinary flow — copy and send on Tender & Procurement.
  root.addEventListener('click', async (event) => {
    const raiseOne = event.target.closest('[data-raise-one]');
    if (!raiseOne) return;
    const rp = raiseOne.dataset.rp;
    const subject = raiseOne.dataset.subject;
    const question = raiseOne.dataset.question;
    raiseOne.disabled = true;
    raiseOne.textContent = 'Raising…';
    try {
      const result = await api.post(`/v1/projects/${rp}/tender-clarifications/batch`, {
        items: [{ side: 'CLIENT', subject, question, links: { document: 'Invitation' } }],
      });
      const ref = result.raised?.[0]?.reference;
      toast('Raised to the client', `${ref ?? 'The question'} is on the clarification register — copy and send it on Tender & Procurement before the clarification deadline.`, 'ok');
      raiseOne.textContent = 'Raised ✓';
    } catch (error) {
      toast('Not raised', error.message, isRoleDenial(error) ? 'warn' : 'err');
      raiseOne.disabled = false;
      raiseOne.textContent = 'Raise this to the client';
    }
    return;
  });

  root.addEventListener('click', async (event) => {
    const raiseBtn = event.target.closest('[data-raise-clars]');
    if (!raiseBtn) return;
    const analysisId = raiseBtn.dataset.raiseClars;
    const raiseProjectId = raiseBtn.dataset.raiseProject;
    raiseBtn.disabled = true;
    raiseBtn.textContent = 'Raising…';
    try {
      const result = await api.post(`/v1/projects/${raiseProjectId}/tender-clarifications/from-analysis`, { analysisId });
      const raised = result.raised?.length ?? 0;
      toast(
        raised > 0 ? `${raised} clarification${raised === 1 ? '' : 's'} raised to the client` : 'Nothing new to raise',
        raised > 0
          ? `${result.raised.map((entry) => entry.reference).join(', ')}` +
              `${result.skipped > 0 ? ` · ${result.skipped} already on the register` : ''}` +
              ' — send and record the answers on Tender & Procurement.'
          : `All ${result.total} are already on the register.`,
        'ok',
      );
    } catch (error) {
      toast('Not raised', error.message, isRoleDenial(error) ? 'warn' : 'err');
    } finally {
      raiseBtn.disabled = false;
      raiseBtn.textContent = 'Raise these to the client';
    }
  });

  // Confirm the drafted compliance undertakings — the agent wrote them; this
  // records that a person declares each true. Idempotent on the backend.
  root.addEventListener('click', async (event) => {
    const confirmBtn = event.target.closest('[data-confirm-undertakings]');
    if (!confirmBtn) return;
    const analysisId = confirmBtn.dataset.confirmUndertakings;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Confirming…';
    try {
      const result = await api.post(`/v1/pipeline/analyses/${analysisId}/undertakings`, {});
      const n = result.confirmed?.length ?? 0;
      toast(
        n > 0 ? `${n} undertaking${n === 1 ? '' : 's'} confirmed` : 'Nothing new to confirm',
        n > 0
          ? `Recorded as declared true${result.already > 0 ? ` · ${result.already} already confirmed` : ''}.`
          : `All ${result.total} are already confirmed.`,
        'ok',
      );
      // Re-open the matrix so the confirmed lines show immediately.
      const open = root.querySelector(`[data-matrix="${analysisId}"]`);
      if (open) open.click();
    } catch (error) {
      toast('Not confirmed', error.message, isRoleDenial(error) ? 'warn' : 'err');
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm all as true';
    }
  });

  /*
   * Cutting one section to length.
   *
   * A button per over-length section rather than a command form, because there
   * is nothing to ask: the pack and the section are what the refusal named, and
   * the limit is the buyer's. It is an AI pass and it is charged, so the press
   * says what it is doing and the result says what came off.
   */
  // Redraft one section that still holds a note to the bid team. An AI pass,
  // charged like the first draft, so the press says what it is doing; a section a
  // person rewrote is refused by the server and the refusal says to edit it.
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-redraft]');
    if (!button || !projectId) return;

    button.disabled = true;
    button.textContent = 'Redrafting…';
    try {
      const result = await api.post(
        `/v1/projects/${projectId}/bid-responses/${button.dataset.pack}/sections/${encodeURIComponent(button.dataset.redraft)}/redraft`,
        {},
      );
      toast(
        `${button.dataset.redraft} redrafted`,
        `${result.written.words} words. Read it before issuing — it is a draft. ${result.acuConsumed} ACUs.`,
        'ok',
      );
      await draw();
    } catch (error) {
      toast('Not redrafted', error.detail ?? error.message ?? 'The section is unchanged.', 'err');
      button.disabled = false;
      button.textContent = 'Redraft this section';
    }
  });

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-shorten]');
    if (!button || !projectId) return;

    button.disabled = true;
    button.textContent = 'Cutting…';
    try {
      const result = await api.post(
        `/v1/projects/${projectId}/bid-responses/${button.dataset.pack}/sections/${encodeURIComponent(button.dataset.shorten)}/shorten`,
        {},
      );
      toast(
        `${button.dataset.shorten} cut to length`,
        `${result.wordsRemoved} words removed, now ${result.section.words} against the buyer’s limit. ` +
          `${result.acuConsumed} ACUs.`,
        'ok',
      );
      await draw();
    } catch (error) {
      // A cut that came back still over leaves the section exactly as it was,
      // and the message says so — it is a refusal, not a failure to save.
      toast('Not cut', error.detail ?? error.message ?? 'The section is unchanged.', 'err');
      button.disabled = false;
      button.textContent = 'Cut it to length';
    }
  });

  /*
   * Read-and-edit, the last mile of the submission. A drafted section could be
   * counted but never seen or changed until this; now Edit opens the answer
   * pre-filled so the real project names and team go in, and Copy lifts it out.
   */
  root.addEventListener('click', async (event) => {
    const reviseBtn = event.target.closest('[data-revise]');
    if (reviseBtn && projectId) {
      const [packId, key] = String(reviseBtn.dataset.revise).split('::');
      const found = fullPacks.find((fp) => fp.pack.id === packId);
      const section = found?.sections.find((s) => s.key === key);
      const current = (section?.body ?? []).join('\n\n');
      const result = await command({
        title: `Edit — ${section?.title ?? key}`,
        intent:
          'Rewrite this answer in your own words: put your real project names, your team and your figures in. A blank ' +
          'line starts a new paragraph. Saving records it as yours, not the model’s, and calls no provider.',
        path: `/v1/projects/${projectId}/bid-responses/${packId}/sections/${encodeURIComponent(key)}/revise`,
        submitLabel: 'Save this answer',
        fields: [
          {
            name: 'text',
            label: 'The answer, as the buyer will read it',
            type: 'textarea',
            rows: 16,
            value: current,
            hint: 'One blank line between paragraphs. Nothing here is sent to a model — this is your text.',
          },
        ],
        transform: (v) => ({
          body: String(v.text || '')
            .split(/\n\s*\n/)
            .map((p) => p.replace(/[ \t]+/g, ' ').trim())
            .filter(Boolean),
        }),
      });
      if (result) {
        toast('Saved', 'Your version is recorded against the pack.', 'ok');
        await draw();
      }
      return;
    }

    const copyBtn = event.target.closest('[data-copy-section]');
    if (copyBtn) {
      const [packId, key] = String(copyBtn.dataset.copySection).split('::');
      const found = fullPacks.find((fp) => fp.pack.id === packId);
      const section = found?.sections.find((s) => s.key === key);
      const text = (section?.body ?? []).join('\n\n');
      try {
        await navigator.clipboard.writeText(text);
        toast('Copied', 'The answer is on your clipboard.', 'ok');
      } catch {
        toast('Could not copy', 'Your browser blocked the clipboard — select the text and copy it by hand.', 'err');
      }
      return;
    }

    // The whole submission as a branded, downloadable file — the end-to-end
    // answer: the submission is produced and downloaded in the platform, not
    // copied out and finished elsewhere. The clipboard copy below stays as the
    // quick option for pasting into a portal's own text boxes.
    const tpDraft = event.target.closest('[data-tp-draft]');
    if (tpDraft) {
      const done = await command({
        title: 'Draft the tender programme',
        intent:
          'Reads your measured bill and the tender’s own programme requirements and drafts the activities, durations, ' +
          'logic, resources and a risk allowance. The platform checks it with its critical-path engine against the ' +
          'period and the bank holidays. It is an AI pass and is charged; nothing is written to the programme until you ' +
          'confirm it.',
        path: `/v1/projects/${state.session.projectId}/programme/tender-draft`,
        submitLabel: 'Draft it',
        fields: [
          { name: 'startDate', label: 'Start on site', type: 'date', hint: 'The first day of work on site.' },
          {
            name: 'completionDate',
            label: 'Completion date the buyer fixed',
            type: 'date',
            required: false,
            hint: 'From the contract data or the invitation. Give this or the period below — the date wins.',
          },
          {
            name: 'periodDays',
            label: 'Or: construction period (calendar days)',
            type: 'number',
            required: false,
            hint: 'Only if the buyer gave a period rather than a date — 84 for twelve weeks.',
          },
          {
            name: 'guidance',
            label: 'What you know that the bill does not say',
            type: 'textarea',
            required: false,
            hint:
              'For example “road closure from 18/01/2027; grout cures 7 days before testing”. Passed to the drafter ' +
              'as your guidance, never as a fact about the tender.',
          },
        ],
      });
      if (done) {
        toast(
          'Programme drafted',
          `${done.draft.activities.length} activities, finishing ${done.draft.forecast.finishDate}` +
            `${done.draft.forecast.fits ? '' : ' — after the completion date'}. Check it, then confirm.`,
          done.draft.forecast.fits ? 'ok' : '',
        );
        await draw();
      }
      return;
    }

    const tpConfirm = event.target.closest('[data-tp-confirm]');
    if (tpConfirm) {
      tpConfirm.disabled = true;
      try {
        const result = await api.post(
          `/v1/projects/${state.session.projectId}/programme/tender-drafts/${tpConfirm.dataset.tpConfirm}/confirm`,
          {},
        );
        toast('Programme confirmed', `It is now this project’s programme, finishing ${result.finishDate}.`, 'ok');
        await draw();
      } catch (error) {
        toast('Not confirmed', error.detail ?? error.message ?? 'The programme is unchanged.', 'err');
        tpConfirm.disabled = false;
      }
      return;
    }

    const tpDownload = event.target.closest('[data-tp-download]');
    if (tpDownload) {
      try {
        await api.download(`/v1/projects/${state.session.projectId}/programme/tender.pdf`, {
          format: tpDownload.dataset.tpDownload,
        });
        toast('Downloaded', 'Your tender programme has been saved.', 'ok');
      } catch (error) {
        toast('Could not download', error?.message ?? 'Could not generate the programme.', 'err');
      }
      return;
    }

    const downloadPackBtn = event.target.closest('[data-download-pack]');
    if (downloadPackBtn) {
      try {
        await api.download(
          `/v1/projects/${state.session.projectId}/bid-responses/${downloadPackBtn.dataset.downloadPack}/submission.pdf`,
          { format: 'PDF' },
        );
        toast('Downloaded', 'Your submission PDF has been saved.', 'ok');
      } catch (error) {
        toast('Could not download', error?.message ?? 'Could not generate the submission PDF.', 'err');
      }
      return;
    }

    // The whole submission in one paste — for the person at the portal who has
    // to attach a single document rather than fill thirteen boxes. It assembles
    // exactly what is on the pack, in order, each answer under its question, so
    // the attached document and the platform's record say the same thing. Only
    // written sections are included; an unwritten one is named so a gap in the
    // paste is a fact rather than a surprise on the return date.
    const copyPackBtn = event.target.closest('[data-copy-pack]');
    if (copyPackBtn) {
      const found = fullPacks.find((fp) => fp.pack.id === copyPackBtn.dataset.copyPack);
      if (!found) return;
      const blocks = found.sections.map((section) => {
        // The full requirement, never the 67-character title: this text is
        // pasted into the buyer's portal.
        const heading = `${section.key} — ${(section.deliverable || section.title).replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ').trim()}`;
        const body =
          section.status === 'DRAFTED' && (section.body ?? []).length > 0
            ? section.body.join('\n\n')
            : '[Not written yet]';
        return `${heading}\n\n${body}`;
      });
      const text = `${found.pack.reference} — ${found.pack.clientName}\n\n${blocks.join('\n\n\n')}\n`;
      try {
        await navigator.clipboard.writeText(text);
        toast('Copied', `All ${found.sections.length} answers are on your clipboard — paste them into your submission document.`, 'ok');
      } catch {
        toast('Could not copy', 'Your browser blocked the clipboard — open each answer and copy it by hand.', 'err');
      }
      return;
    }
  });

  /*
   * What the library has for one requirement category.
   *
   * A lookup rather than a position: the library cannot answer until somebody
   * says which requirement they are answering, so it is a chooser and a press
   * rather than a tenth panel loaded on every visit.
   *
   * Every candidate is shown in full, with the mark it earned. There is no
   * button on any of them that puts the text into a bid, and there is no
   * endpoint behind one either. Copying it is a person's act, done knowing what
   * they are copying — and the note under the heading says what happens to a
   * buyer reading their fourth identical answer.
   */
  const offer = root.querySelector('#answer-offer');
  const offerButton = root.querySelector('#answer-offer-go');
  if (offer && offerButton) {
    offerButton.addEventListener('click', async () => {
      const category = root.querySelector('#answer-category')?.value;
      if (!category) return;

      offerButton.disabled = true;
      offerButton.textContent = 'Reading…';
      try {
        const result = await api.read(
          `/v1/pipeline/answers/offer/${category}`,
          'ESTIMATE_TENDER',
          'COMMERCIAL_L3',
        );
        render(
          offer,
          html`<div style="margin-top:11px">
            <div class="notice info" style="margin:0 0 10px"><div>${result.note}</div></div>
            ${
              result.candidates.length === 0
                ? ''
                : html`<div class="split-list">
                    ${result.candidates.map(
                      (candidate) => html`<div style="padding:10px 0;border-top:1px solid var(--line)">
                        <div class="actions" style="justify-content:space-between;align-items:baseline">
                          <b>${candidate.reference} · ${candidate.title}</b>
                          <span style="font-size:12px;color:var(--text-3)">
                            v${candidate.version} · ${candidate.words} words · used ${candidate.useCount}×
                            ${
                              candidate.medianScorePercent === null
                                ? ' · no mark disclosed'
                                : ` · median ${pct(candidate.medianScorePercent, 0)}`
                            }
                          </span>
                        </div>
                        ${candidate.tags.length > 0
                          ? html`<div style="margin:4px 0">${candidate.tags.map((tag) => badge(tag, ''))}</div>`
                          : ''}
                        ${candidate.body.map(
                          (paragraph) => html`<p style="margin:6px 0;font-size:13px;line-height:1.55">${paragraph}</p>`,
                        )}
                      </div>`,
                    )}
                  </div>`
            }
          </div>`,
        );
      } catch (error) {
        // A denial is shown as a denial. An empty panel here would read as
        // "the library has nothing", which is a different statement.
        render(offer, notice(`The library could not be read: ${error.message}`, 'err'));
      } finally {
        offerButton.disabled = false;
        offerButton.textContent = 'What do we have';
      }
    });
  }

  wireLookups(root, [
    {
      id: 'submission-readiness',
      path: (v) => `/v1/projects/${projectId}/tender/${v.analysisId}/submission-readiness`,
      sections: [
        { key: 'checks', label: 'Every rule, checked', empty: 'No rule has been recorded against this invitation.' },
        { key: 'summary', label: 'Where it stands' },
      ],
    },
  ]);

  /*
   * The insight surface over the pipeline.
   *
   * The AI Insight panel reads an agent's proposals for one *project*, so it can
   * only speak once a project is selected — focused on a tender, or opened from
   * the board. Mounted with no project it fetched `/v1/projects/undefined/...`
   * and showed an error where an insight belonged: "no insights at the tender
   * stage" was exactly that.
   *
   * So when a project is in scope, the AI panel mounts as before. When none is —
   * the tenant-wide board, before a tender is worked — the panel has nothing to
   * read, so in its place goes a deterministic reading *across* the live tenders:
   * what is closing, what is not ready, what has a critical clarification or an
   * unowned mandatory return. It is arithmetic over the board already on screen,
   * so it is always there, model or no model, and it is the thing a bid manager
   * opens the pipeline to see.
   */
  const insightHost = root.querySelector('#pipeline-insight');
  if (projectId) {
    void insightPanel(insightHost, {
      projectId,
      areas: ['BUSINESS_DEVELOPMENT', 'ESTIMATE_TENDER'],
      subject: 'the pipeline and what to bid',
      onChange: draw,
    });
  } else if (insightHost) {
    render(insightHost, tenderAttention(board));
  }


  /*
   * The company's own facts, and the door that was missing entirely.
   *
   * `PUT /v1/company/profile` is what the radar screens against, what a bid is
   * scored against and what the claim register checks a submission's promises
   * against. Nothing in the console called it. A company that had never set it
   * — which is every company, since there is no other way to — opened Pipeline
   * & Bids and read "What this company can claim: **This could not be read**",
   * a red error panel with nothing on it to press, above a screen of empty
   * tables each explaining that it becomes populated as the project progresses.
   * It does not: it becomes populated when this is recorded.
   *
   * Bound separately because the page's dispatcher binds one `.cmd-bar` and
   * this is a second one, on its own card.
   */
  /**
   * The form, callable from anywhere that needs it.
   *
   * It used to exist only inside the click handler on its own panel, so every
   * other place that discovered the facts were missing could do nothing but
   * name the button and scroll to it. A refusal that scrolls somebody to a
   * button is still asking them to go and find the thing; the refusal should
   * open it.
   */
  async function recordCompanyFacts() {
    const held = profile?.error ? null : profile;
    const asList = (value) => (Array.isArray(value) ? value.join(', ') : '');

    /*
     * What the account already knows about itself.
     *
     * Fourteen fields on a form is the reason this record does not exist on
     * most tenancies, and five of them are answerable from projects this
     * business created itself — the towns it works in, the sectors it builds
     * in, the range of job it takes on, and how many it is running now.
     *
     * Not invented, and not asserted: every one is drawn from the company's own
     * records, shown in an editable field, and labelled with where it came
     * from. The four the platform genuinely cannot know — turnover, net assets,
     * accreditations, target margin — stay blank, because a plausible number in
     * a prequalification field is the one that gets a bid disqualified.
     */
    const ourProjects = projectList?.projects ?? [];
    const distinct = (values) => [...new Set(values.filter(Boolean))];
    const suggestedRegions = distinct(ourProjects.map((project) => project.location?.city));
    const suggestedSectors = distinct(ourProjects.map((project) => project.sectorType));
    const projectValues = ourProjects.map((project) => Number(project.contractValueMinor ?? 0)).filter((value) => value > 0);
    const fromOurRecord = (what) => `Suggested from ${what} on this account. Correct it — it is a claim the business makes to a buyer.`;

    const result = await command({
      title: 'The company’s own facts',
      intent:
        'What this business is, in the terms a buyer prequalifies on. The radar screens against it and asserts none of ' +
        'it on the company’s behalf — an opportunity filtered out for a fact nobody recorded is the commonest reason a ' +
        'pipeline looks empty. Turnover is most recent year first. Where a field is already filled in, it was drawn ' +
        'from this company’s own projects and is yours to correct; what the platform cannot know it has left blank.',
      path: '/v1/company/profile',
      method: 'PUT',
      submitLabel: held ? 'Update the facts' : 'Record the facts',
      fields: [
        {
          name: 'legalName',
          label: 'Registered name',
          value: held?.legalName ?? state.session?.enterprise ?? '',
          ...(held?.legalName ? {} : { hint: fromOurRecord('the enterprise name') + ' It is the name on the certificate of incorporation, which may not be the trading name.' }),
        },
        { name: 'turnover', label: 'Turnover by year (£, most recent first)', value: (held?.turnoverMinorByYear ?? []).map((m) => m / 100).join(', '), hint: 'Comma separated. At least one year — the radar sizes what the business can carry from it.' },
        { name: 'netAssets', label: 'Net assets (£)', type: 'number', required: false, value: held ? held.netAssetsMinor / 100 : '' },
        { name: 'workingCapital', label: 'Working capital (£)', type: 'number', required: false, value: held ? held.workingCapitalMinor / 100 : '' },
        {
          name: 'regions',
          label: 'Regions worked',
          value: held?.regions?.length ? asList(held.regions) : suggestedRegions.join(', '),
          hint: held?.regions?.length || suggestedRegions.length === 0
            ? 'Towns, cities or counties the business actually operates in.'
            : fromOurRecord(`the ${suggestedRegions.length} town${suggestedRegions.length === 1 ? '' : 's'} your projects are in`),
        },
        {
          name: 'sectors',
          label: 'Sectors',
          type: 'multiselect',
          value: held?.sectors?.length ? held.sectors : suggestedSectors,
          options: SECTOR_GROUPED.flatMap((group) => group.options ?? [group]).map((o) => ({ value: o.value, label: o.label })),
          ...(held?.sectors?.length || suggestedSectors.length === 0 ? {} : { hint: fromOurRecord('the sectors your projects are in') }),
        },
        {
          name: 'valueMin',
          label: 'Smallest job worth bidding (£)',
          type: 'number',
          value: held ? held.valueBandMinor.min / 100 : projectValues.length ? Math.min(...projectValues) / 100 : '',
          ...(held || projectValues.length === 0 ? {} : { hint: fromOurRecord('the smallest job on your record') }),
        },
        {
          name: 'valueMax',
          label: 'Largest job the business can carry (£)',
          type: 'number',
          value: held ? held.valueBandMinor.max / 100 : projectValues.length ? Math.max(...projectValues) / 100 : '',
          ...(held || projectValues.length === 0
            ? {}
            : { hint: fromOurRecord('the largest job on your record') + ' The largest you have built is not necessarily the largest you can carry.' }),
        },
        { name: 'accreditations', label: 'Accreditations', required: false, value: asList(held?.accreditations), hint: 'CHAS, SafeContractor, ISO 9001 — comma separated.' },
        { name: 'insurances', label: 'Insurances held', type: 'textarea', rows: 4, required: false,
          value: (held?.insurances ?? []).map((i) => `${i.type} | ${i.limitMinor / 100}${i.expiresOn ? ` | ${i.expiresOn}` : ''}`).join('\n'),
          hint:
            'One per line: cover | limit in £ | renews on (optional). ' +
            'e.g. "Employers Liability | 10000000 | 2027-03-31". The compliance matrix reads these against the ' +
            'insurance an ITT demands, so a line here is what turns an insurance requirement from a gap to satisfied. ' +
            'Clearing the box removes them.' },
        { name: 'references', label: 'Project references (your experience)', type: 'textarea', rows: 4, required: false,
          value: (held?.references ?? [])
            .map((r) => `${r.clientName} | ${r.projectName} | ${r.sector} | ${r.valueMinor / 100} | ${r.completedYear}`)
            .join('\n'),
          hint:
            'One per line: client | project | sector | value in £ | year completed. ' +
            'e.g. "South Holland DC | Level-access wet room, 14 Elm Rd | Residential | 18000 | 2024". ' +
            'These are the past projects you stand behind — the matrix reads them against a references/experience ' +
            'requirement, and the radar matches them to opportunities. Clearing the box removes them.' },
        { name: 'dbsHeld', label: 'Enhanced DBS checks in place for staff entering occupied homes', type: 'checkbox',
          value: !!held?.dbs?.held },
        { name: 'trades', label: 'Trades delivered in-house', required: false, value: asList(held?.selfDeliveredTrades) },
        { name: 'concurrent', label: 'Sites the business can run at once', type: 'number', value: held?.capacity?.concurrentProjects ?? '' },
        {
          name: 'committed',
          label: 'Of those, already committed',
          type: 'number',
          value: held?.capacity?.committedProjects ?? ourProjects.length,
          ...(held?.capacity ? {} : { hint: fromOurRecord(`the ${ourProjects.length} live project${ourProjects.length === 1 ? '' : 's'} on this account`) }),
        },
        { name: 'marginMin', label: 'Target margin, minimum (%)', type: 'number', required: false, value: held?.targetMarginPercent?.min ?? '' },
        { name: 'marginMax', label: 'Target margin, maximum (%)', type: 'number', required: false, value: held?.targetMarginPercent?.max ?? '' },
        { name: 'singleOwnerBids', label: 'One-director business — every requirement and return is mine', type: 'checkbox', required: false,
          value: !!held?.singleOwnerBids,
          hint: 'Tick it and the compliance matrix stops suggesting a role per category (QS, EPC, Safety…) that reads as work going to people who do not exist — every owner defaults to the owner instead.' },
      ],
      /*
       * A line the parser below cannot read is refused, naming it — never
       * dropped. "Public liability, 5000000" (a comma, not a bar) used to vanish
       * while the screen said "Recorded", and the matrix then showed the
       * insurance as a gap the business had in fact filled in.
       */
      validate: (v) => {
        const unread = (text, ok) =>
          String(text || '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .find((line) => !ok(line.split('|').map((part) => part.trim())));
        const insurance = unread(v.insurances, (parts) => parts[0] && parts[1] && !Number.isNaN(Number(parts[1])));
        if (insurance) {
          return {
            field: 'insurances',
            message: `"${insurance}" could not be read. Write it as cover | limit in £ | renews on (optional), with a vertical bar between each part — e.g. "Public liability | 5000000 | 2027-10-25".`,
          };
        }
        const reference = unread(v.references, (parts) => parts[0] && parts[1]);
        if (reference) {
          return {
            field: 'references',
            message: `"${reference}" could not be read. Write it as client | project | sector | value in £ | year completed, with a vertical bar between each part.`,
          };
        }
        return null;
      },
      transform: (v) => {
        const money = (x) => Math.round(Number(x || 0) * 100);
        const list = (x) => String(x || '').split(',').map((part) => part.trim()).filter(Boolean);
        return {
          legalName: v.legalName,
          turnoverMinorByYear: list(v.turnover).map((y) => Math.round(Number(y) * 100)),
          netAssetsMinor: money(v.netAssets),
          workingCapitalMinor: money(v.workingCapital),
          regions: list(v.regions),
          sectors: Array.isArray(v.sectors) ? v.sectors : [v.sectors].filter(Boolean),
          cpvCodes: held?.cpvCodes ?? [],
          valueBandMinor: { min: money(v.valueMin), max: money(v.valueMax) },
          // Parsed from the textarea: "cover | limit in £ | renews" per line. A
          // line without a cover name or a numeric limit is dropped rather than
          // written as a malformed insurance the matrix cannot read.
          insurances: String(v.insurances || '')
            .split('\n')
            .map((line) => line.split('|').map((part) => part.trim()))
            .filter((parts) => parts[0] && parts[1] && !Number.isNaN(Number(parts[1])))
            .map((parts) => ({
              type: parts[0],
              limitMinor: Math.round(Number(parts[1]) * 100),
              ...(parts[2] ? { expiresOn: parts[2] } : {}),
            })),
          accreditations: list(v.accreditations),
          // Parsed from the textarea, mirroring insurances: "client | project |
          // sector | value£ | year" per line. A reference the business types here
          // is one it stands behind, so it is recorded verified — that is what the
          // experience probe and the radar count. A malformed line (no client or
          // project) is dropped rather than written half-formed.
          references: String(v.references || '')
            .split('\n')
            .map((line) => line.split('|').map((part) => part.trim()))
            .filter((parts) => parts[0] && parts[1])
            .map((parts) => ({
              clientName: parts[0],
              projectName: parts[1],
              sector: parts[2] || (Array.isArray(v.sectors) ? v.sectors[0] : v.sectors) || 'Residential',
              valueMinor: Math.round(Number(parts[3] || 0) * 100),
              completedYear: Number(parts[4]) || new Date().getFullYear(),
              verified: true,
            })),
          dbs: { held: !!v.dbsHeld },
          selfDeliveredTrades: list(v.trades),
          targetMarginPercent: { min: Number(v.marginMin || 0), max: Number(v.marginMax || 0) },
          capacity: { concurrentProjects: Number(v.concurrent || 0), committedProjects: Number(v.committed || 0) },
          ...(v.singleOwnerBids === true ? { singleOwnerBids: true } : {}),
        };
      },
    });
    if (result) {
      toast('Recorded', 'The radar can screen against these now.', 'ok');
      await draw();
    }
    return result;
  }

  // Delegated on the view, not bound to the one command bar that carries
  // `data-company-facts` — so the "Record the company’s facts" button in the
  // matrix's next-actions panel fires it too, not only the bar on the company
  // card. Same safe pattern as the two dispatchers below: it returns on a click
  // that is not this command, and `#view` is fresh each draw so it cannot stack.
  root.addEventListener('click', async (event) => {
    if (!event.target.closest('[data-command="company-facts"]')) return;
    await recordCompanyFacts();
  });

  /*
   * Every command bar on the screen, not the first one.
   *
   * `querySelector` returns one element. A screen with more than one command
   * bar — and most of them have several, one per panel — wired the first and
   * left the rest inert: the buttons drew, they were not locked, they carried
   * their `data-command`, and pressing them did nothing at all. Reported as
   * "none of these work" on Pipeline & Bids, which renders six.
   *
   * Safe to bind every bar because the handler returns on an id this page does
   * not own, which is the pattern the evidence doors on this page already used
   * with `querySelectorAll` — one bar can carry buttons for two dispatchers.
   */
  /*
   * Delegated from the view, not from a `.cmd-bar` wrapper.
   *
   * `commandBar()` returns bare buttons. Whether they end up inside an element
   * classed `cmd-bar` is up to whichever page called it, and several wrap them
   * in `.actions` instead — so on those screens no listener was ever bound and
   * every button drew, unlocked, carrying its `data-command`, and did nothing.
   * That is seven commands on Concept, four on Field Modules and four more
   * elsewhere, all of them invisible to the suite because the markup is right
   * and only the binding is missing.
   *
   * Binding here removes the coupling rather than adding a second class to
   * remember. It is safe on both counts: the handler returns on an id this
   * page does not own, so two dispatchers can share one view, and `#view` is
   * a fresh element on every `draw()`, so listeners cannot stack.
   */
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const spec = COMMANDS[button.dataset.command];
    if (!spec) return;
    const result = await command(spec);
    if (!result) return;
    /*
     * One of these commands is a question rather than a record.
     *
     * The register's answer is the whole point of asking, and a redraw would
     * throw it away — nothing is written, so there would be nothing on the
     * screen to show for it. Said back instead, with the suggested score and
     * the trades that are too thin to compete, which is what somebody scoring
     * the opportunity is about to type.
     */
    if (button.dataset.command === 'supply-chain-evidence') {
      toast(
        `The register suggests ${result.suggestedScore} out of 5`,
        `${result.note ?? ''}${
          (result.uncovered ?? []).length > 0 ? ` Not on the register at all: ${result.uncovered.join(', ')}.` : ''
        } It is a suggestion: the register knows how many firms cover each trade, not whether they would want this job.`,
        (result.suggestedScore ?? 0) >= 4 ? 'ok' : 'warn',
      );
      return;
    }

    /*
     * Deciding to bid is now a clean commercial call — it is not blocked by
     * unassigned returns. So the decision can succeed with returns still to
     * plan, and a bid manager should be told that plainly rather than finding
     * out at submission. The outstanding returns come back on the result.
     */
    if (button.dataset.command === 'decide') {
      const outstanding = result.outstandingReturns ?? [];
      if (result.conditional) {
        toast(
          'Conditional bid recorded',
          'Limited work is authorised to the condition, under its owner, spend cap and kill date. It becomes a full commitment once the condition is met and you decide again.',
          'ok',
        );
      } else if (result.stage === 'BID') {
        toast(
          outstanding.length > 0 ? 'Bid recorded — returns still to assign' : 'Bid recorded',
          outstanding.length > 0
            ? `${outstanding.length} mandatory ${outstanding.length === 1 ? 'return needs' : 'returns need'} an owner, a date and a source before you can submit. Use "Assign a return" next.`
            : 'Every mandatory return already has an owner, a date and a source.',
          outstanding.length > 0 ? 'warn' : 'ok',
        );
      }
      await draw();
      return;
    }
    await draw();
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
        { name: 'sourceHash', label: 'Document', type: 'file',
          hint: 'The certificate, policy, DBS record or case study that proves this. It is hashed and stored as evidence here — you never copy a hash.' },
        { name: 'issuedBy', label: 'Issued by', type: 'text', required: false },
        { name: 'issuedAt', label: 'Issued on', type: 'date', required: false },
        { name: 'expiresAt', label: 'Current until', type: 'date', required: false,
          hint: 'Leave blank for something that does not lapse. A certificate always lapses.' },
      ],
      transform: (v) => Object.fromEntries(Object.entries(v).filter(([, value]) => String(value ?? '').trim())),
    },
    'link-claim': {
      title: 'Link held evidence to a requirement',
      intent:
        'Say which of this tender’s requirements a document you have already filed answers. A document is filed once ' +
        'and lives on the business, not the bid — you link it to the requirements each tender asks, and the same ' +
        'certificate answers the same clause on the next bid without re-filing it. This is how a proposed match above is ' +
        'confirmed.',
      path: (v) => `/v1/evidence/claims/${v.claimId}/link`,
      submitLabel: 'Link',
      fields: [
        { name: 'claimId', label: 'Held evidence', type: 'select',
          options: (claimRegister?.claims ?? [])
            .filter((claim) => claim.standing !== 'REJECTED')
            .map((claim) => ({ value: claim.id, label: `${claim.reference} — ${claim.claim.slice(0, 60)}` })) },
        { name: 'references', label: 'Requirements it answers', type: 'textarea', rows: 3,
          hint: 'One matrix reference per line — e.g. "18.4" or "Clause 7.1". Copy them from the "Consider linking" rows above.' },
      ],
      transform: ({ references }) => ({
        references: String(references ?? '').split('\n').map((r) => r.trim()).filter(Boolean),
      }),
    },
    'verify-claim': {
      title: profile?.singleOwnerBids ? 'Verify or attest a claim' : 'Verify a claim',
      intent: profile?.singleOwnerBids
        ? 'Say the document proves the sentence, and how it was checked. Normally somebody other than the person who '
          + 'asserted it does this. You have turned on single-director mode, so you may attest your own \u2014 it is '
          + 'recorded as your own attestation, not an independent check, and the record says so.'
        : 'Say the document proves the sentence, and how it was checked. Refused if you were the one who asserted it, '
          + 'and refused over a document that has already lapsed \u2014 an approved claim nobody can stand behind is worse than none.',
      path: (v) => `/v1/evidence/claims/${v.claimId}/verify`,
      submitLabel: profile?.singleOwnerBids ? 'Verify / attest' : 'Verify',
      fields: [
        { name: 'claimId', label: 'Claim', type: 'select',
          options: pendingClaims.map((claim) => ({ value: claim.id, label: `${claim.reference} — ${claim.claim.slice(0, 60)}` })) },
        { name: 'method', label: 'How it was checked', type: 'text',
          hint: profile?.singleOwnerBids
            ? 'State what you checked it against \u2014 "compared the uploaded certificate against the Constructionline portal on 8 Nov".'
            : '"Compared against the insurer\u2019s schedule" is a method. "Yes" is a signature on nothing.' },
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

    /*
     * The answer library — five doors, and no sixth.
     *
     * There is deliberately no "insert into section" command. The library
     * offers candidates and the mark each earned; a person writes the section.
     * An answer pasted unchanged into forty bids is boilerplate, and a library
     * that pasted would converge on a permanent 3/5 — the failure it exists to
     * fix. "Record a use" is how the platform finds out an answer went out,
     * because whether somebody actually worked from one is a fact only they
     * have.
     */
    'capture-answer': {
      title: 'Capture an answer',
      intent:
        'Keep what this business said, while somebody still remembers it worked. It arrives as a draft and is offered ' +
        'to nobody until a second person approves it — what sits in the library is what the company claims on every ' +
        'bid that takes it.',
      path: '/v1/pipeline/answers',
      submitLabel: 'Capture',
      fields: [
        { name: 'title', label: 'What it answers', type: 'text',
          hint: 'How somebody looking for it would describe it — "Social value: local labour and apprenticeships".' },
        { name: 'category', label: 'Requirement category', type: 'select',
          options: REQUIREMENT_CATEGORY,
          hint: 'The same list the compliance matrix classifies requirements onto, so a matrix gap can find this.' },
        { name: 'body', label: 'The answer', type: 'textarea', rows: 10,
          hint: 'As it was written, one paragraph per line. At least 25 words — a note to self is not an answer.' },
        { name: 'tags', label: 'Tags', type: 'text', required: false,
          hint: 'Comma separated. What a buyer or a sector would call it — "social value, apprenticeships, NEC4".' },
        { name: 'packSection', label: 'Where it came from', type: 'select', required: false,
          options: packSections,
          hint: packSections.length === 0
            ? 'Nothing to attribute it to on this project yet. An answer captured from outside the platform needs none.'
            : 'The section this was written for, where it was written here. Attribution only — it changes nothing.' },
      ],
      transform: ({ body, tags, packSection, ...rest }) => ({
        ...rest,
        body: String(body ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
        ...(String(tags ?? '').trim()
          ? { tags: String(tags).split(',').map((tag) => tag.trim()).filter(Boolean) }
          : {}),
        ...(packSection
          ? { origin: { packId: String(packSection).split('::')[0], sectionKey: String(packSection).split('::')[1] } }
          : {}),
      }),
    },
    'approve-answer': {
      title: 'Approve for reuse',
      intent:
        'Refused if you were the one who captured it. An answer in the library is offered to every bid that touches ' +
        'this category, so the second reader is the only thing standing between one person’s draft and what the ' +
        'company claims about itself.',
      path: (v) => `/v1/pipeline/answers/${v.answerId}/approve`,
      submitLabel: 'Approve',
      fields: [
        { name: 'answerId', label: 'Answer', type: 'select',
          options: (library?.answers ?? [])
            .filter((answer) => answer.status === 'DRAFT')
            .map((answer) => ({ value: answer.id, label: `${answer.reference} · v${answer.version} — ${answer.title}` })) },
        { name: 'note', label: 'What you checked', type: 'textarea', rows: 2,
          hint: '"Dates and the apprenticeship figures match the 2026 return" is a check. "OK" is a signature on nothing.' },
      ],
      transform: ({ answerId: _answerId, ...rest }) => rest,
    },
    'revise-answer': {
      title: 'Revise an answer',
      intent:
        'Writes a better version and supersedes the old one rather than overwriting it — the version a buyer read is a ' +
        'promise this business made, and it stays readable. The replacement is a draft and needs its own approval. Its ' +
        'uses do not carry forward: a new answer has not earned the old one’s marks.',
      path: (v) => `/v1/pipeline/answers/${v.answerId}/revise`,
      submitLabel: 'Revise',
      fields: [
        { name: 'answerId', label: 'Answer', type: 'select',
          options: (library?.answers ?? [])
            .filter((answer) => answer.status === 'APPROVED' || answer.status === 'DRAFT')
            .map((answer) => ({ value: answer.id, label: `${answer.reference} · v${answer.version} — ${answer.title}` })) },
        { name: 'body', label: 'The better version', type: 'textarea', rows: 10,
          hint: 'One paragraph per line. At least 25 words.' },
        { name: 'reason', label: 'What changed', type: 'text',
          hint: 'Read by whoever approves it, and by whoever wonders in a year why the old one was replaced.' },
        { name: 'title', label: 'Retitle', type: 'text', required: false,
          hint: 'Leave blank to keep the title it has.' },
        { name: 'tags', label: 'Replace tags', type: 'text', required: false,
          hint: 'Comma separated. Leave blank to keep the tags it has.' },
      ],
      transform: ({ answerId: _answerId, body, tags, title, ...rest }) => ({
        ...rest,
        body: String(body ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
        ...(String(title ?? '').trim() ? { title: String(title).trim() } : {}),
        ...(String(tags ?? '').trim()
          ? { tags: String(tags).split(',').map((tag) => tag.trim()).filter(Boolean) }
          : {}),
      }),
    },
    'record-answer-use': {
      title: 'Record a use and its mark',
      intent:
        'The half that makes the library honest. Without it the register is a bank of answers somebody is proud of; ' +
        'with it, it says which ones go out and what happens when they do — an answer used eleven times for two wins ' +
        'is worse than the blank page it replaced, and that is a sentence nobody can write unless the uses are on the ' +
        'record. The mark is optional because most buyers disclose none, and a guessed mark is worse than no mark.',
      path: (v) => `/v1/pipeline/answers/${v.answerId}/used`,
      submitLabel: 'Record',
      fields: [
        { name: 'answerId', label: 'Answer', type: 'select',
          options: (library?.answers ?? [])
            .filter((answer) => answer.status !== 'DRAFT')
            .map((answer) => ({ value: answer.id, label: `${answer.reference} · v${answer.version} — ${answer.title}` })) },
        { name: 'packSection', label: 'Section it went out on', type: 'select',
          options: packSections,
          hint: packSections.length === 0
            ? 'Open a project with a response pack still being written. A use is recorded against the section it went ' +
              'out on, and this project has none.'
            : 'Every section of every pack this project has not yet issued.' },
        { name: 'scorePercent', label: 'The buyer’s mark (%)', type: 'number', required: false,
          hint: 'Only where the buyer actually disclosed one. Leave blank otherwise — the library reports no median ' +
            'rather than one built from guesses.' },
      ],
      transform: ({ answerId: _answerId, packSection, scorePercent, ...rest }) => ({
        ...rest,
        packId: String(packSection).split('::')[0],
        sectionKey: String(packSection).split('::')[1],
        ...(String(scorePercent ?? '').trim() === '' ? {} : { scorePercent: Number(scorePercent) }),
      }),
    },
    'retire-answer': {
      title: 'Retire an answer',
      intent:
        'Takes it out of use without taking it off the record. It stops being offered; the bids it already went out on ' +
        'still say what they said, and the reason stays readable — otherwise the next person captures the same answer ' +
        'and the same reviewer retires it again.',
      path: (v) => `/v1/pipeline/answers/${v.answerId}/retire`,
      submitLabel: 'Retire',
      fields: [
        { name: 'answerId', label: 'Answer', type: 'select',
          options: (library?.answers ?? [])
            .filter((answer) => answer.status !== 'RETIRED')
            .map((answer) => ({ value: answer.id, label: `${answer.reference} · v${answer.version} — ${answer.title}` })) },
        { name: 'reason', label: 'Why', type: 'text',
          hint: 'The standard it cites was withdrawn; the scheme it describes is finished; it has never scored above 2.' },
      ],
      transform: ({ answerId: _answerId, ...rest }) => rest,
    },
  };

  // The evidence doors sit in their own panel rather than on the page command
  // bar, because they act on the registry rather than on the pipeline.
  /*
   * Delegated from the view, not from a `.cmd-bar` wrapper.
   *
   * `commandBar()` returns bare buttons. Whether they end up inside an element
   * classed `cmd-bar` is up to whichever page called it, and several wrap them
   * in `.actions` instead — so on those screens no listener was ever bound and
   * every button drew, unlocked, carrying its `data-command`, and did nothing.
   * That is seven commands on Concept, four on Field Modules and four more
   * elsewhere, all of them invisible to the suite because the markup is right
   * and only the binding is missing.
   *
   * Binding here removes the coupling rather than adding a second class to
   * remember. It is safe on both counts: the handler returns on an id this
   * page does not own, so two dispatchers can share one view, and `#view` is
   * a fresh element on every `draw()`, so listeners cannot stack.
   */
  {
    root.addEventListener('click', async (event) => {
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
      const [fresh, freshWaivers, freshAddenda, freshCoverage] = await Promise.all([
        api.get(`/v1/pipeline/analyses/${analysisId}`),
        api.read(`/v1/pipeline/analyses/${analysisId}/waivers`, 'ESTIMATE_TENDER', 'COMMERCIAL_L3').catch(() => null),
        api.read(`/v1/pipeline/analyses/${analysisId}/addenda`, 'ESTIMATE_TENDER', 'COMMERCIAL_L3').catch(() => null),
        api.read(`/v1/pipeline/analyses/${analysisId}/evidence-coverage`, 'ESTIMATE_TENDER', 'COMMERCIAL_L3').catch(() => null),
      ]);
      render(detail, matrixDetail(fresh, freshWaivers, freshAddenda, freshCoverage));
      detail.dataset.analysis = analysisId;
    }
  });
}
