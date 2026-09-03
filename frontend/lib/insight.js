import { api } from './api.js';
import { command } from './command.js';
import { badge, date, html, humanise, money, raw, resolveHtml, toast } from './ui.js';
import { drill } from './drill.js';

/**
 * The AI Insight / Recommendation panel.
 *
 * The Build Standard puts one on every command centre, carrying four actions:
 * **Review · Accept · Mitigate · Assign**. All of the machinery behind it was
 * built and it lived on exactly one screen — the autopilot queue — which is the
 * screen a person goes to when they have already decided to look at what the
 * agents found. That is precisely backwards: an insight is worth something at
 * the moment somebody is looking at the number it is about.
 *
 * ---
 *
 * **Scoped by capability area, filtered by the server.** A commercial screen
 * asks for commercial proposals. Doing that here rather than in each screen
 * means the narrowing is one rule the whole product shares and a screen cannot
 * quietly widen it.
 *
 * **An item that is not yours is shown, not hidden.** Somebody needs to be able
 * to see that a design decision has been sitting for a week, and a panel that
 * hides everything outside its reader's remit makes a stalled item invisible to
 * everyone except the person already not acting on it. It is marked, and it
 * names who decides it.
 *
 * ---
 *
 * The four actions are four different things, and collapsing any two of them
 * loses information the record needs:
 *
 * - **Review** opens the evidence. Read-only, and it is the one that has to
 *   exist first: accepting a recommendation without reading what it was built on
 *   is the failure mode this whole platform is against.
 * - **Accept** approves the proposal and runs its command as the approver. It
 *   spends ACU, so the cost is on screen before the button is pressed.
 * - **Mitigate** closes a finding that was right and is being handled another
 *   way. Not a rejection — rejecting says the finding was wrong — and the
 *   statement of what is being done instead is mandatory.
 * - **Assign** names who will decide it. Not a decision: the item stays open,
 *   because moving something to somebody's name is not dealing with it.
 *
 * **Reject stays.** It is not in the specification's four and removing it would
 * be worse: a finding that is simply wrong has to be recordable as wrong, or
 * every incorrect finding gets closed as "mitigated" and the platform loses the
 * only signal it has about its own accuracy.
 */

const SEVERITY_TONE = { URGENT: 'bad', ATTENTION: 'warn', INFO: 'info' };

/**
 * Fetch and render the panel into a host element.
 *
 * @param host        the element to render into
 * @param projectId   project
 * @param areas       capability areas this command centre owns
 * @param subject     what this screen is about, for the empty state
 * @param onChange    called after any action that changed something
 */
export async function insightPanel(host, { projectId, areas, subject, onChange }) {
  if (!host) return;

  let payload;
  try {
    payload = await api.get(`/v1/projects/${projectId}/proposals?area=${encodeURIComponent(areas.join(','))}`);
  } catch (error) {
    host.innerHTML = resolveHtml(
      html`<div class="card"><h3>AI Insight</h3>
        <div class="notice err">${error.detail ?? error.message ?? 'The proposal queue could not be read.'}</div>
      </div>`,
    );
    return;
  }

  const proposals = payload.proposals ?? [];
  const elsewhere = (payload.ofTotal ?? proposals.length) - proposals.length;

  host.innerHTML = resolveHtml(html`<div class="card pad0">
    <div style="padding:15px 17px 0">
      <h3>AI Insight &amp; Recommendation</h3>
      <div class="metric-sub">
        What the agent fleet found in ${subject}, and what it wants done about it. Nothing here has happened —
        every recommendation waits for a person.
        ${elsewhere > 0 ? html` ${elsewhere} more ${raw(elsewhere === 1 ? 'sits' : 'sit')} outside this screen's areas.` : ''}
      </div>
    </div>

    ${
      proposals.length === 0
        ? html`<div style="padding:9px 17px 15px">
            <div class="metric-sub">
              Nothing open. The fleet has raised no recommendation in ${subject} that is still waiting on a
              decision${elsewhere > 0 ? ', though it has elsewhere' : ''}.
            </div>
          </div>`
        : html`<div style="padding:11px 17px 16px">
            ${proposals.map((proposal) => card(proposal))}
          </div>`
    }
  </div>`);

  wire(host, { projectId, proposals, onChange });
}

function card(proposal) {
  const finding = proposal.finding ?? {};
  const proposed = proposal.command;

  return html`<div class="notice ${raw(SEVERITY_TONE[finding.severity] ?? '')}" style="margin:0 0 11px;display:block">
    <div style="display:flex;gap:9px;align-items:baseline;flex-wrap:wrap">
      ${badge(humanise(finding.severity ?? 'INFO'), SEVERITY_TONE[finding.severity] ?? 'neutral')}
      <b style="flex:1">${finding.summary ?? 'Finding'}</b>
      <span class="metric-sub">${humanise(proposal.agent)} · ${date(proposal.raisedAt)}</span>
    </div>

    <div style="margin-top:6px">${finding.consequence ?? ''}</div>

    ${
      proposed
        ? html`<div class="metric-sub" style="margin-top:7px">
            <b>Recommends:</b> ${proposed.effect}<br>
            <b>If not done:</b> ${proposed.ifDeclined}
            ${proposed.estimatedAcuMinor ? html`<br><b>Costs:</b> ${money(proposed.estimatedAcuMinor)} of ACU to run` : ''}
          </div>`
        : html`<div class="metric-sub" style="margin-top:7px">
            An observation. There is nothing to run — it needs a person to decide what, if anything, to do.
          </div>`
    }

    ${
      proposal.assignedToName
        ? html`<div class="metric-sub" style="margin-top:7px">
            Assigned to <b>${proposal.assignedToName}</b>${proposal.assignmentNote ? html` — ${proposal.assignmentNote}` : ''}
          </div>`
        : ''
    }

    <div class="actions" style="margin-top:9px">
      ${
        // Emphasis follows what the item actually offers. Where there is a
        // command, accepting it runs something and is the primary action. Where
        // there is not, the card has just said there is nothing to run — making
        // Accept the loudest button there invites somebody to press the one that
        // does the least, and teaches them the emphasis means nothing.
        proposed
          ? html`<button class="btn quiet" data-insight="review" data-id="${proposal.id}">Review</button>`
          : html`<button class="btn" data-insight="review" data-id="${proposal.id}">Review</button>`
      }
      ${
        proposal.mine
          ? html`
              <button class="btn ${raw(proposed ? '' : 'quiet')}" data-insight="accept" data-id="${proposal.id}">
                ${proposed ? 'Accept' : 'Accept the finding'}
              </button>
              <button class="btn quiet" data-insight="mitigate" data-id="${proposal.id}">Mitigate</button>
              <button class="btn quiet" data-insight="assign" data-id="${proposal.id}">Assign</button>
              <button class="btn quiet" data-insight="reject" data-id="${proposal.id}">Reject</button>
            `
          : html`<span class="metric-sub" style="align-self:center">
              Decided by ${(proposal.approvers ?? []).map(humanise).join(', ') || 'a role you do not hold'}
            </span>`
      }
    </div>
  </div>`;
}

function wire(host, { projectId, proposals, onChange }) {
  const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));

  host.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-insight]');
    if (!button) return;
    const proposal = byId.get(button.dataset.id);
    if (!proposal) return;

    const path = `/v1/projects/${projectId}/proposals/${proposal.id}`;

    // --- Review: read what it was built on, before deciding anything ---------
    if (button.dataset.insight === 'review') {
      const evidence = (proposal.finding?.evidence ?? []).map((item) => ({
        refType: item.refType,
        refId: item.refId,
      }));
      // A finding about something that does not exist has a source too — the
      // register it searched. Without this, Review on "no lookahead has ever
      // been published" opened the project's phase history, which evidences the
      // phase and says nothing at all about lookaheads.
      const absence = proposal.finding?.absence ?? [];
      if (evidence.length === 0 && absence.length === 0) {
        toast('Nothing to review', 'This finding names no source records, which is itself worth knowing.', 'warn');
        return;
      }
      await drill(projectId, proposal.finding.summary ?? 'Finding evidence', evidence, absence);
      return;
    }

    // --- Accept: approve, and run the command as the approver ----------------
    if (button.dataset.insight === 'accept') {
      const cost = proposal.command?.estimatedAcuMinor ?? 0;
      const confirmed = await command({
        title: 'Accept this recommendation',
        intent: proposal.command
          ? `${proposal.command.effect}${cost ? ` It runs as you and spends about ${money(cost)} of ACU.` : ' It runs as you.'}`
          : 'There is no command to run. Accepting records that you agree with the finding.',
        path: `${path}/approve`,
        fields: [
          { name: 'note', label: 'Note', type: 'textarea', required: false, hint: 'Recorded with the approval.' },
        ],
        submitLabel: 'Accept and run',
      });
      if (confirmed) {
        toast('Accepted', 'Recorded against your name, and the command has run.', 'ok');
        await onChange?.();
      }
      return;
    }

    // --- Mitigate: right finding, handled another way ------------------------
    if (button.dataset.insight === 'mitigate') {
      const confirmed = await command({
        title: 'Handled another way',
        intent:
          'Use this where the finding is right and you are dealing with it outside this recommendation. ' +
          'It is not a rejection, and what you are doing instead becomes part of the record.',
        path: `${path}/mitigate`,
        fields: [
          {
            name: 'mitigation',
            label: 'What is being done instead',
            type: 'textarea',
            hint: 'Required. "Mitigated" with nothing behind it reads as a control and is a shrug.',
          },
        ],
        submitLabel: 'Close as mitigated',
      });
      if (confirmed) {
        toast('Closed as mitigated', 'The finding stands; what you are doing about it is recorded.', 'ok');
        await onChange?.();
      }
      return;
    }

    // --- Assign: name who decides. Stays open --------------------------------
    if (button.dataset.insight === 'assign') {
      let owners;
      try {
        owners = await api.get(`${path}/owners`);
      } catch (error) {
        toast('Could not list who may decide this', error.detail ?? error.message ?? '', 'err');
        return;
      }
      if ((owners.owners ?? []).length === 0) {
        toast(
          'Nobody to assign it to',
          `This is decided by ${(owners.approverRoles ?? []).map(humanise).join(', ')}, and nobody in this ` +
            'tenancy holds one of those roles.',
          'warn',
        );
        return;
      }

      const confirmed = await command({
        title: 'Assign this recommendation',
        intent: 'The proposal stays open. Assigning it names who is dealing with it, which is not the same as deciding it.',
        path: `${path}/assign`,
        fields: [
          {
            name: 'userId',
            label: 'Who will decide it',
            type: 'select',
            options: owners.owners.map((owner) => ({
              value: owner.userId,
              label: `${owner.name} · ${humanise(owner.role)}${owner.escalation ? ' (escalation)' : ''}`,
            })),
            hint: 'Ordered by how specialised the role is, so the first name is the one whose job this is.',
          },
          { name: 'note', label: 'Note', type: 'textarea', required: false },
        ],
        submitLabel: 'Assign',
      });
      if (confirmed) {
        toast('Assigned', 'Still open — it now has a name against it.', 'ok');
        await onChange?.();
      }
      return;
    }

    // --- Reject: the finding was wrong ---------------------------------------
    if (button.dataset.insight === 'reject') {
      const confirmed = await command({
        title: 'Reject this recommendation',
        intent:
          'Use this where the finding is wrong or does not matter. If it is right and you are handling it ' +
          'another way, close it as mitigated instead — the difference is what tells us how accurate the fleet is.',
        path: `${path}/reject`,
        fields: [
          { name: 'reason', label: 'Why', type: 'textarea', hint: 'Required, and it becomes part of the record.' },
        ],
        submitLabel: 'Reject',
      });
      if (confirmed) {
        toast('Rejected', 'Recorded against your name.', 'ok');
        await onChange?.();
      }
    }
  });
}
