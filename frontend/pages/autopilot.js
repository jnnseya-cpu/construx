import { api } from '../lib/api.js';
import { badge, ellipsis, html, humanise, positionReport, raw, reference, render, resolveHtml, table, time, toast } from '../lib/ui.js';
import { lookupPanel, wireLookups } from '../lib/lookup.js';
import { blockedReason, can, draw, state } from '../app.js';

/**
 * Autopilot.
 *
 * The agents watch the project and say what they think should happen. Nothing
 * here has happened yet — that is the point of the screen. Every row is a
 * decision waiting for a person who holds the authority to make it, and the
 * screen gives them what they need to make it: what was observed, which records
 * it was read from, what the command would do, and what happens if they decline.
 *
 * An approval runs the command as the approver. A rejection needs a reason and
 * stays in the record, because "the platform raised it and someone decided
 * against it" is the answer to a question that gets asked after an incident.
 */

const TONE = { URGENT: 'bad', ATTENTION: 'warn', INFO: 'info' };

export async function autopilot(root) {
  const projectId = state.session.projectId;

  const [proposals, fleet, runs, ladder, envelopes, ai] = await Promise.all([
    api.get(`/v1/projects/${projectId}/proposals`).catch(() => ({ proposals: [] })),
    api.get('/v1/agents').catch(() => ({ agents: [] })),
    api.get(`/v1/projects/${projectId}/entities/AgentRun`).catch(() => ({ entities: [] })),
    // The rungs themselves, and every grant of unattended authority ever made.
    // The ladder is the safety property this whole screen rests on, and it was
    // published by the platform with nowhere to read it.
    api.get('/v1/agents/ladder').catch((error) => ({ error })),
    api.get(`/v1/projects/${projectId}/agents/envelopes`).catch((error) => ({ error })),
    api
      .get(`/v1/projects/${projectId}/ai/dispositions`)
      .catch(() => ({ executions: 0, disposed: 0, accepted: 0, acceptedWithChange: 0, rejected: 0, outstanding: [] })),
  ]);

  const open = proposals.proposals ?? [];

  const LOOKUPS = [
    {
      id: 'proposalowners',
      title: 'Who could decide this',
      intent:
        'Most specialised first, which is what the assign action offers. A proposal in a queue nobody named can ' +
        'decide is a proposal that sits there — and the queue looks busy while nothing moves.',
      empty: 'No proposal is waiting on a decision.',
      inputs: [
        {
          name: 'proposalId',
          label: 'Proposal',
          options: open.map((proposal) => ({
            value: proposal.id,
            // The finding's own words, not the id. A chooser listing eleven
            // ULIDs is a chooser nobody can use.
            label: `${proposal.agent} \u00b7 ${ellipsis(proposal.finding?.summary ?? proposal.id, 70)}`,
          })),
        },
      ],
      path: (v) => `/v1/projects/${projectId}/proposals/${v.proposalId}/owners`,
      sections: [
        { key: 'owners', label: 'Could decide it', empty: 'Nobody in this tenancy holds the authority to decide it.' },
      ],
    },
  ];
  // The API already sorts mine-first; these are only for the count in the
  // header, so the reader knows how much of the queue is theirs before they
  // start scrolling it.
  const mine = open.filter((p) => p.mine);
  const theirs = open.filter((p) => !p.mine);
  const lastRun = (runs.entities ?? []).at(-1)?.state;
  const urgent = open.filter((p) => p.finding.severity === 'URGENT');
  const actionable = open.filter((p) => p.command);
  const myRoles = state.session.user.roles ?? [];

  const mineToDecide = open.filter((p) => {
    const agent = (fleet.agents ?? []).find((a) => a.name === p.agent);
    return agent && myRoles.some((role) => agent.approvers.includes(role));
  });

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Autopilot</h1>
          <p>
            The agents watch the project continuously and propose what should happen next.
            Nothing on this screen has been done — each one is waiting for someone with the authority to decide.
          </p>
        </div>
        <div class="actions cmd-bar">
          ${
            can('AI_EXECUTION', 'X')
              ? html`<button class="btn" id="run">Run the fleet now</button>`
              : html`<button class="btn quiet locked" disabled title="${blockedReason('AI_EXECUTION', 'X') ?? ''}">Run the fleet now 🔒</button>`
          }
        </div>
      </div>

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Awaiting a decision</h2>
          <div class="metric ${raw(open.length > 0 ? 'orange' : 'good')}">${open.length}</div>
          <div class="metric-sub">${urgent.length} urgent · ${actionable.length} carry a command</div>
        </div>
        <div class="card">
          <h2>Yours to decide</h2>
          <div class="metric ${raw(mineToDecide.length > 0 ? 'warn' : '')}">${mineToDecide.length}</div>
          <div class="metric-sub">as ${myRoles.join(', ')}</div>
        </div>
        <div class="card">
          <h2>Agents watching</h2>
          <div class="metric">${(fleet.agents ?? []).length}</div>
          <div class="metric-sub">one per engine, each inside a fixed mandate</div>
        </div>
        <div class="card">
          <h2>Last pass</h2>
          <div class="metric" style="font-size:19px">${lastRun ? time(lastRun.ranAt) : '—'}</div>
          <div class="metric-sub">${lastRun ? `${lastRun.proposalsRaised} raised · ${lastRun.suppressed} already open` : 'the fleet has not run'}</div>
        </div>
      </div>

      ${
        open.length === 0
          ? html`<div class="card"><div class="empty">
              <b>Nothing awaiting a decision</b>
              Either the fleet has not run, or it looked and found nothing it wanted to raise. Both are stated rather than assumed —
              the last pass above says which.
            </div></div>`
          : html`<div id="queue">
              ${
                mine.length > 0
                  ? html`<div class="metric-sub" style="margin-bottom:10px">
                      <b>${mine.length} awaiting your decision</b>${
                        theirs.length > 0 ? ` · ${theirs.length} for other roles, shown below` : ''
                      }
                    </div>`
                  : html`<div class="metric-sub" style="margin-bottom:10px">
                      Nothing here is yours to decide. ${open.length} open for other roles.
                    </div>`
              }
              ${open.map(proposalCard)}
            </div>`
      }

      ${dispositionPanel(ai)}

      <div class="card pad0" style="margin-top:14px">
        <h2 style="padding:15px 17px 0">The fleet and what each agent may do</h2>
        ${table({
          headers: ['Agent', 'Watches for', 'Reads', 'May propose in', 'Decided by', 'Unattended'],
          rows: (fleet.agents ?? []).map((a) => [
            humanise(a.name),
            a.purpose,
            a.reads.map(humanise).join(', '),
            a.proposes.map(humanise).join(', '),
            a.approvers.join(', '),
            badge(a.maxUnattended === 'ACT' ? 'may act' : 'proposes only', a.maxUnattended === 'ACT' ? 'warn' : 'ok'),
          ]),
          empty: 'No agents registered',
        })}
        <div style="padding:12px 17px 15px"><div class="metric-sub">
          A mandate is the ceiling, not a default. The runtime refuses a proposal outside it, and refuses one that none of the
          named approvers could approve — so an agent cannot quietly widen its own remit or fill the queue with things nobody can act on.
        </div></div>
      </div>

      ${raw(LOOKUPS.map((spec) => resolveHtml(lookupPanel(spec))).join(''))}

      ${positionReport({
        title: 'The mandate ladder',
        intent:
          'Four rungs, and who is in the loop at each. No agent approves its own proposal, and none acts ' +
          'unattended without a granted envelope.',
        data: ladder,
        error: ladder?.error,
        sections: [
          { key: 'ladder', label: 'Rungs', empty: 'No ladder is published, which would mean nothing constrains an agent.' },
          { key: 'automatableCommands', label: 'Commands an envelope may cover', empty: 'No command may be run unattended.' },
        ],
      })}

      ${positionReport({
        title: 'Grants of unattended authority',
        intent:
          'Every envelope ever granted, live or withdrawn. Kept whole rather than pruned: an expired grant is the ' +
          'record of what an agent was allowed to do at the time it did it.',
        data: envelopes,
        error: envelopes?.error,
        sections: [
          { key: 'envelopes', label: 'Envelopes', empty: 'Nothing has been granted authority to act unattended.' },
        ],
      })}
    `,
  );

  // --- decisions --------------------------------------------------------------

  wireLookups(root, LOOKUPS);

  root.querySelector('#run')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Running…';
    try {
      const report = await api.post(`/v1/projects/${projectId}/agents/run`, {});
      const failed = (report.agents ?? []).filter((a) => a.error);
      toast(
        'Fleet run complete',
        `${report.proposals.length} raised, ${report.suppressed} already open${failed.length ? `, ${failed.length} agent failed` : ''}`,
        failed.length ? 'warn' : 'ok',
      );
      await draw();
    } catch (error) {
      toast('Fleet run failed', error.message, 'err');
      button.disabled = false;
      button.textContent = 'Run the fleet now';
    }
  });

  root.querySelector('#dispositions')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-dispose]');
    if (!button) return;

    const card = button.closest('[data-execution]');
    const executionId = card.dataset.execution;
    const decision = button.dataset.dispose;
    const reason = card.querySelector('[name="why"]').value.trim();
    const errorBox = card.querySelector('.cmd-error');
    errorBox.hidden = true;

    // The server refuses this too. Checking here as well is not a duplicate
    // rule — it is the difference between a message beside the field and a
    // round trip that returns the same answer more slowly.
    if (decision !== 'ACCEPTED' && !reason) {
      errorBox.textContent = 'A reason is required — a correction nobody wrote down is one nobody can learn from.';
      errorBox.hidden = false;
      return;
    }

    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Recording…';
    try {
      await api.post(`/v1/projects/${projectId}/ai/executions/${executionId}/dispose`, {
        decision,
        ...(reason ? { reason } : {}),
      });
      toast('Recorded', 'The decision is on the execution and the stage gate can read it', 'ok');
      await draw();
    } catch (error) {
      errorBox.textContent = `${error.code ? `${error.code} — ` : ''}${error.message}`;
      errorBox.hidden = false;
      button.disabled = false;
      button.textContent = original;
    }
  });

  root.querySelector('#queue')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-decide]');
    if (!button) return;

    const card = button.closest('.proposal');
    const { decide } = button.dataset;
    const proposal = card.dataset.proposal;
    const errorBox = card.querySelector('.cmd-error');
    errorBox.hidden = true;

    if (decide === 'reject') {
      const reason = card.querySelector('[name="reason"]').value.trim();
      if (!reason) {
        errorBox.textContent = 'A reason is required — the rejection is part of the record.';
        errorBox.hidden = false;
        return;
      }
      await send(() => api.post(`/v1/projects/${projectId}/proposals/${proposal}/reject`, { reason }), 'Rejected');
      return;
    }

    const note = card.querySelector('[name="note"]')?.value.trim();
    await send(() => api.post(`/v1/projects/${projectId}/proposals/${proposal}/approve`, note ? { note } : {}), 'Approved');

    async function send(request, verb) {
      button.disabled = true;
      const original = button.textContent;
      button.textContent = 'Working…';
      try {
        const result = await request();
        toast(verb, result.executed ? 'The command ran as you' : 'Recorded', 'ok');
        await draw();
      } catch (error) {
        errorBox.textContent = `${error.code ? `${error.code} — ` : ''}${error.message}`;
        errorBox.hidden = false;
        button.disabled = false;
        button.textContent = original;
      }
    }
  });
}

/**
 * What the project has actually stood behind.
 *
 * The fifth clause of every stage gate fails naming an execution nobody has
 * decided about, so there has to be somewhere to go and decide. This is it.
 *
 * The decision is deliberately not a proposal: a proposal is the platform
 * asking whether to run something, and this is a person saying what they did
 * with the answer after it ran. Accepting with a change and rejecting both
 * require a reason, because a correction with no reason recorded is a
 * correction nobody can learn from.
 */
function dispositionPanel(ai) {
  const outstanding = ai.outstanding ?? [];
  const mayDispose = can('AI_EXECUTION', 'X');

  return html`<div id="dispositions" style="margin-top:14px">
    <div class="card" style="margin-bottom:${raw(outstanding.length > 0 ? '12px' : '0')}">
      <h2>AI output, and what a person did with it</h2>
      <div class="split-list" style="margin-top:10px">
        <div class="row"><span class="lbl">Accepted as produced</span><span class="val">${ai.accepted ?? 0}</span></div>
        <div class="row"><span class="lbl">Accepted, then changed</span><span class="val">${ai.acceptedWithChange ?? 0}</span></div>
        <div class="row"><span class="lbl">Rejected</span><span class="val">${ai.rejected ?? 0}</span></div>
        <div class="row">
          <span class="lbl">Nobody has decided</span>
          <span class="val">${badge(String(outstanding.length), outstanding.length > 0 ? 'warn' : 'ok')}</span>
        </div>
      </div>
      ${
        outstanding.length === 0
          ? html`<div class="metric-sub" style="margin-top:12px">
              All ${ai.disposed ?? 0} of ${ai.executions ?? 0} executions carry a named person's decision — which is what the
              fifth clause of each stage gate reads before it passes.
            </div>`
          : mayDispose
            ? html`<div class="metric-sub" style="margin-top:12px">
                Each one below ran, was charged and was written to the ledger. None has a person's name against it, and every
                stage gate reports it by name until one does.
              </div>`
            : html`<div class="metric-sub" style="margin-top:12px">
                ${blockedReason('AI_EXECUTION', 'X') ?? 'Your roles do not carry this decision.'}
              </div>`
      }
    </div>

    ${
      !mayDispose
        ? ''
        : outstanding.map(
            (item) => html`<div class="card proposal" data-execution="${item.executionId}" style="margin-bottom:12px">
              <div style="display:flex;gap:11px;align-items:center;margin-bottom:11px">
                ${badge(humanise(item.taskType ?? 'unknown task'), 'ai')}
                ${item.engine ? badge(humanise(item.engine), 'neutral') : ''}
                <div class="metric-sub mono" style="margin-left:auto;font-size:11px">
                  ${reference(item.executionId)}
                </div>
              </div>

              <div class="cmd-error" hidden></div>

              <div class="input-zone">
                <div class="field">
                  <label for="why-${item.executionId}">Reason <span class="opt">required unless accepted unchanged</span></label>
                  <input id="why-${item.executionId}" name="why" type="text"
                    placeholder="What you changed, or why you are not using it">
                </div>
                <div class="actions">
                  <button class="btn" data-dispose="ACCEPTED">Accept as produced</button>
                  <button class="btn quiet" data-dispose="ACCEPTED_WITH_CHANGE">Accept with change</button>
                  <button class="btn quiet" data-dispose="REJECTED">Reject</button>
                </div>
              </div>
            </div>`,
          )
    }
  </div>`;
}

function proposalCard(proposal) {
  const { finding, command } = proposal;
  const tone = TONE[finding.severity] ?? 'info';

  return html`<div class="card proposal" data-proposal="${proposal.id}" style="margin-bottom:12px">
    <div style="display:flex;gap:11px;align-items:flex-start;margin-bottom:11px">
      ${badge(finding.severity, tone)}
      ${badge(humanise(proposal.agent), 'neutral')}
      ${
        // Whose decision this is, read from the raising agent's own mandate.
        // An item that is not yours is marked rather than hidden: somebody has
        // to be able to see that a design decision has sat for a week, and a
        // queue that hides everything outside its owner's remit makes a stalled
        // item invisible to everyone except the person already not acting on it.
        proposal.mine
          ? badge('Yours to decide', 'ai')
          : proposal.approvers?.length
            ? badge(`Decided by ${proposal.approvers.join(' / ')}`, 'neutral')
            : ''
      }
      <div style="margin-left:auto" class="metric-sub">raised ${time(proposal.raisedAt)}</div>
    </div>

    <div style="font-size:14.5px;font-weight:650;margin-bottom:6px">${finding.summary}</div>
    <div class="metric-sub" style="margin-bottom:12px">${finding.consequence}</div>

    ${
      finding.evidence.length > 0
        ? html`<div class="split-list" style="margin-bottom:12px">
            ${finding.evidence.map(
              (e) => html`<div class="row">
                <span class="lbl"><b>${humanise(e.refType)}</b> ${e.note}</span>
                <span class="val mono" style="font-size:11px;opacity:.6">${reference(e.refId)}</span>
              </div>`,
            )}
          </div>`
        : ''
    }

    ${
      command
        ? html`<div class="notice info" style="margin-bottom:12px">
            <div>
              <b>Proposed: ${command.command}</b><br>
              ${command.effect}<br>
              <span style="opacity:.8">If declined — ${command.ifDeclined}</span>
              ${command.estimatedAcuMinor > 0 ? html`<br><span style="opacity:.8">Estimated AI cost: ${command.estimatedAcuMinor} ACU</span>` : ''}
            </div>
          </div>`
        : html`<div class="metric-sub" style="margin-bottom:12px">
            An observation. There is no command to run — it is here because someone should know.
          </div>`
    }

    <div class="cmd-error" hidden></div>

    <div class="input-zone">
      ${
        command
          ? html`<div class="field">
              <label for="note-${proposal.id}">Note on approval <span class="opt">optional</span></label>
              <input id="note-${proposal.id}" name="note" type="text" placeholder="Why you are approving this">
            </div>`
          : ''
      }
      <div class="field">
        <label for="reason-${proposal.id}">Reason, if declining</label>
        <input id="reason-${proposal.id}" name="reason" type="text" placeholder="Required to reject">
      </div>
      <div class="actions">
        ${command ? html`<button class="btn" data-decide="approve">Approve and run</button>` : ''}
        <button class="btn quiet" data-decide="reject">${command ? 'Decline' : 'Dismiss'}</button>
      </div>
    </div>
  </div>`;
}
