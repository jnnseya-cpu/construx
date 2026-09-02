import { api } from '../lib/api.js';
import { lineChart } from '../lib/charts.js';
import { axisDay, head, refusal } from '../lib/estate.js';
import { badge, html, humanise, pct, raw, render, table, time } from '../lib/ui.js';

/**
 * The event store.
 *
 * The Golden Thread is the whole platform, and until now an operator could see
 * exactly one view of it: the governance acts they were accountable for. Nothing
 * answered how big the record is, whether it is growing, which parts of the
 * catalogue are dead, or whether the durable journal agrees with the ledger it is
 * supposed to be protecting.
 *
 * **This counts and never reads.** Every figure comes from an event's type,
 * tenancy, chain and timestamp. The diff, the entity, the evidence and the actor
 * of a customer chain are not reachable from the operator layer, and that is
 * enforced at the account boundary rather than by this screen choosing not to
 * ask. The platform's own chain is the exception, and it is shown in full at the
 * bottom, because that is the record an operator is accountable for.
 *
 * The two panels worth the screen: **unused catalogue codes** — an event defined
 * and never once written is a feature nobody uses or a command nobody can reach,
 * and the catalogue invariant proves a command exists but not that anybody ran
 * it — and **durability**, where a ledger holding more than the journal means
 * writes that would not survive a restart.
 */

export async function eventstore(root) {
  const position = await api.get('/v1/admin/events').catch((error) => ({ error }));

  if (position.error) {
    render(root, html`${head({ title: 'Event store' })}${refusal('The event store', position.error)}`);
    return;
  }

  const authored = position.authorship ?? { human: 0, ai: 0, system: 0 };
  const authoredTotal = authored.human + authored.ai + authored.system;

  render(
    root,
    html`
      ${head({ title: 'Event store', intent: position.note })}

      <section class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Events</h2>
          <div class="metric">${position.total.toLocaleString('en-GB')}</div>
          <div class="metric-sub">across ${position.chains} chain${position.chains === 1 ? '' : 's'} · ${position.tenancies} tenanc${position.tenancies === 1 ? 'y' : 'ies'}</div>
        </div>
        <div class="card">
          <h2>Catalogue in use</h2>
          <div class="metric">${position.catalogue.used} / ${position.catalogue.defined}</div>
          <div class="metric-sub">${position.catalogue.unused.length} code${position.catalogue.unused.length === 1 ? '' : 's'} have never been written</div>
        </div>
        <div class="card">
          <h2>Written by a model</h2>
          <div class="metric ${raw(authored.ai > 0 ? 'ai' : '')}">${
            authoredTotal === 0 ? '—' : pct((authored.ai / authoredTotal) * 100, 1)
          }</div>
          <div class="metric-sub">${authored.ai.toLocaleString('en-GB')} of ${authoredTotal.toLocaleString('en-GB')} events</div>
        </div>
        <div class="card">
          <h2>Journal agrees</h2>
          <div class="metric ${raw(position.durability.agrees ? 'good' : 'bad')}">${position.durability.agrees ? 'yes' : 'no'}</div>
          <div class="metric-sub">
            ledger ${position.durability.ledgerEvents.toLocaleString('en-GB')} · journal
            ${position.durability.journalEvents.toLocaleString('en-GB')}
          </div>
        </div>
      </section>

      ${!position.durability.agrees
        ? html`<div class="notice ${raw(position.journal ? 'bad' : 'warn')}" style="margin-bottom:14px">
            <div><b>${position.journal ? 'The journal and the ledger disagree' : 'Nothing here survives a restart'}</b><br />
            ${position.durability.note}</div>
          </div>`
        : ''}

      <div class="grid g-2-1" style="margin-bottom:14px">
        <div class="card chart-card">
          <h2>Events written — last ${position.windowDays} days</h2>
          <div class="metric-sub" style="margin-bottom:12px">
            Every chain on the estate. A flat line at zero on a deployment with paying tenancies is the shape of
            something that has stopped working, not of a quiet week.
          </div>
          ${lineChart({
            title: 'Events written, day by day',
            data: (position.daily ?? []).map((day) => ({ label: axisDay(day.date), value: day.count })),
            series: [{ key: 'value', label: 'Events' }],
            format: (value) => String(value),
            empty: 'Nothing has been written in this window.',
          })}
        </div>
        <div class="card">
          <h2>Who wrote the record</h2>
          <div class="split-list">
            <div class="row"><span class="lbl">A person</span><span class="val">${authored.human.toLocaleString('en-GB')}</span></div>
            <div class="row"><span class="lbl">A model</span><span class="val">${authored.ai.toLocaleString('en-GB')}</span></div>
            <div class="row"><span class="lbl">The platform itself</span><span class="val">${authored.system.toLocaleString('en-GB')}</span></div>
            <div class="row">
              <span class="lbl">Carrying evidence</span>
              <span class="val">${position.evidence.withEvidence.toLocaleString('en-GB')}</span>
            </div>
            <div class="row">
              <span class="lbl">Required to carry it</span>
              <span class="val">${position.evidence.requiringEvidence.toLocaleString('en-GB')}</span>
            </div>
          </div>
          <div class="metric-sub" style="margin-top:12px">
            The split between a person and a model is the question every regulator eventually asks, and it is a property
            of the record rather than a claim about it — an event carries whether a model produced it.
          </div>
        </div>
      </div>

      <div class="grid g2" style="margin-bottom:14px">
        <div class="card pad0">
          <h2 style="padding:15px 17px 0">By lifecycle group</h2>
          ${table({
            headers: ['Group', 'Codes', 'Events'],
            align: ['', 'num', 'num'],
            rows: (position.byGroup ?? []).map((group) => [humanise(group.group), group.codes, group.count.toLocaleString('en-GB')]),
            empty: 'Nothing has been written.',
          })}
        </div>
        <div class="card pad0">
          <h2 style="padding:15px 17px 0">By tenancy</h2>
          <div class="metric-sub" style="padding:0 17px 10px">
            How much record each tenancy has built. A count, never a content.
          </div>
          ${table({
            headers: ['Tenancy', 'Chains', 'Events', 'Last written'],
            align: ['', 'num', 'num', ''],
            rows: (position.byTenant ?? []).map((tenant) => [
              tenant.legalName,
              tenant.chains,
              tenant.events.toLocaleString('en-GB'),
              tenant.lastAt ? time(tenant.lastAt) : '—',
            ]),
            empty: 'No tenancy has written anything.',
          })}
        </div>
      </div>

      ${position.catalogue.unused.length > 0
        ? html`<div class="card" style="margin-bottom:14px">
            <h2>Never written ${badge(String(position.catalogue.unused.length), 'warn')}</h2>
            <div class="metric-sub" style="margin:8px 0 12px">
              Every one of these has a command that emits it — the catalogue invariant proves that much and fails the
              build otherwise. What it cannot prove is that anybody has ever run it. A code on this list is a feature
              nobody uses, a command with no door, or a path that is genuinely rare. All three are worth knowing and
              they are not the same thing.
            </div>
            <div class="metric-sub mono" style="font-size:11px;line-height:1.9">
              ${position.catalogue.unused.join(' · ')}
            </div>
          </div>`
        : ''}

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Every event type, and how much it is used</h2>
        <div class="metric-sub" style="padding:0 17px 10px">
          The closed catalogue: ${position.catalogue.defined} codes, and nothing outside it can be committed. Tenancies
          is the column to read for adoption — one tenancy writing a code heavily is one customer's habit, not a
          feature of the platform.
        </div>
        ${table({
          headers: ['Code', 'Entity', 'Action', 'Group', 'Events', 'Tenancies', 'Last written', ''],
          align: ['', '', '', '', 'num', 'num', '', ''],
          rows: (position.byType ?? []).map((entry) => [
            html`<span class="mono" style="font-size:11px">${entry.code}</span>`,
            entry.entity,
            humanise(entry.action),
            humanise(entry.group),
            entry.count > 0 ? entry.count.toLocaleString('en-GB') : html`<span class="metric-sub">never</span>`,
            entry.tenancies || '—',
            entry.lastAt ? time(entry.lastAt) : '—',
            html`${entry.aiAllowed ? badge('AI may write', 'ai') : ''}${
              entry.requiresEvidence ? badge('evidence required', 'warn') : ''
            }`,
          ]),
        })}
      </div>

      <div class="card pad0">
        <h2 style="padding:15px 17px 0">
          The platform's own chain
          <span class="metric-sub">${position.stream?.total ?? 0} events · showing the most recent ${
            Math.min(position.stream?.limit ?? 0, position.stream?.events?.length ?? 0)
          }</span>
        </h2>
        <div class="metric-sub" style="padding:0 17px 10px">
          Governance acts only — a tenancy opened, an identity created, a seat assigned, a payment received. Restricted
          by the same list the audit screen uses, so a delivery event that ever reused one of these codes still could
          not appear here. The chain hash on each row links it to the one before: a deletion or a reordering becomes
          detectable rather than merely forbidden.
        </div>
        ${table({
          headers: ['When', 'Act', 'Entity', 'Tenancy', 'By', 'Source', 'Chain'],
          rows: (position.stream?.events ?? []).map((event) => [
            time(event.timestamp),
            humanise(event.eventType),
            event.entity,
            html`<span class="mono" style="font-size:10.5px">${String(event.tenantId).slice(-8)}</span>`,
            event.actor === 'system' ? badge('system', 'info') : event.actor,
            humanise(event.source),
            html`<span class="mono" style="font-size:10.5px;color:var(--text-3)">${
              event.chainHash ? `${event.chainHash.slice(0, 12)}…` : '—'
            }</span>`,
          ]),
          empty: 'No governance act has been recorded on this deployment.',
        })}
      </div>
    `,
  );
}
