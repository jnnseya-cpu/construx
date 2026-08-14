import { api, ApiError } from './api.js';
import { esc, toast } from './ui.js';

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

const FIELD_TYPES = new Set(['text', 'number', 'date', 'select', 'textarea', 'hidden']);

/**
 * Hash a file the way the ledger does: SHA-256 over the bytes, prefixed.
 *
 * This is the real anchor, computed from the real file, in the browser. What is
 * not built is the object store the file itself would go to — so the platform
 * records that a document with this hash was the evidence, and a later holder
 * of the file can prove it is the same one. That is the half of the evidence
 * chain this build can honestly complete.
 */
export async function hashFile(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

function control(field) {
  const id = `cmd-${field.name}`;
  const required = field.required === false ? '' : 'required';

  if (field.type === 'select') {
    const options = field.options ?? [];
    return `<select id="${id}" name="${esc(field.name)}" ${required}>
      ${field.placeholder ? `<option value="">${esc(field.placeholder)}</option>` : ''}
      ${options
        .map(
          (o) =>
            `<option value="${esc(o.value)}"${String(o.value) === String(field.value ?? '') ? ' selected' : ''}>${esc(o.label)}</option>`,
        )
        .join('')}
    </select>`;
  }

  if (field.type === 'textarea') {
    return `<textarea id="${id}" name="${esc(field.name)}" rows="${field.rows ?? 3}" ${required}
      placeholder="${esc(field.placeholder ?? '')}">${esc(field.value ?? '')}</textarea>`;
  }

  if (field.type === 'file') {
    return `<input id="${id}" name="${esc(field.name)}" type="file" ${required}>
      <div class="file-hash" hidden></div>`;
  }

  const type = FIELD_TYPES.has(field.type) ? field.type : 'text';
  const step = field.type === 'number' ? ` step="${esc(field.step ?? 'any')}"` : '';
  const min = field.min !== undefined ? ` min="${esc(field.min)}"` : '';
  return `<input id="${id}" name="${esc(field.name)}" type="${type}" value="${esc(field.value ?? '')}"
    placeholder="${esc(field.placeholder ?? '')}"${step}${min} ${required}>`;
}

async function collect(host, fields) {
  const body = {};
  for (const field of fields) {
    if (field.type === 'file') {
      const el = host.querySelector(`[name="${CSS.escape(field.name)}"]`);
      const file = el?.files?.[0];
      if (!file) {
        if (field.required === false) continue;
        throw new ApiError({ title: 'EVIDENCE_REQUIRED', detail: `${field.label} is required` }, 400);
      }
      body[field.name] = await hashFile(file);
      if (field.nameInto) body[field.nameInto] = file.name;
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
 * `path` is the endpoint; `transform` lets a caller reshape the collected
 * fields into the body the endpoint expects, for commands whose shape is not
 * flat.
 */
export function command({ title, intent, path, fields, submitLabel = 'Submit', transform }) {
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

    host.addEventListener('click', (event) => {
      if (event.target === host || event.target.closest('[data-close]')) close(null);
    });

    host.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      errorBox.hidden = true;
      submit.disabled = true;
      submit.textContent = 'Working…';

      try {
        const collected = await collect(host, fields);
        const payload = transform ? transform(collected) : collected;
        const response = await api.post(path, payload);
        toast(title, 'Recorded in the Golden Thread', 'ok');
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
