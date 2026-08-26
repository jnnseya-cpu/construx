/**
 * Rendering helpers.
 *
 * Deliberately small: tagged-template HTML with escaping by default, so a
 * supplier name containing a `<` cannot become markup. Interpolating a value
 * without escaping requires calling `raw()`, which makes every such decision
 * visible in review.
 */

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const RAW = Symbol('raw');

/**
 * Mark a string as pre-escaped HTML.
 *
 * Already-raw values pass through. Without that, `raw(badge(...))` — an easy
 * thing to write, because most interpolations do need wrapping — took the
 * object `badge` returns, ran `String()` over it, and put the literal text
 * `[object Object]` on the screen. It failed silently and it failed in the
 * output rather than at the call, which is the worst combination; a browser
 * found one on the clarification register that no test had.
 */
export function raw(value) {
  if (value !== null && typeof value === 'object' && RAW in value) return value;
  return { [RAW]: String(value ?? '') };
}

function resolve(value) {
  if (value === null || value === undefined || value === false) return '';
  if (typeof value === 'object' && RAW in value) return value[RAW];
  if (Array.isArray(value)) return value.map(resolve).join('');
  return esc(value);
}

/** html`` — escapes interpolations unless wrapped in raw(). */
export function html(strings, ...values) {
  return raw(strings.reduce((out, part, i) => out + part + (i < values.length ? resolve(values[i]) : ''), ''));
}

export function render(target, content) {
  target.innerHTML = resolve(content);
}

/**
 * The same resolution `render` performs, for a caller building a detached node.
 *
 * Exported so a component that constructs its own element — a modal host, a
 * drill panel — resolves markup through one function rather than reimplementing
 * the escaping. A second implementation of escaping is a second chance to get
 * escaping wrong.
 */
export function resolveHtml(content) {
  return resolve(content);
}

// --- formatting -------------------------------------------------------------

/** Money in minor units → a readable figure. Zero at portfolio scale reads $0.0M. */
/**
 * Minor units in one major unit, per ISO 4217.
 *
 * This used to be a hardcoded 100 and a three-symbol lookup that fell back to a
 * dollar sign. A yen has no minor unit and a dinar has three, so dividing by a
 * hundred was wrong by an order of magnitude on the first Japanese contract —
 * and it would have appeared in front of a client before anybody noticed. The
 * server holds the same table; this is the display half of it.
 */
const MINOR_EXPONENT = { JPY: 0, KRW: 0, KWD: 3, BHD: 3, OMR: 3, TND: 3 };

function minorPerMajor(currency) {
  return 10 ** (MINOR_EXPONENT[currency] ?? 2);
}

/**
 * The reader's locale, taken from the browser rather than assumed.
 *
 * `Intl` already knows a French reader expects a space before the symbol and a
 * comma for the decimal. Hardcoding a symbol table threw that away and got the
 * answer wrong for every currency outside three.
 */
const LOCALE = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-GB';

function symbolFor(currency) {
  // Just the symbol, so the abbreviated forms below can keep their K/M/B suffix.
  const parts = new Intl.NumberFormat(LOCALE, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
    .formatToParts(0)
    .filter((p) => p.type === 'currency');
  return parts[0]?.value ?? `${currency} `;
}

export function money(minor, currency = 'GBP') {
  const symbol = symbolFor(currency);
  const value = Number(minor ?? 0);
  if (value === 0) return `${symbol}0`;
  const major = value / minorPerMajor(currency);
  const abs = Math.abs(major);
  const digits = MINOR_EXPONENT[currency] ?? 2;
  if (abs < 1_000) return `${symbol}${major.toFixed(digits)}`;
  if (abs < 1_000_000) return `${symbol}${(major / 1_000).toFixed(1)}K`;
  if (abs < 1_000_000_000) return `${symbol}${(major / 1_000_000).toFixed(2)}M`;
  return `${symbol}${(major / 1_000_000_000).toFixed(2)}B`;
}

export function exact(minor, currency = 'GBP') {
  const digits = MINOR_EXPONENT[currency] ?? 2;
  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(minor ?? 0) / minorPerMajor(currency));
}

export function pct(value, digits = 1) {
  return `${Number(value ?? 0).toFixed(digits)}%`;
}

export function days(value) {
  return `${Number(value ?? 0).toFixed(value % 1 === 0 ? 0 : 1)}d`;
}

export function date(iso) {
  if (!iso) return '—';
  return String(iso).slice(0, 10);
}

export function time(iso) {
  if (!iso) return '—';
  return String(iso).slice(11, 19);
}

export function initials(name) {
  return String(name ?? '?')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function shortHash(hash) {
  const value = String(hash ?? '');
  return value.startsWith('sha256:') ? `${value.slice(7, 19)}…` : value.slice(0, 12);
}

/** Tokens whose readable form is not derivable — mostly acronyms in the middle. */
const DISPLAY_NAMES = {
  BoQItem: 'BoQ item',
  OMManual: 'O&M manual',
  ACUWallet: 'ACU wallet',
  AIExecution: 'AI execution',
  AIRequest: 'AI request',
  BIM_TWIN: 'BIM and twin',
  RISK_SAFETY: 'Risk and safety',
  CONTRACTS_CLAIMS: 'Contracts and claims',
  RESOURCE_COST: 'Resource and cost',
  BOQ_TAKEOFF: 'BoQ and take-off',
  SAFETY_RAMS: 'Safety and RAMS',
  BILLING_ACU: 'Billing and ACU',
  AI_EXECUTION: 'AI execution',
  HANDOVER_OM: 'Handover and O&M',
  // Event-catalogue groups. `AI_BILLING` rendered as "Ai billing" on the
  // enterprise change panel — the same class of defect as `RMI` becoming "Rmi",
  // and the reason `sectorLabel` exists rather than calling `humanise`.
  AI_BILLING: 'AI and billing',
  PROJECT_CONTROL: 'Project control',
  BUSINESS_DEVELOPMENT: 'Business development',
};

/** Left alone, because sentence-casing them makes them harder to read. */
const ACRONYMS = new Set([
  'CVR', 'RFQ', 'RFI', 'NCR', 'RAMS', 'BIM', 'ACU', 'AI', 'BOQ', 'EVM', 'CPI', 'SPI',
  'PM', 'QS', 'FM', 'HSE', 'EPC', 'QAQC', 'API', 'MEP', 'WBS', 'CPM',
]);

/**
 * Turn a platform token into a readable phrase. Handles both vocabularies the
 * system uses: SCREAMING_SNAKE for capability areas, engines and event types,
 * CamelCase for entity types — "SupplierSubmission" has to read as "Supplier
 * submission", not "Suppliersubmission".
 */
export function humanise(token) {
  const raw = String(token ?? '');
  if (DISPLAY_NAMES[raw]) return DISPLAY_NAMES[raw];
  if (ACRONYMS.has(raw)) return raw;

  const spaced = raw.includes('_') ? raw.replace(/_/g, ' ') : raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

// --- components -------------------------------------------------------------

/**
 * The attributes that make an element drillable.
 *
 * Markup, so it lives with the design system rather than with the behaviour
 * that reads it — and keeping it here means `metric()` does not have to import
 * from the module that imports `metric()`.
 */
export function drillAttrs(label, sources) {
  const usable = (sources ?? []).filter((source) => source && source.refType && source.refId);
  if (usable.length === 0) return '';
  const payload = usable.map((source) => ({ refType: source.refType, refId: source.refId }));
  return (
    ` data-drill="${esc(JSON.stringify(payload))}"` +
    ` data-drill-label="${esc(label)}" tabindex="0" role="button"` +
    ` title="${esc(`${usable.length} source record${usable.length === 1 ? '' : 's'} — open the events behind this figure`)}"`
  );
}

/**
 * The full class and attributes for a drillable card, as one token.
 *
 * `metric()` is the tile for a plain label/value/sub. Plenty of real tiles are
 * not that — a count with a denominator in a smaller span, a value with a badge
 * beside it — and rewriting them into a shape they do not fit would be churn
 * for its own sake against working markup. This gives those the same
 * affordance without touching what is inside them:
 *
 *     <div ${raw(drillable('Open clashes', clashSources))}>
 *
 * Falls back to a plain card when there are no sources, so a tile that cannot
 * be opened does not pretend it can.
 */
export function drillable(label, sources) {
  const attrs = drillAttrs(label, sources);
  return attrs ? `class="card drillable"${attrs}` : 'class="card"';
}

/**
 * A KPI tile.
 *
 * `sources` is the list of records the figure was computed from, as
 * `[{refType, refId}]`. Supplying it makes the tile drillable: the Build
 * Standard requires every KPI to open to the events behind it, and a figure
 * nobody can check is an assertion rather than a report.
 *
 * Passing the same array the tile added up — rather than a description of the
 * query — is what keeps the drill honest. A query is a second statement of the
 * calculation, and the day somebody changes the sum without changing the query
 * the drill starts lying.
 *
 * A tile with no sources renders exactly as it always did. Some figures are a
 * count of nothing or a configured constant, and giving one an affordance that
 * opens an empty panel is worse than leaving it plain.
 */
export function metric({ label, value, sub, tone = '', sources }) {
  const attrs = drillAttrs(label, sources);
  return html`<div class="card${raw(attrs ? ' drillable' : '')}"${raw(attrs)}>
    <h3>${label}</h3>
    <div class="metric ${raw(tone)}">${value}</div>
    ${sub ? html`<div class="metric-sub">${sub}</div>` : ''}
    ${attrs ? html`<div class="drill-hint">${sources.length} source record${raw(sources.length === 1 ? '' : 's')} →</div>` : ''}
  </div>`;
}

export function table({ headers, rows, empty = 'Nothing recorded yet', align = [] }) {
  if (!rows || rows.length === 0) {
    return html`<div class="empty"><b>${empty}</b>This becomes populated as the project progresses.</div>`;
  }
  return html`<div class="table-scroll"><table>
    <thead><tr>${headers.map((h, i) => html`<th class="${raw(align[i] === 'num' ? 'num' : '')}">${h}</th>`)}</tr></thead>
    <tbody>${rows.map(
      (row) => html`<tr>${row.map((cell, i) => html`<td class="${raw(align[i] === 'num' ? 'num' : align[i] === 'mono' ? 'mono' : '')}">${cell}</td>`)}</tr>`,
    )}</tbody>
  </table></div>`;
}

export function badge(text, tone = 'neutral') {
  return html`<span class="badge ${raw(tone)}">${text}</span>`;
}

/** Map a status string to a badge tone, using the platform's own vocabulary. */
export function statusTone(status) {
  const value = String(status ?? '').toUpperCase();
  if (['APPROVED', 'ACCEPTED', 'EXECUTED', 'COMPLETE', 'COMPLETED', 'PASSED', 'CLOSED', 'VERIFIED', 'AGREED', 'IN_SERVICE', 'LIVE', 'CURRENT', 'FROZEN', 'LOCKED', 'AWARDED'].includes(value)) return 'ok';
  if (['OPEN', 'DRAFT', 'SUBMITTED', 'ASSESSED', 'IN_PROGRESS', 'RUNNING', 'ISSUED', 'INSTRUCTED', 'DISPATCHED', 'RECEIVED', 'PROPOSED', 'CLAIMED'].includes(value)) return 'info';
  if (['INCOMPLETE', 'PENDING', 'NOT_STARTED', 'SUPERSEDED', 'MEDIUM', 'WARNING'].includes(value)) return 'warn';
  if (['FAILED', 'REJECTED', 'CRITICAL', 'HIGH', 'BLOCKED', 'OVERDUE', 'EXPIRED'].includes(value)) return 'bad';
  return 'neutral';
}

export function track(percent, tone = '') {
  const width = Math.max(0, Math.min(100, Number(percent ?? 0)));
  return html`<div class="track"><i class="${raw(tone)}" style="width:${raw(width)}%"></i></div>`;
}

export function notice(text, tone = 'info') {
  return html`<div class="notice ${raw(tone)}">${text}</div>`;
}

let toastHost;

export function toast(title, detail, tone = '') {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    document.body.append(toastHost);
  }
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.innerHTML = resolve(html`<b>${title}</b>${detail ? html`<span>${detail}</span>` : ''}`);
  toastHost.append(el);
  setTimeout(() => el.remove(), 5200);
}

/**
 * One entry in a `<select>` — either an option, or a group of them.
 *
 * A grouped entry carries its own `options` array and renders as `<optgroup>`.
 * This exists because a construction reader scanning the sector list looks for
 * "Building" and the nine ONS categories do not contain that word; the heading
 * puts it where they look without adding a tenth value that overlaps three of
 * the others. See `SECTOR_GROUP` in the shared vocabulary.
 */
function option(o) {
  return o.options
    ? html`<optgroup label="${o.label}">${o.options.map((child) => option(child))}</optgroup>`
    : html`<option value="${o.value}">${o.label}</option>`;
}

/** A modal that resolves with the collected values, or null if dismissed. */
export function modal({ title, fields, submitLabel = 'Confirm' }) {
  return new Promise((resolveModal) => {
    const host = document.createElement('div');
    host.className = 'modal-host';
    host.innerHTML = resolve(html`<div class="modal">
      <header><h3>${title}</h3><button data-close aria-label="Close">×</button></header>
      <div class="body">
        ${fields.map(
          (f) => html`<div class="field">
            <label for="${f.name}">${f.label}</label>
            ${f.type === 'select'
              ? html`<select id="${f.name}" name="${f.name}">${f.options.map((o) => option(o))}</select>`
              : f.type === 'textarea'
                ? html`<textarea id="${f.name}" name="${f.name}" rows="3">${f.value ?? ''}</textarea>`
                : html`<input id="${f.name}" name="${f.name}" type="${f.type ?? 'text'}" value="${f.value ?? ''}">`}
            ${f.hint ? html`<div class="metric-sub">${f.hint}</div>` : ''}
          </div>`,
        )}
      </div>
      <div class="foot">
        <button class="btn quiet" data-close>Cancel</button>
        <button class="btn" data-submit>${submitLabel}</button>
      </div>
    </div>`);

    const close = (value) => {
      host.remove();
      resolveModal(value);
    };
    host.addEventListener('click', (event) => {
      if (event.target === host || event.target.closest('[data-close]')) close(null);
      if (event.target.closest('[data-submit]')) {
        const values = {};
        for (const field of fields) {
          values[field.name] = host.querySelector(`[name="${field.name}"]`).value;
        }
        close(values);
      }
    });
    document.body.append(host);
    host.querySelector('input, select, textarea')?.focus();
  });
}
