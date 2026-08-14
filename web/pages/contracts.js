import { api, entityBundle } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { CHANGE_ORIGIN, DELAY_CAUSE, NOTICE_TYPE, today } from '../lib/enums.js';
import { badge, date, days, html, humanise, money, pct, raw, render, statusTone, table, toast } from '../lib/ui.js';
import { blockedReason, can, draw, state } from '../app.js';

/**
 * Change & Claims.
 *
 * Change is a chain, not a form: origin, notice, impact, instruction, valuation
 * and downstream effect. Because each link is a timestamped, hashed event, the
 * claim position below is arithmetic over the record rather than an argument
 * assembled afterwards.
 */

export async function contracts(root) {
  const projectId = state.session.projectId;

  const b = await entityBundle(projectId, [
    'Contract',
    'ContractClause',
    'Obligation',
    'ChangeRequest',
    'Variation',
    'DelayEvent',
    'Claim',
    'Notice',
    'ImpactAssessment',
  ]);

  const contract = b.Contract.filter((c) => c.status === 'EXECUTED').at(-1) ?? b.Contract.at(-1);
  const claim = b.Claim.at(-1);
  const attribution = claim?.attribution;

  const approvedVariations = b.Variation.filter((v) => v.status === 'AGREED');
  const openVariations = b.Variation.filter((v) => v.status !== 'AGREED' && v.status !== 'REJECTED');
  const domestic = b.Variation.filter((v) => v.isDomestic);
  const variationValue = b.Variation.reduce((sum, v) => sum + Number(v.valuedAmountMinor ?? 0), 0);

  const lateNotices = b.Notice.filter((n) => n.withinTimeBar === false);

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Change &amp; Claims</h1>
          <p>${contract ? contractLabel(contract) : 'No contract'} · every change traced from origin to downstream effect.</p>
        </div>
        <div class="actions cmd-bar">
          ${raw(commandBar([
            { id: 'change', label: 'Raise change request', tone: '', permitted: can('CHANGE_VARIATION', 'C'), reason: blockedReason('CHANGE_VARIATION', 'C') },
            { id: 'delay', label: 'Record delay event', permitted: can('CONTRACTS_CLAIMS', 'C'), reason: blockedReason('CONTRACTS_CLAIMS', 'C') },
            { id: 'notice', label: 'Serve notice', permitted: can('CONTRACTS_CLAIMS', 'C'), reason: blockedReason('CONTRACTS_CLAIMS', 'C') },
          ]))}
          ${can('CONTRACTS_CLAIMS', 'X') ? html`<button class="btn ghost" id="assess">Reassess claim</button>` : ''}
          ${can('CONTRACTS_CLAIMS', 'I') ? html`<button class="btn quiet" id="pack">Build evidence pack</button>` : ''}
        </div>
      </div>

      ${
        lateNotices.length > 0
          ? html`<div class="notice warn">
              <div><b>${lateNotices.length} notice served outside the time bar.</b><br>
              Recorded rather than hidden — the record is what supports an argument on waiver later.</div>
            </div>`
          : ''
      }

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h3>Variations</h3>
          <div class="metric orange">${b.Variation.length}</div>
          <div class="metric-sub">${approvedVariations.length} agreed · ${openVariations.length} open · ${domestic.length} domestic</div>
        </div>
        <div class="card">
          <h3>Variation value</h3>
          <div class="metric">${money(variationValue)}</div>
          <div class="metric-sub">instructed and claimed, at valuation</div>
        </div>
        <div class="card">
          <h3>Assessed entitlement</h3>
          <div class="metric warn">${claim ? days(claim.assessedDays) : '—'}</div>
          <div class="metric-sub">${claim ? `against ${days(claim.claimedDays)} claimed` : 'no claim opened'}</div>
        </div>
        <div class="card">
          <h3>Entitlement score</h3>
          <div class="metric ${raw(!claim ? '' : claim.entitlementScore >= 0.7 ? 'good' : claim.entitlementScore >= 0.4 ? 'warn' : 'bad')}">
            ${claim ? claim.entitlementScore : '—'}
          </div>
          <div class="metric-sub">contract basis · causation · evidence · procedure</div>
        </div>
      </div>

      ${
        claim
          ? html`<div class="card" style="margin-bottom:14px">
              <h3>Claim assessment</h3>
              <div class="notice ${raw(claim.entitlementScore >= 0.7 ? 'ok' : claim.entitlementScore >= 0.4 ? 'warn' : 'err')}" style="margin-bottom:14px">
                ${claim.recommendation}
              </div>
              <div class="grid g2">
                <div>
                  <h3>Strengths</h3>
                  ${
                    (claim.strengths ?? []).length === 0
                      ? html`<div class="metric-sub">None recorded.</div>`
                      : html`<div class="split-list">${claim.strengths.map((s) => html`<div class="row"><span class="st" style="color:var(--success)">✓</span><span class="lbl">${s}</span></div>`)}</div>`
                  }
                </div>
                <div>
                  <h3>Weaknesses</h3>
                  ${
                    (claim.weaknesses ?? []).length === 0
                      ? html`<div class="metric-sub">None recorded.</div>`
                      : html`<div class="split-list">${claim.weaknesses.map((w) => html`<div class="row"><span class="st" style="color:var(--critical)">✗</span><span class="lbl">${w}</span></div>`)}</div>`
                  }
                </div>
              </div>
            </div>`
          : ''
      }

      ${
        attribution
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h3 style="padding:15px 17px 0">Delay attribution — ${days(attribution.totalCriticalDelayDays)} of critical delay</h3>
              <div style="padding:0 17px 12px" class="grid g4">
                <div><div class="metric bad" style="font-size:20px">${days(attribution.employerRiskDays)}</div><div class="metric-sub">employer risk</div></div>
                <div><div class="metric" style="font-size:20px">${days(attribution.contractorRiskDays)}</div><div class="metric-sub">contractor risk</div></div>
                <div><div class="metric warn" style="font-size:20px">${days(attribution.neutralRiskDays)}</div><div class="metric-sub">neutral</div></div>
                <div><div class="metric good" style="font-size:20px">${days(attribution.compensableDays)}</div><div class="metric-sub">compensable</div></div>
              </div>
              ${table({
                headers: ['Event', 'Cause', 'Responsibility', 'Critical', 'Entitlement', 'Compensable', 'Evidence', 'Notes'],
                align: ['mono', '', '', 'num', 'num', 'num', 'num', ''],
                rows: (attribution.perEvent ?? []).map((e) => [
                  e.eventId.slice(-6),
                  humanise(e.cause),
                  badge(e.responsibility, e.responsibility === 'EMPLOYER' ? 'bad' : e.responsibility === 'CONTRACTOR' ? 'neutral' : 'warn'),
                  days(e.criticalDelayDays),
                  days(e.entitlementDays),
                  days(e.compensableDays),
                  pct(e.evidenceStrength * 100, 0),
                  (e.notes ?? []).join('; ') || '—',
                ]),
              })}
              ${
                (attribution.concurrency ?? []).length > 0
                  ? html`<div style="padding:12px 17px 16px">
                      <div class="notice info" style="margin:0">
                        <div><b>${attribution.concurrency.length} concurrency finding${attribution.concurrency.length === 1 ? '' : 's'}</b><br>
                        ${attribution.concurrency.map((c) => `${c.overlapDays}d — ${c.rationale}`).join(' · ')}</div>
                      </div>
                    </div>`
                  : ''
              }
            </div>`
          : ''
      }

      <div class="grid g2" style="margin-bottom:14px">
        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Variation register</h3>
          ${table({
            headers: ['Ref', 'Origin', 'Value', 'Time', 'Status'],
            align: ['', '', 'num', 'num', ''],
            rows: b.Variation.map((v) => [
              html`${v.reference}${v.isDomestic ? html` ${badge('domestic', 'warn')}` : ''}${v.earlyWarning ? html` ${badge('early warning', 'bad')}` : ''}`,
              humanise(v.origin),
              money(v.valuedAmountMinor),
              days(v.timeImpactDays ?? 0),
              badge(humanise(v.status), statusTone(v.status)),
            ]),
            empty: 'No variations',
          })}
        </div>

        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Notices served</h3>
          ${table({
            headers: ['Ref', 'Type', 'Served on', 'Elapsed', 'Time bar'],
            align: ['', '', '', 'num', ''],
            rows: b.Notice.map((n) => [
              n.reference,
              humanise(n.type),
              n.servedTo,
              `${n.daysElapsed}d / ${n.timeBarDays}d`,
              n.withinTimeBar ? badge('in time', 'ok') : badge('late', 'bad'),
            ]),
            empty: 'No notices served',
          })}
        </div>
      </div>

      <div class="grid g2">
        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Obligation register — time-barred</h3>
          ${table({
            headers: ['Category', 'Time bar', 'Owner', 'Status'],
            align: ['', 'num', '', ''],
            rows: b.Obligation.map((o) => [humanise(o.category), `${o.timeBarDays}d`, o.owner, badge(humanise(o.status), statusTone(o.status))]),
            empty: 'No obligations extracted',
          })}
        </div>

        <div class="card">
          <h3>Contract terms</h3>
          ${
            contract
              ? html`<div class="split-list">
                  <div class="row"><span class="lbl">Contract sum</span><span class="val">${money(contract.contractSumMinor)}</span></div>
                  <div class="row"><span class="lbl">LDs per day</span><span class="val">${money(contract.liquidatedDamagesPerDayMinor)}</span></div>
                  <div class="row"><span class="lbl">LD cap</span><span class="val">${money(contract.ldCapMinor)} (${pct(contract.ldCapPercent, 0)})</span></div>
                  <div class="row"><span class="lbl">Retention</span><span class="val">${pct(contract.retentionPercent, 0)}</span></div>
                  <div class="row"><span class="lbl">Defects liability</span><span class="val">${contract.defectsLiabilityMonths} months</span></div>
                  <div class="row"><span class="lbl">Clauses extracted</span><span class="val">${b.ContractClause.length}</span></div>
                </div>
                ${
                  (contract.carriedQualifications ?? []).length > 0
                    ? html`<div class="metric-sub" style="margin-top:11px">
                        Carried from the bid: ${contract.carriedQualifications.join(' · ')}
                      </div>`
                    : ''
                }`
              : html`<div class="empty"><b>No contract</b></div>`
          }
        </div>
      </div>
    `,
  );

  document.getElementById('assess')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Assessing…';
    try {
      const result = await api.post(`/v1/projects/${state.session.projectId}/claims`, {
        contractId: contract._refId,
        claimType: 'EOT',
        claimedDays: 33,
        claimedAmountMinor: 61_050_000,
        dailyProlongationMinor: 1_850_000,
      });
      toast('Claim assessed', `${result.assessment.assessedDays}d supportable · score ${result.assessment.entitlementScore}`, 'ok');
      await contracts(root);
    } catch (error) {
      toast('Assessment failed', error.message, 'err');
      button.disabled = false;
      button.textContent = 'Reassess claim';
    }
  });

  document.getElementById('pack')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (!claim) {
      toast('No claim', 'Assess a claim before building an evidence pack', 'err');
      return;
    }
    button.disabled = true;
    button.textContent = 'Building…';
    try {
      const result = await api.post(`/v1/projects/${state.session.projectId}/claims/${claim._refId}/evidence-pack`, {
        from: '1970-01-01T00:00:00.000Z',
        to: new Date().toISOString(),
        audience: 'ADJUDICATOR',
      });
      toast('Evidence pack built', `${result.eventCount} events · hash ${result.packHash.slice(7, 19)}…`, 'ok');
    } catch (error) {
      toast('Could not build pack', error.message, 'err');
    }
    button.disabled = false;
    button.textContent = 'Build evidence pack';
  });
}

/**
 * Contracts carry a suite and a form, and the form is often written to include
 * the suite ("NEC4 ECC Option C"). Both are valid entries, so the label is
 * composed rather than concatenated.
 */
function contractLabel(contract) {
  const suite = String(contract.suite ?? '').trim();
  const form = String(contract.form ?? '').trim();
  if (!form) return suite || 'Contract';
  return form.startsWith(suite) ? form : `${suite} ${form}`.trim();

  const COMMANDS = {
    change: {
      title: 'Raise change request',
      intent: 'Origin and notice type are the start of the chain a claim is later argued from. Both are recorded now, not reconstructed later.',
      path: `/v1/projects/${projectId}/changes`,
      submitLabel: 'Raise',
      fields: [
        { name: 'description', label: 'What has changed', type: 'textarea' },
        { name: 'origin', label: 'Origin', type: 'select', options: CHANGE_ORIGIN },
        { name: 'noticeType', label: 'Notice type', type: 'select', options: NOTICE_TYPE },
        { name: 'reason', label: 'Why it is a change', type: 'textarea' },
        { name: 'supportingEvidenceHash', label: 'Supporting evidence', type: 'file' },
      ],
      transform: (v) => ({ ...v, impactedPackageIds: [], affectedSubcontractIds: [] }),
    },
    delay: {
      title: 'Record delay event',
      intent: 'Serve the notice before the time bar. An unserved notice is recorded as unserved — the platform will not pretend otherwise.',
      path: `/v1/projects/${projectId}/delay-events`,
      submitLabel: 'Record',
      fields: [
        { name: 'cause', label: 'Cause', type: 'select', options: DELAY_CAUSE },
        { name: 'description', label: 'What happened', type: 'textarea' },
        { name: 'start', label: 'Start', type: 'date', value: today() },
        { name: 'end', label: 'End', type: 'date', value: today() },
        { name: 'criticalDelayDays', label: 'Critical delay (days)', type: 'number', min: 0 },
        { name: 'noticeDate', label: 'Notice served on', type: 'date', required: false, hint: 'Leave blank if no notice has been served' },
        { name: 'evidenceHash', label: 'Evidence', type: 'file' },
      ],
      transform: (v) => ({
        cause: v.cause,
        description: v.description,
        start: v.start,
        end: v.end,
        criticalDelayDays: v.criticalDelayDays,
        affectedTaskIds: [],
        noticeServed: Boolean(v.noticeDate),
        noticeDate: v.noticeDate,
        evidenceHashes: [v.evidenceHash],
      }),
    },
    notice: {
      title: 'Serve contractual notice',
      intent: 'The platform checks the notice against the contract time bar and records whether it was in time. It does not refuse a late notice — it records that it was late.',
      path: `/v1/projects/${projectId}/notices`,
      submitLabel: 'Serve',
      fields: [
        { name: 'noticeType', label: 'Notice type', type: 'select', options: NOTICE_TYPE },
        { name: 'subject', label: 'Subject', type: 'text' },
        { name: 'body', label: 'Notice', type: 'textarea', rows: 4 },
        { name: 'servedDate', label: 'Served on', type: 'date', value: today() },
        { name: 'triggerDate', label: 'Trigger event date', type: 'date', hint: 'The date the time bar runs from' },
      ],
    },
  };

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const spec = COMMANDS[button.dataset.command];
    if (!spec) return;
    if (await command(spec)) await draw();
  });
}
