import { api } from './api.js';
import { badge, html, raw } from './ui.js';

/**
 * Where this job is, and the one thing to do next.
 *
 * Said plainly after walking one enquiry through four screens: *"the flow is
 * not working everywhere in this OS"*. Every screen was right on its own. What
 * was missing is the thing that makes a set of screens an operating system —
 * anywhere in it, an answer to "what happens now".
 *
 * The symptom was a chain of dead ends, each individually correct: read the
 * invitation, no tender requirements, because the enquiry is a letter; confirm
 * it, no compliance matrix, because the company's facts are not recorded; plan
 * a response pack, nothing to act on, because there is no matrix. Three
 * truthful refusals, and nothing anywhere saying that this job does not need a
 * matrix at all — it needs a price.
 *
 * One panel, on every screen the road runs through, reading one endpoint. The
 * states are computed server-side from the record; this draws them and holds no
 * rule of its own, for the same reason the console holds no copy of the
 * permission matrix.
 */

const TONE = { DONE: 'ok', READY: 'warn', BLOCKED: 'bad', NOT_NEEDED: 'neutral' };
const SAYS = { DONE: 'done', READY: 'do this', BLOCKED: 'waiting', NOT_NEEDED: 'not needed' };
const SCREEN = {
  pipeline: 'Pipeline & Bids',
  procurement: 'Tender & Procurement',
  documents: 'Site Documents',
  enterprise: 'Enterprise & Portfolio',
};

/** Read the flow for a project, or null where there is no project open. */
export async function loadFlow(projectId) {
  if (!projectId) return null;
  return api.get(`/v1/projects/${projectId}/flow`).catch(() => null);
}

export function flowPanel(flow, { here } = {}) {
  if (!flow || !Array.isArray(flow.steps)) return '';

  const road = flow.road === 'BID' ? 'Bid it' : 'Price it';
  const now = flow.nowDo;

  return html`<div class="card pad0" style="margin-bottom:14px">
    <div style="padding:15px 17px">
      <h2>Where this job is ${badge(road, flow.road === 'BID' ? 'info' : 'ok')}</h2>
      <p class="metric-sub" style="margin:4px 0 0">${flow.why}</p>

      ${
        now
          ? html`<div class="notice ${now.state === 'READY' ? 'warn' : 'info'}" style="margin-top:11px">
              <div>
                <b>Next: ${now.title}.</b> ${now.next ?? now.detail}
                ${
                  SCREEN[now.screen] && now.screen !== here
                    ? html` <button class="btn quiet sm" data-nav="${now.screen}" style="margin-left:6px">
                        Go to ${SCREEN[now.screen]} →
                      </button>`
                    : ''
                }
              </div>
            </div>`
          : html`<div class="notice ok" style="margin-top:11px"><div>
              <b>Nothing is outstanding on this road.</b> ${flow.summary}
            </div></div>`
      }

      <div class="split-list" style="margin-top:11px">
        ${flow.steps.map(
          (step) => html`<div class="row">
            <span class="lbl">
              ${badge(SAYS[step.state] ?? step.state, TONE[step.state] ?? '')}
              <b style="${raw(step.state === 'NOT_NEEDED' ? 'color:var(--text-3)' : '')}">${step.title}</b>
              <span class="metric-sub" style="display:block;margin-top:2px">${step.detail}</span>
            </span>
            <span class="val metric-sub">${SCREEN[step.screen] ?? ''}</span>
          </div>`,
        )}
      </div>
    </div>
  </div>`;
}
