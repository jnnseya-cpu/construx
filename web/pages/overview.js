import { api, entityBundle, isWithheld } from '../lib/api.js';
import { badge, date, days, html, money, pct, raw, render, statusTone, table, time, humanise } from '../lib/ui.js';
import { state } from '../app.js';

/**
 * Project Command Centre.
 *
 * The one screen that answers "where is this project, and what should worry
 * me". Everything on it is read from materialised Golden Thread state — there
 * is no separate reporting store that can drift from the record.
 */

const PHASES = ['CONCEPT', 'DESIGN', 'TENDER', 'CONSTRUCTION', 'COMMISSIONING', 'HANDOVER', 'OPERATIONS'];

export async function overview(root) {
  const projectId = state.session.projectId;

  const [briefing, bundle, events] = await Promise.all([
    // The greeting uses the signed-in person's own name. A briefing addressed
    // to nobody reads like a report; addressed to somebody it reads like a
    // handover, which is what it is.
    api.get(`/v1/briefing?name=${encodeURIComponent((state.session.user?.name ?? '').split(' ')[0] ?? '')}`).catch(() => null),
    entityBundle(projectId, [
      'CVR',
      'EarnedValueSnapshot',
      'ProgrammeBaseline',
      'DelayRiskSnapshot',
      'RiskRegisterItem',
      'Variation',
      'Claim',
      'SafetyForecast',
      'Clash',
      'Defect',
    ]),
    api.get(`/v1/projects/${projectId}/audit/events`),
  ]);

  const project = state.project;
  const cvr = bundle.CVR.at(-1);
  const evm = bundle.EarnedValueSnapshot.at(-1);
  const delay = bundle.DelayRiskSnapshot.at(-1);
  const claim = bundle.Claim.at(-1);
  const safety = bundle.SafetyForecast.at(-1);
  const baseline = bundle.ProgrammeBaseline.filter((b) => b.status === 'APPROVED').at(-1);
  const openRisks = bundle.RiskRegisterItem.filter((r) => r.status === 'OPEN');
  const currentIndex = PHASES.indexOf(project.phase);

  // Exceptions first: this is what a project manager opens the screen for.
  const exceptions = [];
  if (cvr) {
    for (const alert of cvr.alerts ?? []) exceptions.push({ tone: 'bad', area: 'Commercial', text: alert });
  }
  if (delay && delay.expectedDelayDays > 0) {
    exceptions.push({
      tone: delay.severity === 'CRITICAL' ? 'bad' : 'warn',
      area: 'Programme',
      text: `${days(delay.expectedDelayDays)} of forecast delay (${delay.severity}). Cheapest recovery: ${delay.correctiveMeasures?.[0]?.measure ?? 'none costed'}.`,
    });
  }
  if (claim && claim.entitlementScore !== undefined) {
    exceptions.push({
      tone: 'warn',
      area: 'Claims',
      text: `${days(claim.claimedDays)} claimed against ${days(claim.assessedDays)} assessed as supportable.`,
    });
  }
  if (safety && safety.severity !== 'LOW') {
    exceptions.push({ tone: 'warn', area: 'Safety', text: `Safety risk index ${safety.riskIndex} (${safety.severity}).` });
  }
  const openClashes = bundle.Clash.filter((c) => c.status === 'OPEN' && c.severity === 'CRITICAL');
  if (openClashes.length > 0) {
    exceptions.push({ tone: 'warn', area: 'Design', text: `${openClashes.length} critical clash(es) unresolved.` });
  }

  const aiEvents = events.events.filter((e) => e.actor.refType === 'AI').length;

  // "Nothing outstanding" is only true if the reader could have seen an
  // exception in the first place.
  const exceptionSourcesWithheld = ['CVR', 'Claim', 'DelayRiskSnapshot', 'SafetyForecast', 'Clash'].some(isWithheld);

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>${project.name}</h1>
          <p>${humanise(project.sectorType)} · ${project.assetType} · ${project.location.city}, ${project.location.countryCode}</p>
        </div>
        <div class="actions">
          <button class="btn ghost" data-nav="copilot">Ask the copilot</button>
          <button class="btn" data-nav="audit">Verify the record</button>
        </div>
      </div>

      ${
        briefing
          ? html`
            <div class="card" style="margin-bottom:14px">
              <h3>${briefing.greeting} ${badge(briefing.asAt, '')}</h3>
              <p style="font-size:13px;color:var(--text-2);margin:2px 0 13px">${briefing.headline}</p>

              <div class="grid g4" style="margin-bottom:13px">
                <div>
                  <div class="metric">${briefing.market.detected}</div>
                  <div class="metric-sub">opportunities screened, ${briefing.market.rejected} rejected before anybody read them</div>
                </div>
                <div>
                  <div class="metric orange">${briefing.market.recommended.length}</div>
                  <div class="metric-sub">recommended to bid</div>
                </div>
                <div>
                  <div class="metric ${raw(briefing.money.marginErosionMinor > 0 ? 'bad' : 'good')}">${money(briefing.money.marginErosionMinor)}</div>
                  <div class="metric-sub">margin gone since tender, across every job</div>
                </div>
                <div>
                  <div class="metric ${raw(briefing.delivery.worstDelayDays > 0 ? 'warn' : 'good')}">${days(briefing.delivery.worstDelayDays)}</div>
                  <div class="metric-sub">worst forecast delay${briefing.delivery.worstDelayProject ? ` — ${briefing.delivery.worstDelayProject}` : ''}</div>
                </div>
              </div>

              ${
                briefing.market.recommended.length > 0
                  ? html`<div class="split-list" style="margin-bottom:13px">
                      ${briefing.market.recommended.map(
                        (b) => html`<div class="row">
                          <span class="lbl">${b.title} — ${b.region} — ${b.daysToDeadline}d left</span>
                          <span class="val">${money(b.valueMinor)} · ${b.score}%</span>
                        </div>`,
                      )}
                    </div>`
                  : ''
              }

              ${
                briefing.actions.length === 0
                  ? html`<div class="empty"><b>Nothing needs a decision today</b>That is a real answer, not an empty screen.</div>`
                  : table({
                      headers: ['', 'Do this', 'Because', 'By'],
                      align: ['', '', '', ''],
                      rows: briefing.actions.map((a) => [
                        badge(a.severity, a.severity === 'URGENT' ? 'bad' : a.severity === 'ATTENTION' ? 'warn' : ''),
                        a.action,
                        html`<span style="font-size:12px;color:var(--text-3)">${a.because}</span>`,
                        a.dueBy ? date(a.dueBy) : '—',
                      ]),
                    })
              }

              <div class="split-list" style="margin-top:11px">
                ${briefing.fleet.map(
                  (f) => html`<div class="row">
                    <span class="lbl">${f.label}</span>
                    <span class="val">${f.agents} agent${f.agents === 1 ? '' : 's'}${f.openFindings > 0 ? ` · ${f.openFindings} open` : ''}</span>
                  </div>`,
                )}
              </div>
            </div>`
          : ''
      }

      <div class="card" style="margin-bottom:14px">
        <h3>Lifecycle</h3>
        <div class="rail">
          ${PHASES.map(
            (phase, i) =>
              html`<div class="${raw(i < currentIndex ? 'done' : i === currentIndex ? 'current' : '')}">${humanise(phase)}</div>`,
          )}
        </div>
      </div>

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h3>Contract value</h3>
          <div class="metric orange">${money(project.contractValueMinor, project.currency)}</div>
          <div class="metric-sub">${date(project.plannedStart)} → ${date(project.plannedCompletion)}</div>
        </div>
        <div class="card">
          <h3>Forecast margin</h3>
          <div class="metric ${raw(!cvr ? '' : cvr.forecastMarginPercent < 0 ? 'bad' : cvr.marginErosionPercent > 2 ? 'warn' : 'good')}">
            ${cvr ? pct(cvr.forecastMarginPercent, 2) : '—'}
          </div>
          <div class="metric-sub">
            ${
              cvr
                ? `${cvr.marginErosionPercent > 0 ? 'eroded' : 'ahead'} ${Math.abs(cvr.marginErosionPercent).toFixed(2)} pts vs tender`
                : isWithheld('CVR')
                  ? 'commercial position is not visible to your role'
                  : 'no CVR published'
            }
          </div>
        </div>
        <div class="card">
          <h3>Delay exposure</h3>
          <div class="metric ${raw(!delay ? '' : delay.severity === 'CRITICAL' ? 'bad' : delay.severity === 'LOW' ? 'good' : 'warn')}">
            ${delay ? days(delay.expectedDelayDays) : '—'}
          </div>
          <div class="metric-sub">${delay ? `P80 ${days(delay.p80DelayDays)} · ${delay.severity}` : 'not forecast'}</div>
        </div>
        <div class="card">
          <h3>Golden Thread</h3>
          <div class="metric">${events.events.length}</div>
          <div class="metric-sub">${aiEvents} AI-authored · none editable</div>
        </div>
      </div>

      <div class="grid g-2-1" style="margin-bottom:14px">
        <div class="card">
          <h3>Requires attention</h3>
          ${
            exceptions.length === 0
              ? html`<div class="empty">
                  <b>${exceptionSourcesWithheld ? 'Nothing outstanding that you can see' : 'Nothing outstanding'}</b>
                  ${
                    exceptionSourcesWithheld
                      ? 'Commercial and contractual records are withheld from your role, so exceptions raised against them are not shown here.'
                      : 'No commercial, programme or safety exception is currently raised.'
                  }
                </div>`
              : html`<div class="split-list">
                  ${exceptions.map(
                    (item) => html`<div class="row">
                      ${badge(item.area, item.tone === 'bad' ? 'bad' : 'warn')}
                      <span class="lbl">${item.text}</span>
                    </div>`,
                  )}
                </div>`
          }
        </div>

        <div class="card">
          <h3>Phase gate — ${humanise(project.phase)}</h3>
          ${
            (state.gate?.criteria ?? []).length === 0
              ? html`<div class="empty"><b>Final phase</b>No exit gate applies.</div>`
              : html`${state.gate.criteria.map(
                  (c) => html`<div class="gate-row">
                    <span class="st ${raw(c.satisfied ? 'ok' : 'no')}">${c.satisfied ? '✓' : '✗'}</span>
                    <span>${c.description}</span>
                    <span class="ct">${c.found}/${c.required}</span>
                  </div>`,
                )}
                <div style="margin-top:11px">
                  ${state.gate.passed
                    ? badge(`Gate passed — may advance to ${humanise(state.gate.nextPhase ?? '')}`, 'ok')
                    : badge('Gate not met — cannot advance', 'bad')}
                </div>`
          }
        </div>
      </div>

      <div class="grid g2" style="margin-bottom:14px">
        <div class="card">
          <h3>Programme</h3>
          <div class="split-list">
            <div class="row"><span class="lbl">Approved baseline</span><span class="val">${baseline?.version ?? '—'}</span></div>
            <div class="row"><span class="lbl">Baseline duration</span><span class="val">${baseline ? days(baseline.durationDays) : '—'}</span></div>
            <div class="row"><span class="lbl">Critical activities</span><span class="val">${baseline?.criticalPathTaskIds?.length ?? '—'}</span></div>
            <div class="row"><span class="lbl">Contractual completion</span><span class="val">${date(baseline?.contractualCompletionDate)}</span></div>
          </div>
        </div>
        <div class="card">
          <h3>Commercial position</h3>
          <div class="split-list">
            <div class="row"><span class="lbl">Forecast final value</span><span class="val">${cvr ? money(cvr.forecastFinalValueMinor) : '—'}</span></div>
            <div class="row"><span class="lbl">Forecast final cost</span><span class="val">${cvr ? money(cvr.forecastFinalCostMinor) : '—'}</span></div>
            <div class="row"><span class="lbl">CPI / SPI${evm?.period ? ` · ${evm.period}` : ''}</span><span class="val">${evm ? `${evm.costPerformanceIndex} / ${evm.schedulePerformanceIndex}` : '—'}</span></div>
            <div class="row"><span class="lbl">Unapproved exposure</span><span class="val">${cvr ? money(cvr.unapprovedExposureMinor) : '—'}</span></div>
          </div>
        </div>
      </div>

      <div class="grid g2">
        <div class="card">
          <h3>Open risk register</h3>
          ${table({
            headers: ['Risk', 'Category', 'Severity', 'Expected'],
            align: ['', '', '', 'num'],
            rows: openRisks
              .slice(0, 6)
              .map((r) => [r.title, humanise(r.category), badge(r.severity, statusTone(r.severity)), money(r.expectedCostMinor)]),
            empty: 'No open risks',
          })}
        </div>
        <div class="card">
          <h3>Latest Golden Thread activity</h3>
          ${events.events
            .slice(-8)
            .reverse()
            .map(
              (e) => html`<div class="ev">
                <time>${time(e.timestamp)}</time>
                <div class="t"><b>${e.eventType}</b> <span>${e.entity.refType}</span></div>
                ${badge(e.actor.refType === 'AI' ? 'AI' : e.actor.refType === 'System' ? 'SYS' : 'USER', e.actor.refType === 'AI' ? 'ai' : 'neutral')}
              </div>`,
            )}
        </div>
      </div>
    `,
  );
}
