import { api } from '../lib/api.js';
import { command } from '../lib/command.js';
import { badge, html, humanise, notice, raw, render, table, toast } from '../lib/ui.js';
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

  const [catalogue, ingestion, evidence] = await Promise.all([
    api.get(`/v1/projects/${projectId}/documents`).catch(() => ({ documents: [], summary: '' })),
    api.get(`/v1/projects/${projectId}/ingestion`).catch(() => null),
    api.get(`/v1/projects/${projectId}/evidence`).catch(() => null),
  ]);
  const all = catalogue.documents ?? [];
  const generable = all.filter((document) => document.generable);

  // Held, named in the ledger, and never looked at. The queue the ingestion
  // pipeline exists to empty — and the only list on this screen that is about
  // documents somebody else wrote rather than documents this platform composes.
  const ingested = new Set((ingestion?.files ?? []).map((file) => file.hash));
  const unread = (evidence?.entries ?? []).filter((entry) => entry.held && !ingested.has(entry.hash));
  const quarantine = ingestion?.position?.quarantine ?? [];

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
                    text extracted and indexed${ingestion.position.awaitingOcr > 0
                      ? ` · ${ingestion.position.awaitingOcr} need a model that can see`
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
                      ? 'Read'
                      : file.extraction.method === 'NEEDS_OCR'
                        ? 'Needs a model that can see'
                        : '—',
                    file.lexicalVector
                      ? html`<button class="btn quiet sm" data-similar="${file.ingestionId}">Find duplicates</button>`
                      : '',
                  ]),
                ],
                empty: evidence?.storeConfigured
                  ? 'No files are held on this project yet. A hash on its own cannot be read.'
                  : 'This deployment holds no evidence files, so there is nothing to read.',
              }))}

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
    `,
  );

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
