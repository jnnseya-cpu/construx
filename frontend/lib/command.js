import { api, ApiError, hashFile, isRoleDenial } from './api.js';
import { recordVoice, voiceSupport } from './voice.js';
import { forEvidence } from './capture.js';
import { queueFile, uploadInParts } from './outbox.js';
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
/**
 * Above this, a console upload is sent in resumable parts rather than in one
 * request. Sixty-four megabytes: below it a single request is quicker and a
 * failed one is cheap to repeat; above it the cost of starting again is the
 * thing worth avoiding.
 */
const PARTS_ABOVE_BYTES = 64 * 1_048_576;

async function storeEvidence(files) {
  const carried = [];
  for (const { hash, file } of files) {
    try {
      const path = `/v1/evidence/${encodeURIComponent(hash)}`;
      /*
       * A large file goes up in resumable parts, here as well as from the
       * outbox.
       *
       * One request for three gigabytes means one dropped connection costs the
       * whole of it — and construction uploads happen on site connections. The
       * parts are checksummed and the platform is asked what it already holds,
       * so a retry sends what is missing rather than starting again. Under the
       * threshold a file is sent in one request, which is what it always was.
       */
      if (file.size > PARTS_ABOVE_BYTES) {
        await uploadInParts((target, blob) => api.upload(target, blob), (target) => api.get(target), path, file);
      } else {
        await api.upload(path, file);
      }
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


/**
 * The per-file upload ceiling the platform enforces, read from the platform.
 *
 * Fetched once per page load and remembered. `/v1/commands` publishes it beside
 * the schemas for the same reason it publishes those: the console holds no rule
 * the API does not, and a limit guessed here would be a second limit to keep in
 * step with `EVIDENCE_MAX_BYTES`.
 *
 * Returns 0 when it cannot be read, which means "do not refuse anything" — a
 * console that blocked every upload because one read failed would be worse than
 * one that lets the server refuse a file it was always going to refuse.
 */
let ceilingPromise = null;
function evidenceCeiling() {
  ceilingPromise ??= api
    .get('/v1/commands')
    .then((published) => Number(published?.evidenceMaxBytes ?? 0) || 0)
    .catch(() => 0);
  return ceilingPromise;
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

  if (field.type === 'multiselect') {
    // A real multiple-select rather than a comma-separated text box.
    // Scopes are the case this exists for: a person picking what an
    // integration may do needs to see the whole list of what they could
    // grant, and typing them means typos that fail server-side with a
    // message about a scope nobody meant to ask for.
    //
    // `field.value` marks what is already chosen, and it has to, because every
    // endpoint behind a multiselect *replaces* the set rather than adding to
    // it. The roles form passed the person's current roles and this ignored
    // them, so an administrator opening "Change what Ana may do" saw nothing
    // selected and submitted whatever they ticked — silently stripping every
    // role they had not remembered to re-tick. A pre-selection is not a
    // convenience here; it is the difference between amending an authority and
    // replacing it by accident.
    const chosen = new Set((Array.isArray(field.value) ? field.value : field.value == null ? [] : [field.value]).map(String));
    return `<select id="${id}" name="${esc(field.name)}" multiple size="${Math.min(10, Math.max(4, (field.options ?? []).length))}" ${required}>
      ${(field.options ?? [])
        .map((o) => `<option value="${esc(o.value)}"${chosen.has(String(o.value)) ? ' selected' : ''}>${esc(o.label)}</option>`)
        .join('')}
    </select>`;
  }

  if (field.type === 'checkbox') {
    // A yes or no. Never `required`: an unticked box is an answer, and the
    // browser's required-checkbox rule would refuse "no" as an omission. It
    // used to fall through to the generic input below, which rendered a
    // checkbox and then submitted its `value` — the string "on" — to a schema
    // that asked for a boolean. The operator saw "must be of type boolean,
    // received string" and could not grant a package free of charge.
    return `<input id="${id}" name="${esc(field.name)}" type="checkbox"${field.value ? ' checked' : ''}>`;
  }

  if (field.type === 'textarea') {
    return `<textarea id="${id}" name="${esc(field.name)}" rows="${field.rows ?? 3}" ${required}
      placeholder="${esc(field.placeholder ?? '')}">${esc(field.value ?? '')}</textarea>`;
  }

  if (field.type === 'textfile') {
    // A file the browser reads as TEXT into another field, entirely on the
    // device — it is never uploaded, hashed or filed. It exists to fill a paste
    // box from a chosen file (a CSV price list) so the same parse, on-screen
    // preview and import path handles a file and a paste identically. The
    // reading is wired below `data-textfile-into`, and an optional `parse` on
    // the field reshapes the text first (CSV columns → the paste box's lines).
    const accept = field.accept ? ` accept="${esc(field.accept)}"` : '';
    return `<input id="${id}" name="${esc(field.name)}" type="file"${accept} data-textfile-into="${esc(field.into ?? '')}">`;
  }

  if (field.type === 'file') {
    // A dictate button beside the file input rather than instead of it. The
    // specification wants voice across every field module, and a note is
    // sometimes a photograph and sometimes a sentence — offering only one of
    // the two would move the gap rather than close it.
    const support = field.voice === false ? { available: false } : voiceSupport();
    // `multiple` is one field that files many records. A tender pack is a Word
    // instruction, a spreadsheet of deliverables, a drawing set, a model and a
    // dozen photographs of a site, and filing them one modal at a time is not
    // something anybody does twelve times.
    const many = field.multiple ? ' multiple' : '';
    return `<input id="${id}" name="${esc(field.name)}" type="file"${many} ${required}>
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
  // Suggestions, not a choice. A select would be wrong wherever the platform
  // has an opinion about the usual answers and still has to accept an unusual
  // one — a bill may legitimately be measured in something the unit engine does
  // not read, and the engine reports that rather than refusing it. A datalist
  // offers the recognised set and takes anything.
  const suggestions = Array.isArray(field.suggestions) && field.suggestions.length > 0 ? field.suggestions : null;
  const listId = suggestions ? `${id}-list` : '';
  const list = suggestions ? ` list="${listId}"` : '';
  const datalist = suggestions
    ? `<datalist id="${listId}">${suggestions
        .map((option) =>
          typeof option === 'string'
            ? `<option value="${esc(option)}"></option>`
            : `<option value="${esc(option.value)}">${esc(option.label ?? '')}</option>`,
        )
        .join('')}</datalist>`
    : '';
  const step = field.type === 'number' ? ` step="${esc(field.step ?? 'any')}"` : '';
  const min = field.min !== undefined ? ` min="${esc(field.min)}"` : '';
  // `max` was never rendered, so a date field had no upper bound to offer even
  // where one obviously applied. The bound is an affordance — it puts the
  // calendar's greyed-out days in the right place — and never the enforcement:
  // the API refuses a future notice date whatever the browser allowed.
  const max = field.max !== undefined ? ` max="${esc(field.max)}"` : '';
  return `<input id="${id}" name="${esc(field.name)}" type="${type}" value="${esc(field.value ?? '')}"
    placeholder="${esc(field.placeholder ?? '')}"${step}${min}${max}${list} ${required}>${datalist}`;
}

/**
 * Read the form into the body the command will send.
 *
 * Returns the body and, where a file field took more than one file, one overlay
 * per extra file. Each overlay carries that file's hash and name, and the
 * caller sends the command once per overlay — because one document is one
 * record. Filing ten documents as one record with ten hashes would make the
 * ledger say a thing that is not true: that one document arrived with ten
 * different contents.
 */
/**
 * Say how far through a large file's hash the browser is.
 *
 * A gigabyte takes seconds to read, and a console that sits on "Working…" for
 * fifteen of them is one somebody reloads — losing nothing, because no record
 * has been written yet, but losing the upload they were in the middle of. Only
 * for files large enough to notice; a site photograph is hashed before the
 * button finishes repainting.
 */
function readingProgress(say, file) {
  if (!say || file.size < 32 * 1_048_576) return undefined;
  const mb = Math.round(file.size / 1_048_576);
  let last = -1;
  return (read, total) => {
    const percent = Math.floor((read / Math.max(1, total)) * 100);
    if (percent === last) return;
    last = percent;
    say(`Reading ${mb}MB · ${percent}%`);
  };
}

async function collect(host, fields, files = [], say) {
  const body = {};
  const repeats = [];
  for (const field of fields) {
    // Read on the device into another field, never sent as a value of its own.
    if (field.type === 'textfile') continue;
    if (field.type === 'file') {
      const el = host.querySelector(`[name="${CSS.escape(field.name)}"]`);
      // A dictated recording is held on the element rather than in `files`,
      // which is read-only. Either way it is the same `File` from here on and
      // takes the same path: prepared, hashed, filed, uploaded, queued if it
      // cannot be.
      const chosen = el?.dictated ? [el.dictated] : [...(el?.files ?? [])];
      const file = chosen[0];
      if (!file) {
        if (field.required === false) continue;
        throw new ApiError({ title: 'EVIDENCE_REQUIRED', detail: `${field.label} is required` }, 400);
      }
      // Refused here, before any record is written.
      //
      // The record is filed first and the bytes follow it, so a file over the
      // ceiling used to produce a filed record naming a document the platform
      // would never accept, and a file queued on the device retrying for ever.
      // The ceiling is published on `/v1/commands` rather than assumed.
      const ceiling = await evidenceCeiling();
      const tooBig = chosen.filter((candidate) => ceiling > 0 && candidate.size > ceiling);
      if (tooBig.length > 0) {
        throw new ApiError(
          {
            title: 'FILE_TOO_LARGE',
            detail:
              `${tooBig.map((f) => f.name).join(', ')} ${tooBig.length === 1 ? 'is' : 'are'} over the ` +
              `${Math.round(ceiling / 1_048_576)}MB limit for a single file. Nothing has been filed. ` +
              'Split the file, or ask the operator to raise EVIDENCE_MAX_BYTES.',
          },
          413,
        );
      }
      // Resize before hashing, never after. The hash is the address the bytes
      // are stored at and the value written into an append-only event, so it
      // has to be taken over the bytes that are actually kept. A large
      // photograph comes back smaller; everything else comes back untouched.
      const prepared = await forEvidence(file);
      const hash = await hashFile(prepared, readingProgress(say, prepared));
      body[field.name] = hash;
      // The prepared name, not the captured one: a resized HEIC is stored as
      // JPEG bytes, and a record naming it `.HEIC` would hand somebody a file
      // their machine refuses to open.
      if (field.nameInto) body[field.nameInto] = prepared.name;
      // Held for after the command succeeds. The upload is refused until a
      // ledger record names the hash, and this command is what creates it.
      files.push({ hash, file: prepared });

      // Every file after the first becomes another run of the same command.
      if (field.multiple && chosen.length > 1) {
        for (const extra of chosen.slice(1)) {
          const preparedExtra = await forEvidence(extra);
          const extraHash = await hashFile(preparedExtra, readingProgress(say, preparedExtra));
          files.push({ hash: extraHash, file: preparedExtra });
          repeats.push({
            [field.name]: extraHash,
            ...(field.nameInto ? { [field.nameInto]: preparedExtra.name } : {}),
          });
        }
      }
      continue;
    }

    const el = host.querySelector(`[name="${CSS.escape(field.name)}"]`);
    if (!el) continue;

    if (field.type === 'multiselect') {
      const chosen = [...el.selectedOptions].map((option) => option.value);
      // An empty required multiselect is a refusal, not an empty array: the
      // endpoint would reject it anyway, and refusing here names the field.
      if (chosen.length === 0) {
        if (field.required === false) continue;
        throw new ApiError({ title: 'FIELD_REQUIRED', detail: `${field.label} needs at least one choice` }, 400);
      }
      body[field.name] = chosen;
      continue;
    }

    if (field.type === 'checkbox') {
      // The state of the box, as the boolean the schema asks for. Always sent:
      // "no" is an answer, not a field left blank.
      body[field.name] = el.checked;
      continue;
    }

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
  return { body, repeats };
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
/**
 * `method` exists because the platform has PUT routes and this door could only
 * POST.
 *
 * A configuration route is a replacement rather than an append — setting a
 * tenancy's branding is not creating a second one — and PUT is the honest verb
 * for that. Without this, every such route was reachable only through the
 * generated command catalogue or not at all, which is the doorless-capability
 * problem in a smaller shape.
 */
/**
 * A required choice with nothing to choose from.
 *
 * Eleven commands across three screens opened a form whose required dropdown
 * was empty: "Answer a comment" on a programme with no comments, "Agree a
 * variation" with no variation, "Record a referral" with no dispute. The form
 * could not be submitted and did not say why — the reader was left to work out
 * that the list was empty because the thing did not exist yet. The Construction
 * screen already refuses this pattern for its own commands: "locks with a
 * reason, rather than a modal whose required dropdown is empty." This is that
 * refusal made once, for every command, at the one place a form is built.
 */
function missingPrerequisites(fields) {
  return fields.filter(
    (f) => (f.type === 'select' || f.type === 'multiselect') && f.required !== false && (f.options ?? []).length === 0,
  );
}

function nothingToChoose({ title, intent, missing }) {
  return new Promise((resolveCommand) => {
    const host = document.createElement('div');
    host.className = 'modal-host';
    host.innerHTML = `<div class="modal" role="dialog" aria-labelledby="cmd-nothing-title">
      <header>
        <div>
          <h3 id="cmd-nothing-title">${esc(title)}</h3>
          ${intent ? `<div class="metric-sub">${esc(intent)}</div>` : ''}
        </div>
        <button type="button" data-close aria-label="Close">×</button>
      </header>
      <div class="body">
        <div class="notice warn">
          <b>Nothing to act on yet.</b>
          ${missing
            .map(
              (f) =>
                /*
                 * Why the chooser is empty, where the field knows.
                 *
                 * "This project holds none" is true when a project genuinely
                 * has no bids, and false — misleadingly so — when the chooser
                 * is *filtered*: drafting offers only bids with a confirmed
                 * question list, so somebody holding a bid whose list is still
                 * a proposal was told their project had no bids at all, and
                 * went looking for the wrong thing.
                 *
                 * A field that filters says what it filters on, and that
                 * sentence replaces the generic one rather than following it.
                 */
                `<div style="margin-top:6px">This needs ${esc(article(f.label))} <b>${esc(f.label.toLowerCase())}</b> to act against. ${
                  f.emptyHint ? esc(f.emptyHint) : `There is none here yet.${f.hint ? ` ${esc(f.hint)}` : ''}`
                }</div>`,
            )
            .join('')}
        </div>
      </div>
      <div class="foot">
        <button type="button" class="btn quiet" data-close>Close</button>
      </div>
    </div>`;
    const close = () => {
      host.remove();
      document.removeEventListener('keydown', onKey);
      resolveCommand(null);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close();
    };
    host.addEventListener('click', (event) => {
      if (event.target === host || event.target.closest('[data-close]')) close();
    });
    document.addEventListener('keydown', onKey);
    document.body.append(host);
    host.querySelector('[data-close]')?.focus();
  });
}

function article(word) {
  return /^[aeiou]/i.test(String(word ?? '')) ? 'an' : 'a';
}

export function command({
  title,
  intent,
  path,
  fields,
  submitLabel = 'Submit',
  transform,
  aiCost = false,
  method = 'POST',
  /**
   * A rule the form can check for itself, before anything is sent.
   *
   * For the one shape a schema cannot express and a person should not discover
   * from the server: **either of these two fields, but not neither.** The
   * questionnaire reader takes a filed document or pasted text, so both are
   * optional — which made the panel look as though neither was needed, and
   * pressing the button with both empty produced a refusal from the platform
   * about a form it had just offered as complete.
   *
   * Returns nothing when the form is good, or `{ field, message }` to place a
   * refusal on that field — the same box a server field error lands in, so a
   * person reads one kind of correction in one place. The platform still
   * enforces the rule; this only stops the round trip.
   */
  validate,
  /**
   * What to say about what came back, where "recorded" is not the whole truth.
   *
   * Every command used to report the same green line — *"Recorded in the
   * Golden Thread"* — and for almost all of them that is exactly right: the
   * command either did the thing or was refused. The AI commands are not like
   * that. `Draft an answer` answers with an **outcome**: it either wrote a
   * draft or found nothing it could cite and raised a gap instead. Both are a
   * 200, because both are the platform working correctly, and both produced
   * the same green "Recorded" — so somebody who asked for a draft, paid for a
   * retrieval and got a gap was told, in green, that their draft was recorded.
   *
   * Given the response, returns `{ title, message, tone }` to say what
   * actually happened. Used for a single run only: a command filing twelve
   * documents reports the twelve, not the last one.
   */
  report,
  /**
   * What the person is deciding about, above the fields.
   *
   * `intent` says what a command is for and is the same sentence every time.
   * This is the opposite: the particular thing in front of them, now. The
   * director pressing **Approve** was shown a note field and a score override
   * and **not the answer they were signing** — a two-person check in which the
   * second person cannot read what the first wrote is a signature on a
   * reference number.
   *
   * Pre-rendered markup from the caller, because the caller is the only thing
   * that knows what matters here: an answer and its citations for an approval,
   * the scorer's own reasons for a rejection.
   */
  brief,
}) {
  const missing = missingPrerequisites(fields);
  if (missing.length > 0) return nothingToChoose({ title, intent, missing });

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
        ${brief ? `<div class="cmd-brief">${brief}</div>` : ''}
        ${fields
          .map((f) =>
            // A hidden field is a value the door already knows — the hash a
            // row was clicked on, the record a panel is open against. It is
            // rendered as the input it is, with no label, so `collect` finds
            // it by name like every other field. It used to be filtered out
            // of the form entirely, which meant it was never sent: every door
            // that relied on one failed schema validation on a required field
            // the person could not see, or worked only because a `transform`
            // put the value back.
            f.type === 'hidden'
              ? control(f)
              : `<div class="field" data-field="${esc(f.name)}">
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
      const unplaced = [];
      for (const detail of fieldErrors) {
        const name = String(detail.path ?? detail.field ?? '').replace(/^\//, '');
        const box = host.querySelector(`[data-field="${CSS.escape(name)}"] .field-error`);
        if (!box) {
          // A failure inside a nested value — `administrators[1].name` — has
          // no box of its own. It used to vanish, and the person read a bare
          // "VALIDATION_FAILED — request body failed schema validation" with
          // nothing to correct. Kept, and said below.
          unplaced.push(`${name || 'request'} ${detail.message ?? 'is invalid'}`);
          continue;
        }
        box.textContent = detail.message ?? 'Invalid';
        box.hidden = false;
        handled += 1;
      }

      // A denial or a domain rule is about the command, not one field — and so
      // is a failure the form has no field for.
      if (handled === 0 || unplaced.length > 0) {
        errorBox.textContent = unplaced.length > 0 ? `${error.code ? `${error.code} — ` : ''}${unplaced.join('; ')}` : `${error.code ? `${error.code} — ` : ''}${error.message}`;
        errorBox.hidden = false;
      }
    }

    /*
     * A refusal about a field it no longer describes.
     *
     * `showProblem` clears every field error and sets the ones the server just
     * sent, which is right — but it only runs on the next submit. So a person
     * who left Subject empty, read "must be at least 3 characters" and then
     * typed a subject sat looking at a form that still said their subject was
     * too short. The denial was true when it was made and false by the time it
     * was read, which is the one thing an error message may not be.
     *
     * Cleared as soon as the field changes. Nothing is validated here — this
     * says "that was about what you had before", not "that is fixed", and the
     * server still decides on submit.
     */
    const clearFieldError = (event) => {
      const field = event.target.closest?.('[data-field]');
      const box = field?.querySelector('.field-error');
      if (box && !box.hidden) {
        box.hidden = true;
        box.textContent = '';
      }
    };
    host.addEventListener('input', clearFieldError);
    host.addEventListener('change', clearFieldError);

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
        const { body: collected, repeats } = await collect(host, fields, files, (progress) => {
          submit.textContent = progress;
        });
        submit.textContent = 'Working…';

        // The form's own rule, where it has one. Shown exactly as a server
        // field error is, and nothing is sent.
        const refusal = validate?.(collected);
        if (refusal) {
          throw new ApiError(
            { title: 'FIELD_REQUIRED', detail: refusal.message, errors: [{ field: refusal.field, message: refusal.message }] },
            400,
          );
        }

        /*
         * One command per document.
         *
         * A tender pack is many files and each one is its own record with its
         * own hash — so this runs the command once for the first file and once
         * more for each of the others, with that file's hash and name swapped
         * in. The alternative, one record carrying ten hashes, would have the
         * ledger assert that a single document arrived with ten different
         * contents.
         *
         * Each run is a separate command the platform has accepted, so a
         * failure part-way through is not a failure of the ones before it. The
         * ones that landed stay landed and the error names how far it got,
         * rather than reporting the whole batch as lost and leaving somebody to
         * re-file documents that are already on the record.
         */
        const runs = [collected, ...repeats.map((overlay) => ({ ...collected, ...overlay }))];
        let response;
        let filed = 0;
        try {
          for (const run of runs) {
            const payload = transform ? transform(run) : run;
            const target = typeof path === 'function' ? path(run) : path;
            response = method === 'PUT' ? await api.put(target, payload) : await api.post(target, payload);
            filed += 1;
          }
        } catch (error) {
          if (filed > 0) {
            toast(
              `${filed} of ${runs.length} filed`,
              `The rest stopped at: ${error.message ?? String(error)}. What is filed is on the record; re-file only the remainder.`,
              'warn',
            );
            void storeEvidence(files.slice(0, filed));
          }
          throw error;
        }

        // What came back, in the command's own words where it has any.
        const said = report && runs.length === 1 ? report(response) : null;
        toast(
          said?.title ?? title,
          said?.message ??
            (runs.length === 1 ? 'Recorded in the Golden Thread' : `${runs.length} documents recorded in the Golden Thread`),
          said?.tone ?? 'ok',
        );
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

    // A `textfile` field reads the chosen file as text, on the device, into the
    // field named by `into` — reshaped first by the field's own `parse` where it
    // has one. Nothing is uploaded; the target box then goes through the same
    // validate/transform/import path a paste does, and the person can read and
    // edit the loaded lines before submitting.
    for (const input of host.querySelectorAll('input[type="file"][data-textfile-into]')) {
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        const field = fields.find((f) => f.name === input.name);
        const target = input.dataset.textfileInto
          ? host.querySelector(`[name="${CSS.escape(input.dataset.textfileInto)}"]`)
          : null;
        const box = host.querySelector(`[data-field="${CSS.escape(input.name)}"] .field-error`);
        try {
          const raw = await file.text();
          const text = field?.parse ? field.parse(raw, file.name) : raw;
          if (target) {
            target.value = text;
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.focus();
          }
          if (box) {
            box.hidden = true;
            box.textContent = '';
          }
        } catch (error) {
          // A file that cannot be read is told, not swallowed.
          if (box) {
            box.textContent = `Could not read ${file.name}: ${error?.message ?? String(error)}`;
            box.hidden = false;
          }
        }
      });
    }

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
  /*
   * A cap passed is not a block, and showing it as one would be a lie.
   *
   * A ceiling the customer set does not cut an AI task in half: the run goes
   * ahead and is charged against the funded balance as normal. So the person is
   * told what it does to the budget — before they press it, beside the price,
   * which is the same rule as the cost disclosure it sits next to — and the
   * button stays live, because the platform will run it.
   *
   * An empty balance is a block, and is rendered as one above. Prepaid means
   * prepaid, and no ACUs means no AI.
   */
  const overrun = !blocked && typeof quote.overrunReason === 'string' && quote.overrunReason !== '';
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
    ${disclosureBlock(quote.disclosure)}
    ${blocked ? `<div class="notice warn">${esc(quoteBlockedText(quote))}</div>` : ''}
    ${overrun ? `<div class="notice warn">${esc(quoteOverrunText(quote))}</div>` : ''}
  </div>`;
}

/**
 * A cap about to be passed, worded for the person passing it.
 *
 * The server's sentence is written in minor units for a log. This says what it
 * does to the budget in the customer's own currency — and it never says the
 * work will stop, because it will not.
 */
function quoteOverrunText(quote) {
  if (quote.capBreach) {
    const { scope, capMinor, spentMinor, scopeId } = quote.capBreach;
    const where =
      scope === 'MONTHLY' ? 'this month’s AI budget' : scope === 'PROJECT' ? 'this project’s AI budget' : `the AI budget for ${scopeId}`;
    return `This takes ${where} past its ${exact(capMinor)} cap — ${exact(spentMinor)} is already spent. It will still run, because a cap does not cut an AI task in half, and it is charged against your balance as normal.`;
  }
  return quote.overrunReason;
}

/**
 * What running this would disclose, and to whom — §16.1.
 *
 * Beside the price rather than on a settings screen, because they are the same
 * decision. Somebody about to spend forty pence of a prepaid balance is also
 * about to send a commercial record to a third party, and the platform knew
 * both facts and showed only one.
 *
 * The sentence comes from the server. Wording it here would create a second
 * account of what a vendor does with customer data, and two accounts of that
 * eventually disagree — which is the one place a disagreement is a
 * data-protection problem rather than a copy problem.
 *
 * An undeclared retention route is marked, deliberately. It is the honest state
 * of a deployment where nobody has read the vendor's terms yet, and rendering
 * it quietly would make "we have not checked" look like "it is fine".
 */
function disclosureBlock(disclosure) {
  if (!disclosure) return '';

  const stays = !disclosure.leavesPlatform;
  const undeclared = disclosure.retention?.route === 'NOT_DECLARED';
  const tone = stays ? 'ok' : undeclared ? 'warn' : '';

  return `<div class="cost-disclosure">
    <div class="split-list">
      <div class="row">
        <span class="lbl">Where this runs</span>
        <span class="val">${esc(stays ? 'On this platform' : disclosure.provider)}</span>
      </div>
      <div class="row">
        <span class="lbl">What it carries</span>
        <span class="val">${esc(sensitivityText(disclosure.sensitivity))}</span>
      </div>
    </div>
    <div class="notice ${tone}" style="margin-top:8px">${esc(disclosure.statement)}</div>
  </div>`;
}

/** The sensitivity class in the words the rest of the console uses for it. */
function sensitivityText(level) {
  const said = {
    PUBLIC: 'Public information',
    INTERNAL: 'Ordinary project information',
    SAFETY_L2: 'Safety information',
    COMMERCIAL_L3: 'Commercial in confidence',
    LEGAL_L4: 'Legally privileged',
  };
  return said[level] ?? level ?? 'Unclassified';
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
 *
 * ## The three refusals, drawn as two things
 *
 * Every greyed control used to look identical: padlock, tooltip. That put a
 * permanent refusal — a project manager will never raise a lookahead
 * constraint, because the planner raises it and the PM approves it — beside a
 * temporary one that tells you what to do first, in the same grey, with the
 * same padlock. Counted across the demonstration identities, one person met
 * about ninety of the permanent kind and thirty of the useful kind, and a
 * reader's verdict on the result was "many randomly locked functions".
 *
 * They are not random. They are correct, and correctly enforced — and drawing
 * them all made the screen unreadable and the product look broken.
 *
 * So the two kinds are now drawn differently, which is the decision the sidebar
 * already reached and recorded for exactly the same reason (`navigation()` in
 * `app.js`): a padlock on something you can never hold is grey furniture, and a
 * count that links to the answer is worth more than a lock that shouts an enum.
 *
 * - **Role refusals** are not drawn as buttons. They are counted in one line
 *   that goes to the Permissions screen, which explains every capability area
 *   in full and names who does hold it.
 * - **Everything else** — the phase gate, and a state refusal like "Nothing is
 *   drafted and waiting" — keeps its padlocked button and its tooltip, because
 *   those tell the reader what has to happen first, which is worth reading.
 *
 * Nothing is hidden in the sense that matters: the refusal is still stated, in
 * one place, with somewhere to go. What is removed is the repetition.
 */
export function commandBar(entries) {
  const live = entries.filter((entry) => entry);
  const shown = live.filter((entry) => entry.permitted || !isRoleDenial(entry.reason));
  const roleLocked = live.filter((entry) => !entry.permitted && isRoleDenial(entry.reason));

  const buttons = shown
    .map((entry) =>
      entry.permitted
        ? `<button class="btn ${esc(entry.tone ?? 'quiet')}" data-command="${esc(entry.id)}">${esc(entry.label)}</button>`
        : `<button class="btn quiet locked" disabled title="${esc(entry.reason ?? 'Not permitted for your role')}">${esc(entry.label)} 🔒</button>`,
    )
    .join('');

  if (roleLocked.length === 0) return buttons;

  // The whole bar, or part of it. Both say the same thing; the first says it
  // about a screen the reader can do nothing on, so it says it more fully.
  const everything = shown.length === 0;
  const count = roleLocked.length;
  const line = everything
    ? `Nothing on this bar is yours to run — ${esc(roleLocked[0].reason ?? 'it belongs to another role')}. ` +
      'Roles are changed on Team &amp; Access by an administrator or the owner; the person who founded the company holds both.'
    : `${count} further action${count === 1 ? '' : 's'} here belong${count === 1 ? 's' : ''} to another role.`;

  return (
    `${buttons}<button class="btn quiet sm cmd-bar-locked" data-nav="permissions" ` +
    `style="flex-basis:100%;text-align:left;white-space:normal" ` +
    `title="${esc(roleLocked.map((entry) => `${entry.label} — ${entry.reason ?? ''}`).join('\n'))}">` +
    `${line} See what your role can do →</button>`
  );
}
