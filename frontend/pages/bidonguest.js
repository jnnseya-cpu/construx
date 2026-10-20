import { api } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { badge, date, html, humanise, money, notice, raw, render, table } from '../lib/ui.js';
import { blockedReason, can, draw } from '../app.js';

/**
 * The customer's own side of Bid-On.
 *
 * ## Why this is a different screen and not a filtered one
 *
 * A Bid-On customer is a guest in their provider's tenancy, and the obvious
 * move is to show them the provider's screen with the other customers removed.
 * That is wrong twice over.
 *
 * It shows them things that are not theirs to see — what the provider charges,
 * which staff are assigned, how many other customers exist. And it buries the
 * three things they actually have to do: send the evidence that has been asked
 * for, confirm the declarations only they can confirm, and read what has been
 * delivered against what they are paying.
 *
 * So this screen is built from their point of view. Everything on it is theirs.
 *
 * ## The declarations panel is the reason this page exists
 *
 * Insurance cover, accident figures and legal statements are representations
 * their company makes to a buyer under its own name. The API refuses one from
 * the provider's staff and from an agent, which means **this screen is the only
 * place in the platform where a declaration can be confirmed at all.** Until it
 * existed, the route was reachable only through the generated command
 * catalogue — the honest record of that is in `docs/STATE.md`, and this closes
 * it.
 *
 * ## What is deliberately not here
 *
 * No approval. A customer does not approve their own answers: the provider's
 * reviewer does, because the whole service is somebody competent reading it
 * before it goes. No export. No readiness percentage either — a number that
 * says 68% invites a conversation about the number rather than about the two
 * certificates that are missing, and the gap list is the useful form of the
 * same fact.
 */

const INVOICE_TONE = { ISSUED: 'warn', PAID: 'ok', WAIVED: '', VOID: '' };

export async function bidonguest(root) {
  // A guest sees exactly one workspace, so the register is how this screen
  // finds out which. Asking for it by id would mean the browser holding an id
  // it was told rather than one it was given.
  const register = await api
    .read('/v1/bid-on/customers', 'BID_SERVICES', 'COMMERCIAL_L3')
    .catch((error) => ({ error }));

  const mine = (register?.customers ?? [])[0];
  if (register?.error || !mine) {
    render(
      root,
      html`<h1>Our bid work</h1>
        ${notice(
          register?.error
            ? (register.error.detail ?? 'This workspace could not be read.')
            : 'There is no workspace for your company here yet. Your bid writer opens one and invites you into it; ' +
              'until they do there is nothing for you to see, which is the correct answer rather than an empty page.',
          register?.error ? 'bad' : 'warn',
        )}`,
    );
    return;
  }

  const [workspace, evidence, bids, invoices] = await Promise.all([
    api.read(`/v1/bid-on/customers/${mine.id}`, 'BID_SERVICES', 'COMMERCIAL_L3').catch((error) => ({ error })),
    api
      .read(`/v1/bid-on/customers/${mine.id}/evidence`, 'BID_SERVICES', 'COMMERCIAL_L3')
      .catch((error) => ({ error })),
    api.read('/v1/bid-on/bids', 'BID_SERVICES', 'COMMERCIAL_L3').catch((error) => ({ error })),
    api.read('/v1/bid-on/invoices', 'BID_SERVICES', 'COMMERCIAL_L3').catch((error) => ({ error })),
  ]);

  const library = evidence?.evidence ?? [];
  const bidList = bids?.bids ?? [];
  const live = workspace?.liveDeclarations ?? [];
  const all = workspace?.declarations ?? [];

  // Everything the provider is waiting on, from every pack, in one list. The
  // whole point of batching gaps is that a customer answers them in a sitting
  // rather than one email at a time, and that only works if they are together.
  const asked = await Promise.all(
    bidList
      .filter((bid) => bid.openGaps > 0)
      .map((bid) =>
        api
          .read(`/v1/bid-on/bids/${bid.id}`, 'BID_SERVICES', 'COMMERCIAL_L3')
          .then((position) =>
            position.openGaps.map((gap) => ({
              bid,
              gap,
              question:
                position.questions.find((entry) => entry.question.id === gap.questionId)?.question ?? null,
            })),
          )
          .catch(() => []),
      ),
  );
  const gaps = asked.flat();

  render(
    root,
    html`
      <h1>Our bid work</h1>
      <p class="metric-sub" style="margin-bottom:14px">
        ${mine.legalName}. Everything on this page is yours: the documents we hold for you, the statements only your
        company can make, what we have been asked for, and what you are being charged. You will not find anything
        about anybody else here, and nobody else can see this.
      </p>

      ${
        gaps.length > 0
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">We need ${gaps.length} thing(s) from you</h2>
              <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                All of it in one list rather than an email each, so you can gather it in one go. Each one holds up
                exactly one answer — the rest of the submission is being written while you find these.
              </p>
              <div style="padding:11px 17px 0">
                ${raw(commandBar([
                  { id: 'send-evidence', label: 'Send us a document',
                    permitted: can('BID_SERVICES', 'C'), reason: blockedReason('BID_SERVICES', 'C') },
                  { id: 'answer-gap', label: 'Answer one of these',
                    permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
                ]))}
              </div>
              ${table({
                headers: ['Bid', 'Question', 'What we need', 'Asked', 'Due'],
                rows: gaps.map((entry) => [
                  entry.bid.buyerName,
                  entry.question ? `${entry.question.number} ${entry.question.text}` : '—',
                  entry.gap.promptToClient,
                  date(entry.gap.raisedAt),
                  entry.bid.daysLeft < 0
                    ? badge('past the deadline', 'bad')
                    : badge(`${entry.bid.daysLeft} day(s)`, entry.bid.daysLeft <= 5 ? 'warn' : ''),
                ]),
              })}
            </div>`
          : ''
      }

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Statements only your company can make</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          Your insurance cover, your accident figures, your legal statements. These go to a buyer under your name, so
          only your own director can confirm them — not us, and not the software. An answer resting on one you have not
          confirmed is held back from the submission rather than sent, because whoever confirms it is who the buyer
          will hold to it.
        </p>
        <div style="padding:11px 17px 0">
          ${raw(commandBar([
            { id: 'confirm-declaration', label: 'Confirm a statement',
              permitted: can('BID_SERVICES', 'U'), reason: blockedReason('BID_SERVICES', 'U') },
          ]))}
        </div>
        ${table({
          headers: ['Kind', 'What it says', 'Figure', 'Confirmed by', 'On', 'Good until', 'Standing'],
          rows: all.map((declaration) => {
            const isLive = live.some((entry) => entry.id === declaration.id);
            return [
              humanise(declaration.kind),
              declaration.statement,
              declaration.value ?? '—',
              declaration.confirmedByOrganisation,
              date(declaration.confirmedAt),
              declaration.validUntil ? date(declaration.validUntil) : html`<span style="font-size:12px;color:var(--text-3)">no end date</span>`,
              isLive
                ? badge('current', 'ok')
                : declaration.supersedes || all.some((entry) => entry.supersedes === declaration.id)
                  ? badge('replaced', '')
                  : badge('lapsed', 'bad'),
            ];
          }),
          empty: 'Nothing confirmed yet',
          emptyDetail:
            'Your bid writer cannot confirm these for you. Until one is confirmed, any answer that rests on it is ' +
            'held back from the submission.',
        })}
      </div>

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Documents we hold for you</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          ${evidence?.error ? 'Your documents could not be read.' : (evidence?.summary ?? '')}
          Every answer we write is drawn from these and cites the page it came from. A certificate that runs out
          before the buyer reads the submission is no use to it, which is why the end date matters as much as the
          document.
        </p>
        ${table({
          headers: ['Ref', 'Kind', 'Document', 'Expires', 'Days left', 'Standing'],
          align: ['', '', '', '', 'num', ''],
          rows: library.map((item) => [
            item.reference,
            humanise(item.type),
            item.title,
            item.expiresOn ? date(item.expiresOn) : html`<span style="font-size:12px;color:var(--text-3)">does not run out</span>`,
            item.daysLeft === null
              ? '—'
              : item.daysLeft < 0
                ? badge(`${Math.abs(item.daysLeft)} ago`, 'bad')
                : item.daysLeft <= 60
                  ? badge(String(item.daysLeft), 'warn')
                  : String(item.daysLeft),
            item.withdrawnAt ? badge('withdrawn', '') : item.currentNow ? badge('current', 'ok') : badge('out of date', 'bad'),
          ]),
          empty: 'Nothing on file yet',
          emptyDetail:
            'Send us your policies, certificates, case studies and CVs. The first bid is the slow one; after that ' +
            'they are already here.',
        })}
        ${
          (evidence?.limits ?? []).length > 0
            ? html`<div class="notice warn" style="margin:11px 17px 15px"><div>
                ${evidence.limits.map((line) => html`<div>${line}</div>`)}
              </div></div>`
            : ''
        }
      </div>

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Bids being written for you</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          Where each one is. We do not show a readiness percentage here on purpose: a number invites a conversation
          about the number, and the list above of what is still needed is the useful form of the same fact.
        </p>
        ${table({
          headers: ['Buyer', 'Scheme', 'Due', 'Left', 'Questions', 'Waiting on you', 'Where it is'],
          align: ['', '', '', 'num', 'num', 'num', ''],
          rows: bidList.map((bid) => [
            bid.buyerName,
            humanise(bid.scheme),
            // In the customer's own words: a submission with no return date is
            // "ongoing", not a blank cell and not today's date under "Due".
            bid.rolling ? badge('ongoing', 'info') : date(bid.deadline),
            bid.daysLeft === null
              ? html`<span style="font-size:12px;color:var(--text-3)">no closing date</span>`
              : bid.daysLeft < 0
                ? badge('past', 'bad')
                : String(bid.daysLeft),
            String(bid.questions),
            bid.openGaps === 0 ? badge('nothing', 'good') : badge(String(bid.openGaps), 'warn'),
            // Deliberately plain words rather than the internal status. "In
            // review" means something to a bid team; "we are checking it"
            // means something to a contractor.
            badge(
              {
                CREATED: 'just started',
                PARSING: 'reading the questionnaire',
                DRAFTING: 'being written',
                IN_REVIEW: 'we are checking it',
                APPROVED: 'checked',
                EXPORTED: 'ready for you to submit',
                SUBMITTED: 'submitted',
                WON: 'won',
                LOST: 'not this time',
              }[bid.status] ?? humanise(bid.status),
              bid.status === 'WON' ? 'good' : bid.status === 'LOST' ? 'bad' : bid.exportable ? 'ok' : '',
            ),
          ]),
          empty: 'Nothing under way',
          emptyDetail: 'When your bid writer starts a bid for you it appears here.',
        })}
      </div>

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">What you are being charged</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          ${invoices?.error ? 'Your invoices could not be read.' : (invoices?.summary ?? '')}
        </p>
        ${table({
          headers: ['Ref', 'For', 'Amount', 'Issued', 'Due', 'Standing'],
          align: ['', '', 'num', '', '', ''],
          rows: (invoices?.invoices ?? []).map((invoice) => [
            invoice.reference,
            invoice.narrative,
            money(invoice.amountMinor, invoice.currency),
            date(invoice.issuedAt),
            invoice.dueOn ? date(invoice.dueOn) : '—',
            invoice.overdue
              ? badge('past due', 'bad')
              : badge(humanise(invoice.status), INVOICE_TONE[invoice.status] ?? ''),
          ]),
          empty: 'Nothing invoiced yet',
        })}
        ${
          (invoices?.limits ?? []).length > 0
            ? html`<div class="notice info" style="margin:11px 17px 15px"><div>
                ${invoices.limits.map((line) => html`<div>${line}</div>`)}
              </div></div>`
            : ''
        }
      </div>
    `,
  );

  const COMMANDS = {
    'confirm-declaration': {
      title: 'Confirm a statement about your company',
      intent:
        'Only your own director can do this — not your bid writer and not the software — because this goes to a ' +
        'buyer under your company’s name and whoever confirms it is who the buyer will hold to it. Nothing is ' +
        'overwritten: a statement you replace stays on the record, because a bid that went out on it said so.',
      path: `/v1/bid-on/customers/${mine.id}/declarations`,
      submitLabel: 'Confirm',
      fields: [
        { name: 'kind', label: 'What kind', type: 'select',
          options: [
            { value: 'INSURANCE', label: 'Insurance cover' },
            { value: 'ACCIDENT_STATISTICS', label: 'Accident figures' },
            { value: 'LEGAL_STATEMENT', label: 'A legal statement' },
            { value: 'FINANCIAL', label: 'Something financial' },
            { value: 'OTHER', label: 'Something else' },
          ] },
        { name: 'statement', label: 'What it says', type: 'textarea', rows: 3,
          hint: 'As a buyer should read it — "Employers liability cover of £10m each and every claim".' },
        { name: 'value', label: 'The figure', type: 'text', required: false,
          hint: 'Where there is one. "£10m each and every claim", "0.12 per 100,000 hours".' },
        { name: 'validUntil', label: 'Good until', type: 'date', required: false,
          hint: 'Your renewal date, where it has one. After it, answers resting on this are held back rather than sent.' },
        { name: 'supersedes', label: 'Replaces', type: 'select', required: false,
          options: [
            { value: '', label: 'A new statement' },
            ...live.map((declaration) => ({
              value: declaration.id,
              label: `${humanise(declaration.kind)} — ${declaration.statement.slice(0, 60)}`,
            })),
          ],
          hint: 'Pick the one this updates and the old one is kept as what you said before.' },
      ],
      transform: (v) => Object.fromEntries(Object.entries(v).filter(([, value]) => String(value ?? '').trim())),
    },
    'send-evidence': {
      title: 'Send us a document',
      intent:
        'Your policies, certificates, case studies and CVs. A certificate needs the date it runs out, because one ' +
        'that expires before the buyer reads the submission is no use to it. A CV needs that person’s consent — it ' +
        'is their data and it is going to a buyer.',
      path: `/v1/bid-on/customers/${mine.id}/evidence`,
      submitLabel: 'Send',
      fields: [
        { name: 'type', label: 'What is it', type: 'select',
          options: [
            { value: 'POLICY', label: 'A policy' },
            { value: 'CERTIFICATE', label: 'A certificate — needs its end date' },
            { value: 'CASE_STUDY', label: 'A past job we can describe' },
            { value: 'CV', label: 'Somebody’s CV — needs their consent' },
            { value: 'STATS', label: 'Accident or performance figures' },
            { value: 'INSURANCE', label: 'An insurance schedule — needs its end date' },
            { value: 'OTHER', label: 'Something else' },
          ] },
        { name: 'title', label: 'What to call it', type: 'text' },
        { name: 'hash', label: 'File reference', type: 'text',
          hint: 'The reference of the file you uploaded. Your bid writer can give you this if you are unsure.' },
        { name: 'expiresOn', label: 'Runs out on', type: 'date', required: false },
        { name: 'consentSubject', label: 'Whose CV is it', type: 'text', required: false },
        { name: 'consentBasis', label: 'How you got their consent', type: 'text', required: false },
      ],
      transform: ({ consentSubject, consentBasis, ...rest }) => ({
        ...Object.fromEntries(Object.entries(rest).filter(([, value]) => String(value ?? '').trim())),
        ...(String(consentSubject ?? '').trim()
          ? { consent: { subject: String(consentSubject).trim(), basis: String(consentBasis ?? '').trim() } }
          : {}),
      }),
    },
    'answer-gap': {
      title: 'Answer one of the things we asked for',
      intent:
        'Either point us at a document you have sent, or answer in words where there is no document. Each of these ' +
        'holds up exactly one answer; the rest of your submission is being written in the meantime.',
      path: (v) => {
        const [bidId, gapId] = String(v.gap).split('::');
        return `/v1/bid-on/bids/${bidId}/gaps/${gapId}/resolve`;
      },
      submitLabel: 'Send',
      fields: [
        { name: 'gap', label: 'Which one', type: 'select',
          // One chooser carrying both ids, so a customer cannot pick a request
          // from one bid and a bid from another.
          options: gaps.map((entry) => ({
            value: `${entry.bid.id}::${entry.gap.id}`,
            label: `${entry.bid.buyerName} — ${entry.gap.promptToClient.slice(0, 70)}`,
          })) },
        { name: 'evidenceId', label: 'The document', type: 'select', required: false,
          options: [
            { value: '', label: 'No document — I will answer in words' },
            ...library
              .filter((item) => !item.withdrawnAt)
              .map((item) => ({ value: item.id, label: `${item.reference} — ${item.title}` })),
          ] },
        { name: 'note', label: 'Anything we should know', type: 'textarea', rows: 3 },
      ],
      transform: ({ gap: _g, evidenceId, ...rest }) => ({
        ...rest,
        ...(String(evidenceId ?? '').trim() ? { evidenceId: String(evidenceId).trim() } : {}),
      }),
    },
  };

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const spec = COMMANDS[button.dataset.command];
    if (!spec) return;
    if (await command(spec)) await draw();
  });
}
