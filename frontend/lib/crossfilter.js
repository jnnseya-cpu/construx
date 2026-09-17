import { html } from './ui.js';

/**
 * Cross-filtering: selecting a mark narrows every visual on the page.
 *
 * ## Why this is not a DOM trick
 *
 * The obvious implementation is to hide rows and dim slices when something is
 * selected. It is quick, it looks right, and it is a lie: the totals in the
 * KPI cards do not move, the chart captions still describe the unfiltered set,
 * and the CSV exports everything. A filter that looks applied and is not is
 * worse than no filter at all, because the reader trusts it.
 *
 * So the filter lives *above* the render. It is held in the address bar, the
 * page re-renders through the console's own `draw()`, and the page narrows its
 * payload before it builds anything. Every figure on the screen — tiles,
 * charts, tables, the data panels and therefore the exports — is computed from
 * the narrowed set, because they are all computed from the same array they
 * always were.
 *
 * ## Why the address bar
 *
 * Three requirements in section 3.2 turn out to be one mechanism: "deep link
 * preserving all filters", "global filters", and cross-filtering itself. If the
 * filter is a query parameter then a link carries it, the back button undoes
 * it, a reload keeps it, and the chart tools' Link button needs no special
 * case — it already copies `location.search`.
 *
 * Holding it in a module variable instead would have given the same behaviour
 * on screen and none of the other three.
 *
 * ## What a page has to do to take part
 *
 * Read `activeFilter()` and narrow its own data. That is the whole contract. A
 * page that does not read it is simply not cross-filtered, rather than being
 * half-filtered — which is the state this design exists to avoid.
 */

/** The query parameter the filter lives in. One, so it round-trips as a unit. */
const PARAM = 'filter';

/**
 * The filter in force, or null.
 *
 * Shape: `{ dimension, key, label }`. `dimension` is what is being filtered on
 * — a severity, a phase, a discipline — and `key` is the value. `label` is what
 * to call it in the chip, because a reader should not be shown `WORK_PACKAGE_3`.
 */
export function activeFilter() {
  const raw = new URLSearchParams(location.search).get(PARAM);
  if (!raw) return null;
  const [dimension, key, ...rest] = raw.split('~');
  if (!dimension || !key) return null;
  return { dimension, key, label: rest.join('~') || key };
}

/** True where this mark is the one currently selected. */
export function isSelected(dimension, key) {
  const filter = activeFilter();
  return Boolean(filter && filter.dimension === dimension && String(filter.key) === String(key));
}

/**
 * Apply a filter, or lift it where the same mark is clicked again.
 *
 * Toggling rather than only setting, because the way a person clears a
 * cross-filter is by clicking the thing they clicked to apply it. Making them
 * find a separate control for that is how a dashboard ends up permanently
 * filtered by something somebody selected by accident.
 *
 * `replaceState` rather than `pushState` when lifting: a back button that walks
 * back through eleven filter states somebody clicked through is not history
 * anybody wants.
 */
export function toggleFilter(dimension, key, label) {
  const url = new URL(location.href);
  if (isSelected(dimension, key)) url.searchParams.delete(PARAM);
  else url.searchParams.set(PARAM, [dimension, key, label ?? key].join('~'));
  history.pushState({}, '', url);
}

/** Lift whatever is in force. */
export function clearFilter() {
  const url = new URL(location.href);
  url.searchParams.delete(PARAM);
  history.pushState({}, '', url);
}

/**
 * Narrow a list to the filter, where the filter is on this dimension.
 *
 * A page passes the dimension it holds and how to read that dimension off a
 * row. Where the filter is on something else — or there is no filter — the list
 * comes back whole, so a page can call this unconditionally.
 */
export function narrow(rows, dimension, readKey) {
  const filter = activeFilter();
  if (!filter || filter.dimension !== dimension) return rows;
  return rows.filter((row) => String(readKey(row)) === String(filter.key));
}

/**
 * The chip that says what is in force, and lifts it.
 *
 * Section 3.1 puts active filters in the context header, and it is right to: a
 * filtered screen that does not say it is filtered is how somebody reports a
 * number that was true of a tenth of the project. The chip is deliberately
 * loud — it is the only thing on the page that explains why every figure moved.
 */
export function filterChip() {
  const filter = activeFilter();
  if (!filter) return '';
  return html`<div class="filter-chip" role="status">
    <span class="filter-chip-what">Filtered</span>
    <span class="filter-chip-value">${filter.label}</span>
    <button type="button" class="filter-chip-clear" data-clear-filter aria-label="Remove the ${filter.label} filter">
      Clear
    </button>
  </div>`;
}

/**
 * The attributes that make a mark clickable.
 *
 * Returned as a string for the chart kit to splat onto a shape, rather than as
 * a handler, because the chart kit renders to markup and holds no listeners of
 * its own — `charttools.js` has the one delegated listener for the whole
 * console.
 */
export function filterable(dimension, key, label) {
  if (!dimension || key === undefined || key === null || key === '') return '';
  const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return (
    ` data-filter-dimension="${escape(dimension)}" data-filter-key="${escape(key)}"` +
    ` data-filter-label="${escape(label ?? key)}"` +
    (isSelected(dimension, key) ? ' data-filter-selected="true"' : '')
  );
}
