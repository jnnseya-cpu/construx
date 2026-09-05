import { api } from '../lib/api.js';
import { command } from '../lib/command.js';
import { badge, date, html, humanise, notice, positionReport, raw, render, table, toast } from '../lib/ui.js';
// No `can` gate on the row buttons: the navigation already reaches this screen
// only for a role holding EVIDENCE_AUDIT read, which is the same authority
// generation checks. A second copy of that rule here would be a second place
// for it to drift.
import { draw, state } from '../app.js';

/**
 * Site Documents.
 *
 * Fifteen document types, one screen, and the whole point of it is the column
 * that says **why not**.
 *
 * A generated document on this platform is composed from records rather than
 * written from a template, so a type whose records do not exist cannot be
 * produced — and the interesting question is never "can I generate this", it is
 * "what would I have to record first". The catalogue answers that per type, in
 * sentences, and this screen shows the sentence rather than greying a button
 * out and leaving somebody to guess.
 *
 * The lesson already learnt on the procurement screen applies twice here. A
 * record-scoped type with no record to generate against opens a modal with an
 * empty required dropdown — a dead end nobody can diagnose — so those commands
 * lock with the reason instead, using the affordance the permission matrix
 * already uses.
 */

const CATEGORIES = [
  {
    key: 'SAFETY_AND_HEALTH',
    label: 'Safety and health',
    blurb:
      'The documents that authorise people to do dangerous things. Each is cross-referenced against the records a paper ' +
      'form cannot see — a permit against the expiry date of the ticket that authorises each operative, checked against ' +
      'the permit’s own end date rather than against today.',
  },
  {
    key: 'PROJECT_MANAGEMENT',
    label: 'Project management and planning',
    blurb:
      'The documents that carry arithmetic nobody does by hand: a dimension formula re-evaluated against the quantity it ' +
      'produced, a day named because no diary entry covers it, an action measured against the date it was originally ' +
      'given rather than the date it was last restated.',
  },
  {
    key: 'QUALITY_AND_COMPLIANCE',
    label: 'Quality and compliance',
    blurb:
      'The documents read years later by somebody who was not there. A hold point with no recorded release is named; a ' +
      'non-conformance closed as use-as-is says in plain words that a departure was accepted into the permanent works, ' +
      'and by whom.',
  },
];

export async function documents(root) {
  const projectId = state.session.projectId;

  const [catalogue, ingestion, evidence, perception, cdmDocuments, branding] = await Promise.all([
    api.get(`/v1/projects/${projectId}/documents`).catch(() => ({ documents: [], summary: '' })),
    api.get(`/v1/projects/${projectId}/ingestion`).catch(() => null),
    api.get(`/v1/projects/${projectId}/evidence`).catch(() => null),
    // Whether this deployment has a model that can see, for the scans
    // ingestion could not read. Null, not a refusal: the ingestion card stands
    // on its own without it.
    api.get(`/v1/projects/${projectId}/perception`).catch(() => null),
    // What CDM demands and what identity these documents will carry. Both had
    // engines with no screen — a generated document goes to a client under
    // somebody's brand, and nobody could see whose until it arrived.
    api.get('/v1/cdm/documents').catch((error) => ({ error })),
    api.get(`/v1/projects/${projectId}/branding`).catch((error) => ({ error })),
  ]);
  const all = catalogue.documents ?? [];
  const generable = all.filter((document) => document.generable);

  // Held, named in the ledger, and never looked at. The queue the ingestion
  // pipeline exists to empty — and the only list on this screen that is about
  // documents somebody else wrote rather than documents this platform composes.
  const ingested = new Set((ingestion?.files ?? []).map((file) => file.hash));
  const unread = (evidence?.entries ?? []).filter((entry) => entry.held && !ingested.has(entry.hash));
  const quarantine = ingestion?.position?.quarantine ?? [];
  // Transcriptions a model produced that nobody has confirmed or rejected yet.
  // Only this task's: the drawing and site readings belong on their own screens.
  const transcriptions = (perception?.drafts ?? []).filter((draft) => draft.task === 'DOCUMENT_TEXT' && draft.status === 'DRAFT');
  const canTranscribe = Boolean(perception?.capability?.available);

  // Where a type cannot be generated, the records it is waiting on. Deduplicated
  // across types, because five documents blocked on the same missing register is
  // one thing to go and do, not five.
  const waitingOn = new Map();
  for (const document of all) {
    for (const source of document.missing ?? []) {
      const existing = waitingOn.get(source.refType) ?? { ...source, blocks: [] };
      existing.blocks.push(document.title);
      waitingOn.set(source.refType, existing);
    }
  }

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Site Documents</h1>
          <p>
            Composed from this project’s records, branded for the client, and hashed so the issue can be proved later.
            Nothing here is written to fill a gap.
          </p>
        </div>
        <div class="actions">
          <div class="metric-sub" style="max-width:280px;text-align:right">
            ${generable.length} of ${all.length} types can be generated. Each is generated from its own row, so the
            record list offered is only ever that type's own.
          </div>
        </div>
      </div>

      <div class="grid g4" style="margin-bottom:14px">
        <div>
          <h2>Can be generated now</h2>
          <div class="metric ${raw(generable.length === 0 ? 'warn' : 'good')}">${generable.length}</div>
          <div class="metric-sub">of ${all.length} document types</div>
        </div>
        <div>
          <h2>Waiting on a record</h2>
          <div class="metric">${all.length - generable.length}</div>
          <div class="metric-sub">${waitingOn.size} distinct record${waitingOn.size === 1 ? '' : 's'} would unblock them</div>
        </div>
        <div>
          <h2>Composed, not written</h2>
          <div class="metric">100%</div>
          <div class="metric-sub">every figure traces to a record on this project</div>
        </div>
        <div>
          <h2>Branding</h2>
          <div class="metric-sub" style="margin-top:8px">
            Every document carries the issuing entity, the client and a document control block. Generation refuses
            outright where branding is not configured — an unbranded document sent to a client is worse than none.
          </div>
        </div>
      </div>

      ${
        waitingOn.size > 0
          ? html`<div class="card" style="margin-bottom:14px">
              <h2>What to record next</h2>
              <p class="metric-sub">
                One row per missing record, not one per blocked document. A register that does not exist blocks
                everything composed from it, and going and creating it once clears all of them.
              </p>
              ${raw(table({
                headers: ['Record', 'What it contributes', 'Where it is recorded', 'Documents it is blocking'],
                rows: [...waitingOn.values()].map((source) => [
                  humanise(source.refType),
                  source.qualifier ? `${source.contributes} (${source.qualifier} only)` : source.contributes,
                  source.recordedBy,
                  source.blocks.join(', '),
                ]),
              }))}
            </div>`
          : raw(notice('Every document type on this platform can be generated from what this project already holds.', 'ok'))
      }

      ${CATEGORIES.map((category) => {
        const rows = all.filter((document) => document.category === category.key);
        return html`<div class="card" style="margin-bottom:14px">
          <h2>${category.label}</h2>
          <p class="metric-sub">${category.blurb}</p>
          ${raw(table({
            headers: ['Document', 'What it is for', 'Covers', 'Status', ''],
            rows: rows.map((document) => [
              document.title,
              document.purpose,
              // No leading article. "One rams" and "One ncr" both read wrong,
              // and fixing the casing to "One RAMS" only moves the problem to
              // "One Site meeting". The column header already says Covers.
              document.scope === 'RECORD'
                ? `${humanise(document.subject ?? 'record')} · ${
                    document.subjects.length === 0 ? 'none' : document.subjects.length
                  } on this project`
                : 'The whole project',
              document.generable
                ? badge('Ready', 'ok')
                : // Composed with `html`, not a bare template literal. `badge`
                  // returns a raw-marked value, and interpolating it into a
                  // plain string renders "[object Object]" — which looks like
                  // data and tells the reader the platform is broken.
                  html`${badge('Waiting', 'warn')}
                    ${(document.missing ?? [])
                      .map((source) => `no ${humanise(source.refType).toLowerCase()} yet — ${source.contributes}`)
                      .join('; ')}`,
              // The door, on the row. The type is settled before the modal
              // opens, so the record list inside it can be — and is — only this
              // type's own records. A single modal asking for both offered every
              // record on the project against every type, and the only thing
              // catching the wrong pick was the server refusing it.
              document.generable
                ? html`<button class="btn sm" data-generate="${document.code}">Generate</button>`
                : raw(
                    `<button class="btn quiet sm locked" disabled title="${(document.missing ?? [])
                      .map((source) => `Record a ${humanise(source.refType).toLowerCase()} first — ${source.recordedBy}.`)
                      .join(' ')
                      .replace(/"/g, '&quot;')}">Generate 🔒</button>`,
                  ),
            ]),
            empty: 'No document types in this category',
          }))}
        </div>`;
      })}

      ${
        ingestion
          ? html`<div class="card" style="margin-bottom:14px">
              <h2>Files this project holds</h2>
              <p class="metric-sub">
                The documents somebody else wrote. The store already refused anything whose bytes did not match the hash
                it was filed under; ingestion is the part that looks at the file — what kind of document it is, whether
                its text can be read, and whether it is what it claims to be.
              </p>

              <div class="grid g4" style="margin:12px 0">
                <div>
                  <h2>Never looked at</h2>
                  <div class="metric ${raw(ingestion.position.notIngested > 0 ? 'warn' : 'good')}">
                    ${ingestion.position.notIngested}
                  </div>
                  <div class="metric-sub">held files nothing has read</div>
                </div>
                <div>
                  <h2>Read</h2>
                  <div class="metric">${ingestion.position.read}</div>
                  <div class="metric-sub">
                    text extracted and indexed${ingestion.position.readByModel > 0
                      ? ` · ${ingestion.position.readByModel} transcribed by a model and confirmed`
                      : ''}${ingestion.position.awaitingOcr > 0
                      ? ` · ${ingestion.position.awaitingOcr} need a model that can see${
                          canTranscribe ? '' : perception ? ' — none is configured here' : ''
                        }`
                      : ''}
                  </div>
                </div>
                <div>
                  <h2>Quarantined</h2>
                  <div class="metric ${raw(ingestion.position.quarantined > 0 ? 'bad' : 'good')}">
                    ${ingestion.position.quarantined}
                  </div>
                  <div class="metric-sub">refused, and kept — the bytes are still an address</div>
                </div>
                <div>
                  <h2>${ingestion.position.antivirusConfigured ? 'Signature scanning' : 'Not a virus scan'}</h2>
                  <div class="metric-sub" style="margin-top:8px">
                    ${
                      ingestion.position.antivirusConfigured
                        ? html`Every file read here is sent to
                            <b>${ingestion.position.antivirusScanner}</b>${ingestion.position.antivirusReachable
                              ? ''
                              : ' — which is not answering, so nothing can be read until it does'}.
                            The platform holds no signatures of its own; it asks something that does.
                            ${ingestion.position.ingestedUnscanned > 0
                              ? html`<br /><b>${ingestion.position.ingestedUnscanned}</b> file(s) here were read before
                                  the scanner was configured and were never scanned.`
                              : ''}`
                        : html`There is no signature engine on this deployment and this does not claim to be one. What is
                            checked is whether a file <b>is what it says it is</b> — a renamed executable, active markup in
                            a document, an archive carrying a program. A count of zero above means nothing was refused,
                            not that nothing is infected.`
                    }
                  </div>
                </div>
              </div>

              ${raw(table({
                headers: ['Evidence', 'Type', 'Read as', 'Text', ''],
                rows: [
                  ...unread.slice(0, 15).map((entry) => [
                    entry.description,
                    entry.contentType ?? '—',
                    badge('Not read', 'warn'),
                    '—',
                    html`<button class="btn sm" data-ingest="${entry.hash}">Read it</button>`,
                  ]),
                  ...(ingestion.files ?? []).slice(0, 15).map((file) => [
                    file.filename ?? file.hash.slice(0, 18),
                    file.inspection.actualType ?? file.inspection.declaredType,
                    file.status === 'QUARANTINED'
                      ? badge('Quarantined', 'bad')
                      : html`${badge(humanise(file.classification.kind), 'ok')}
                          <span class="metric-sub">
                            ${Math.round(file.classification.confidence * 100)}% — ${file.classification.signals.join('; ')}
                          </span>`,
                    file.extraction.method === 'NATIVE'
                      ? html`Read${file.extraction.pages ? ` · ${file.extraction.pages} page${file.extraction.pages === 1 ? '' : 's'}` : ''}${
                          (file.extraction.pageTables ?? []).length > 0
                            ? html` · ${file.extraction.pageTables.length} table${file.extraction.pageTables.length === 1 ? '' : 's'} as rows
                                <button class="btn quiet sm" data-tables="${file.ingestionId}">Show rows</button>`
                            : ''
                        }${
                          file.extraction.note ? html`<br /><span class="metric-sub">${file.extraction.note}</span>` : ''
                        }`
                      : file.extraction.method === 'OCR'
                        ? html`Transcribed by a model, confirmed${file.extraction.pages ? ` · ${file.extraction.pages} page${file.extraction.pages === 1 ? '' : 's'}` : ''}`
                        : file.extraction.method === 'NEEDS_OCR'
                          ? html`Needs a model that can see${file.extraction.reason ? html`<br /><span class="metric-sub">${file.extraction.reason}</span>` : ''}`
                          : file.extraction.reason
                            ? html`<span class="metric-sub">${file.extraction.reason}</span>`
                            : '—',
                    html`${
                      file.status === 'INGESTED' &&
                      (file.extraction.method === 'NEEDS_OCR' || (file.extraction.method === 'NATIVE' && file.extraction.note)) &&
                      /^(image\/|application\/pdf)/.test(file.inspection.actualType ?? '')
                        ? canTranscribe
                          ? transcriptions.some((draft) => draft.evidenceHash === file.hash)
                            ? html`<span class="metric-sub">Transcription awaiting confirmation below</span>`
                            : html`<button class="btn sm" data-read="DOCUMENT_TEXT" data-hash="${file.hash}">Transcribe with a model</button>`
                          : perception
                            ? html`<span class="metric-sub" title="${perception.capability.reason ?? ''}">No model here can see it</span>`
                            : ''
                        : ''
                    }
                    ${
                      // Text on the record can be read as a specification in one
                      // step: the same reading the Design screen runs on pasted
                      // text, with the file's own hash as the document.
                      file.status === 'INGESTED' && (file.extraction.method === 'NATIVE' || file.extraction.method === 'OCR')
                        ? html`<button class="btn quiet sm" data-specify="${file.ingestionId}" data-name="${file.filename ?? file.hash.slice(0, 18)}">Read as specification</button>`
                        : ''
                    }
                    ${file.lexicalVector ? html`<button class="btn quiet sm" data-similar="${file.ingestionId}">Find duplicates</button>` : ''}`,
                  ]),
                ],
                empty: evidence?.storeConfigured
                  ? 'No files are held on this project yet. A hash on its own cannot be read.'
                  : 'This deployment holds no evidence files, so there is nothing to read.',
              }))}
              ${(ingestion.files ?? [])
                .slice(0, 15)
                .filter((file) => (file.extraction.pageTables ?? []).length > 0)
                .map(
                  (file) => html`<div id="tables-${file.ingestionId}" hidden style="padding:8px 4px 4px">
                    <p class="metric-sub">
                      Rows recovered from where the text sits on the page, header row first. A blank is a blank on the page; a
                      description wrapped over two lines is joined. Nothing here is a reading of what the words mean.
                    </p>
                    ${file.extraction.pageTables.map(
                      (found, index) => html`<div style="margin-top:8px">
                        <div class="metric-sub" style="margin-bottom:4px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                          <span>
                            Table ${index + 1} · page ${found.page} · ${found.rows.length - 1} row${found.rows.length === 2 ? '' : 's'} under
                            ${found.rows[0].length} columns
                          </span>
                          <button class="btn quiet sm" data-measure="${file.ingestionId}" data-table="${index + 1}" data-name="${file.filename ?? file.hash.slice(0, 18)}">
                            Into a measurement schedule
                          </button>
                        </div>
                        ${raw(table({ headers: found.rows[0], rows: found.rows.slice(1), empty: 'A header row and nothing under it' }))}
                      </div>`,
                    )}
                  </div>`,
                )}

              ${
                transcriptions.length > 0
                  ? html`<div style="margin-top:14px">
                      <h2>Transcriptions awaiting confirmation</h2>
                      <p class="metric-sub">
                        What a model read off a scan. Nothing is indexed until somebody confirms it, and confirming files the
                        text through the same event a native read writes — with the provider and the confirmer on the record.
                      </p>
                      ${raw(table({
                        headers: ['File', 'Pages', 'Opening words', 'Confidence', ''],
                        rows: transcriptions.map((draft) => {
                          const pages = Array.isArray(draft.extraction?.pages) ? draft.extraction.pages : [];
                          const opening = pages
                            .map((page) => String(page?.text ?? '').trim())
                            .find((text) => text !== '') ?? '';
                          const file = (ingestion.files ?? []).find((entry) => entry.hash === draft.evidenceHash);
                          return [
                            file?.filename ?? draft.evidenceHash.slice(0, 18),
                            String(pages.length),
                            html`<span class="metric-sub">${opening.slice(0, 140)}${opening.length > 140 ? '…' : ''}</span>`,
                            draft.confidence !== undefined && draft.confidence !== null ? `${Math.round(draft.confidence * 100)}%` : '—',
                            html`<button class="btn sm" data-confirm="${draft.id}">Confirm</button>
                              <button class="btn quiet sm" data-discard="${draft.id}">Reject</button>`,
                          ];
                        }),
                      }))}
                    </div>`
                  : ''
              }

              ${
                quarantine.length > 0
                  ? html`<div style="margin-top:14px">
                      <h2>Refused, and why</h2>
                      ${raw(table({
                        headers: ['File', 'What was found', 'Why it is refused'],
                        rows: quarantine.flatMap((file) =>
                          file.findings.map((finding) => [
                            file.filename ?? file.hash.slice(0, 18),
                            finding.what,
                            finding.because,
                          ]),
                        ),
                      }))}
                    </div>`
                  : ''
              }
            </div>`
          : ''
      }

      <div class="card">
        <h2>Why a document can refuse to exist</h2>
        <p>
          Every type declares the records it is composed from. A mandatory record that does not exist is a refusal naming
          exactly what is missing and where to create it — never a document with the section filled in from what the
          platform assumed. A section with no record behind it reads exactly like one with a record behind it, and nobody
          downstream can tell them apart.
        </p>
        <p>
          The reasoning engine writes the connective sections — why this sequence, how a hazard leads to the control
          chosen for it, what the pattern across forty diary entries says. It is given the records and asked to reason
          about them; it is never asked for a fact. Each of those sections is marked on the page as machine-written, with
          the model’s own stated confidence beside it.
        </p>
      </div>

      ${positionReport({
        title: 'The CDM document set',
        intent: 'Each duty document, who approves it, whether it gates construction, and the sections it must contain.',
        data: cdmDocuments,
        error: cdmDocuments?.error,
        sections: [{ key: 'documents', label: 'CDM documents', empty: 'No CDM document type is published.' }],
      })}

      ${positionReport({
        title: 'Whose identity these documents carry',
        intent:
          'Every generated document leaves under a name and a mark. Shown here with where it came from, because a ' +
          'document that reaches a client under the wrong identity cannot be recalled.',
        data: branding,
        error: branding?.error,
        sections: [
          { key: 'source', label: 'Where the identity came from' },
          { key: 'branding', label: 'Identity applied', empty: 'No branding is configured, so the platform default applies.' },
        ],
      })}

      <!--
        The door. Reading whose identity a document carries was on this screen
        and setting it was not, so the one thing somebody does after discovering
        it is wrong — change it — had no button anywhere in the console. A
        capability with no door is a feature only its author can use.
      -->
      <div class="card" id="branding-door" style="margin-top:14px">
        <h2>Set the identity on this project's documents</h2>
        <div class="metric-sub" style="margin:8px 0 14px">
          Every generated document goes out under this name, this colour and this legal detail, and opens on a cover
          carrying them. Set it on the project where the client differs from your own; leave it unset and the tenancy's
          own identity carries through, which is right far more often than a client's name would be.
        </div>
        <div class="actions">
          <button class="btn" id="set-branding">Set the client identity</button>
          <label class="btn quiet" style="cursor:pointer">
            Set the cover image
            <input type="file" accept="image/png,image/jpeg,image/webp" id="cover-file" style="display:none" />
          </label>
        </div>
        <div class="cmd-error" hidden style="margin-top:12px"></div>
        <div class="metric-sub" style="margin-top:12px">
          The cover image is held by its own hash, so the document's content hash commits to exactly which image was on
          it: swap the image afterwards and the document stops verifying, which is correct for something somebody may
          have to stand behind. A document with no cover image still gets a cover — typographic rather than blank.
        </div>
      </div>

      <div id="issuer-host"></div>
    `,
  );
  void issuerPanels(root.querySelector('#issuer-host'));

  // --- the branding door -----------------------------------------------------
  const brandingError = (message) => {
    const box = document.getElementById('branding-door')?.querySelector('.cmd-error');
    if (!box) return;
    box.textContent = message;
    box.hidden = message === '';
  };

  const held = branding?.error ? undefined : branding?.branding;

  document.getElementById('set-branding')?.addEventListener('click', async () => {
    const ok = await command({
      title: "This project's client identity",
      intent:
        'What every generated document for this project says about who it is for and who issued it. It reaches the ' +
        'client on the cover and in the header of every page, and a document that reaches them under the wrong ' +
        'identity cannot be recalled.',
      path: `/v1/projects/${projectId}/branding`,
      method: 'PUT',
      submitLabel: 'Apply',
      fields: [
        { name: 'clientName', label: 'Client name', value: held?.clientName, hint: 'Prepared for. Printed verbatim on the cover.' },
        {
          name: 'issuingEntity',
          label: 'Issued by',
          value: held?.issuingEntity,
          required: false,
          hint: 'Who carries the duty under the document, where that is not you. A joint venture, or a subsidiary contracting in its own name.',
        },
        { name: 'primaryColour', label: 'Colour', value: held?.primaryColour ?? '#e2571e', hint: 'Hex, as #rrggbb. The cover band and the rules take it.' },
        {
          name: 'legalFooter',
          label: 'Legal detail',
          value: held?.legalFooter,
          hint: 'Registered office, company number and any regulated-entity detail. It goes on the cover and the foot of every page.',
        },
        {
          name: 'documentReferencePrefix',
          label: 'Reference prefix',
          value: held?.documentReferencePrefix,
          hint: 'Every document reference starts with this. It is what a page pulled out of a bundle is identified by.',
        },
        { name: 'logoRef', label: 'Logo, as a data URI', value: held?.logoRef, required: false, hint: 'Optional. A document with no logo is honest; one with somebody else\'s is not.' },
      ],
    });
    if (ok) {
      toast('Identity applied', `${ok.clientName} — every document from here carries it`, 'ok');
      await draw();
    }
  });

  document.getElementById('cover-file')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    brandingError('');
    try {
      const stored = await api.upload(`/v1/projects/${projectId}/branding/cover`, file);
      toast('Cover set', `${Math.round(stored.bytes / 1024)}KB · ${stored.contentType} — on every document from here`, 'ok');
      await draw();
    } catch (error) {
      // Named on the panel rather than only in a toast: the refusals here are
      // specific — configure the identity first, that is not a PNG — and worth
      // reading twice.
      brandingError(`${error.code ? `${error.code} — ` : ''}${error.message}`);
      event.target.value = '';
    }
  });

  const specFor = (document) => ({
    title: `Generate: ${document.title}`,
    intent: document.purpose,
    path: `/v1/projects/${projectId}/documents`,
    submitLabel: 'Generate',
    fields: [
      { name: 'code', type: 'hidden', label: 'Document', value: document.code },
      ...(document.scope === 'RECORD'
        ? [
            {
              name: 'subjectId',
              label: `Which ${humanise(document.subject).toLowerCase()}`,
              type: 'select',
              // Only this type's own records. Nothing else on the project can
              // be chosen, so nothing else can be got wrong.
              options: document.subjects.map((subject) => ({ value: subject.id, label: subject.label })),
            },
          ]
        : []),
      { name: 'preparedBy', label: 'Prepared by', type: 'text', value: state.session.user.name },
      {
        name: 'checkedBy',
        label: 'Checked by',
        type: 'text',
        required: false,
        hint: 'Left blank the document says "Not yet checked" rather than implying somebody did.',
      },
      { name: 'approvedBy', label: 'Approved by', type: 'text', required: false },
      {
        name: 'status',
        label: 'Status of this issue',
        type: 'select',
        options: [
          { value: 'DRAFT', label: 'Draft' },
          { value: 'FOR_REVIEW', label: 'For review' },
          { value: 'ISSUED', label: 'Issued' },
          { value: 'SUPERSEDED', label: 'Superseded' },
        ],
      },
      {
        name: 'audience',
        label: 'Audience',
        type: 'select',
        required: false,
        placeholder: 'The type’s own default',
        hint: 'The exporter redacts for the audience and says on the document what it withheld.',
        options: [
          { value: 'INTERNAL', label: 'Internal' },
          { value: 'CLIENT', label: 'Client' },
          { value: 'SUPPLIER', label: 'Supplier' },
          { value: 'REGULATOR', label: 'Regulator' },
          { value: 'INSURER', label: 'Insurer' },
          { value: 'ADJUDICATOR', label: 'Adjudicator' },
          { value: 'COURT', label: 'Court' },
        ],
      },
      {
        name: 'distribution',
        label: 'Issued to',
        type: 'textarea',
        rows: 3,
        required: false,
        hint: 'One party per line. A distribution nobody recorded is a document nobody can prove they sent.',
      },
      {
        name: 'withNarrative',
        label: 'Machine-written sections',
        type: 'select',
        options: [
          { value: 'true', label: 'Include them — marked as machine-written, with the stated confidence' },
          { value: 'false', label: 'Leave them out — every fact is on the document either way' },
        ],
      },
    ],
    transform: ({ distribution, withNarrative, subjectId, audience, checkedBy, approvedBy, ...rest }) => ({
      ...rest,
      code: document.code,
      ...(subjectId ? { subjectId } : {}),
      ...(audience ? { audience } : {}),
      ...(checkedBy ? { checkedBy } : {}),
      ...(approvedBy ? { approvedBy } : {}),
      withNarrative: withNarrative !== 'false',
      distribution: String(distribution ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    }),
  });

  root.addEventListener('click', async (event) => {
    const ingest = event.target.closest('[data-ingest]');
    if (ingest) {
      const entry = unread.find((item) => item.hash === ingest.dataset.ingest);
      const result = await command({
        title: 'Read this file',
        intent:
          'Look at the bytes, say what kind of document it is, and read its text where the bytes are the text. ' +
          'Nothing is decompressed and nothing is deleted — a file that should not have been accepted is quarantined ' +
          'with the reason on the record.',
        path: `/v1/projects/${projectId}/ingestion`,
        submitLabel: 'Read it',
        fields: [
          { name: 'hash', type: 'hidden', value: ingest.dataset.ingest },
          {
            name: 'filename',
            label: 'The name it was uploaded under',
            type: 'text',
            required: false,
            value: entry?.description ?? '',
            hint:
              'The store keeps the hash, not the name. Supplying it lets the platform see a mismatch between what the ' +
              'file is called and what it actually is.',
          },
        ],
      });
      if (!result) return;
      toast(
        result.status === 'QUARANTINED' ? 'File quarantined' : 'File read',
        result.status === 'QUARANTINED'
          ? `${result.findings} finding(s). The bytes are kept; nothing downstream should use them.`
          : `Read as ${humanise(result.kind).toLowerCase()}.`,
        result.status === 'QUARANTINED' ? 'bad' : 'ok',
      );
      await draw();
      return;
    }

    const read = event.target.closest('[data-read]');
    if (read) {
      // Written out, as on the design screen: one route per task is what makes
      // each one quotable and checkable against the route table.
      read.disabled = true;
      read.textContent = 'Transcribing…';
      try {
        await api.post(`/v1/projects/${projectId}/perception/document-text`, { hash: read.dataset.hash });
        toast('Transcribed', 'Read the opening words below and confirm or reject it. Nothing is indexed until you do.', 'ok');
        await draw();
      } catch (error) {
        // A refusal here is usually a true statement about the file or the
        // deployment, so it is shown as it was given rather than retitled.
        toast('Not transcribed', error.message, error.code === 'PERCEPTION_PROVIDER_UNAVAILABLE' ? 'warn' : 'err');
        read.disabled = false;
        read.textContent = 'Transcribe with a model';
      }
      return;
    }

    const confirmDraft = event.target.closest('[data-confirm]');
    if (confirmDraft) {
      confirmDraft.disabled = true;
      try {
        const result = await api.post(`/v1/projects/${projectId}/perception/${confirmDraft.dataset.confirm}/confirm`, {});
        toast(
          'Transcription confirmed',
          `${result.result?.pages ?? ''} page(s), ${result.result?.characters ?? ''} characters indexed. Read as ${humanise(result.result?.kind ?? 'unknown').toLowerCase()}.`,
          'ok',
        );
        await draw();
      } catch (error) {
        toast('Not confirmed', error.message, 'err');
        confirmDraft.disabled = false;
      }
      return;
    }

    const discardDraft = event.target.closest('[data-discard]');
    if (discardDraft) {
      const reason = window.prompt('Why is this transcription wrong? It stays in the record either way.');
      if (!reason) return;
      try {
        await api.post(`/v1/projects/${projectId}/perception/${discardDraft.dataset.discard}/discard`, { reason });
        await draw();
      } catch (error) {
        toast('Not rejected', error.message, 'err');
      }
      return;
    }

    const specify = event.target.closest('[data-specify]');
    if (specify) {
      const result = await command({
        title: `Read ${specify.dataset.name} as a specification`,
        intent:
          'The text ingestion read out of this file goes to the specification reading as it stands, with the file’s own hash as ' +
          'the document. Every clause that states a requirement becomes a clause record; a contents page or a covering letter is refused.',
        path: `/v1/projects/${projectId}/ingestion/${specify.dataset.specify}/specification`,
        submitLabel: 'Read the clauses',
        aiCost: true,
        fields: [
          { name: 'sectionRef', label: 'Work section', type: 'text', placeholder: 'E10', hint: 'As the specification numbers it — E10, A12, Section 5.' },
          { name: 'title', label: 'Section title', type: 'text', placeholder: 'In situ concrete' },
          { name: 'revision', label: 'Revision', type: 'text', placeholder: 'C2' },
        ],
      });
      if (!result) return;
      toast(
        'Specification read',
        `${result.clauses} clause${result.clauses === 1 ? '' : 's'} recorded from ${specify.dataset.name}. See them on Design & BIM.`,
        'ok',
      );
      return;
    }

    const measure = event.target.closest('[data-measure]');
    if (measure) {
      // The open schedules, so the chooser can only name one the platform has.
      const position = await api.get(`/v1/projects/${projectId}/measurement`).catch(() => ({ schedules: [] }));
      const open = (position.schedules ?? []).filter((schedule) => schedule.status === 'OPEN');
      const result = await command({
        title: `Table ${measure.dataset.table} of ${measure.dataset.name} into a schedule`,
        intent:
          'Every row with a description, a unit and a figure for its quantity becomes a measured item, sourced to this document and ' +
          'page. Headings and notes are skipped and named. Nothing is priced — a rate typed in is exactly what the estimate refuses.',
        path: `/v1/projects/${projectId}/ingestion/${measure.dataset.measure}/tables/${measure.dataset.table}/measure`,
        submitLabel: 'Record the items',
        fields: [
          {
            name: 'scheduleId',
            label: 'Measurement schedule',
            type: 'select',
            options: open.map((schedule) => ({ value: schedule.scheduleId, label: `${schedule.reference} — ${schedule.title} (${schedule.items} items)` })),
            hint: open.length === 0 ? 'No schedule is open. Open one on Tender & Procurement first.' : undefined,
          },
          {
            name: 'basis',
            label: 'Quantity basis',
            type: 'select',
            value: 'MEASURED',
            options: [
              { value: 'MEASURED', label: 'Measured — the bill’s figures stand' },
              { value: 'PROVISIONAL', label: 'Provisional — to be remeasured on site' },
              { value: 'APPROXIMATE', label: 'Approximate — off information not yet trusted' },
            ],
          },
        ],
      });
      if (!result) return;
      toast(
        `${result.recorded} item${result.recorded === 1 ? '' : 's'} recorded`,
        `${result.total} on the schedule now${result.skipped.length > 0 ? ` · ${result.skipped.length} row${result.skipped.length === 1 ? '' : 's'} skipped: ${result.skipped
          .slice(0, 3)
          .map((entry) => `row ${entry.row}, ${entry.reason}`)
          .join('; ')}` : ''}${result.findings.length > 0 ? ` · ${result.findings.length} finding${result.findings.length === 1 ? '' : 's'} on the schedule` : ''}`,
        result.findings.some((finding) => finding.severity === 'CRITICAL') ? 'warn' : 'ok',
      );
      return;
    }

    const rows = event.target.closest('[data-tables]');
    if (rows) {
      const target = root.querySelector(`#tables-${rows.dataset.tables}`);
      if (!target) return;
      target.hidden = !target.hidden;
      rows.textContent = target.hidden ? 'Show rows' : 'Hide rows';
      return;
    }

    const similar = event.target.closest('[data-similar]');
    if (similar) {
      const found = await api
        .get(`/v1/projects/${projectId}/ingestion/${similar.dataset.similar}/similar`)
        .catch(() => null);
      const matches = found?.matches ?? [];
      toast(
        matches.length === 0 ? 'Nothing close enough' : `${matches.length} document(s) read like this one`,
        matches.length === 0
          ? 'The match is lexical — shared wording, not shared meaning. Nothing on this project overlaps enough to report.'
          : matches
              .slice(0, 4)
              .map((match) => `${match.filename ?? match.hash.slice(0, 14)} — ${Math.round(match.similarity * 100)}%`)
              .join(' · '),
        matches.length === 0 ? 'warn' : 'ok',
      );
      return;
    }

    const button = event.target.closest('[data-generate]');
    if (!button) return;
    const document_ = all.find((entry) => entry.code === button.dataset.generate);
    if (!document_) return;
    const result = await command(specFor(document_));
    if (!result) return;
    // The document's own reference, not the export id. They are different
    // numbers and only one of them is what the site calls the document.
    const issued = result.document ?? {};
    const control = result.control ?? {};
    toast(
      'Document generated',
      `${control.reference ?? ''} revision ${control.revision ?? ''} · ${issued.blocks?.length ?? 0} sections · ` +
        `hash ${String(issued.contentHash ?? '').slice(0, 14)}…` +
        (result.narrativeSections ? ` · ${result.narrativeSections} machine-written section(s)` : ''),
      'ok',
    );
    await draw();
  });
}

// --- the issuing company: profile, numbers, shares -----------------------------

/**
 * Who issues this company's documents, how they are numbered, and what has
 * been shared with other companies in the group. The profile is versioned:
 * every document pins the version it went out under, and a later change
 * never alters it. Rendered after the main panel so a refusal here — a role
 * without ENTERPRISE_STRUCTURE — costs the page nothing.
 */
/** "label: value" lines into the body a legal document prints. A number stays a number. */
function parseRows(text) {
  const body = {};
  for (const line of String(text ?? '').split('\n')) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const label = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (!label) continue;
    body[label] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }
  return body;
}

async function issuerPanels(host) {
  if (!host) return;
  const [issuer, shares, lifecycle, readiness] = await Promise.all([
    api.get('/v1/company/issuer').catch((error) => ({ error })),
    api.get('/v1/shares').catch((error) => ({ error })),
    api.get('/v1/documents/lifecycle').catch((error) => ({ error })),
    api.get('/v1/company/readiness').catch(() => null),
  ]);
  if (issuer.error && shares.error && lifecycle.error) return;
  const profile = issuer.profile;
  const rules = Object.entries(profile?.numberingRules ?? {});
  const legal = readiness?.legal ?? lifecycle?.legal ?? null;
  const statusTone = (status) => (status === 'ISSUED' ? 'ok' : status === 'APPROVED' ? 'ok' : status === 'AWAITING_APPROVAL' ? 'warn' : 'neutral');
  const documentActions = (doc) => {
    const act = (action, label, tone = 'quiet') => html`<button class="btn ${tone} sm" data-document-action="${action}" data-document="${doc.id}" data-title="${doc.title}" data-revision="${doc.revision}" data-hash="${doc.revisions[doc.revisions.length - 1]?.hash ?? ''}">${label}</button>`;
    if (doc.status === 'ISSUED') return html`${act('download', 'Download')} ${act('supersede', 'Supersede')}`;
    const pending = (lifecycle.issuances ?? []).find((issuance) => issuance.documentId === doc.id && issuance.status === 'PENDING');
    if (pending) return html`${act('issue', `Retry ${pending.number}`, '')} <button class="btn quiet sm" data-issuance-void="${pending.id}" data-number="${pending.number}">Void number</button>`;
    if (doc.status === 'DRAFT') return act('generate', doc.revision === 0 ? 'Generate' : 'Regenerate');
    if (doc.status === 'GENERATED') return html`${act('generate', 'Regenerate')} ${act('submit', 'Submit')} ${act('approve', 'Approve')} ${act('issue', 'Issue', '')}`;
    if (doc.status === 'AWAITING_APPROVAL') return html`${act('approve', 'Approve', '')} ${act('reject', 'Send back')}`;
    if (doc.status === 'APPROVED') return html`${act('issue', 'Issue', '')} ${act('reject', 'Send back')} ${act('generate', 'Regenerate')}`;
    return '';
  };
  render(
    host,
    html`
      ${issuer.error
        ? ''
        : html`<div class="card" style="margin-top:14px" data-issuer>
            <h2>Who issues these documents <span class="metric-sub">version ${profile.version}</span></h2>
            <div class="metric-sub" style="margin:6px 0 12px">
              The issuing company decides what a document says about who issued it — never the person, never the group.
              Every document pins the profile version it went out under; changing the profile leaves issued documents exactly as issued.
            </div>
            ${legal
              ? html`<div class="notice ${legal.complete ? '' : 'warn'}" style="margin-bottom:12px"><div>
                  <b>Registered issuer ${legal.complete ? 'complete' : 'incomplete'}</b> · ${humanise((profile.legal?.state ?? legal.verification ?? 'UNVERIFIED').toLowerCase())}${profile.legal?.verifiedAt ? html` on ${date(profile.legal.verifiedAt)}` : ''}.
                  ${legal.complete ? 'Legal documents can be issued under it; the platform operator verifies the details against the register.' : html`Missing: ${legal.missing.join(', ')}. Nothing is issued until they are entered — no detail is guessed.`}
                </div></div>`
              : ''}
            <div class="grid g3" style="gap:14px">
              <div>
                <div class="metric-sub">Registered issuer</div>
                <b>${profile.issuer.registeredName || '—'}</b>
                ${profile.issuer.tradingName && profile.issuer.tradingName !== profile.issuer.registeredName ? html`<div class="metric-sub">trading as ${profile.issuer.tradingName}</div>` : ''}
                <div class="metric-sub">${[profile.issuer.registrationNo ? `No. ${profile.issuer.registrationNo}` : '', profile.issuer.vatNumber ? `VAT ${profile.issuer.vatNumber}` : ''].filter(Boolean).join(' · ') || 'no registration recorded'}</div>
                <div class="metric-sub">${[profile.issuer.registeredAddress.line1, profile.issuer.registeredAddress.city, profile.issuer.registeredAddress.postcode, profile.issuer.registeredAddress.country].filter(Boolean).join(', ') || 'no registered address'}</div>
              </div>
              <div>
                <div class="metric-sub">Footer on contractual documents</div>
                <div>${profile.issuer.footerLegalText || html`<span class="metric-sub">not set</span>`}</div>
              </div>
              <div>
                <div class="metric-sub">Signatories</div>
                ${profile.signatories.length ? profile.signatories.map((s) => html`<div>${s.title} <span class="metric-sub">— ${s.documents.join(', ')}</span></div>`) : html`<span class="metric-sub">none named</span>`}
              </div>
            </div>
            <h3 style="margin-top:14px">Numbering</h3>
            ${table({
              headers: ['Document type', 'Prefix', 'Pattern', 'Sequence'],
              rows: rules.map(([type, rule]) => [type, rule.prefix, rule.pattern, rule.seqScope === 'year' ? 'restarts each year' : 'continuous']),
              empty: 'No numbering rule. Exports keep their reference prefix; quotations and invoices cannot be numbered until a rule exists.',
            })}
            <div class="actions" style="margin-top:12px;flex-wrap:wrap">
              <button class="btn" data-issuer-action="issuer">Set the issuer details</button>
              <button class="btn quiet" data-issuer-action="rule">Set a numbering rule</button>
              <button class="btn quiet" data-issuer-action="signatory">Name a signatory</button>
              <button class="btn quiet" data-issuer-action="policy">Approval policy</button>
              <button class="btn quiet" data-issuer-action="allocate">Allocate a number</button>
              ${profile.version > 0 ? html`<button class="btn quiet" data-issuer-action="version">See a past version</button>` : ''}
            </div>
            <div id="issuer-result" style="margin-top:12px"></div>
          </div>`}

      ${lifecycle.error
        ? ''
        : html`<div class="card pad0" style="margin-top:14px" data-lifecycle>
            <h2 style="padding:15px 17px 0">Legal documents — draft, generated, approved, issued</h2>
            <div class="metric-sub" style="padding:6px 17px 10px">
              Quotations, invoices, contracts and certificates go out under this company’s registered issuer. A revision is a frozen,
              hashed manifest; an approval names the hash it approved; issuing reserves the number first and finishes with the same
              number on a retry. An issued document never changes — a correction supersedes it.
            </div>
            ${table({
              headers: ['Type', 'Title', 'Status', 'Revision', 'Number', 'Updated', ''],
              rows: (lifecycle.documents ?? []).map((doc) => [
                doc.documentType,
                html`${doc.title}${doc.supersedes ? html`<div class="metric-sub">supersedes ${doc.supersedes.slice(-8)}</div>` : ''}`,
                badge(humanise(doc.status.toLowerCase()), statusTone(doc.status)),
                html`${doc.revision}${doc.revisions[doc.revisions.length - 1]?.approval ? html`<div class="metric-sub">approved</div>` : ''}`,
                doc.issuance ? html`<b>${doc.issuance.number}</b>` : html`<span class="metric-sub">unnumbered</span>`,
                date(doc.updatedAt),
                html`<span class="row-actions">${documentActions(doc)}</span>`,
              ]),
              empty: 'No legal document yet. Open a draft, generate a revision, approve it, issue it.',
            })}
            ${(lifecycle.issuances ?? []).length
              ? html`<h3 style="padding:10px 17px 0">Numbers issued</h3>
                ${table({
                  headers: ['Number', 'Type', 'Status', 'Reserved', 'Issued', 'Attempts'],
                  rows: lifecycle.issuances.map((issuance) => [
                    html`<b>${issuance.number}</b>`,
                    issuance.documentType,
                    badge(issuance.status.toLowerCase(), issuance.status === 'ISSUED' ? 'ok' : issuance.status === 'VOID' ? 'bad' : 'warn'),
                    date(issuance.reservedAt),
                    issuance.issuedAt ? date(issuance.issuedAt) : html`<span class="metric-sub">${issuance.status === 'VOID' ? issuance.voidReason ?? 'void' : issuance.lastError ?? '—'}</span>`,
                    issuance.attempts,
                  ]),
                })}`
              : ''}
            <div class="actions" style="padding:12px 17px 15px"><button class="btn" data-document-new>Open a draft</button></div>
            <div id="lifecycle-result" style="padding:0 17px 15px"></div>
          </div>`}

      ${shares.error
        ? ''
        : html`<div class="card" style="margin-top:14px" data-shares>
            <h2>Shared with other companies in the group</h2>
            <div class="metric-sub" style="margin:6px 0 12px">
              By explicit grant, one record at a time — the whole record or named fields — read-only, until it expires or is
              ended, and only once the other company accepts. Ownership never moves: quotations, margins and correspondence stay
              private unless individually shared. A record shared with you renders with the owner’s branding and says who shared it.
            </div>
            ${table({
              headers: ['Direction', 'Company', 'Record', 'Fields', 'Note', 'Standing', ''],
              rows: [
                ...shares.given.map((share) => [
                  badge('given', 'neutral'),
                  share.granteeName,
                  html`${share.refType}<div class="metric-sub">${share.refId}</div>`,
                  share.fields?.length ? share.fields.join(', ') : 'whole record',
                  share.note,
                  share.revokedAt ? html`ended ${date(share.revokedAt)}` : html`${badge((share.status ?? 'ACCEPTED').toLowerCase(), share.status === 'PENDING' ? 'warn' : 'ok')}<div class="metric-sub">${share.expiresAt ? `until ${date(share.expiresAt)}` : 'until ended'}</div>`,
                  share.revokedAt ? '' : html`<button class="btn quiet sm" data-share-revoke="${share.id}">End</button>`,
                ]),
                ...shares.received.map((share) => [
                  badge('shared with us', 'ok'),
                  share.ownerName,
                  html`${share.refType}<div class="metric-sub">${share.refId}</div>`,
                  share.fields?.length ? share.fields.join(', ') : 'whole record',
                  share.note,
                  share.revokedAt ? html`ended ${date(share.revokedAt)}` : html`${badge((share.status ?? 'ACCEPTED').toLowerCase(), share.status === 'PENDING' ? 'warn' : 'ok')}<div class="metric-sub">${share.expiresAt ? `until ${date(share.expiresAt)}` : 'until ended'}</div>`,
                  share.revokedAt ? '' : share.status === 'PENDING' ? html`<button class="btn sm" data-share-accept="${share.id}">Accept</button>` : html`<button class="btn quiet sm" data-share-open="${share.id}">Open</button>`,
                ]),
              ],
              empty: shares.companies.length ? 'Nothing shared yet.' : 'This company is not in a group, so there is nobody to share with.',
            })}
            ${shares.companies.length ? html`<div class="actions" style="margin-top:12px"><button class="btn quiet" data-share-new>Share a record</button></div>` : ''}
            <div id="share-result" style="margin-top:12px"></div>
          </div>`}
    `,
  );

  const again = () => issuerPanels(host);
  const issuerResult = host.querySelector('#issuer-result');

  for (const button of host.querySelectorAll('[data-issuer-action]')) {
    button.addEventListener('click', async () => {
      const action = button.dataset.issuerAction;
      if (action === 'issuer') {
        const a = profile.issuer;
        const result = await command({
          title: 'The registered issuer',
          intent: 'What contractual documents carry. The registered name appears on them; the brand may use the trading name.',
          path: '/v1/company/issuer',
          method: 'PUT',
          submitLabel: 'Save as a new version',
          fields: [
            { name: 'registeredName', label: 'Registered name', value: a.registeredName },
            { name: 'tradingName', label: 'Trading name', value: a.tradingName, required: false },
            { name: 'registrationNo', label: 'Company number', value: a.registrationNo, required: false, hint: 'Companies House, RCCM or equivalent' },
            { name: 'vatNumber', label: 'VAT number', value: a.vatNumber, required: false },
            { name: 'line1', label: 'Registered address', value: a.registeredAddress.line1, required: false },
            { name: 'city', label: 'City', value: a.registeredAddress.city, required: false },
            { name: 'postcode', label: 'Postcode', value: a.registeredAddress.postcode, required: false },
            { name: 'country', label: 'Country code', value: a.registeredAddress.country, required: false, hint: 'GB, CD, FR…' },
            { name: 'phone', label: 'Phone', value: a.contact.phone, required: false },
            { name: 'email', label: 'Email', value: a.contact.email, required: false },
            { name: 'web', label: 'Web', value: a.contact.web, required: false },
            { name: 'footerLegalText', label: 'Footer legal text', type: 'textarea', value: a.footerLegalText, required: false, hint: 'e.g. ETABLIX LTD, registered in England & Wales No. 12345678' },
          ],
          transform: (v) => ({
            issuer: {
              registeredName: v.registeredName,
              tradingName: v.tradingName ?? '',
              registrationNo: v.registrationNo ?? '',
              vatNumber: v.vatNumber ?? '',
              registeredAddress: { line1: v.line1 ?? '', line2: a.registeredAddress.line2 ?? '', city: v.city ?? '', postcode: v.postcode ?? '', country: v.country ?? '' },
              contact: { phone: v.phone ?? '', email: v.email ?? '', web: v.web ?? '' },
              footerLegalText: v.footerLegalText ?? '',
            },
          }),
        });
        if (result) again();
      }
      if (action === 'rule') {
        const result = await command({
          title: 'A numbering rule',
          intent: 'One per document type. {YYYY}, {YY} and {MM} are the date; {seq:5} is a five-digit sequence. A yearly sequence restarts on 1 January.',
          path: '/v1/company/issuer',
          method: 'PUT',
          submitLabel: 'Save as a new version',
          fields: [
            { name: 'documentType', label: 'Document type', type: 'select', options: (issuer.documentTypes ?? []).map((t) => ({ value: t, label: t })) },
            { name: 'prefix', label: 'Prefix', placeholder: 'ETX-Q-' },
            { name: 'pattern', label: 'Pattern', value: '{YYYY}-{seq:5}' },
            { name: 'seqScope', label: 'Sequence', type: 'select', options: [{ value: 'year', label: 'Restarts each year' }, { value: 'all', label: 'Continuous' }] },
          ],
          transform: (v) => ({ numberingRules: { ...profile.numberingRules, [v.documentType]: { prefix: v.prefix, pattern: v.pattern, seqScope: v.seqScope } } }),
        });
        if (result) again();
      }
      if (action === 'signatory') {
        const people = await api.get('/v1/users').catch(() => ({ users: [] }));
        const result = await command({
          title: 'Name a signatory',
          intent: 'Who signs which kinds of document for this company. Recorded on the profile; a new version.',
          path: '/v1/company/issuer',
          method: 'PUT',
          submitLabel: 'Save as a new version',
          fields: [
            { name: 'userId', label: 'Person', type: 'select', options: (people.users ?? []).map((u) => ({ value: u.id, label: u.name })) },
            { name: 'title', label: 'Title', placeholder: 'Directeur Général' },
            { name: 'documents', label: 'Signs', type: 'multiselect', options: (issuer.documentTypes ?? []).map((t) => ({ value: t, label: t })) },
          ],
          transform: (v) => ({ signatories: [...profile.signatories.filter((s) => s.userId !== v.userId), { userId: v.userId, title: v.title, documents: v.documents ?? [] }] }),
        });
        if (result) again();
      }
      if (action === 'policy') {
        const result = await command({
          title: 'Approval policy per document type',
          intent: 'Whether a generated revision needs an approval before it is issued. By default quotations, invoices, contracts and certificates do; reports, notices and letters may go from generated to issued. A new profile version.',
          path: '/v1/company/issuer',
          method: 'PUT',
          submitLabel: 'Save as a new version',
          fields: [
            { name: 'documentType', label: 'Document type', type: 'select', options: (issuer.documentTypes ?? []).map((t) => ({ value: t, label: t })) },
            { name: 'approvalRequired', label: 'Approval required', type: 'select', options: [{ value: 'true', label: 'Yes — approved by a signatory before issue' }, { value: 'false', label: 'No — issued straight from a generated revision' }] },
          ],
          transform: (v) => ({ documentPolicies: { ...(profile.documentPolicies ?? {}), [v.documentType]: { approvalRequired: v.approvalRequired === 'true' } } }),
        });
        if (result) again();
      }
      if (action === 'allocate') {
        const result = await command({
          title: 'Allocate a document number',
          intent: 'The next number under this company’s rule for the type. Atomic and gapless: a number handed out is used.',
          path: '/v1/documents/numbers/allocate',
          submitLabel: 'Allocate',
          fields: [{ name: 'documentType', label: 'Document type', type: 'select', options: rules.map(([type]) => ({ value: type, label: type })) }],
        });
        if (result) render(issuerResult, html`<div class="notice"><div><b>${result.number}</b> — ${result.documentType} #${result.seq}, profile version ${result.profileVersion}</div></div>`);
      }
      if (action === 'version') {
        const version = Number(window.prompt(`Which version? 1 to ${profile.version}`, String(Math.max(1, profile.version - 1))));
        if (!Number.isInteger(version)) return;
        try {
          const past = await api.get(`/v1/company/issuer/versions/${version}`);
          render(issuerResult, html`<div class="notice"><div><b>Version ${past.version}</b> · ${past.change.toLowerCase()} · ${date(past.updatedAt)}<br />
            Issuer ${past.issuer.registeredName} · footer “${past.issuer.footerLegalText || '—'}” · brand ${past.brand?.clientName ?? '—'} · rules ${Object.keys(past.numberingRules).join(', ') || 'none'}</div></div>`);
        } catch (error) {
          render(issuerResult, html`<div class="notice warn"><div>${error.message}</div></div>`);
        }
      }
    });
  }

  host.querySelector('[data-share-new]')?.addEventListener('click', async () => {
    const result = await command({
      title: 'Share a record with another company',
      intent: 'Read-only, one record or named fields of it, until it expires or you end it, once the other company accepts. They see it with your branding and “shared by” on it.',
      path: '/v1/shares',
      submitLabel: 'Propose the share',
      fields: [
        { name: 'granteeTenantId', label: 'Company', type: 'select', options: shares.companies.map((c) => ({ value: c.tenantId, label: c.name })) },
        { name: 'refType', label: 'Record type', placeholder: 'Project', hint: 'As the record is named in the audit feed' },
        { name: 'refId', label: 'Record id' },
        { name: 'fields', label: 'Fields', required: false, placeholder: 'name, plannedStart, plannedCompletion', hint: 'Comma-separated field names to share; blank shares the whole record. A tender margin stays home unless named.' },
        { name: 'exportAllowed', label: 'They may export it', type: 'checkbox', required: false },
        { name: 'expiresAt', label: 'Until', type: 'date', iso: true, required: false },
        { name: 'note', label: 'Why', required: false, placeholder: 'Site services on the depot' },
      ],
      transform: (v) => ({
        granteeTenantId: v.granteeTenantId,
        refType: v.refType,
        refId: v.refId,
        ...(v.fields ? { fields: v.fields.split(',').map((field) => field.trim()).filter(Boolean) } : {}),
        exportAllowed: Boolean(v.exportAllowed),
        ...(v.expiresAt ? { expiresAt: v.expiresAt } : {}),
        ...(v.note ? { note: v.note } : {}),
      }),
    });
    if (result) again();
  });
  for (const button of host.querySelectorAll('[data-share-accept]')) {
    button.addEventListener('click', async () => {
      try {
        await api.post(`/v1/shares/${button.dataset.shareAccept}/accept`, {});
        toast('Share accepted', 'The record is readable from here, with the owner’s branding.', 'ok');
        again();
      } catch (error) {
        toast('Could not accept', error.message, 'err');
      }
    });
  }

  // The document lifecycle.
  const lifecycleResult = host.querySelector('#lifecycle-result');
  host.querySelector('[data-document-new]')?.addEventListener('click', async () => {
    const result = await command({
      title: 'Open a draft legal document',
      intent: 'Unnumbered, unapproved, changeable. The issuer is this company. The body is the rows the document prints — labels and values — and is frozen into a hashed revision when generated.',
      path: '/v1/documents/lifecycle',
      submitLabel: 'Open the draft',
      fields: [
        { name: 'documentType', label: 'Document type', type: 'select', options: (lifecycle.documentTypes ?? []).map((t) => ({ value: t, label: t })) },
        { name: 'title', label: 'Title', placeholder: 'Quotation — welfare village, phase 1' },
        { name: 'body', label: 'Rows', type: 'textarea', required: false, placeholder: 'Client: Riverside Depot Ltd\nTotal excl. VAT: 48,500.00\nValidity: 30 days', hint: 'One row per line, label: value' },
        { name: 'sourceRefType', label: 'Source record type', required: false, placeholder: 'Project' },
        { name: 'sourceRefId', label: 'Source record id', required: false },
      ],
      transform: (v) => ({
        documentType: v.documentType,
        title: v.title,
        body: parseRows(v.body),
        ...(v.sourceRefType && v.sourceRefId ? { source: { refType: v.sourceRefType, refId: v.sourceRefId } } : {}),
      }),
    });
    if (result) again();
  });
  for (const button of host.querySelectorAll('[data-document-action]')) {
    button.addEventListener('click', async () => {
      const { documentAction, document: id, title, revision, hash } = button.dataset;
      try {
        if (documentAction === 'generate') {
          const doc = await api.get(`/v1/documents/lifecycle/${id}`);
          const result = await command({
            title: `Generate a revision — ${title}`,
            intent: 'Freezes the rows, the issuer profile version, the brand and the source record’s version into a hashed manifest. Any earlier approval no longer applies to what you are about to make.',
            path: `/v1/documents/lifecycle/${id}/generate`,
            submitLabel: 'Generate',
            fields: [{ name: 'body', label: 'Rows', type: 'textarea', value: Object.entries(doc.body ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'), hint: 'One row per line, label: value' }],
            transform: (v) => ({ body: parseRows(v.body), expectedVersion: doc.version }),
          });
          if (result) again();
        }
        if (documentAction === 'submit') {
          await api.post(`/v1/documents/lifecycle/${id}/submit`, {});
          toast('Submitted', `${title} awaits its approver.`, 'ok');
          again();
        }
        if (documentAction === 'approve') {
          const result = await command({
            title: `Approve revision ${revision} — ${title}`,
            intent: `You approve exactly this revision, by its hash ${hash.slice(0, 23)}…. If the document changes, this approval no longer applies.`,
            path: `/v1/documents/lifecycle/${id}/approve`,
            submitLabel: 'Approve this revision',
            fields: [],
            transform: () => ({ revision: Number(revision), hash }),
          });
          if (result) again();
        }
        if (documentAction === 'reject') {
          const result = await command({
            title: `Send back — ${title}`,
            intent: 'The revision is marked rejected with your reason and the document becomes a draft again.',
            path: `/v1/documents/lifecycle/${id}/reject`,
            submitLabel: 'Send back',
            fields: [{ name: 'reason', label: 'Why', type: 'textarea' }],
          });
          if (result) again();
        }
        if (documentAction === 'issue') {
          const key = `issue-${id}-${revision}`;
          const result = await api.post(`/v1/documents/lifecycle/${id}/issue`, { idempotencyKey: key });
          toast(result.replayed ? 'Already issued' : 'Issued', `${title} — ${result.issuance.number}`, 'ok');
          again();
        }
        if (documentAction === 'download') {
          await api.download(`/v1/documents/lifecycle/${id}/download`, {});
          toast('Downloaded', 'The issued bytes, reauthorised on this download.', 'ok');
        }
        if (documentAction === 'supersede') {
          const doc = await api.get(`/v1/documents/lifecycle/${id}`);
          const result = await command({
            title: `Supersede ${doc.issuance?.number ?? title}`,
            intent: 'An issued document never changes. The correction is a new document that names the one it supersedes, and goes through generation, approval and issue like any other.',
            path: '/v1/documents/lifecycle',
            submitLabel: 'Open the superseding draft',
            fields: [
              { name: 'title', label: 'Title', value: `${doc.title} (revised)` },
              { name: 'body', label: 'Rows', type: 'textarea', value: Object.entries(doc.body ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n') },
            ],
            transform: (v) => ({ documentType: doc.documentType, title: v.title, body: parseRows(v.body), supersedes: doc.id, ...(doc.source ? { source: doc.source } : {}) }),
          });
          if (result) again();
        }
      } catch (error) {
        render(lifecycleResult, html`<div class="notice warn"><div><b>${error.code ?? 'Refused'}</b><br />${error.message}</div></div>`);
      }
    });
  }
  for (const button of host.querySelectorAll('[data-issuance-void]')) {
    button.addEventListener('click', async () => {
      const result = await command({
        title: `Void ${button.dataset.number}`,
        intent: 'The pending issuance is abandoned. The number stays on the record as void and is never handed out again; the document can be issued under the next number.',
        path: `/v1/documents/issuances/${button.dataset.issuanceVoid}/void`,
        submitLabel: 'Void the number',
        fields: [{ name: 'reason', label: 'Why' }],
      });
      if (result) again();
    });
  }
  for (const button of host.querySelectorAll('[data-share-revoke]')) {
    button.addEventListener('click', async () => {
      try {
        await api.post(`/v1/shares/${button.dataset.shareRevoke}/revoke`, {});
        toast('Share ended', 'The other company stops reading it on its next request.', 'ok');
        again();
      } catch (error) {
        toast('Could not end the share', error.message, 'err');
      }
    });
  }
  for (const button of host.querySelectorAll('[data-share-open]')) {
    button.addEventListener('click', async () => {
      const result = host.querySelector('#share-result');
      try {
        const opened = await api.get(`/v1/shares/${button.dataset.shareOpen}/record`);
        render(result, html`<div class="notice"><div><b>Shared by ${opened.sharedBy.name}</b> · ${opened.share.refType} · ${opened.share.note || ''}<br />
          <code style="white-space:pre-wrap;font-size:12px">${JSON.stringify(opened.record, null, 2).slice(0, 4000)}</code></div></div>`);
      } catch (error) {
        render(result, html`<div class="notice warn"><div>${error.message}</div></div>`);
      }
    });
  }
}
