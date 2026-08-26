import { api, ApiError, hashFile } from './api.js';
import { recordVoice, voiceSupport } from './voice.js';
import { forEvidence } from './capture.js';
import { queueFile } from './outbox.js';
import { esc, exact, toast } from './ui.js';

/**
 * Command surfaces.
 *
 * The platform is a command system with sixty-eight project-scoped commands,
 * and a screen that only reads is half a product. Every command here builds its
 * body from a declared field list, posts to the real endpoint, and surfaces the
 * API's own problem+json — including per-field validation errors — rather than
 * validating a second time in the browser and drifting from the schema.
 *
 * Nothing is submitted optimistically. The panel stays open until the platform
 * has accepted the command, because a field record that shows work as saved
 * when it was rejected is worse than one that shows nothing.
 */

// `datetime-local` is here because a tender deadline is a date *and* a time and
// a `date` field cannot express one. Falling back to `text` made the person
// type `2027-03-12T12:00` by hand into the most consequential field in the
// stage, which is where the typos that lose bids come from.
const FIELD_TYPES = new Set(['text', 'number', 'date', 'datetime-local', 'month', 'select', 'textarea', 'hidden']);

/**
 * The hash is computed in the browser over the real bytes and becomes the
 * evidence reference in the event. `hashFile` lives in the API client, which is
 * where the wire format is decided; this file used to carry its own copy.
 *
 * The file itself now follows the record. It could not before — the platform
 * held hashes and no object store — and a hash alone is a chain that lasts
 * exactly as long as somebody outside the platform still has the document.
 */

/**
 * Send the files behind the hashes this command just committed.
 *
 * Failures are queued rather than surfaced as errors: the command succeeded,
 * and telling somebody their record failed because an upload retried would be
 * false. What is worth saying is when a file is being carried on the device.
 */
async function storeEvidence(files) {
  const carried = [];
  for (const { hash, file } of files) {
    try {
      await api.upload(`/v1/evidence/${encodeURIComponent(hash)}`, file);
    } catch {
      try {
        await queueFile(file);
        carried.push(file.name);
      } catch {
        // No IndexedDB — a private window, or storage refused. The record and
        // its hash still stand; the file does not follow it.
        carried.push(file.name);
      }
    }
  }
  if (carried.length > 0) {
    toast(
      'Held on this device',
      `${carried.join(', ')} could not be stored yet. The record is filed; the file will follow on the next sync.`,
      'warn',
    );
  }
}

function control(field) {
  const id = `cmd-${field.name}`;
  const required = field.required === false ? '' : 'required';

  if (field.type === 'select') {
    // An entry carrying its own `options` is a heading, not a value — see
    // `SECTOR_GROUPED`. Nothing about the submitted body changes; the grouping
    // only affects where a reader's eye lands in a nine-item list.
    const option = (o) =>
      o.options
        ? `<optgroup label="${esc(o.label)}">${o.options.map(option).join('')}</optgroup>`
        : `<option value="${esc(o.value)}"${String(o.value) === String(field.value ?? '') ? ' selected' : ''}>${esc(o.label)}</option>`;

    return `<select id="${id}" name="${esc(field.name)}" ${required}>
      ${field.placeholder ? `<option value="">${esc(field.placeholder)}</option>` : ''}
      ${(field.options ?? []).map(option).join('')}
    </select>`;
  }

  if (field.type === 'textarea') {
    return `<textarea id="${id}" name="${esc(field.name)}" rows="${field.rows ?? 3}" ${required}
      placeholder="${esc(field.placeholder ?? '')}">${esc(field.value ?? '')}</textarea>`;
  }

  if (field.type === 'file') {
    // A dictate button beside the file input rather than instead of it. The
    // specification wants voice across every field module, and a note is
    // sometimes a photograph and sometimes a sentence — offering only one of
    // the two would move the gap rather than close it.
    const support = field.voice === false ? { available: false } : voiceSupport();
    return `<input id="${id}" name="${esc(field.name)}" type="file" ${required}>
      ${
        support.available
          ? `<div class="voice-field" style="margin-top:8px">
               <button type="button" class="btn quiet sm" data-dictate="${esc(field.name)}">Dictate instead</button>
               <span class="voice-taken" data-dictated="${esc(field.name)}" hidden></span>
             </div>`
          : ''
      }
      <div class="file-hash" hidden></div>`;
  }

  const type = FIELD_TYPES.has(field.type) ? field.type : 'text';
  const step = field.type === 'number' ? ` step="${esc(field.step ?? 'any')}"` : '';
  const min = field.min !== undefined ? ` min="${esc(field.min)}"` : '';
  // `max` was never rendered, so a date field had no upper bound to offer even
  // where one obviously applied. The bound is an affordance — it puts the
  // calendar's greyed-out days in the right place — and never the enforcement:
  // the API refuses a future notice date whatever the browser allowed.
  const max = field.max !== undefined ? ` max="${esc(field.max)}"` : '';
  return `<input id="${id}" name="${esc(field.name)}" type="${type}" value="${esc(field.value ?? '')}"
    placeholder="${esc(field.placeholder ?? '')}"${step}${min}${max} ${required}>`;
}

async function collect(host, fields, files = []) {
  const body = {};
  for (const field of fields) {
    if (field.type === 'file') {
      const el = host.querySelector(`[name="${CSS.escape(field.name)}"]`);
      // A dictated recording is held on the element rather than in `files`,
      // which is read-only. Either way it is the same `File` from here on and
      // takes the same path: prepared, hashed, filed, uploaded, queued if it
      // cannot be.
      const file = el?.dictated ?? el?.files?.[0];
      if (!file) {
        if (field.required === false) continue;
        throw new ApiError({ title: 'EVIDENCE_REQUIRED', detail: `${field.label} is required` }, 400);
      }
      // Resize before hashing, never after. The hash is the address the bytes
      // are stored at and the value written into an append-only event, so it
      // has to be taken over the bytes that are actually kept. A large
      // photograph comes back smaller; everything else comes back untouched.
      const prepared = await forEvidence(file);
      const hash = await hashFile(prepared);
      body[field.name] = hash;
      // The prepared name, not the captured one: a resized HEIC is stored as
      // JPEG bytes, and a record naming it `.HEIC` would hand somebody a file
      // their machine refuses to open.
      if (field.nameInto) body[field.nameInto] = prepared.name;
      // Held for after the command succeeds. The upload is refused until a
      // ledger record names the hash, and this command is what creates it.
      files.push({ hash, file: prepared });
      continue;
    }

    const el = host.querySelector(`[name="${CSS.escape(field.name)}"]`);
    if (!el) continue;

    let value = el.value;
    if (value === '' && field.required === false) continue;

    if (field.type === 'number') {
      const numeric = Number(value);
      // Money is entered in major units because that is how people say it, and
      // stored in minor units because that is the only way it stays exact.
      value = field.money ? Math.round(numeric * 100) : numeric;
    }
    if (field.type === 'date' && field.iso) value = new Date(`${value}T00:00:00Z`).toISOString();

    body[field.name] = value;
  }
  return body;
}

/**
 * Open a command panel. Resolves with the API response once the platform has
 * accepted it, or null if the user closed the panel.
 *
 * `path` is the endpoint. It may be a function of the collected payload, for
 * commands where the subject of the command is part of the URL rather than the
 * body — a pay less notice is given *against an application*, and putting the
 * application id in the body would give the endpoint two ways to say the same
 * thing. `transform` lets a caller reshape the collected fields into the body
 * the endpoint expects, for commands whose shape is not flat.
 *
 * `aiCost` marks a command that reaches an AI provider. The panel then quotes
 * the action as it opens and puts the figure above the submit button, so the
 * cost is on screen before the person commits — the same rule the confirmation
 * dialog enforces, met inside a panel that was going to open anyway rather than
 * by stacking a second dialog in front of it.
 */
export function command({ title, intent, path, fields, submitLabel = 'Submit', transform, aiCost = false }) {
  return new Promise((resolveCommand) => {
    const host = document.createElement('div');
    host.className = 'modal-host';
    host.innerHTML = `<form class="modal" novalidate>
      <header>
        <div>
          <h3>${esc(title)}</h3>
          ${intent ? `<div class="metric-sub">${esc(intent)}</div>` : ''}
        </div>
        <button type="button" data-close aria-label="Close">×</button>
      </header>
      <div class="body">
        <div class="cmd-error" hidden></div>
        ${fields
          .filter((f) => f.type !== 'hidden')
          .map(
            (f) => `<div class="field" data-field="${esc(f.name)}">
              <label for="cmd-${esc(f.name)}">${esc(f.label)}${f.required === false ? ' <span class="opt">optional</span>' : ''}</label>
              ${control(f)}
              ${f.hint ? `<div class="metric-sub">${esc(f.hint)}</div>` : ''}
              <div class="field-error" hidden></div>
            </div>`,
          )
          .join('')}
        ${aiCost ? '<div class="cost-slot"></div>' : ''}
      </div>
      <div class="foot">
        <button type="button" class="btn quiet" data-close>Cancel</button>
        <button type="submit" class="btn" data-submit>${esc(submitLabel)}</button>
      </div>
    </form>`;

    const close = (value) => {
      host.remove();
      document.removeEventListener('keydown', onKey);
      resolveCommand(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(null);
    };

    const errorBox = host.querySelector('.cmd-error');
    const submit = host.querySelector('[data-submit]');

    function showProblem(error) {
      for (const el of host.querySelectorAll('.field-error')) {
        el.hidden = true;
        el.textContent = '';
      }

      const fieldErrors = error instanceof ApiError ? error.fieldErrors : [];
      let handled = 0;
      for (const detail of fieldErrors) {
        const name = String(detail.path ?? detail.field ?? '').replace(/^\//, '');
        const box = host.querySelector(`[data-field="${CSS.escape(name)}"] .field-error`);
        if (!box) continue;
        box.textContent = detail.message ?? 'Invalid';
        box.hidden = false;
        handled += 1;
      }

      // A denial or a domain rule is about the command, not one field.
      if (handled === 0) {
        errorBox.textContent = `${error.code ? `${error.code} — ` : ''}${error.message}`;
        errorBox.hidden = false;
      }
    }

    host.addEventListener('click', async (event) => {
      if (event.target === host || event.target.closest('[data-close]')) return close(null);

      const dictate = event.target.closest('[data-dictate]');
      if (!dictate) return;

      const name = dictate.dataset.dictate;
      const label = fields.find((f) => f.name === name)?.label ?? 'evidence';
      const recording = await recordVoice({
        title: `Dictate: ${label}`,
        intent: 'The recording is filed as evidence exactly as a photograph would be. Nothing is sent until you submit.',
      });
      if (!recording) return;

      // Held on the element: `input.files` cannot be assigned from a Blob in
      // every browser, and a hidden second input would be a second place the
      // truth about "what file is attached" lives.
      const input = host.querySelector(`[name="${CSS.escape(name)}"]`);
      input.dictated = recording;
      input.removeAttribute('required');

      const taken = host.querySelector(`[data-dictated="${CSS.escape(name)}"]`);
      if (taken) {
        taken.textContent = `${recording.name} · ${Math.round(recording.size / 1024)}KB attached`;
        taken.hidden = false;
      }
      dictate.textContent = 'Record again';
    });

    host.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      errorBox.hidden = true;
      submit.disabled = true;
      submit.textContent = 'Working…';

      const files = [];
      try {
        const collected = await collect(host, fields, files);
        const payload = transform ? transform(collected) : collected;
        const response = await api.post(typeof path === 'function' ? path(collected) : path, payload);
        toast(title, 'Recorded in the Golden Thread', 'ok');
        // Afterwards, and never as a condition of the command. The record is
        // what the chain is made of; the file is what makes it useful in three
        // years, and a failed upload must not undo a command the platform has
        // already accepted. Anything that does not land is queued on the device
        // and retried on the next sync rather than lost.
        void storeEvidence(files);
        close(response);
      } catch (error) {
        showProblem(error);
        submit.disabled = false;
        submit.textContent = submitLabel;
      }
    });

    document.addEventListener('keydown', onKey);
    document.body.append(host);
    host.querySelector('input, select, textarea')?.focus();

    if (aiCost) {
      const slot = host.querySelector('.cost-slot');
      // The path may depend on fields the person has not filled in yet, so the
      // quote is taken against the path as declared. Every quotable route is
      // identified by its pattern rather than its body, so that is the same
      // route the submit will hit.
      const quotePath = typeof path === 'function' ? path({}) : path;

      // Held shut until the cost is on screen. An AI panel that could be
      // submitted before its price arrived would defeat the rule on exactly
      // the fast connections nobody tests on.
      submit.disabled = true;
      quoteAction(quotePath)
        .then((quote) => {
          slot.innerHTML = costBlock(quote);
          submit.disabled = !quote.affordable;
          if (quote.affordable) submit.textContent = `${submitLabel} · ${exact(quote.estimatedChargeMinor)}`;
        })
        .catch((error) => {
          slot.innerHTML = `<div class="notice err">${esc(error.message)}</div>`;
        });
    }
  });
}

/**
 * What an AI action would cost, asked of the platform rather than guessed here.
 *
 * The browser names the request it is about to send and nothing else. Which
 * engine that reaches, what it is charged at and whether the wallet can carry
 * it are all server-side facts, and duplicating any of them here would create a
 * second pricing model that drifts from the one that bills.
 */
export function quoteAction(path) {
  return api.post('/v1/ai/quote', { method: 'POST', path });
}

/** How confident the figure is, said in words rather than left to a label. */
function quoteBasisText(quote) {
  if (quote.basis === 'MEASURED') {
    const range =
      quote.highChargeMinor && quote.highChargeMinor !== quote.lowChargeMinor
        ? ` They cost between ${exact(quote.lowChargeMinor)} and ${exact(quote.highChargeMinor)}.`
        : '';
    const runs = quote.observations === 1 ? 'one previous run' : `${quote.observations} previous runs`;
    return `Estimated from ${runs} of this action on your account.${range}`;
  }
  return 'This action has not run on your account yet, so this is the provider’s floor cost rather than a prediction — the real charge is usually higher. It becomes a measured figure after the first run.';
}

/**
 * Why the action cannot run, in the customer's own currency.
 *
 * The platform decides *whether* it is blocked and *by what* — this only words
 * it. The server's own message is written in minor units for a log and ends by
 * saying execution was halted, which is not true of something that has not
 * started, so it is the fallback rather than the first choice.
 */
function quoteBlockedText(quote) {
  if (quote.blockedBy === 'BALANCE') {
    return `This action costs ${exact(quote.estimatedChargeMinor)} and ${exact(quote.availableMinor)} is available. Top up before running it.`;
  }
  if (quote.blockedBy === 'CAP' && quote.capBreach) {
    const { scope, capMinor, spentMinor, scopeId } = quote.capBreach;
    const where =
      scope === 'MONTHLY' ? 'this month’s AI budget' : scope === 'PROJECT' ? 'this project’s AI budget' : `the AI budget for ${scopeId}`;
    return `This would take ${where} past its ${exact(capMinor)} cap — ${exact(spentMinor)} of it is already spent. The cap is a setting, not a shortage.`;
  }
  return quote.blockedReason;
}

/**
 * The cost of an AI action, as a block to put in front of the button that
 * spends it. Shared by the confirmation dialog and the command panels so both
 * say the same thing in the same words.
 */
export function costBlock(quote) {
  const blocked = Boolean(quote.blockedReason);
  return `<div class="cost-quote${blocked ? ' blocked' : ''}">
    <div class="cost-head">
      <div>
        <div class="metric">${esc(exact(quote.estimatedChargeMinor))}</div>
        <div class="metric-sub">estimated ACU charge</div>
      </div>
      <div class="cost-balance">
        <div>${esc(exact(quote.availableMinor))} available</div>
        ${
          // Only where it can actually run. "£858.00 after this action" under a
          // refusal describes something that is not going to happen.
          blocked ? '' : `<div class="metric-sub">${esc(exact(quote.balanceAfterMinor))} after this action</div>`
        }
      </div>
    </div>
    <div class="metric-sub">${esc(quoteBasisText(quote))}</div>
    ${blocked ? `<div class="notice warn">${esc(quoteBlockedText(quote))}</div>` : ''}
  </div>`;
}

/**
 * Show what an AI action will cost and wait for the person to accept it.
 *
 * The commercial model states the rule plainly: no AI action runs without
 * showing its estimated cost first. A prepaid balance that moves for reasons
 * the customer could not see beforehand reads as a meter running, however fair
 * the arithmetic, and no amount of billing transparency after the fact repairs
 * that.
 *
 * Resolves true only if the person accepted. A quote that cannot be obtained is
 * a refusal, not a licence to spend — if the platform cannot say what something
 * costs, nobody is committed to it by default.
 */
export function confirmCost({ title, intent, path, runLabel = 'Run' }) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'modal-host';
    host.innerHTML = `<div class="modal">
      <header>
        <div>
          <h3>${esc(title)}</h3>
          ${intent ? `<div class="metric-sub">${esc(intent)}</div>` : ''}
        </div>
        <button type="button" data-close aria-label="Close">×</button>
      </header>
      <div class="body"><div class="cost-slot">Asking what this costs…</div></div>
      <div class="foot">
        <button type="button" class="btn quiet" data-close>Cancel</button>
        <button type="button" class="btn" data-run disabled>${esc(runLabel)}</button>
      </div>
    </div>`;

    const close = (value) => {
      host.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(false);
    };

    const slot = host.querySelector('.cost-slot');
    const run = host.querySelector('[data-run]');

    host.addEventListener('click', (event) => {
      if (event.target === host || event.target.closest('[data-close]')) close(false);
    });
    run.addEventListener('click', () => close(true));

    document.addEventListener('keydown', onKey);
    document.body.append(host);

    quoteAction(path)
      .then((quote) => {
        slot.innerHTML = costBlock(quote);
        if (quote.affordable) {
          run.disabled = false;
          run.textContent = `${runLabel} · ${exact(quote.estimatedChargeMinor)}`;
          run.focus();
        } else {
          // Left disabled. The reason is already on screen, and a button that
          // fails on click teaches people to distrust every other button.
          run.textContent = runLabel;
        }
      })
      .catch((error) => {
        slot.innerHTML = `<div class="notice err">${esc(error.message)}</div>`;
      });
  });
}

/**
 * A row of command buttons. Each entry declares the capability it needs, so a
 * role that cannot run the command sees why rather than a button that fails.
 */
export function commandBar(entries) {
  return entries
    .filter((entry) => entry)
    .map((entry) =>
      entry.permitted
        ? `<button class="btn ${esc(entry.tone ?? 'quiet')}" data-command="${esc(entry.id)}">${esc(entry.label)}</button>`
        : `<button class="btn quiet locked" disabled title="${esc(entry.reason ?? 'Not permitted for your role')}">${esc(entry.label)} 🔒</button>`,
    )
    .join('');
}
