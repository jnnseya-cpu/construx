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
const BADGE_TONE = {
  PARTICIPANT_NO_SEAT: 'neutral',
  CONTROLLER_HOST_SEAT: 'ai',
  CONTROLLER_HOME_LICENSED: 'ok',
  CONTROLLER_GROUP_LICENSED: 'ok',
  CONTROLLER_HOST_SPONSORED: 'warn',
  CONTROLLER_LICENCE_REQUIRED: 'bad',
  CONTROLLER_LICENCE_EXPIRED: 'bad',
};
const ACTIVITY_LABEL = { ACTIVE: 'Active this week', RECENT: 'Active this month', IDLE: 'Idle', DORMANT: 'Dormant', NEVER: 'Never active' };
const ACTIVITY_TONE = { ACTIVE: 'good', RECENT: 'good', IDLE: 'warn', DORMANT: 'bad', NEVER: 'neutral' };

function administers() {
  const roles = state.session?.user?.roles ?? [];
  return roles.includes('ENTERPRISE_ADMIN') || roles.includes('OWNER');
}

export async function team(root) {
  let position;
  const [support, transfers, reporting, away, licensing] = await Promise.all([
    api.get('/v1/team/support-access').catch(() => null),
    api.get('/v1/team/transfer-cases').catch(() => null),
    api.get('/v1/company/reporting-grants').catch(() => null),
    // The home side of an invitation: this company's people on other
    // organisations' projects, and what it has been asked to pay for them.
    // Null where the reader may not see the wallet.
    api.get('/v1/users/external-projects').catch(() => null),
    // Which roles are Controllers and why, as the platform derives it.
    api.get('/v1/controller-licences/permissions').catch(() => null),
  ]);
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
  const billable = seats.billable;
  const classOf = new Map((licensing?.roles ?? []).map((entry) => [entry.role, entry.accessClass]));
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
            // A company that signed up as one company and now has others: the
            // door to becoming a group is here, where its administrator already
            // is, rather than on a Group screen the menu does not yet show.
            state.me?.group
              ? null
              : {
                  id: 'found',
                  label: 'Found a group from this company',
                  tone: '',
                  permitted: admin,
                  reason: 'Only an enterprise admin may found a group',
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

      ${billable
        ? html`<div class="card" style="margin-bottom:14px" data-billable>
            <h2>People against paid licences</h2>
            <p class="metric-sub" style="margin-bottom:12px">
              Total users are not billable seats. The package’s seats are Controller seats — the people who approve money,
              baselines and contracts, administer people or run the business. Participants take none. A Controller from
              another organisation, or from a company of this group, is licensed by them and costs nothing here. What this
              organisation pays for is its own Controllers and any Project Controller Pass it bought for a guest.
            </p>
            <div class="grid g4">
              ${raw(metric({ label: 'Total active users', value: billable.totalActiveUsers, sub: 'people who can sign in' }))}
              ${raw(metric({ label: 'Host-owned Controller seats', value: billable.hostOwnedControllerSeats, sub: `of ${seats.cap === null ? 'unlimited' : seats.cap} on the ${seats.package} package`, tone: 'good' }))}
              ${raw(metric({ label: 'Internal participants', value: billable.internalParticipants, sub: 'no seat required' }))}
              ${raw(metric({ label: 'External participants', value: billable.externalParticipants, sub: 'no seat required' }))}
              ${raw(metric({ label: 'Externally licensed Controllers', value: billable.externallyLicensedControllers, sub: 'seat held by their own organisation' }))}
              ${raw(metric({ label: 'Group-licensed Controllers', value: billable.groupLicensedControllers, sub: 'seat held in the group' }))}
              ${raw(metric({ label: 'Host-sponsored passes', value: billable.hostSponsoredPasses, sub: billable.passChargeMinor > 0 ? `${billable.passChargeMinor} a month, on the invoice` : 'none bought', tone: billable.hostSponsoredPasses > 0 ? 'warn' : '' }))}
              ${raw(metric({ label: 'Total host-billable licences', value: billable.totalHostBillableLicences, sub: billable.formula, tone: 'good' }))}
            </div>
            ${billable.controllersAwaitingLicence > 0
              ? html`<div style="margin-top:10px">${notice(`${billable.controllersAwaitingLicence} Controller${billable.controllersAwaitingLicence === 1 ? '' : 's'} from outside ${billable.controllersAwaitingLicence === 1 ? 'is' : 'are'} waiting on a licence decision. Their Controller roles are withheld and nothing is charged. Buy a pass or reduce the roles on Enterprise & Portfolio.`, 'warn')}</div>`
              : ''}
          </div>`
        : ''}

      <div class="card" style="margin-bottom:14px" data-directory>
        <h2>User directory</h2>
        <p class="metric-sub" style="margin-bottom:12px">
          Named identity, one per human. Activity and history are read from the hash-chained ledger; the second factor from the
          credential store; the risk signals from both. Every action here is recorded against whoever took it.
        </p>
        ${table({
          headers: admin ? ['Identity', 'Roles', 'Activity', 'Risk signal', 'Second factor', 'Status', ''] : ['Identity', 'Roles', 'Activity', 'Risk signal', 'Second factor', 'Status'],
          rows: people.map((person) => [
            html`<div><b>${person.name}</b>${person.external ? html` ${badge(`external · ${person.homeOrganisation ?? 'another organisation'}`, 'warn')}` : ''}</div>
              <div class="metric-sub">${person.email}${person.unitName ? ` · ${person.unitName}` : ''}${
                person.managerName ? ` · reports to ${person.managerName}` : ''
              }${person.reports > 0 ? ` · manages ${person.reports}` : ''}</div>`,
            html`${(person.roles ?? []).map((role) => badge(humanise(role), 'neutral'))}
              <div class="metric-sub">${person.accessClass === 'CONTROLLER' ? (person.external ? 'Controller · licensed elsewhere' : 'Controller · one of this package’s seats') : 'Participant · no seat'}</div>`,
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
          Every invitation this tenancy has sent, across its projects. A pending invitation to one of this organisation’s own
          Controllers holds a seat; withdrawing it gives the seat back. A participant, or a Controller from another
          organisation, holds none. Invitations are sent from a project on Enterprise &amp; Portfolio.
        </p>
        ${table({
          headers: admin ? ['Person', 'Project', 'Roles', 'Licence', 'Invited', 'Status', ''] : ['Person', 'Project', 'Roles', 'Licence', 'Invited', 'Status'],
          rows: invitations.map((invitation) => [
            html`<div><b>${invitation.name}</b></div><div class="metric-sub">${invitation.email}${invitation.organisation ? ` · ${invitation.organisation}` : ''}${invitation.external ? ' · external' : ''}</div>`,
            invitation.projectName || invitation.projectId,
            html`${(invitation.roles ?? []).map((role) => badge(humanise(role), 'neutral'))}`,
            invitation.badge ? badge(invitation.badgeLabel ?? humanise(invitation.badge), BADGE_TONE[invitation.badge] ?? 'neutral') : '—',
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

      ${away
        ? html`<div class="card" style="margin-bottom:14px" data-away>
            <h2>Our people on other organisations’ projects</h2>
            <p class="metric-sub" style="margin-bottom:12px">
              Where one of this company’s people has been invited onto another organisation’s project, their Controller seat
              here follows them and nothing is charged to the host. Their AI there is paid for by nobody until an
              administrator here approves an allowance — a monthly or project limit, and whether it may be exceeded. The host
              sees whether the allowance stands, never its size or this company’s wallet.
            </p>
            ${table({
              headers: ['Person', 'Host', 'Project', 'Roles', 'Licence', 'Ends', 'Status'],
              rows: (away.memberships ?? []).map((m) => [
                html`<div><b>${m.person.name}</b></div><div class="metric-sub">${m.person.email}</div>`,
                m.hostName,
                m.projectName,
                html`${(m.roles ?? []).map((role) => badge(humanise(role), 'neutral'))}`,
                badge(m.accessClass === 'PARTICIPANT' ? 'participant · no seat' : m.licenceSource === 'NONE' ? 'controller · licence required' : `controller · ${humanise(m.licenceSource).toLowerCase()}`, m.accessClass === 'PARTICIPANT' ? 'neutral' : m.licenceSource === 'NONE' ? 'bad' : 'ok'),
                m.expiresAt ? date(m.expiresAt) : html`<span class="metric-sub">until revoked</span>`,
                badge(m.status.toLowerCase(), m.status === 'ACTIVE' ? 'ok' : m.status === 'PENDING' ? 'warn' : 'neutral'),
              ]),
              empty: 'Nobody from this company is on another organisation’s project.',
            })}
            <h3 style="margin:14px 0 6px">AI sponsorships this company has been asked for${away.awaitingDecision ? html` ${badge(`${away.awaitingDecision} awaiting a decision`, 'warn')}` : ''}</h3>
            ${table({
              headers: admin ? ['Person', 'Host · project', 'What', 'Limit', 'Used', 'Standing', ''] : ['Person', 'Host · project', 'What', 'Limit', 'Used', 'Standing'],
              rows: (away.asSponsor ?? []).map((s) => [
                html`<div><b>${s.person.name}</b></div><div class="metric-sub">asked by ${s.requestedBy?.name ?? '—'} · ${date(s.requestedAt)}</div>`,
                `${s.hostName} · ${s.projectName}`,
                html`${humanise(s.authorisationType)}${s.workflow ? html`<div class="metric-sub">${s.workflow}</div>` : ''}<div class="metric-sub">${s.reason}</div>`,
                html`${s.maximumMinor} ACUs${s.overageAllowed ? html`<div class="metric-sub">overage allowed</div>` : ''}${s.expiresAt ? html`<div class="metric-sub">until ${date(s.expiresAt)}</div>` : ''}`,
                s.usage ? html`${s.usage.consumedMinor} used · ${s.usage.remainingMinor} left${s.usage.heldMinor ? html`<div class="metric-sub">${s.usage.heldMinor} held</div>` : ''}` : '—',
                badge(s.status.toLowerCase(), s.status === 'ACTIVE' ? 'ok' : s.status === 'PENDING' ? 'warn' : 'neutral'),
                ...(admin
                  ? [
                      html`${s.status === 'PENDING' ? html`<button class="btn sm" data-sponsorship-action="approve" data-sponsorship="${s.id}" data-name="${s.person.name}">Approve</button> <button class="btn quiet sm" data-sponsorship-action="reject" data-sponsorship="${s.id}" data-name="${s.person.name}">Decline</button>` : ''}
                        ${s.status === 'ACTIVE' ? html`<button class="btn quiet sm" data-sponsorship-action="limit" data-sponsorship="${s.id}" data-name="${s.person.name}" data-limit="${s.maximumMinor}">Change limit</button> <button class="btn quiet sm" data-sponsorship-action="usage" data-sponsorship="${s.id}" data-name="${s.person.name}">Usage</button> <button class="btn quiet danger sm" data-sponsorship-action="revoke" data-sponsorship="${s.id}" data-name="${s.person.name}">Withdraw</button>` : ''}`,
                    ]
                  : []),
              ]),
              empty: 'No organisation has asked this company to pay for anybody’s AI.',
            })}
          </div>`
        : ''}

      <div class="grid g2" style="margin-bottom:14px">
        <div class="card">
          <h2>Roles &amp; permissions</h2>
          <p class="metric-sub" style="margin-bottom:12px">
            The ${summary.rolesDefined} roles a tenancy may grant, and what each may do, as the platform publishes and enforces
            them. Least privilege by construction: a role holds nothing that is not listed, and a person holds nothing outside
            their roles. Change what somebody may do by changing their roles. A Controller role takes one of the package’s
            seats; a participant role takes none.
          </p>
          ${table({
            headers: ['Role', 'Class', 'Holders', 'Areas', 'Codes'],
            rows: roles.map((entry) => [
              humanise(entry.role),
              classOf.has(entry.role) ? badge(classOf.get(entry.role) === 'CONTROLLER' ? 'Controller' : 'Participant', classOf.get(entry.role) === 'CONTROLLER' ? 'ai' : 'neutral') : '—',
              String(entry.holders),
              String(entry.areas.length),
              html`${[...new Set(entry.areas.flatMap((area) => area.codes))].sort().map((code) => badge(code, 'neutral'))}`,
            ]),
            empty: 'No roles are published.',
          })}
          <div class="metric-sub" style="margin-top:8px">R read · C create · U update · A approve · I import/export · X run AI · G governance. The full matrix is on Permissions.</div>
          ${licensing
            ? html`<details style="margin-top:8px"><summary class="metric-sub">What makes a role a Controller</summary>
                ${table({
                  headers: ['Permission', 'On the matrix', 'Note'],
                  rows: licensing.permissions.map((p) => [p.permission, p.basis ? `${p.basis.area} · ${p.basis.codes.join('')}` : html`<span class="metric-sub">no separate entry</span>`, p.note]),
                })}
              </details>`
            : ''}
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

        ${reporting
          ? html`<div class="card" data-reporting-grants>
              <h2>What the group may read about this company</h2>
              <div class="metric-sub" style="margin:6px 0 10px">
                ${reporting.group ? html`${reporting.group} reads nothing operational about this company unless this company says so. A grant names the metrics, the group roles, the period, whether they may be exported, and until when.` : 'This company is not in a group; there is nobody to grant reporting to.'}
              </div>
              ${table({
                headers: ['Metrics', 'To', 'Period', 'Export', 'Until', ''],
                rows: (reporting.grants ?? []).map((grant) => [
                  grant.metrics.join(', '),
                  grant.roles.map((role) => humanise(role)).join(', '),
                  grant.periodFrom || grant.periodTo ? `${grant.periodFrom ? date(grant.periodFrom) : '…'} – ${grant.periodTo ? date(grant.periodTo) : '…'}` : 'any',
                  grant.exportAllowed ? 'allowed' : 'on screen only',
                  grant.revokedAt ? html`revoked ${date(grant.revokedAt)}` : grant.expiresAt ? date(grant.expiresAt) : 'until revoked',
                  !grant.revokedAt && admin ? html`<button class="btn quiet sm" data-grant-revoke="${grant.id}">Revoke</button>` : '',
                ]),
                empty: 'No reporting grant. The group sees billing figures only.',
              })}
              ${admin && reporting.group ? html`<div class="actions" style="margin-top:10px"><button class="btn quiet sm" data-grant-new>Grant the group a view</button></div>` : ''}
            </div>`
          : ''}

        ${(transfers?.cases ?? []).length
          ? html`<div class="card" data-transfer-cases>
              <h2>Group transfer</h2>
              <div class="metric-sub" style="margin:6px 0 10px">
                A move between groups changes who administers this company and nothing else: its people, records, wallet and issued
                documents stay. It needs this company’s own administrator to approve it.
              </div>
              ${table({
                headers: ['From', 'To', 'Why', 'Standing', ''],
                rows: transfers.cases.map((t) => [
                  t.fromGroupName,
                  t.toGroupName,
                  t.reason,
                  badge(t.status.toLowerCase(), t.status === 'COMPLETED' ? 'ok' : t.status === 'FAILED' ? 'bad' : 'warn'),
                  t.status === 'REVIEW' && admin && !t.approvals.some((a) => a.capacity === 'COMPANY_ADMINISTRATOR') ? html`<button class="btn sm" data-transfer-approve="${t.id}">Approve the move</button>` : t.approvals.some((a) => a.capacity === 'COMPANY_ADMINISTRATOR') ? html`<span class="metric-sub">approved by this company</span>` : '',
                ]),
              })}
            </div>`
          : ''}

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
          'The same person, a second membership: they keep their identity and their sign-in, take a seat here, and hold exactly the roles you name here — a viewer, read-only, if you name none. Nothing of their other company comes with them.',
        path: '/v1/users/memberships',
        submitLabel: 'Add',
        fields: [
          { name: 'email', label: 'Their email, as it is in the other company' },
          { name: 'roles', label: 'Roles here (viewer if none)', type: 'multiselect', required: false, options: tenantGrantableRoles().map((role) => ({ value: role, label: humanise(role) })) },
        ],
        transform: (v) => ({ email: v.email, ...(Array.isArray(v.roles) && v.roles.length ? { roles: v.roles } : typeof v.roles === 'string' && v.roles ? { roles: [v.roles] } : {}) }),
      });
      if (result) draw();
      return;
    }
    if (button.dataset.command === 'found') {
        const result = await command({
          title: 'Found a group from this company',
          intent:
            'This company becomes the first of a group of up to five, and you its group administrator. Nothing about the ' +
            'company changes — its people, records, wallet and subscription are as they were. The Group screen then appears, ' +
            'where you add the other companies, each with the administrators you name, and grant group roles to others.',
          path: '/v1/groups',
          submitLabel: 'Found the group',
          fields: [{ name: 'displayName', label: 'Group name', required: false, hint: 'Defaults to this company’s name — “JNN GLOBAL LTD” founds a group called JNN GLOBAL LTD.' }],
          transform: (v) => (v.displayName ? { displayName: v.displayName } : {}),
        });
        if (result) {
          toast(`${result.group.displayName} founded`, `${result.company.name} is its first company (cost centre ${result.company.code}); ${result.maxCompanies} companies may be held. Open Group to add the next.`, 'ok');
          await refresh();
        }
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

  root.querySelector('[data-grant-new]')?.addEventListener('click', async () => {
    const result = await command({
      title: `Grant ${reporting.group} a view of this company`,
      intent: 'Named metrics only, to the group roles you choose, over a period, exportable or not, until a date. Recorded here, revocable here; a report the group runs reads only what is granted and names the rest as withheld.',
      path: '/v1/company/reporting-grants',
      submitLabel: 'Grant',
      fields: [
        { name: 'metrics', label: 'Metrics', type: 'multiselect', options: (reporting.metrics ?? []).map((m) => ({ value: m.key, label: m.label })) },
        { name: 'roles', label: 'Group roles', type: 'multiselect', options: [{ value: 'GROUP_ADMIN', label: 'Group admin' }, { value: 'GROUP_FINANCE', label: 'Group finance' }, { value: 'GROUP_VIEWER', label: 'Group viewer' }] },
        { name: 'exportAllowed', label: 'They may export', type: 'checkbox', required: false },
        { name: 'periodFrom', label: 'Period from', type: 'date', iso: true, required: false },
        { name: 'periodTo', label: 'Period to', type: 'date', iso: true, required: false },
        { name: 'expiresAt', label: 'Until', type: 'date', iso: true, required: false },
        { name: 'note', label: 'Why', required: false },
      ],
      transform: (v) => ({
        metrics: v.metrics ?? [],
        roles: v.roles ?? [],
        exportAllowed: Boolean(v.exportAllowed),
        ...(v.periodFrom ? { periodFrom: v.periodFrom } : {}),
        ...(v.periodTo ? { periodTo: v.periodTo } : {}),
        ...(v.expiresAt ? { expiresAt: v.expiresAt } : {}),
        ...(v.note ? { note: v.note } : {}),
      }),
    });
    if (result) draw();
  });
  for (const button of root.querySelectorAll('[data-grant-revoke]')) {
    button.addEventListener('click', async () => {
      try {
        await api.post(`/v1/company/reporting-grants/${button.dataset.grantRevoke}/revoke`, {});
        toast('Grant revoked', 'Reports already run stop showing this company on their next read.', 'ok');
        draw();
      } catch (error) {
        toast('Could not revoke', error.message, 'err');
      }
    });
  }
  for (const button of root.querySelectorAll('[data-transfer-approve]')) {
    button.addEventListener('click', async () => {
      const result = await command({
        title: 'Approve the move to another group',
        intent: 'Recorded under your name as this company’s administrator. The platform operator then schedules and executes it.',
        path: `/v1/team/transfer-cases/${button.dataset.transferApprove}/approve`,
        submitLabel: 'Approve',
        fields: [],
      });
      if (result) draw();
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

  // The home organisation's decisions about its people's AI on other
  // organisations' projects: approve with a limit, decline, change the
  // limit, see what was used, withdraw.
  root.querySelector('[data-away]')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-sponsorship-action]');
    if (!button) return;
    const id = button.dataset.sponsorship;
    const name = button.dataset.name ?? 'this person';
    const action = button.dataset.sponsorshipAction;
    try {
      let done = null;
      if (action === 'approve' || action === 'limit') {
        done = await command({
          title: action === 'approve' ? `Approve paying for ${name}’s AI` : `Change the limit for ${name}`,
          intent:
            action === 'approve'
              ? 'This company’s wallet funds their AI on that project up to the limit. The host is charged nothing, and sees only that the allowance stands.'
              : 'The new limit applies from now; what was already spent stays spent.',
          path: `/v1/acu-sponsorships/${id}/approve`,
          submitLabel: action === 'approve' ? 'Approve' : 'Change the limit',
          fields: [
            { name: 'maximumMinor', label: 'Maximum ACUs', type: 'number', step: '1', value: button.dataset.limit ?? '', required: false, hint: 'Left empty, the amount asked for stands.' },
            {
              name: 'overageAllowed',
              label: 'Beyond the limit',
              type: 'select',
              options: [
                { value: 'false', label: 'Refuse — more needs a new approval' },
                { value: 'true', label: 'Allow — an estimate above the limit still runs' },
              ],
            },
            { name: 'expiresAt', label: 'Until', type: 'datetime-local', required: false },
            reason('At least five characters.'),
          ],
          transform: (f) => ({
            reason: f.reason,
            overageAllowed: String(f.overageAllowed) === 'true',
            ...(f.maximumMinor ? { maximumMinor: Number(f.maximumMinor) } : {}),
            ...(f.expiresAt ? { expiresAt: new Date(f.expiresAt).toISOString() } : {}),
          }),
        });
      } else if (action === 'reject') {
        done = await command({
          title: `Decline to pay for ${name}’s AI`,
          intent: 'Nothing runs on this company’s wallet for that project. The host may sponsor it itself.',
          path: `/v1/acu-sponsorships/${id}/reject`,
          submitLabel: 'Decline',
          fields: [reason('At least five characters.')],
        });
      } else if (action === 'revoke') {
        done = await command({
          title: `Withdraw the sponsorship for ${name}`,
          intent: 'Anything in flight on it is released; nothing further runs on this company’s wallet for that project.',
          path: `/v1/acu-sponsorships/${id}/revoke`,
          submitLabel: 'Withdraw',
          fields: [reason('At least five characters.')],
        });
      } else if (action === 'usage') {
        const usage = await api.get(`/v1/acu-sponsorships/${id}/usage`);
        toast(
          `${name}: ${usage.usage.consumedMinor} of ${usage.usage.maximumMinor} ACUs used`,
          `${usage.usage.remainingMinor} remain${usage.usage.heldMinor ? `, ${usage.usage.heldMinor} held against work in flight` : ''} · ${usage.usage.period}`,
          usage.usage.exhausted ? 'warn' : 'ok',
        );
        return;
      }
      if (done) await refresh();
    } catch (error) {
      toast('Could not do that', error.message, 'err');
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
