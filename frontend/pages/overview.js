import { api, entityBundle, isWithheld } from '../lib/api.js';
import { badge, date, days, drillable, html, humanise, metric, money, pct, raw, render, statusTone, table, time, track } from '../lib/ui.js';
import { insightPanel } from '../lib/insight.js';
import { barChart, boxPlot, lineChart, pieChart, scatterPlot, radarChart } from '../lib/charts.js';
import { can, draw, state } from '../app.js';
import { sectorLabel } from '../lib/enums.js';

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

  const [briefing, bundle, events, commercial, riba] = await Promise.all([
    // The greeting uses the signed-in person's own name. A briefing addressed
    // to nobody reads like a report; addressed to somebody it reads like a
    // handover, which is what it is.
    // The briefing reads across the whole tenancy and authorises on
    // BUSINESS_DEVELOPMENT, which a planner, a supervisor or a BIM lead does not
    // hold. Fourteen identities were asking for it on every sign-in and eleven
    // were being refused — correctly, and noisily. The matrix already says who
    // may read it; the ones who may not are not asked on their behalf.
    can('BUSINESS_DEVELOPMENT', 'R')
      ? api.get(`/v1/briefing?name=${encodeURIComponent((state.session.user?.name ?? '').split(' ')[0] ?? '')}`).catch(() => null)
      : Promise.resolve(null),
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
    // The commercial position as one read. Null where the reader is not cleared
    // for Commercial-L3 — a denial is shown as a denial, never as zero.
    can('BUDGET_COST', 'R') ? api.get(`/v1/projects/${projectId}/commercial-overview`).catch(() => null) : Promise.resolve(null),
    // Where the project is in RIBA Plan of Work terms. Derived from the same
    // phase and the same design maturity assessment the gate reads, never
    // stored — see `domain/standards.ts` for why a second stage number beside
    // the lifecycle would be a second answer.
    api.get(`/v1/projects/${projectId}/riba-stages`).catch(() => null),
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

  // The records behind each figure.
  //
  // The Golden Thread tile is the exception and is deliberately not drillable:
  // it counts every event on the project, so its "sources" would be the whole
  // ledger. That is the audit trail, which has a screen of its own, and putting
  // a modal of 325 rows behind a tile would be worse than the link.
  // The contract value is a field on the Project record, so that is what the
  // tile drills to. Naming the Contract records as well would be a guess: this
  // page does not load them and cannot say which one the figure came from.
  const contractSources = [{ refType: 'Project', refId: projectId }];
  const marginSources = isWithheld('CVR') ? [] : bundle.CVR.map((c) => ({ refType: 'CVR', refId: c._refId }));
  const delaySources = bundle.DelayRiskSnapshot.map((d) => ({ refType: 'DelayRiskSnapshot', refId: d._refId }));
  const threadSources = [];

  // "Nothing outstanding" is only true if the reader could have seen an
  // exception in the first place.
  const exceptionSourcesWithheld = ['CVR', 'Claim', 'DelayRiskSnapshot', 'SafetyForecast', 'Clash'].some(isWithheld);

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>${project.name}</h1>
          <p>${sectorLabel(project.sectorType)} · ${project.assetType} · ${project.location.city}, ${project.location.countryCode}</p>
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
              <h2>${briefing.greeting} ${badge(briefing.asAt, '')}</h2>
              <p style="font-size:13px;color:var(--text-2);margin:2px 0 13px">${briefing.headline}</p>

              <!--
                Label first, then the figure. A bare "49d" means nothing until
                you have been told what it counts, and a caption underneath asks the
                reader to hold a number they cannot yet interpret.

                Only two of these carry colour, and both earn it: money lost and
                days late are conditions somebody has to act on. The count of
                opportunities recommended is a count — it used to be painted in
                Signal Orange, which is the colour this palette reserves for
                things that carry meaning, and spending it on a neutral figure
                is how the accent stops meaning anything.
              -->
              <div class="figure-strip">
                <div>
                  <div class="fig-k">Screened</div>
                  <div class="metric">${briefing.market.detected}</div>
                  <div class="metric-sub">${briefing.market.rejected} rejected before anybody read them</div>
                </div>
                <div>
                  <div class="fig-k">Recommended to bid</div>
                  <div class="metric">${briefing.market.recommended.length}</div>
                  <div class="metric-sub">of those screened</div>
                </div>
                <div>
                  <div class="fig-k">Margin gone since tender</div>
                  <div class="metric ${raw(briefing.money.marginErosionMinor > 0 ? 'bad' : 'good')}">${money(briefing.money.marginErosionMinor)}</div>
                  <div class="metric-sub">across every job</div>
                </div>
                <div>
                  <div class="fig-k">Worst forecast delay</div>
                  <div class="metric ${raw(briefing.delivery.worstDelayDays > 0 ? 'warn' : 'good')}">${days(briefing.delivery.worstDelayDays)}</div>
                  <div class="metric-sub">${briefing.delivery.worstDelayProject ? briefing.delivery.worstDelayProject : 'nothing forecast late'}</div>
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
        <h2>Lifecycle</h2>
        <div class="rail">
          ${PHASES.map(
            (phase, i) =>
              html`<div class="${raw(i < currentIndex ? 'done' : i === currentIndex ? 'current' : '')}">${humanise(phase)}</div>`,
          )}
        </div>
        ${ribaRibbon(riba)}
      </div>

      <div class="grid g4" style="margin-bottom:14px">
        <div ${raw(drillable('Contract value', contractSources))}>
          <h2>Contract value</h2>
          <div class="metric orange">${money(project.contractValueMinor, project.currency)}</div>
          <div class="metric-sub">${date(project.plannedStart)} → ${date(project.plannedCompletion)}</div>
        </div>
        <div ${raw(drillable('Forecast margin', marginSources))}>
          <h2>Forecast margin</h2>
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
          ${
            // Target, actual and variance, which is what makes the number a
            // decision rather than a reading. The target here is a real one —
            // the margin tendered — not a figure invented to fill the slot.
            cvr
              ? html`<div class="kpi-band ${raw(cvr.marginErosionPercent > 0 ? 'warn' : 'ok')}">
                  <span aria-hidden="true">${raw(cvr.marginErosionPercent > 0 ? '▲' : '●')}</span>
                  ${cvr.marginErosionPercent > 0 ? 'Below tender' : 'At or above tender'} · target
                  ${pct(cvr.forecastMarginPercent + cvr.marginErosionPercent, 2)}
                </div>`
              : ''
          }
        </div>
        <div ${raw(drillable('Delay exposure', delaySources))}>
          <h2>Delay exposure</h2>
          <div class="metric ${raw(!delay ? '' : delay.severity === 'CRITICAL' ? 'bad' : delay.severity === 'LOW' ? 'good' : 'warn')}">
            ${delay ? days(delay.expectedDelayDays) : '—'}
          </div>
          <div class="metric-sub">${delay ? `P80 ${days(delay.p80DelayDays)} · ${delay.severity}` : 'not forecast'}</div>
          ${
            // The target for delay is nought. Stated rather than implied,
            // because "48 days" with no target beside it reads as a fact when
            // it is a variance.
            delay
              ? html`<div class="kpi-band ${raw(delay.expectedDelayDays > 0 ? 'warn' : 'ok')}">
                  <span aria-hidden="true">${raw(delay.expectedDelayDays > 0 ? '▲' : '●')}</span>
                  ${delay.expectedDelayDays > 0 ? 'Behind' : 'On programme'} · target 0d
                </div>`
              : ''
          }
        </div>
        <div ${raw(drillable('Golden Thread', threadSources))}>
          <h2>Golden Thread</h2>
          <div class="metric">${events.events.length}</div>
          <div class="metric-sub">${aiEvents} AI-authored · none editable</div>
        </div>
      </div>

      <div id="overview-insight" style="margin-bottom:14px"></div>

      <div class="grid g-2-1" style="margin-bottom:14px">
        <div class="card">
          <h2>Requires attention</h2>
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
          <h2>Phase gate — ${humanise(project.phase)}</h2>
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
          <h2>Programme</h2>
          <div class="split-list">
            <div class="row"><span class="lbl">Approved baseline</span><span class="val">${baseline?.version ?? '—'}</span></div>
            <div class="row"><span class="lbl">Baseline duration</span><span class="val">${baseline ? days(baseline.durationDays) : '—'}</span></div>
            <div class="row"><span class="lbl">Critical activities</span><span class="val">${baseline?.criticalPathTaskIds?.length ?? '—'}</span></div>
            <div class="row"><span class="lbl">Contractual completion</span><span class="val">${date(baseline?.contractualCompletionDate)}</span></div>
          </div>
        </div>
        <div class="card">
          <h2>Commercial position</h2>
          <div class="split-list">
            <div class="row"><span class="lbl">Forecast final value</span><span class="val">${cvr ? money(cvr.forecastFinalValueMinor) : '—'}</span></div>
            <div class="row"><span class="lbl">Forecast final cost</span><span class="val">${cvr ? money(cvr.forecastFinalCostMinor) : '—'}</span></div>
            <div class="row"><span class="lbl">CPI / SPI${evm?.period ? ` · ${evm.period}` : ''}</span><span class="val">${evm ? `${evm.costPerformanceIndex} / ${evm.schedulePerformanceIndex}` : '—'}</span></div>
            <div class="row"><span class="lbl">Unapproved exposure</span><span class="val">${cvr ? money(cvr.unapprovedExposureMinor) : '—'}</span></div>
          </div>
        </div>
      </div>

      ${commercialBand(commercial)}

      ${projectCharts(bundle, commercial)}

      <div class="grid g2">
        <div class="card">
          <h2>Open risk register</h2>
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
          <h2>Latest Golden Thread activity</h2>
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

  // The command centre's own panel. It carries the widest scope of any screen
  // because the question it answers is "what needs me today" across the whole
  // project rather than within one discipline — but it is still the server that
  // narrows it, and still only what the reader's roles may decide.
  void insightPanel(root.querySelector('#overview-insight'), {
    projectId,
    areas: [
      'PROJECT_SETUP',
      'PROGRAMME_BASELINES',
      'BUDGET_COST',
      'CONTRACTS_CLAIMS',
      'CHANGE_VARIATION',
      'RISK_REGISTER',
      'SAFETY_RAMS',
      'FIELD_EXECUTION',
      'DESIGN_INFORMATION',
      'PROCUREMENT_AWARD',
      'PAYMENT_APPLICATIONS',
      'QUALITY_COMMISSIONING',
      'HANDOVER_OM',
    ],
    subject: 'this project',
    onChange: draw,
  });
}

/**
 * The commercial band: six headline figures, cost against value, and where the
 * money sits.
 *
 * Every figure comes from `GET /v1/projects/:id/commercial-overview`, which
 * composes records that already exist and computes nothing of its own. Nothing
 * here is derived in the browser — settled decision 6 applied to money, and the
 * reason a margin on this screen is the same margin the CVR published.
 *
 * A missing record reads as missing. `absent` names the record that would carry
 * the figure, because "£0 forecast final cost" on a project nobody has forecast
 * looks like an answer and is not one.
 */
function commercialBand(commercial) {
  if (!commercial) return '';
  const cur = commercial.header.currency;
  // Through the design system's own `metric`, not hand-rolled markup. The
  // progress track goes in `sub`, which is the slot it already has, so the six
  // tiles are the same component every other headline figure on the platform
  // uses and pick up any change to it.
  const tile = (item) =>
    raw(
      metric({
        label: item.label,
        value: item.amountMinor === null ? '—' : money(item.amountMinor, cur),
        tone: item.key === 'exposure' && item.percent !== null && item.percent > 5 ? 'warn' : '',
        sub: item.absent
          ? item.absent
          : item.percent === null
            ? ''
            : html`${item.percent}% of ${item.percentOf}
                ${track(item.percent, item.key === 'exposure' ? 'warn' : item.key === 'forecastMargin' ? 'ok' : '')}`,
      }),
    );

  const curve = commercial.costVsValue;
  const codes = commercial.breakdown.byCostCode;

  return html`
    <div class="grid g3" style="margin-bottom:14px">${commercial.headline.map(tile)}</div>

    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        ${raw(
          lineChart({
            title: 'Cost against value',
            data: curve.periods.map((period, index) => ({
              label: period,
              contract: curve.contractValueMinor[index],
              forecast: curve.forecastFinalCostMinor[index],
              certified: curve.certifiedMinor[index],
              actual: curve.actualCostMinor[index],
            })),
            series: [
              { key: 'contract', label: 'Contract value' },
              { key: 'forecast', label: 'Forecast final cost' },
              { key: 'certified', label: 'Certified value' },
              { key: 'actual', label: 'Actual cost' },
            ],
            format: (value) => money(value, cur),
            empty: curve.note,
            footnote: curve.note,
          }),
        )}
      </div>
      <div class="card">
        ${raw(
          pieChart({
            title: 'Cost breakdown',
            data: codes.map((code) => ({ label: code.description || code.costCode, value: code.budgetMinor })),
            format: (value) => money(value, cur),
            centreLabel: money(commercial.breakdown.totalMinor, cur),
            empty: commercial.breakdown.absent ?? 'The approved baseline names no cost code.',
            footnote: commercial.breakdown.absent ?? 'The approved cost baseline, by its own cost codes.',
          }),
        )}
      </div>
    </div>

    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <h2>Top cost codes by value</h2>
        ${table({
          headers: ['Code', 'Description', 'Baseline', 'Actual', 'Share'],
          align: ['', '', 'num', 'num', 'num'],
          rows: codes.slice(0, 8).map((code) => [
            code.costCode,
            code.description,
            money(code.budgetMinor, cur),
            money(code.actualMinor, cur),
            `${code.share}%`,
          ]),
          empty: commercial.breakdown.absent ?? 'No cost code on the approved baseline.',
        })}
      </div>
      <div class="card">
        <h2>Risk exposure</h2>
        ${table({
          headers: ['Risk', 'Category', 'Severity', 'Expected'],
          align: ['', '', '', 'num'],
          rows: commercial.risks.slice(0, 6).map((risk) => [
            risk.title,
            humanise(risk.category),
            badge(risk.severity, statusTone(risk.severity)),
            money(risk.expectedCostMinor, cur),
          ]),
          empty: 'No open risk is scored against this project.',
        })}
        <div class="metric-sub" style="margin-top:10px">${commercial.opportunities.because}</div>
      </div>
    </div>
  `;
}

/**
 * RIBA Plan of Work 2020, stages 0 to 7, against this project.
 *
 * The same seven phases in the rail above, read the way a practice working to
 * the Plan of Work reads them. Not a second lifecycle: the state of every stage
 * is derived server-side from the phase the project is in and the design
 * maturity already assessed per discipline, so the ribbon and the rail cannot
 * disagree.
 *
 * Each stage carries its own goal and the reason it is in the state it is in,
 * because "Stage 3" on its own tells a client nothing and a tooltip that says
 * what the stage is *for* is the difference between a progress bar and a
 * position somebody can act on.
 */
function ribaRibbon(riba) {
  if (!riba) return '';
  const tone = { COMPLETE: 'done', CURRENT: 'current', NOT_STARTED: '' };
  return html`<div class="metric-sub" style="margin:12px 0 6px">RIBA Plan of Work 2020</div>
    <div class="rail">
      ${riba.stages.map(
        (stage) => html`<div
          class="${raw(tone[stage.state] ?? '')}"
          title="${`Stage ${stage.stage} · ${stage.name} — ${stage.goal} ${stage.because}${stage.evidence.length > 0 ? ` (${stage.evidence.join('; ')})` : ''}`}"
        >${stage.stage} ${stage.name}</div>`,
      )}
    </div>
    ${riba.assessedAt
      ? html`<div class="metric-sub" style="margin-top:6px">
          Stages 2–4 read from the design maturity assessed on ${date(riba.assessedAt)}, per discipline.
        </div>`
      : html`<div class="metric-sub" style="margin-top:6px">
          No design maturity has been assessed, so the record cannot say which design stage has been reached.
        </div>`}`;
}

/**
 * The project, drawn from the records the screen already fetched.
 *
 * Nothing new is requested: `entityBundle` above already pulls the CVR, the
 * earned-value snapshots, the risk register, the variations, the clashes and
 * the defects, and every one of them was being rendered as a row in a list or
 * not at all. These are the same records as shapes.
 *
 * The risk scatter is the one worth explaining. A register sorted by expected
 * cost answers "what is worst" and hides *why* — a near-certain small problem
 * and an unlikely catastrophe can carry the same expected value and need
 * completely different responses. Probability against impact separates them,
 * which is the whole reason a risk matrix is a matrix.
 */
function projectCharts(bundle, commercial) {
  const evm = bundle.EarnedValueSnapshot ?? [];
  const risks = (bundle.RiskRegisterItem ?? []).filter((risk) => risk.status === 'OPEN');
  const variations = bundle.Variation ?? [];
  const defects = bundle.Defect ?? [];
  const clashes = bundle.Clash ?? [];
  if (evm.length === 0 && risks.length === 0 && variations.length === 0) return '';

  const cur = commercial?.header?.currency ?? 'GBP';

  // Performance indices over the snapshots taken. 1.0 is the line where the
  // project is doing what it said it would, and it is drawn because a CPI of
  // 0.94 means nothing to a reader who does not know where par is.
  const performance = evm.map((snapshot) => ({
    label: snapshot.period ?? String(snapshot.takenAt ?? '').slice(0, 7),
    cpi: snapshot.costPerformanceIndex,
    spi: snapshot.schedulePerformanceIndex,
  }));

  // Probability against impact. The dot is the risk; its size is what the
  // register expects it to cost.
  const matrix = risks
    .filter((risk) => risk.costImpact)
    .map((risk) => ({
      x: Math.round((risk.probability ?? 0) * 100),
      y: (risk.costImpact.mostLikely ?? 0) / 100,
      label: risk.title,
      tone: risk.severity === 'HIGH' ? 'bad' : risk.severity === 'MEDIUM' ? 'warn' : '',
    }));

  // The three-point estimate each risk carries, as a spread. A single expected
  // cost is one number standing in for a range somebody actually assessed, and
  // the range is what a contingency argument turns on.
  const spreads = risks
    .filter((risk) => risk.costImpact)
    .slice(0, 6)
    // `boxPlot` takes the measurements and works out the quartiles itself, so
    // the three points are handed over as three values rather than pre-chewed
    // into a five-number summary this file would have had to invent.
    .map((risk) => ({
      label: risk.title,
      values: [
        (risk.costImpact.optimistic ?? 0) / 100,
        (risk.costImpact.mostLikely ?? 0) / 100,
        (risk.costImpact.pessimistic ?? 0) / 100,
      ],
      tone: risk.severity === 'HIGH' ? 'bad' : risk.severity === 'MEDIUM' ? 'warn' : '',
    }));

  const byStatus = [...new Set(variations.map((variation) => variation.status))].map((status) => ({
    label: humanise(String(status)),
    value: variations.filter((variation) => variation.status === status).length,
  }));

  return html`
    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <h2>Cost and schedule performance</h2>
        ${raw(
          lineChart({
            title: 'CPI and SPI',
            data: performance,
            series: [
              { key: 'cpi', label: 'Cost performance' },
              { key: 'spi', label: 'Schedule performance' },
            ],
            format: (value) => Number(value).toFixed(2),
            reference: [{ value: 1, label: 'on plan', tone: 'ok' }],
            empty: 'No earned-value snapshot has been taken on this project.',
            footnote: 'Below 1.00 is spending faster, or earning slower, than the plan said.',
          }),
        )}
      </div>
      <div class="card">
        <h2>Risk: how likely against how much</h2>
        ${raw(
          scatterPlot({
            title: 'Probability against impact',
            points: matrix,
            xLabel: 'Probability (%)',
            yLabel: 'Most likely cost',
            formatX: (value) => `${value}%`,
            formatY: (value) => money(value * 100, cur),
            empty: 'No open risk carries a three-point cost estimate.',
            footnote: 'Sorting a register by expected cost hides the difference between a likely small problem and an unlikely disaster.',
          }),
        )}
      </div>
    </div>

    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <h2>What each risk could cost</h2>
        ${raw(
          boxPlot({
            title: 'Optimistic, most likely, pessimistic',
            groups: spreads,
            format: (value) => money(value * 100, cur),
            empty: 'No open risk carries a three-point estimate.',
            footnote: 'The range each risk was assessed at, not the single expected figure derived from it.',
          }),
        )}
      </div>
      <div class="card">
        <h2>Where the change is</h2>
        ${raw(
          pieChart({
            title: 'Variations by status',
            data: byStatus,
            format: (value) => `${value} variation${value === 1 ? '' : 's'}`,
            centreLabel: String(variations.length),
            empty: 'No variation has been raised on this project.',
            footnote: `${defects.length} defect${defects.length === 1 ? '' : 's'} and ${clashes.length} clash${clashes.length === 1 ? '' : 'es'} also on the record.`,
          }),
        )}
      </div>
    </div>
  `;
}
