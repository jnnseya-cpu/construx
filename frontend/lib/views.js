import { html } from './ui.js';

/**
 * Compare mode and saved views — the two pieces of view state that are not a
 * filter.
 *
 * Both live where the filter lives, in the address bar, for the same reasons:
 * a deep link carries them, the back button undoes them, and the chart tools'
 * Link button needed no special case. A saved view is therefore a stored URL
 * rather than a stored object, which means it cannot fall out of step with what
 * the console can actually render.
 *
 * ---
 *
 * ## Compare mode is a toggle, not a second dataset
 *
 * The standard asks for "compare mode for baseline/current/forecast and
 * current/previous period". Three of this platform's charts already hold both
 * sides of such a comparison — the Gantt carries the baseline dates beside the
 * current ones, the S-curve carries the early dates beside the late, the cash
 * curve carries measurement beside forecast — because the engines publish both.
 *
 * What was missing is the control. A comparison that is always drawn is not a
 * compare mode; it is a busier chart. So `comparing()` is a switch a page reads,
 * and a chart that has a second side shows it when the switch is on.
 *
 * **It is deliberately not "current versus previous period".** That needs the
 * previous period's figures, and most of these engines publish a position as it
 * stands rather than a series of past positions. Offering the control and
 * quietly comparing against something else would be worse than not offering it,
 * so a page with no second side simply does not show the toggle.
 *
 * ## Saved views are per person, per browser
 *
 * `localStorage`, which is this device and this browser. The standard asks for
 * "saved views by role and user"; per-user is met and per-role is not, and a
 * view saved on a laptop is not on the phone. Stated rather than implied —
 * storing them server-side is a real feature with a real permission question
 * attached, and pretending a device store is that would be worse than saying
 * where they actually live.
 */

const COMPARE = 'compare';
const STORE = 'construx.views';

/** Whether comparison is switched on. */
export function comparing() {
  return new URLSearchParams(location.search).get(COMPARE) === '1';
}

/** Turn it on or off, keeping everything else in the address bar. */
export function toggleCompare() {
  const url = new URL(location.href);
  if (comparing()) url.searchParams.delete(COMPARE);
  else url.searchParams.set(COMPARE, '1');
  history.pushState({}, '', url);
}

/**
 * The switch.
 *
 * `label` names what the two sides are on this screen, because "compare" on its
 * own is a question rather than a control — a reader has to know it is baseline
 * against current before they know whether they want it.
 */
export function compareToggle(label) {
  const on = comparing();
  return html`<button
    type="button"
    class="view-toggle ${on ? 'is-on' : ''}"
    data-toggle-compare
    aria-pressed="${on ? 'true' : 'false'}"
  >
    <span aria-hidden="true">${on ? '◉' : '○'}</span> ${label}
  </button>`;
}

/** Every saved view, newest first. Never throws — storage can be refused. */
export function savedViews() {
  try {
    const raw = localStorage.getItem(STORE);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    // A private window, cleared site data, or storage refused outright. A
    // feature that throws here would take the whole screen down with it.
    return [];
  }
}

/**
 * Save where the reader is now, under a name.
 *
 * The whole address after the origin, so the page, the filter and the compare
 * switch all come back together. Replacing a view of the same name rather than
 * accumulating duplicates: somebody saving "My patch" twice means they want the
 * second one.
 */
export function saveView(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return savedViews();
  const view = { name: trimmed, at: new Date().toISOString(), href: `${location.pathname}${location.search}` };
  const next = [view, ...savedViews().filter((entry) => entry.name !== trimmed)].slice(0, 24);
  try {
    localStorage.setItem(STORE, JSON.stringify(next));
  } catch {
    // Quota, or storage refused. The view is not saved and the caller is told
    // by the list coming back without it, rather than by an exception.
  }
  return savedViews();
}

/** Forget one. */
export function forgetView(name) {
  try {
    localStorage.setItem(STORE, JSON.stringify(savedViews().filter((entry) => entry.name !== name)));
  } catch {
    /* as above */
  }
  return savedViews();
}

/**
 * The saved-view bar.
 *
 * Only the views saved for the page being looked at. A list of every view
 * across the console would be a navigation menu wearing a filter's clothes, and
 * the reader would have to read each one to find out which screen it opens.
 */
export function savedViewBar() {
  const here = location.pathname;
  const mine = savedViews().filter((view) => String(view.href).split('?')[0] === here);
  return html`<div class="saved-views">
    <button type="button" class="view-toggle" data-save-view>Save this view</button>
    ${mine.map(
      (view) => html`<span class="saved-view${`${here}${location.search}` === view.href ? ' is-current' : ''}">
        <button type="button" class="saved-view-open" data-open-view="${view.href}">${view.name}</button>
        <button type="button" class="saved-view-forget" data-forget-view="${view.name}" aria-label="Forget the view ${view.name}">
          &times;
        </button>
      </span>`,
    )}
  </div>`;
}
