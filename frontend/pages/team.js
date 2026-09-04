import { api } from '../lib/api.js';
import { badge, date, html, humanise, metric, notice, raw, render, table, toast } from '../lib/ui.js';
import { blockedReason, can, draw, state, tenantGrantableRoles } from '../app.js';
import { command, commandBar } from '../lib/command.js';

/**
 * Team & Access — identity governance for the tenancy.
 *
 * Everybody in the tenancy, where each of them sits, what each of them may do,
 * how each of them signs in, what each of them has done, and what the platform
 * enforces about all of it. Assembled from records that already exist — the
 * users, the seats, the invitations, the credential posture and the ledger —
 * rather than kept as a screen of its own, so nothing here can disagree with
 * the record behind it.
 *
 * What is deliberately not here, and why. Custom role templates and per-user
 * permission toggles: the permission matrix is the one published source of
 * what a role may do, the browser holds no rule the API does not publish, and
 * a permission granted to one person outside their role is a permission no
 * screen can account for. Approval-rule toggles ("finance access requires owner
 * approval"): the controls in force are the ones the engines enforce, and they
 * are listed as such below; a switch that nothing reads would be a promise
 * with nothing behind it.
 */

const STATE_TONE = { ACTIVE: 'good', DEACTIVATED: 'warn', DELETION_PENDING: 'bad', ERASED: 'neutral' };
const ACTIVITY_LABEL = { ACTIVE: 'Active this week', RECENT: 'Active this month', IDLE: 'Idle', DORMANT: 'Dormant', NEVER: 'Never active' };
const ACTIVITY_TONE = { ACTIVE: 'good', RECENT: 'good', IDLE: 'warn', DORMANT: 'bad', NEVER: 'neutral' };

function administers() {
  const roles = state.session?.user?.roles ?? [];
  return roles.includes('ENTERPRISE_ADMIN') || roles.includes('OWNER');
}

export async function team(root) {
  let position;
  const support = await api.get('/v1/team/support-access').catch(() => null);
  try {
    position = await api.get('/v1/team');
  } catch (error) {
    render(
      root,
      html`<div class="view-head"><div><h1>Team &amp; Access</h1></div></div>
        ${notice(`${error.code ? `${error.code} — ` : ''}${error.message}`, 'err')}`,
    );
    return;
  }

  const { summary, seats, people, units, invitations, roles, governance } = position;
  const admin = administers();
  const me = state.session?.user?.id;
  const live = units.filter((unit) => !unit.retiredAt);
  const pending = invitations.filter((invitation) => invitation.status === 'PENDING');
  const byId = new Map(people.map((person) => [person.id, person]));

  const unitPath = (unit) => {
    const parts = [unit.name];
    let cursor = unit;
    const seen = new Set();
    while (cursor?.parentId && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      cursor = units.find((candidate) => candidate.id === cursor.parentId);
      if (cursor) parts.unshift(cursor.name);
    }
    return parts.join(' › ');
  };

  const personActions = (person) => {
    if (!admin || person.id === me || person.state === 'ERASED') return '';
    const act = (action, label, tone = 'quiet') =>
      html`<button class="btn ${tone} sm" data-person-action="${action}" data-user="${person.id}" data-name="${person.name}">${label}</button>`;
    if (person.state === 'DELETION_PENDING') return act('cancel-erasure', 'Cancel deletion');
    if (person.state === 'DEACTIVATED') return html`${act('reactivate', 'Reactivate')} ${act('delete', 'Delete', 'quiet danger')}`;
    return html`${act('roles', 'Roles')} ${act('place', 'Place')} ${act('deactivate', 'Deactivate')}`;
  };

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Team &amp; Access</h1>
          <p>
            ${summary.identities} identit${summary.identities === 1 ? 'y' : 'ies'} · ${summary.pendingInvitations} pending
            invitation${summary.pendingInvitations === 1 ? '' : 's'} · ${seats.package} package,
            ${seats.cap === null ? 'unlimited seats' : `${seats.used} of ${seats.cap} seats taken`}
          </p>
        </div>
        <div class="actions cmd-bar">
          ${raw(commandBar([
            { id: 'unit', label: 'Add unit', permitted: admin, reason: 'Only an enterprise admin may change the structure' },
            {
              id: 'import',
              label: 'Import people',
              permitted: admin && seats.remaining !== 0,
              reason: seats.remaining === 0 ? 'Every seat is taken or invited. Buy a seat on ACU & Billing, or move package.' : 'Only an enterprise admin may add people',
            },
            { id: 'report', label: 'Export user report', tone: '', permitted: admin, reason: 'Only an enterprise admin may export the user report' },
            {
              id: 'membership',
              label: 'Add from another company',
              tone: '',
              permitted: admin && Boolean(state.me?.group),
              reason: !state.me?.group ? 'Memberships across companies are a group feature; this company is not in a group.' : 'Only an enterprise admin may add people',
            },
          ]))}
        </div>
      </div>

      <div class="grid g4" style="margin-bottom:14px">
        ${raw(metric({ label: 'Active members', value: summary.active, sub: `${summary.identities} total` }))}
        ${raw(metric({ label: 'Pending invitations', value: summary.pendingInvitations, sub: seats.remaining === null ? 'unlimited seats' : `${seats.remaining} seat${seats.remaining === 1 ? '' : 's'} free` }))}
        ${raw(metric({ label: 'Deactivated', value: summary.deactivated, sub: summary.deletionPending > 0 ? `${summary.deletionPending} deletion pending` : 'records kept', tone: summary.deactivated > 0 ? 'warn' : '' }))}
        ${raw(
          metric({
            label: 'Second factor enrolled',
            value: `${summary.secondFactor.enrolled} of ${summary.secondFactor.of}`,
            sub: `${summary.secondFactor.coverage}% of active members hold a passkey or a bound device`,
            tone: summary.secondFactor.coverage === 100 ? 'good' : summary.secondFactor.coverage >= 50 ? 'warn' : 'bad',
          }),
        )}
      </div>

      <div class="card" style="margin-bottom:14px" data-directory>
        <h2>User directory</h2>
        <p class="metric-sub" style="margin-bottom:12px">
          Named identity, one per human. Activity and history are read from the hash-chained ledger; the second factor from the
          credential store; the risk signals from both. Every action here is recorded against whoever took it.
        </p>
        ${table({
          headers: admin ? ['Identity', 'Roles', 'Activity', 'Risk signal', 'Second factor', 'Status', ''] : ['Identity', 'Roles', 'Activity', 'Risk signal', 'Second factor', 'Status'],
          rows: people.map((person) => [
            html`<div><b>${person.name}</b></div>
              <div class="metric-sub">${person.email}${person.unitName ? ` · ${person.unitName}` : ''}${
                person.managerName ? ` · reports to ${person.managerName}` : ''
              }${person.reports > 0 ? ` · manages ${person.reports}` : ''}</div>`,
            html`${(person.roles ?? []).map((role) => badge(humanise(role), 'neutral'))}`,
            html`${badge(ACTIVITY_LABEL[person.activity] ?? person.activity, ACTIVITY_TONE[person.activity] ?? 'neutral')}
              ${person.lastActivityAt ? html`<div class="metric-sub">${date(person.lastActivityAt)}</div>` : ''}`,
            person.risk.length === 0
              ? badge('clear', 'good')
              : html`${person.risk.map((signal) => html`<div class="metric-sub bad">${signal}</div>`)}`,
            badge(person.mfa.label, person.mfa.passkey || person.mfa.device ? 'good' : 'warn'),
            html`${badge(humanise(person.state).toLowerCase(), STATE_TONE[person.state] ?? 'neutral')}
              ${person.erasureDueAt ? html`<div class="metric-sub">erased on ${date(person.erasureDueAt)}</div>` : ''}`,
            ...(admin
              ? [
                  html`${personActions(person)}
                    <button class="btn quiet sm" data-person-action="history" data-user="${person.id}" data-name="${person.name}">History</button>`,
                ]
              : []),
          ]),
          empty: 'Nobody is in this tenancy yet.',
        })}
        <div id="history-slot"></div>
      </div>

      <div class="grid g2" style="margin-bottom:14px">
        <div class="card" data-structure>
          <h2>Organisation structure</h2>
          <p class="metric-sub" style="margin-bottom:12px">
            Departments, branches and teams — the shape of your own organisation, separate from the delivery hierarchy of
            enterprise, portfolio and project. A person belongs to at most one unit and reports to at most one person.
          </p>
          ${table({
            headers: admin ? ['Unit', 'Kind', 'Members', ''] : ['Unit', 'Kind', 'Members'],
            rows: live.map((unit) => [
              unitPath(unit),
              badge(humanise(unit.kind).toLowerCase(), 'neutral'),
              String(unit.members),
              ...(admin ? [html`<button class="btn quiet sm" data-unit-retire="${unit.id}" data-name="${unit.name}">Retire</button>`] : []),
            ]),
            empty: 'No units yet. Add a department, then place people in it.',
          })}
          ${units.some((unit) => unit.retiredAt)
            ? html`<div class="metric-sub" style="margin-top:8px">${units.filter((unit) => unit.retiredAt).length} retired unit(s) kept on the record.</div>`
            : ''}
        </div>

        <div class="card">
          <h2>Reporting lines</h2>
          <p class="metric-sub" style="margin-bottom:12px">Manager → staff, as placed. Loops are refused.</p>
          ${table({
            headers: ['Manager', 'Reports to them'],
            rows: people
              .filter((person) => person.reports > 0)
              .map((manager) => [
                manager.name,
                html`${people.filter((person) => person.managerId === manager.id).map((person) => badge(person.name, 'neutral'))}`,
              ]),
            empty: 'No reporting lines recorded. Use Place on a person to set who they report to.',
          })}
        </div>
      </div>

      <div class="card" style="margin-bottom:14px" data-invitations>
        <h2>Invitations</h2>
        <p class="metric-sub" style="margin-bottom:12px">
          Every invitation this tenancy has sent, across its projects. A pending invitation holds a seat; withdrawing it gives
          the seat back. Invitations are sent from a project on Enterprise &amp; Portfolio.
        </p>
        ${table({
          headers: admin ? ['Person', 'Project', 'Roles', 'Invited', 'Status', ''] : ['Person', 'Project', 'Roles', 'Invited', 'Status'],
          rows: invitations.map((invitation) => [
            html`<div><b>${invitation.name}</b></div><div class="metric-sub">${invitation.email}${invitation.organisation ? ` · ${invitation.organisation}` : ''}${invitation.external ? ' · external' : ''}</div>`,
            invitation.projectName || invitation.projectId,
            html`${(invitation.roles ?? []).map((role) => badge(humanise(role), 'neutral'))}`,
            html`${date(invitation.invitedAt)}<div class="metric-sub">by ${invitation.invitedByName}${invitation.status === 'PENDING' ? ` · lapses ${date(invitation.expiresAt)}` : ''}</div>`,
            badge(String(invitation.status).toLowerCase(), invitation.status === 'ACCEPTED' ? 'good' : invitation.status === 'PENDING' ? 'warn' : 'neutral'),
            ...(admin
              ? [
                  invitation.status === 'PENDING'
                    ? html`<button class="btn quiet sm" data-invitation-withdraw="${invitation.id}" data-project="${invitation.projectId}" data-name="${invitation.name}">Withdraw</button>`
                    : '',
                ]
              : []),
          ]),
          empty: 'No invitations have been sent.',
        })}
      </div>

      <div class="grid g2" style="margin-bottom:14px">
        <div class="card">
          <h2>Roles &amp; permissions</h2>
          <p class="metric-sub" style="margin-bottom:12px">
            The ${summary.rolesDefined} roles a tenancy may grant, and what each may do, as the platform publishes and enforces
            them. Least privilege by construction: a role holds nothing that is not listed, and a person holds nothing outside
            their roles. Change what somebody may do by changing their roles.
          </p>
          ${table({
            headers: ['Role', 'Holders', 'Areas', 'Codes'],
            rows: roles.map((entry) => [
              humanise(entry.role),
              String(entry.holders),
              String(entry.areas.length),
              html`${[...new Set(entry.areas.flatMap((area) => area.codes))].sort().map((code) => badge(code, 'neutral'))}`,
            ]),
            empty: 'No roles are published.',
          })}
          <div class="metric-sub" style="margin-top:8px">R read · C create · U update · A approve · I import/export · X run AI · G governance. The full matrix is on Permissions.</div>
        </div>

        <div class="card" data-support-access>
          <h2>Support access</h2>
          <div class="metric-sub" style="margin:6px 0 10px">
            Every time the platform operator opened a window on this company’s governance record: who, why, the ticket,
            the window, and what was read. Operators have no other way in. End a window early from here.
          </div>
          ${table({
            headers: ['Opened', 'Operator', 'Ticket', 'Why', 'Until', 'Reads', ''],
            rows: (support?.grants ?? []).map((grant) => [
              date(grant.openedAt),
              grant.operatorName,
              grant.ticketRef,
              grant.reason,
              grant.closedAt ? html`closed ${date(grant.closedAt)}` : new Date(grant.expiresAt) > new Date() ? badge('open', 'warn') : badge('expired', 'neutral'),
              grant.uses.length,
              !grant.closedAt && new Date(grant.expiresAt) > new Date() && admin ? html`<button class="btn quiet sm" data-support-close="${grant.id}">End now</button>` : '',
            ]),
            empty: 'No operator has opened support access on this company.',
          })}
        </div>

        <div class="card">
          <h2>Governance in force</h2>
          <p class="metric-sub" style="margin-bottom:12px">
            What the platform enforces about access, read from where it is enforced. Nothing here is a setting that something
            else could ignore.
          </p>
          <div class="split-list">
            <div class="row"><span class="lbl">Separation of duties</span><span class="val">${governance.separationOfDuties}</span></div>
            <div class="row"><span class="lbl">Seats</span><span class="val">${governance.seatCap}</span></div>
            <div class="row"><span class="lbl">Administration</span><span class="val">${governance.lastAdministrator}</span></div>
            <div class="row"><span class="lbl">AI</span><span class="val">${governance.aiMandateCeiling}</span></div>
            <div class="row"><span class="lbl">Deletion</span><span class="val">Erasure is carried out ${governance.erasureGraceDays} days after it is requested, and can be cancelled until then</span></div>
            <div class="row"><span class="lbl">Sign-in</span><span class="val">${governance.deviceBindingRequired ? 'A bound device is required for every session' : 'One-time code by email; passkeys and device binding available on Security'}</span></div>
            <div class="row"><span class="lbl">Second factor</span><span class="val">${
              governance.mfaRequired === 'EVERYONE'
                ? 'Everyone must hold an authenticator app; a session without one can only enrol'
                : governance.mfaRequired === 'ADMINISTRATORS'
                  ? 'Administrators must hold an authenticator app; a session without one can only enrol'
                  : 'Not required — anyone may set one up on Security'
            }${governance.mfaPolicySetAt ? html`<div class="metric-sub">set ${date(governance.mfaPolicySetAt)}</div>` : ''}</span></div>
          </div>
          ${admin
            ? html`<div class="actions" style="margin-top:12px">
                <button class="btn quiet sm" data-mfa-policy>Change who must hold a second factor</button>
              </div>`
            : ''}
        </div>
      </div>
    `,
  );

  if (!admin) return;

  const reason = (hint) => ({ name: 'reason', label: 'Reason', type: 'textarea', hint });
  const refresh = () => draw();

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    try {
      if (button.dataset.command === 'unit') {
        const done = await command({
          title: 'Add a unit',
          intent: 'A department, branch or team. Nested under a parent if it has one; at the root if not.',
          path: '/v1/team/units',
          submitLabel: 'Add unit',
          fields: [
            { name: 'name', label: 'Unit name' },
            {
              name: 'kind',
              label: 'Kind',
              type: 'select',
              options: [
                { value: 'DEPARTMENT', label: 'Department' },
                { value: 'BRANCH', label: 'Branch' },
                { value: 'TEAM', label: 'Team' },
              ],
            },
            {
              name: 'parentId',
              label: 'Parent unit',
              type: 'select',
              required: false,
              options: [{ value: '', label: '— at root —' }, ...live.map((unit) => ({ value: unit.id, label: unitPath(unit) }))],
            },
          ],
          transform: (values) => ({ name: values.name, kind: values.kind, ...(values.parentId ? { parentId: values.parentId } : {}) }),
        });
        if (done) await refresh();
      } else if (button.dataset.command === 'import') {
        const result = await command({
          title: 'Import people',
          intent:
            'One person per line: email, full name, roles, unit, manager email. Roles are separated by spaces or |; unit and ' +
            'manager are optional. Each line is admitted or refused on its own — a refused line does not stop the others.',
          path: '/v1/users/import',
          submitLabel: 'Import',
          fields: [
            {
              name: 'rows',
              label: 'Rows',
              type: 'textarea',
              placeholder: 'rider@acme.example, Riya Kaur, SUPERVISOR, Field, owner@acme.example',
              hint: `Roles: ${tenantGrantableRoles().join(', ')}.`,
            },
            {
              name: 'unitId',
              label: 'Unit for rows that name none',
              type: 'select',
              required: false,
              options: [{ value: '', label: '— none —' }, ...live.map((unit) => ({ value: unit.id, label: unitPath(unit) }))],
            },
          ],
          transform: (values) => ({
            rows: String(values.rows)
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean)
              .map((line) => {
                const [email = '', name = '', roles = '', unit = '', managerEmail = ''] = line.split(',').map((cell) => cell.trim());
                return {
                  email,
                  name,
                  roles: roles.split(/[\s|/]+/).filter(Boolean).map((role) => role.toUpperCase()),
                  ...(unit ? { unit } : {}),
                  ...(managerEmail ? { managerEmail } : {}),
                };
              }),
            ...(values.unitId ? { unitId: values.unitId } : {}),
          }),
        });
        if (result) {
          const refused = result.rows.filter((row) => row.outcome === 'REFUSED');
          toast(
            `${result.created} added, ${result.refused} refused`,
            refused.length > 0 ? refused.map((row) => `${row.email}: ${row.reason}`).join(' · ') : 'Every row was admitted.',
            refused.length > 0 ? 'warn' : 'ok',
          );
          const unsent = result.rows.filter((row) => row.outcome === 'CREATED' && row.notified !== 'SENT');
          if (unsent.length > 0) {
            toast('No email left the platform', `${unsent.length} of the people added were not emailed: this deployment has no mail server configured.`, 'warn');
          }
          await refresh();
        }
      } else if (button.dataset.command === 'membership') {
      const result = await command({
        title: 'Add somebody from another company in the group',
        intent:
          'The same person, a second membership: they keep their identity and their sign-in, take a seat here, and hold exactly the roles you name here. Nothing of their other company comes with them.',
        path: '/v1/users/memberships',
        submitLabel: 'Add',
        fields: [
          { name: 'email', label: 'Their email, as it is in the other company' },
          { name: 'roles', label: 'Roles here', type: 'multiselect', options: tenantGrantableRoles().map((role) => ({ value: role, label: humanise(role) })) },
        ],
      });
      if (result) draw();
      return;
    }
    if (button.dataset.command === 'report') {
        await api.download('/v1/team/report', {});
        toast('User report', 'Downloaded as a spreadsheet.', 'ok');
      }
    } catch (error) {
      toast('Could not do that', error.message, 'err');
    }
  });

  for (const button of root.querySelectorAll('[data-support-close]')) {
    button.addEventListener('click', async () => {
      try {
        await api.post(`/v1/team/support-access/${button.dataset.supportClose}/close`, {});
        toast('Support access ended', 'The operator’s window on this company is closed.', 'ok');
        draw();
      } catch (error) {
        toast('Could not end it', error.message, 'err');
      }
    });
  }

  root.querySelector('[data-mfa-policy]')?.addEventListener('click', async () => {
    try {
      const done = await command({
        title: 'Who must hold a second factor',
        intent:
          'Enforced at the gateway: a person this applies to who has no authenticator app is signed in to a session that can ' +
          'do nothing but enrol. Set up your own first — the platform refuses to require of others what you have not done.',
        path: '/v1/team/security-policy',
        submitLabel: 'Apply',
        fields: [
          {
            name: 'mfaRequired',
            label: 'Required of',
            type: 'select',
            value: governance.mfaRequired,
            options: [
              { value: 'OFF', label: 'Nobody — optional for everyone' },
              { value: 'ADMINISTRATORS', label: 'Administrators — enterprise admins and owners' },
              { value: 'EVERYONE', label: 'Everyone in the tenancy' },
            ],
          },
          reason('Why the requirement is changing; recorded against the decision.'),
        ],
      });
      if (done) await refresh();
    } catch (error) {
      toast('Could not change the requirement', error.message, 'err');
    }
  });

  root.querySelector('[data-structure]')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-unit-retire]');
    if (!button) return;
    try {
      const done = await command({
        title: `Retire ${button.dataset.name}`,
        intent: 'The unit leaves the structure; its people keep their records and lose the placement. A unit with live units under it is kept.',
        path: `/v1/team/units/${button.dataset.unitRetire}/retire`,
        submitLabel: 'Retire',
        fields: [reason('Why the unit is going — "merged into Operations", "branch closed".')],
      });
      if (done) await refresh();
    } catch (error) {
      toast('Could not retire the unit', error.message, 'err');
    }
  });

  root.querySelector('[data-invitations]')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-invitation-withdraw]');
    if (!button) return;
    try {
      const done = await command({
        title: `Withdraw the invitation to ${button.dataset.name}`,
        intent: 'The seat it was holding is given back. They can be invited again.',
        path: `/v1/projects/${button.dataset.project}/invitations/${button.dataset.invitationWithdraw}/withdraw`,
        submitLabel: 'Withdraw',
        fields: [reason('At least five characters.')],
      });
      if (done) await refresh();
    } catch (error) {
      toast('Could not withdraw', error.message, 'err');
    }
  });

  root.querySelector('[data-directory]')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-person-action]');
    if (!button) return;
    const userId = button.dataset.user;
    const name = button.dataset.name ?? 'this person';
    const person = byId.get(userId);
    const action = button.dataset.personAction;
    try {
      if (action === 'deactivate') {
        const done = await command({
          title: `Deactivate ${name}`,
          intent: 'Their seat is released and they can no longer sign in. Nothing is removed; every record still carries their name, and you can reactivate them at any time.',
          path: `/v1/users/${userId}/deactivate`,
          submitLabel: 'Deactivate',
          fields: [reason('Recorded against this decision — "left the company", "contract ended".')],
        });
        if (done) await refresh();
      } else if (action === 'reactivate') {
        const done = await command({
          title: `Reactivate ${name}`,
          intent: 'Gives their access back and takes a seat again. Refused if every seat is taken.',
          path: `/v1/users/${userId}/reactivate`,
          submitLabel: 'Reactivate',
          fields: [reason('Why they are coming back.')],
        });
        if (done) await refresh();
      } else if (action === 'delete') {
        const done = await command({
          title: `Delete ${name}`,
          intent:
            'Irreversible once carried out. Their name, email address and telephone number are removed after the grace period; ' +
            'the project record they took part in is kept, as the law requires, against an identity that no longer names anybody. ' +
            'The person is notified and the request can be cancelled until the date.',
          path: `/v1/users/${userId}/erasure`,
          submitLabel: 'Delete',
          fields: [reason('At least ten characters. Quote the written request or the decision this rests on.')],
        });
        if (done) {
          toast('Deletion scheduled', `${name} will be erased on ${date(done.dueAt)}.`, 'warn');
          await refresh();
        }
      } else if (action === 'cancel-erasure') {
        if (!confirm(`Keep ${name}? The scheduled deletion is cancelled and their access is restored.`)) return;
        await api.delete(`/v1/users/${userId}/erasure`);
        toast('Deletion cancelled', `${name} is restored.`, 'ok');
        await refresh();
      } else if (action === 'roles') {
        const done = await command({
          title: `Change what ${name} may do`,
          intent: 'Roles decide authority. The change is recorded against you, with the roles before and after.',
          path: `/v1/users/${userId}/roles`,
          submitLabel: 'Change roles',
          fields: [
            {
              name: 'roles',
              label: 'Roles',
              type: 'multiselect',
              value: person?.roles ?? [],
              options: tenantGrantableRoles().map((role) => ({ value: role, label: humanise(role) })),
            },
            reason('Why their authority is changing.'),
          ],
        });
        if (done) await refresh();
      } else if (action === 'place') {
        const others = people.filter((candidate) => candidate.id !== userId && candidate.state === 'ACTIVE');
        const done = await command({
          title: `Place ${name}`,
          intent: 'Which unit they belong to and who they report to. Structure, not authority — their roles are unchanged.',
          path: `/v1/users/${userId}/placement`,
          submitLabel: 'Place',
          fields: [
            {
              name: 'unitId',
              label: 'Unit',
              type: 'select',
              required: false,
              value: person?.unitId ?? '',
              options: [{ value: '', label: '— no unit —' }, ...live.map((unit) => ({ value: unit.id, label: unitPath(unit) }))],
            },
            {
              name: 'managerId',
              label: 'Reports to',
              type: 'select',
              required: false,
              value: person?.managerId ?? '',
              options: [{ value: '', label: '— nobody —' }, ...others.map((candidate) => ({ value: candidate.id, label: candidate.name }))],
            },
            { ...reason('Optional.'), required: false },
          ],
          transform: (values) => ({
            unitId: values.unitId ? values.unitId : null,
            managerId: values.managerId ? values.managerId : null,
            ...(values.reason ? { reason: values.reason } : {}),
          }),
        });
        if (done) await refresh();
      } else if (action === 'history') {
        const slot = root.querySelector('#history-slot');
        render(slot, html`<div class="metric-sub" style="margin-top:10px">Reading the record for ${name}…</div>`);
        const history = await api.get(`/v1/users/${userId}/history`);
        render(
          slot,
          html`<div style="margin-top:14px">
            <h2>What ${history.name} has done</h2>
            <p class="metric-sub" style="margin-bottom:8px">
              The last ${history.events.length} events they authored, newest first, from the hash-chained ledger.
            </p>
            ${table({
              headers: ['When', 'Event', 'Record', 'Project'],
              rows: history.events.map((event) => [
                date(event.at),
                humanise(event.eventType),
                `${humanise(event.entity.refType)} ${String(event.entity.refId).slice(-6)}`,
                event.projectId.endsWith('-governance') ? 'Governance' : event.projectId,
              ]),
              empty: 'They have not authored anything on the record yet.',
            })}
          </div>`,
        );
      }
    } catch (error) {
      toast('Could not do that', error.message, 'err');
    }
  });
}
