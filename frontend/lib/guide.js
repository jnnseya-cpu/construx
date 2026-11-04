import { api } from './api.js';
import { badge, html, raw } from './ui.js';

/**
 * The guided walkthrough, on every screen.
 *
 * The per-screen "Where this job is" panel answered "what now?" well, but only
 * on the four screens a job's road runs through, and only once a job existed.
 * The person who most needs guidance — a brand-new subscriber with no company
 * facts and no job — saw nothing, because there was no project for the flow to
 * read, and the panel sat two-thirds of the way down pages they had no reason
 * to be on yet.
 *
 * This is a slim strip the shell mounts above every view. It reads one
 * tenant-level endpoint that starts from an empty account — record the company,
 * open a job — and then folds in that job's own flow unchanged. The strip holds
 * no rule of its own: the next step, which screen it is on and the button to
 * press are all computed server-side, for the same reason the permission matrix
 * is. It only draws them, and takes the person to the right screen.
 */

const SCREEN = {
  pipeline: 'Pipeline & Bids',
  procurement: 'Tender & Procurement',
  documents: 'Site Documents',
  enterprise: 'Enterprise & Portfolio',
};

const TONE = { DONE: 'ok', READY: 'warn', BLOCKED: 'neutral', NOT_NEEDED: 'neutral' };
const SAYS = { DONE: 'done', READY: 'do this', BLOCKED: 'waiting', NOT_NEEDED: 'not needed' };

/** Read the journey for this workspace, keyed to the open job where there is one. */
export async function loadJourney(projectId) {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return api.get(`/v1/journey${query}`).catch(() => null);
}

/**
 * The strip. `here` is the current screen id, so the button reads "on this
 * screen" where the step is already in front of the person and takes them
 * elsewhere where it is not.
 */
export function guideStrip(journey, { here } = {}) {
  if (!journey || !Array.isArray(journey.stages) || journey.stages.length === 0) return '';

  const now = journey.nowDo;
  const onHere = now && now.screen === here;
  const steps = journey.stages.filter((step) => step.state !== 'NOT_NEEDED');
  const done = steps.filter((step) => step.state === 'DONE').length;

  return html`<div class="guide-strip">
    <div class="guide-main">
      <span class="guide-tag">${raw(now ? badge('next step', 'warn') : badge('on track', 'ok'))}</span>
      <div class="guide-say">
        ${
          now
            ? html`<b>${now.title}.</b>
                <span class="guide-sub"
                  >${now.next ?? now.detail}${
                    now.door
                      ? html` Press <b>“${now.door}”</b>${onHere ? ' on this screen' : html` on <b>${SCREEN[now.screen] ?? 'the next screen'}</b>`}.`
                      : ''
                  }</span
                >`
            : html`<b>Nothing is outstanding.</b> <span class="guide-sub">${journey.summary}</span>`
        }
      </div>
      ${
        now && SCREEN[now.screen] && !onHere
          ? html`<button class="btn guide-go" data-nav="${now.screen}">Go to ${SCREEN[now.screen]} →</button>`
          : ''
      }
    </div>
    <details class="guide-all">
      <summary>Show the whole journey · ${done} of ${steps.length} done</summary>
      <div class="guide-list">
        ${journey.stages.map(
          (step) => html`<div class="guide-row">
            <span class="guide-row-lbl">
              ${raw(badge(SAYS[step.state] ?? step.state, TONE[step.state] ?? ''))}
              <b style="${raw(step.state === 'NOT_NEEDED' ? 'opacity:.6' : '')}">${step.title}</b>
              <span class="guide-sub" style="display:block">${step.detail}</span>
            </span>
            <span class="guide-row-at">
              ${step.door && step.state !== 'DONE' && step.state !== 'NOT_NEEDED' ? html`“${step.door}” · ` : ''}${SCREEN[step.screen] ?? ''}
            </span>
          </div>`,
        )}
      </div>
    </details>
  </div>`;
}
