import { api, entityBundle } from '../lib/api.js';
import { command, commandBar, confirmCost } from '../lib/command.js';
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

  // Signatures. Fetched rather than assumed, because whether this deployment can
  // witness one at all is a fact about the deployment: with no key configured
  // the platform refuses rather than signing with something nothing can verify
  // against tomorrow.
  const signing = await api.get(`/v1/projects/${projectId}/signatures`).catch(() => null);

  // Who can sign, resolved to named people rather than left as a capability.
  // The same map the platform already uses to answer "who owns this decision" —
  // a document put to signature under an area goes to whoever approves there,
  // and an area with nobody seated says so before anybody fills the form in.
  const ownership = await api.get('/v1/ownership').catch(() => ({ areas: [] }));

  // Contractual correspondence, and the matrix that governs it. The matrix is
  // fetched rather than restated here: who a letter must be served on is a rule,
  // and the interface holds no rule the API does not publish.
  const [letters, matrix] = await Promise.all([
    api.get(`/v1/projects/${projectId}/correspondence/position`).catch(() => null),
    api.get('/v1/correspondence/matrix').catch(() => ({ types: [] })),
  ]);
  const evidenceHeld = await api
    .get(`/v1/projects/${projectId}/evidence`)
    .then((r) => r.entries.filter((entry) => entry.held))
    .catch(() => []);

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

  // The matrix reconciles the two sides of every change, which no entity read
  // can do — it needs the link between an upstream variation and the
  // subcontractor claim that belongs to it.
  const register = await api.get(`/v1/projects/${projectId}/variations/register`).catch(() => null);

  // Dated obligations. Nothing triggers these and nobody is watching for them,
  // which is exactly why they get missed.
  const calendar = await api.get(`/v1/projects/${projectId}/obligations/calendar`).catch(() => null);

  // Statutory adjudication. The timetable is the point: both ends of it are
  // fatal in different directions, and neither is about who is right.
  const disputes = await api.get(`/v1/projects/${projectId}/disputes/position`).catch(() => null);

  const contract = b.Contract.filter((c) => c.status === 'EXECUTED').at(-1) ?? b.Contract.at(-1);

  // The commercial terms as a position rather than as fields: percentages
  // resolved into money, durations into dates, each citing the clause it sits
  // under. Nobody argues about a percentage; they argue about the sum.
  const terms = contract?.id
    ? await api.get(`/v1/projects/${projectId}/contracts/${contract.id}/terms`).catch(() => null)
    : null;
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
            { id: 'value', label: 'Agree a variation', permitted: can('CHANGE_VARIATION', 'A'), reason: blockedReason('CHANGE_VARIATION', 'A') },
            { id: 'reject', label: 'Refuse a change', permitted: can('CHANGE_VARIATION', 'A'), reason: blockedReason('CHANGE_VARIATION', 'A') },
            { id: 'delay', label: 'Record delay event', permitted: can('CONTRACTS_CLAIMS', 'C'), reason: blockedReason('CONTRACTS_CLAIMS', 'C') },
            { id: 'notice', label: 'Serve notice', permitted: can('CONTRACTS_CLAIMS', 'C'), reason: blockedReason('CONTRACTS_CLAIMS', 'C') },
            { id: 'obligation', label: 'Register obligation', permitted: can('CONTRACTS_CLAIMS', 'C'), reason: blockedReason('CONTRACTS_CLAIMS', 'C') },
            { id: 'dispute', label: 'Give notice of adjudication', permitted: can('CONTRACTS_CLAIMS', 'C'), reason: blockedReason('CONTRACTS_CLAIMS', 'C') },
            { id: 'refer', label: 'Record a referral', permitted: can('CONTRACTS_CLAIMS', 'U'), reason: blockedReason('CONTRACTS_CLAIMS', 'U') },
            { id: 'decision', label: 'Record a decision', permitted: can('CONTRACTS_CLAIMS', 'U'), reason: blockedReason('CONTRACTS_CLAIMS', 'U') },
            { id: 'letter', label: 'Write a letter', permitted: can('DESIGN_INFORMATION', 'C'), reason: blockedReason('DESIGN_INFORMATION', 'C') },
            { id: 'reply', label: 'Answer a letter', permitted: can('DESIGN_INFORMATION', 'U'), reason: blockedReason('DESIGN_INFORMATION', 'U') },
            // Offered only where the deployment can actually witness one. A
            // control that always refuses is worse than one that is not there.
            ...(signing?.available
              ? [{ id: 'signature', label: 'Put a document to signature', permitted: can('CONTRACTS_CLAIMS', 'C'), reason: blockedReason('CONTRACTS_CLAIMS', 'C') }]
              : []),
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

      ${
        !letters || letters.total === 0
          ? ''
          : html`<div class="card pad0" style="margin-bottom:14px">
              <h3 style="padding:15px 17px 0">Correspondence — what is awaiting a reply</h3>
              <div style="padding:8px 17px 0"><div class="metric-sub">${letters.summary}</div></div>
              ${
                letters.deemedAccepted.length === 0
                  ? ''
                  : html`<div style="padding:12px 17px 0"><div class="notice err">
                      <div>
                        <b>${letters.deemedAccepted.length} decided by silence, not outstanding</b><br>
                        ${letters.deemedAccepted
                          .map(
                            (entry) =>
                              `${entry.reference} — ${entry.subject}: the reply was due ${entry.dueBy}, ${entry.daysSince} days ago. ${entry.consequence}`,
                          )
                          .join(' · ')}
                      </div>
                    </div></div>`
              }
              ${
                letters.suite
                  ? ''
                  : html`<div style="padding:12px 17px 0"><div class="notice warn">
                      <div><b>No response periods derived</b><br>${letters.suiteReason}</div>
                    </div></div>`
              }
              ${table({
                headers: ['Reference', 'Letter', 'Subject', 'Served on', 'Issued', 'Reply due', 'Clause'],
                rows: letters.outstanding.map((entry) => [
                  entry.reference,
                  entry.typeLabel,
                  entry.subject,
                  humanise(entry.to),
                  date(entry.issuedOn),
                  entry.dueBy
                    ? entry.overdue
                      ? badge(`${Math.abs(entry.daysRemaining)} days late`, 'bad')
                      : badge(`${entry.daysRemaining} days`, entry.daysRemaining <= 3 ? 'warn' : 'neutral')
                    : // Said rather than left blank: an empty cell reads as an
                      // oversight, and this is the contract's own silence.
                      badge('no period', 'neutral'),
                  entry.clause ? `${entry.clause.suite} ${entry.clause.clause}` : '—',
                ]),
                empty: 'Every letter has been answered',
              })}
            </div>`
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

      ${
        calendar && (calendar.entries.length > 0 || calendar.running.length > 0)
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h3 style="padding:15px 17px 0">Obligations calendar</h3>
              <div style="padding:0 17px"><div class="metric-sub">
                A reactive obligation has no date until something happens, and is lost by not noticing. A dated one
                exists from the day the contract is signed and is missed because nothing triggers it. They are kept
                apart because a list mixing the two is unusable.
              </div></div>
              ${table({
                headers: ['Ref', 'Clause', 'Category', 'Obligation', 'Owner', 'Due', 'Days'],
                align: ['', '', '', '', '', '', 'num'],
                rows: calendar.entries.map((e) => [
                  e.reference,
                  // The difference between a reminder and a position. A dash
                  // where the form is bespoke: a confident wrong clause number
                  // is evidence that gets quoted in a letter.
                  e.clause
                    ? html`<span class="mono" title="${e.clause.note ?? ''}">${e.clause.suite} ${e.clause.clause}</span>`
                    : '—',
                  humanise(e.category),
                  String(e.description).slice(0, 78) + (String(e.description).length > 78 ? '…' : ''),
                  e.owner,
                  e.status === 'OVERDUE' ? html`${date(e.dueDate)} ${badge('overdue', 'bad')}` : e.status === 'APPROACHING' ? html`${date(e.dueDate)} ${badge('soon', 'warn')}` : date(e.dueDate),
                  `${e.daysRemaining}`,
                ]),
                empty: 'Nothing dated falls due in the window',
              })}
              ${
                calendar.running.length > 0
                  ? html`<div style="padding:12px 17px 4px">
                      <div class="metric-sub" style="margin-bottom:7px"><b>Time bars running</b> — against recorded events, not a diary.</div>
                      ${table({
                        headers: ['Trigger', 'From', 'Bar', 'Days left', 'Notice'],
                        align: ['', '', 'num', 'num', ''],
                        rows: calendar.running.map((r) => [
                          String(r.trigger).slice(0, 60),
                          date(r.triggerDate),
                          days(r.timeBarDays),
                          `${r.daysRemaining}`,
                          r.served ? badge('served', 'good') : r.lost ? badge('lost', 'bad') : badge('open', 'warn'),
                        ]),
                        empty: 'No time bar running',
                      })}
                    </div>`
                  : ''
              }
              <div style="padding:10px 17px 15px">
                <div class="notice ${raw(calendar.overdue.length > 0 || calendar.running.some((r) => r.lost) ? 'warn' : 'ok')}">${calendar.summary}</div>
              </div>
            </div>`
          : ''
      }

      ${
        disputes && disputes.total > 0
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h3 style="padding:15px 17px 0">Adjudication — HGCRA 1996 s.108</h3>
              <div style="padding:0 17px"><div class="metric-sub">
                A party may refer a dispute at any time. Seven days from the notice to secure an appointment and serve the
                referral; twenty-eight from the referral to a decision. Miss the first and the appointment is a nullity;
                miss the second and the decision is. Neither is about who is right.
              </div></div>
              ${table({
                headers: ['Ref', 'Dispute', 'Referring', 'In dispute', 'Next deadline', 'Status'],
                align: ['', '', '', 'num', '', ''],
                rows: disputes.disputes.map((d) => [
                  d.reference,
                  String(d.natureOfDispute).slice(0, 58) + (String(d.natureOfDispute).length > 58 ? '…' : ''),
                  d.referringParty,
                  d.disputedAmountMinor ? money(d.disputedAmountMinor) : '—',
                  d.nextDeadline
                    ? html`${date(d.nextDeadline)} · ${badge(
                        `${d.daysToNextDeadline}d`,
                        d.daysToNextDeadline < 0 ? 'bad' : d.daysToNextDeadline <= 7 ? 'warn' : 'neutral',
                      )}`
                    : '—',
                  badge(humanise(d.status), statusTone(d.status)),
                ]),
              })}
              ${
                disputes.disputes.flatMap((d) => d.findings.filter((f) => f.severity !== 'INFO').map((f) => ({ ...f, ref: d.reference })))
                  .length > 0
                  ? html`<div style="padding:6px 17px 4px">
                      ${disputes.disputes.flatMap((d) =>
                        d.findings
                          .filter((f) => f.severity !== 'INFO')
                          .map(
                            (f) => html`<div class="notice ${raw(f.severity === 'CRITICAL' ? 'err' : 'warn')}" style="margin-bottom:9px">
                              <div><b>${d.reference} · ${f.authority}</b><br>${f.finding}<br>
                              <span style="color:var(--text-3)">${f.consequence}</span></div>
                            </div>`,
                          ),
                      )}
                    </div>`
                  : ''
              }
              ${(disputes.costsProvisionFindings ?? []).map(
                (f) => html`<div style="padding:0 17px 9px"><div class="notice err">
                  <div><b>${f.authority}</b><br>${f.finding}<br>
                  <span style="color:var(--text-3)">${f.consequence}</span></div>
                </div></div>`,
              )}
              <div style="padding:4px 17px 15px"><div class="metric-sub">${disputes.summary}</div></div>
            </div>`
          : ''
      }

      <div class="grid g2" style="margin-bottom:14px">
        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Variation control matrix</h3>
          <div style="padding:0 17px"><div class="metric-sub">
            One change, both sides of it. Change is where money leaves a contract quietly, and it leaves in
            two directions — cost the business will pay and never charged on, and a price agreed with the client
            before anybody knew what the packages would cost.
          </div></div>
          ${table({
            headers: ['Ref', 'Origin', 'Upstream', 'Downstream', 'Time', 'Status'],
            align: ['', '', 'num', 'num', 'num', ''],
            rows: (register?.lines ?? b.Variation.map((v) => ({
              reference: v.reference,
              origin: v.origin,
              agreedMinor: 0,
              instructedMinor: Number(v.valuedAmountMinor ?? 0),
              downstreamCapturedMinor: 0,
              timeImpactDays: v.timeImpactDays ?? 0,
              status: v.status,
            }))).map((l) => [
              html`${l.reference}${l.mismatch ? html` ${badge(l.mismatch.kind === 'DOWNSTREAM_NOT_RECOVERED' ? 'not recovered' : 'unsupported', 'bad')}` : ''}`,
              humanise(l.origin),
              l.agreedMinor > 0 ? money(l.agreedMinor) : l.instructedMinor > 0 ? html`${money(l.instructedMinor)} <span class="metric-sub">instructed</span>` : '—',
              l.downstreamCapturedMinor > 0 ? money(l.downstreamCapturedMinor) : '—',
              days(l.timeImpactDays ?? 0),
              badge(humanise(l.status), statusTone(l.status)),
            ]),
            empty: 'No change recorded',
          })}
          ${
            register
              ? html`<div style="padding:10px 17px 15px">
                  <div class="split-list">
                    <div class="row"><span class="lbl">Cost carried with nothing claimed upstream</span><span class="val">${
                      register.downstreamNotRecoveredMinor > 0 ? money(register.downstreamNotRecoveredMinor) : '—'
                    }</span></div>
                    <div class="row"><span class="lbl">Value agreed against packages not yet priced</span><span class="val">${
                      register.upstreamUnsupportedMinor > 0 ? money(register.upstreamUnsupportedMinor) : '—'
                    }</span></div>
                    <div class="row"><span class="lbl">Assessed and not instructed</span><span class="val">${
                      register.uninstructedMinor > 0 ? money(register.uninstructedMinor) : '—'
                    }</span></div>
                    <div class="row"><span class="lbl">Instructed and not agreed</span><span class="val">${
                      register.unvaluedMinor > 0 ? money(register.unvaluedMinor) : '—'
                    }</span></div>
                    <div class="row"><span class="lbl">Margin on change</span><span class="val">${money(register.marginOnChangeMinor)}</span></div>
                  </div>
                  <div class="notice ${raw(register.downstreamNotRecoveredMinor > 0 || register.upstreamUnsupportedMinor > 0 ? 'warn' : 'ok')}" style="margin-top:10px">${register.summary}</div>
                </div>`
              : ''
          }
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
              ? html`${
                  // Percentages resolved into money and durations into dates,
                  // each citing the clause it sits under. The raw fields below
                  // stay as the fallback where the register cannot be read.
                  terms
                    ? html`<div class="split-list" style="margin-bottom:11px">
                        <div class="row"><span class="lbl">Contract sum</span><span class="val">${money(terms.contractSumMinor)}</span></div>
                        ${terms.terms.map((t) => html`<div class="row">
                          <span class="lbl">
                            ${t.term}
                            ${t.clause ? html`<span class="metric-sub mono" title="${t.clause.note ?? ''}"> ${t.clause.suite} ${t.clause.clause}</span>` : ''}
                          </span>
                          <span class="val">
                            ${t.valueMinor !== undefined ? money(t.valueMinor) : t.resolvesTo ? date(t.resolvesTo) : t.stated}
                            ${t.valueMinor !== undefined || t.resolvesTo ? html`<span class="metric-sub"> ${t.stated}</span>` : ''}
                          </span>
                        </div>`)}
                      </div>
                      ${
                        terms.uncited.length > 0
                          ? html`<div class="metric-sub" style="margin-bottom:11px">
                              No clause in ${terms.form} for: ${terms.uncited.map(humanise).join(', ')} —
                              these obligations are real and cannot be argued from a clause number.
                            </div>`
                          : ''
                      }`
                    : html`<div class="split-list">
                        <div class="row"><span class="lbl">Contract sum</span><span class="val">${money(contract.contractSumMinor)}</span></div>
                        <div class="row"><span class="lbl">LDs per day</span><span class="val">${money(contract.liquidatedDamagesPerDayMinor)}</span></div>
                        <div class="row"><span class="lbl">LD cap</span><span class="val">${money(contract.ldCapMinor)} (${pct(contract.ldCapPercent, 0)})</span></div>
                        <div class="row"><span class="lbl">Retention</span><span class="val">${pct(contract.retentionPercent, 0)}</span></div>
                        <div class="row"><span class="lbl">Defects liability</span><span class="val">${contract.defectsLiabilityMonths} months</span></div>
                      </div>`
                }
                <div class="split-list">
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

      ${
        signing
          ? html`<div class="card pad0" style="margin-top:14px">
              <div style="padding:15px 17px 0">
                <h3>Signatures</h3>
                <p class="metric-sub" style="margin-bottom:12px">
                  <b>Witnessed by the platform, not by the signatory.</b> What a signature here proves is that an identity the
                  platform authenticated, with multi-factor satisfied, affirmed a named document by its content hash at a recorded
                  time. The signing key is the platform's, so this is a simple electronic signature with an evidenced trail — not
                  an advanced or qualified electronic signature, and it is never described as one.
                  ${
                    signing.available
                      ? ''
                      : html`<br><b>No signing key is configured on this deployment</b>, so every signature request is refused.`
                  }
                </p>
              </div>
              ${table({
                headers: ['Document', 'Purpose', 'Signatories', 'Status'],
                rows: signing.requests.map((request) => [
                  request.documentDescription,
                  request.purpose,
                  request.requiredSignatories
                    .map((s) => `${s.name}${request.signedBy.includes(s.actorId) ? ' ✓' : ''}`)
                    .join(', '),
                  request.status === 'OPEN' && request.requiredSignatories.some((s) => s.actorId === state.session.user.id)
                    && !request.signedBy.includes(state.session.user.id)
                    ? html`<button class="btn sm" data-sign="${request.id}">Sign</button>
                        <button class="btn quiet sm" data-decline-sign="${request.id}">Refuse</button>`
                    : badge(humanise(request.status), statusTone(request.status)),
                ]),
                empty: 'Nothing has been put to signature on this project.',
              })}
              ${
                signing.signatures.length > 0
                  ? html`<div style="padding:0 17px 15px">
                      <h3 style="margin-top:14px">Signed</h3>
                      ${table({
                        headers: ['Who', 'Capacity', 'What they agreed', 'When', 'Verifies'],
                        rows: signing.signatures.map((s) => [
                          s.signatoryName ?? s.signatory,
                          s.declined ? '—' : (s.capacity ?? '—'),
                          s.declined ? `Refused: ${s.reason}` : s.affirmation,
                          date(s.signedAt ?? s.declinedAt),
                          s.declined
                            ? badge('refused', 'bad')
                            : badge(s.verified ? 'verifies' : 'does not verify', s.verified ? 'good' : 'bad'),
                        ]),
                      })}
                      <div class="metric-sub" style="margin-top:9px">
                        Each signature is re-checked against the platform's public key as this page is read, rather than trusting a
                        stored flag. A record whose value is that it can be checked years later needs the check to actually run.
                      </div>
                    </div>`
                  : ''
              }
            </div>`
          : ''
      }
    `,
  );

  root.addEventListener('click', async (event) => {
    const signButton = event.target.closest('[data-sign]');
    if (signButton) {
      const affirmation = window.prompt(
        'What are you agreeing to? This is recorded in your words, signed, and cannot be edited afterwards.',
      );
      if (!affirmation) return;
      try {
        await api.post(`/v1/projects/${projectId}/signatures/${signButton.dataset.sign}/sign`, {
          signatoryName: state.session.user.name,
          affirmation,
        });
        toast('Signed', 'Witnessed by the platform and recorded in the Golden Thread', 'ok');
        await draw();
      } catch (error) {
        // The MFA refusal is the one worth naming rather than retitling: it is
        // the strongest thing the ceremony asserts about who signed.
        toast(
          error.code === 'MFA_REQUIRED_TO_SIGN' ? 'Multi-factor required' : 'Not signed',
          error.message,
          error.code === 'MFA_REQUIRED_TO_SIGN' ? 'warn' : 'err',
        );
      }
      return;
    }

    const refuseButton = event.target.closest('[data-decline-sign]');
    if (refuseButton) {
      const reason = window.prompt('Why are you not signing? The refusal is recorded and it ends the request.');
      if (!reason) return;
      try {
        await api.post(`/v1/projects/${projectId}/signatures/${refuseButton.dataset.declineSign}/decline`, { reason });
        await draw();
      } catch (error) {
        toast('Not recorded', error.message, 'err');
      }
    }
  });

  document.getElementById('assess')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const path = `/v1/projects/${state.session.projectId}/claims`;

    const accepted = await confirmCost({
      title: 'Reassess claim',
      intent: 'Reviews the delay attribution and sets out the contractual argument, concurrency included.',
      path,
      runLabel: 'Assess',
    });
    if (!accepted) return;

    button.disabled = true;
    button.textContent = 'Assessing…';
    try {
      const result = await api.post(path, {
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

    const path = `/v1/projects/${state.session.projectId}/claims/${claim._refId}/evidence-pack`;
    const accepted = await confirmCost({
      title: 'Build evidence pack',
      intent: 'Writes the narrative chronology tying the evidence to the entitlement argument.',
      path,
      runLabel: 'Build pack',
    });
    if (!accepted) return;

    button.disabled = true;
    button.textContent = 'Building…';
    try {
      const result = await api.post(path, {
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

  const COMMANDS = {
    // The letter types, their senders and their recipients all come from the
    // published matrix. Typing them here would put a second copy of a
    // contractual rule in the browser, and the copy is the one that goes stale.
    letter: {
      title: 'Write a letter',
      intent:
        'The contract decides who may write each letter and who it must be served on. Served on the wrong party a '
        + 'notice is not served, so the platform refuses rather than filing it — and the reply period comes from the '
        + 'form this project runs, or is reported as absent where the form imposes none.',
      path: `/v1/projects/${projectId}/correspondence`,
      submitLabel: 'Issue',
      fields: [
        { name: 'type', label: 'Letter', type: 'select',
          options: (matrix.types ?? []).map((entry) => ({ value: entry.type, label: entry.label })) },
        { name: 'from', label: 'From', type: 'select',
          hint: 'Only the parties the contract lets write the chosen letter will be accepted.',
          options: [...new Set((matrix.types ?? []).flatMap((entry) => entry.senders))].sort()
            .map((party) => ({ value: party, label: humanise(party) })) },
        { name: 'to', label: 'Served on', type: 'select',
          options: [...new Set((matrix.types ?? []).flatMap((entry) => entry.recipients))].sort()
            .map((party) => ({ value: party, label: humanise(party) })) },
        { name: 'subject', label: 'Subject', type: 'text' },
        { name: 'body', label: 'Letter', type: 'textarea', rows: 6 },
        { name: 'author', label: 'Signed by', type: 'text', value: state.session.user.name },
        { name: 'evidenceHash', label: 'The letter as sent', type: 'file', required: false,
          hint: 'Optional. Without it the letter’s own text is hashed, which is still checkable later.' },
      ],
    },
    reply: {
      title: 'Answer a letter',
      intent:
        'A reply after the period has run is recorded as a reply and as late — the letter was answered, and whether '
        + 'the lateness matters is a question about the contract. Where silence has already decided the point the '
        + 'reply does not undo it, and the record says both things happened.',
      path: (collected) => `/v1/projects/${projectId}/correspondence/${encodeURIComponent(collected.correspondenceId)}/reply`,
      submitLabel: 'Reply',
      fields: [
        { name: 'correspondenceId', label: 'Letter', type: 'select',
          options: (letters?.outstanding ?? []).map((entry) => ({
            value: entry.id,
            label: `${entry.reference} — ${entry.subject}${entry.dueBy ? ` (due ${entry.dueBy})` : ''}`,
          })) },
        { name: 'body', label: 'Reply', type: 'textarea', rows: 6 },
        { name: 'author', label: 'Signed by', type: 'text', value: state.session.user.name },
        { name: 'evidenceHash', label: 'The reply as sent', type: 'file', required: false },
      ],
      transform: ({ correspondenceId, ...rest }) => rest,
    },
    signature: {
      title: 'Put a document to signature',
      intent:
        'Witnessed by the platform: an authenticated identity with multi-factor satisfied affirms this document by its content hash. '
        + 'The signing key is the platform\'s, not the signatory\'s, so this is a simple electronic signature with an evidenced trail — not a qualified one.',
      path: `/v1/projects/${projectId}/signatures`,
      submitLabel: 'Request signatures',
      fields: [
        { name: 'documentHash', label: 'Document', type: 'select',
          options: evidenceHeld.map((entry) => ({ value: entry.hash, label: `${entry.description} · ${entry.type}` })) },
        { name: 'purpose', label: 'What is being agreed', type: 'textarea', rows: 3,
          hint: 'This is signed along with the document hash, so a signature agreeing one thing cannot be read as agreeing another.' },
        { name: 'area', label: 'Whose decision this is', type: 'select',
          hint: 'The request goes to whoever approves in that area.',
          options: (ownership.areas ?? []).map((area) => ({
            value: area.area,
            label:
              area.approve.length > 0
                ? `${humanise(area.area)} — ${area.approve.map((person) => person.name).join(', ')}`
                : `${humanise(area.area)} — nobody seated to sign`,
          })) },
      ],
      // The signatories are resolved here rather than typed. Naming them by
      // hand is how a certificate goes to somebody who left in March.
      transform: ({ area, ...rest }) => ({
        ...rest,
        area,
        requiredSignatories: ((ownership.areas ?? []).find((entry) => entry.area === area)?.approve ?? []).map((person) => ({
          actorId: person.userId,
          name: person.name,
          capacity: humanise(person.role),
        })),
      }),
    },
    dispute: {
      title: 'Give notice of adjudication',
      intent:
        'The right arises at any time — no waiting for practical completion or for an escalation ladder. Seven days from this notice to secure an appointment and serve the referral.',
      path: `/v1/projects/${projectId}/disputes`,
      submitLabel: 'Give notice',
      fields: [
        { name: 'contractId', label: 'Contract', type: 'select', options: b.Contract.map((c) => ({ value: c._refId, label: `${c.form} · ${c.suite}` })) },
        { name: 'natureOfDispute', label: 'What the dispute is', type: 'textarea', rows: 4,
          hint: 'The adjudicator has jurisdiction over the dispute referred and nothing else. A vague notice is a gift to the other side.' },
        { name: 'redressSought', label: 'What is being asked for', type: 'textarea' },
        { name: 'disputedAmountMinor', label: 'Sum in dispute', type: 'number', money: true, required: false },
        { name: 'referringParty', label: 'Referring party', type: 'text' },
        { name: 'respondingParty', label: 'Responding party', type: 'text' },
        { name: 'noticeDate', label: 'Date of the notice', type: 'date', value: today(), max: today() },
        { name: 'evidenceHash', label: 'Notice of adjudication', type: 'file' },
      ],
    },
    refer: {
      title: 'Record a referral',
      intent:
        'The appointment and the referral, against the seven-day period. A referral served late does not lose the right — a fresh notice can be given — but it puts this reference in jeopardy.',
      path: (collected) => `/v1/projects/${projectId}/disputes/${collected.disputeId}/refer`,
      transform: ({ disputeId, ...rest }) => rest,
      submitLabel: 'Record',
      fields: [
        { name: 'disputeId', label: 'Dispute', type: 'select',
          options: (disputes?.disputes ?? [])
            .filter((d) => d.status === 'NOTICE_GIVEN')
            .map((d) => ({ value: d.disputeId, label: `${d.reference} · ${String(d.natureOfDispute).slice(0, 44)}` })) },
        { name: 'adjudicatorName', label: 'Adjudicator', type: 'text' },
        { name: 'nominatingBody', label: 'Nominating body', type: 'text', required: false,
          placeholder: 'Where the parties did not agree — RICS, TeCSA, ICE' },
        { name: 'referralDate', label: 'Date referred', type: 'date', value: today(), max: today() },
        { name: 'evidenceHash', label: 'Referral notice', type: 'file' },
      ],
    },
    decision: {
      title: 'Record a decision',
      intent:
        'Recorded whether or not it was reached in time. A decision one day outside the period is a nullity, and that is a fact somebody needs in front of them before they pay against it.',
      path: (collected) => `/v1/projects/${projectId}/disputes/${collected.disputeId}/decision`,
      transform: ({ disputeId, extensionAgreedBy, ...rest }) => ({
        ...rest,
        ...(extensionAgreedBy && extensionAgreedBy !== 'NONE' ? { extensionAgreedBy } : {}),
      }),
      submitLabel: 'Record',
      fields: [
        { name: 'disputeId', label: 'Dispute', type: 'select',
          options: (disputes?.disputes ?? [])
            .filter((d) => d.status === 'REFERRED')
            .map((d) => ({ value: d.disputeId, label: `${d.reference} · ${String(d.natureOfDispute).slice(0, 44)}` })) },
        { name: 'decisionDate', label: 'Date of the decision', type: 'date', value: today(), max: today() },
        { name: 'inFavourOf', label: 'In favour of', type: 'text' },
        { name: 'awardedAmountMinor', label: 'Amount awarded', type: 'number', money: true, required: false },
        { name: 'awardedDays', label: 'Days awarded', type: 'number', required: false },
        { name: 'extensionDays', label: 'Extension of the decision period', type: 'number', required: false,
          hint: 'Up to 14 days on the referring party’s consent alone; longer needs both parties, agreed after referral' },
        { name: 'extensionAgreedBy', label: 'Extension agreed by', type: 'select', required: false, options: [
          { value: 'NONE', label: 'No extension' },
          { value: 'REFERRING_PARTY', label: 'The referring party' },
          { value: 'BOTH_PARTIES', label: 'Both parties' },
        ] },
        { name: 'extensionAgreedDate', label: 'Extension agreed on', type: 'date', required: false },
        { name: 'adjudicatorFeesMinor', label: 'Adjudicator’s fees', type: 'number', money: true, required: false },
        { name: 'feesBorneBy', label: 'Fees borne by', type: 'text', required: false },
        { name: 'evidenceHash', label: 'Decision', type: 'file' },
      ],
    },
    obligation: {
      title: 'Register obligation',
      intent:
        'A dated obligation — a renewal, an expiry, a review cycle. Nothing in the project will trigger it, which is why it needs a date and an owner.',
      path: `/v1/projects/${projectId}/obligations`,
      submitLabel: 'Register',
      fields: [
        { name: 'contractId', label: 'Contract', type: 'select', options: b.Contract.map((c) => ({ value: c._refId, label: `${c.form} · ${c.suite}` })) },
        { name: 'category', label: 'Category', type: 'select', options: [
          { value: 'INSURANCE', label: 'Insurance renewal' },
          { value: 'PERFORMANCE_BOND', label: 'Bond or guarantee expiry' },
          { value: 'COLLATERAL_WARRANTY', label: 'Collateral warranty' },
          { value: 'REVIEW_CYCLE', label: 'Review cycle' },
          { value: 'HANDOVER_TRIGGER', label: 'Handover trigger' },
          { value: 'RETENTION', label: 'Retention release' },
          { value: 'DEFECTS_LIABILITY', label: 'Defects liability' },
        ] },
        { name: 'description', label: 'What has to happen', type: 'textarea' },
        { name: 'dueDate', label: 'Due', type: 'date', min: today() },
        { name: 'owner', label: 'Owner', type: 'text' },
        { name: 'recurrenceMonths', label: 'Recurs every (months)', type: 'number', required: false,
          hint: 'Leave blank for a one-off. An annual policy is not one obligation, it is one a year.' },
      ],
    },
    value: {
      title: 'Agree a variation',
      intent:
        'Agreeing the client figure before the packages have priced means agreeing it without knowing your own cost, and there is no route back. The platform refuses until the downstream cost is captured.',
      path: (collected) => `/v1/projects/${projectId}/variations/${collected.variationId}/value`,
      transform: ({ variationId, ...rest }) => rest,
      submitLabel: 'Agree',
      fields: [
        { name: 'variationId', label: 'Variation', type: 'select',
          options: b.Variation.filter((v) => !v.isDomestic && v.status !== 'VALUED').map((v) => ({ value: v._refId, label: `${v.reference} · ${money(v.valuedAmountMinor)} instructed` })) },
        { name: 'valuationMethod', label: 'Valuation method', type: 'select', options: [
          { value: 'BOQ_RATES', label: 'Bill rates' },
          { value: 'STAR_RATE', label: 'Star rate' },
          { value: 'DAYWORK', label: 'Daywork' },
          { value: 'LUMP_SUM', label: 'Lump sum' },
          { value: 'FAIR_VALUATION', label: 'Fair valuation' },
        ] },
        { name: 'agreedAmountMinor', label: 'Amount agreed', type: 'number', money: true },
        { name: 'agreedTimeDays', label: 'Time agreed (days)', type: 'number' },
        { name: 'basis', label: 'Basis of the figure', type: 'textarea', hint: 'A valuation without a basis is a number' },
        { name: 'agreedWith', label: 'Agreed with', type: 'text' },
      ],
    },
    reject: {
      title: 'Refuse a change',
      intent: 'A register full of changes nobody decided is worse than a short one — at final account every unresolved line is argued as though it were live.',
      path: (collected) => `/v1/projects/${projectId}/changes/${collected.changeRequestId}/reject`,
      transform: ({ changeRequestId, ...rest }) => rest,
      submitLabel: 'Refuse',
      fields: [
        { name: 'changeRequestId', label: 'Change', type: 'select',
          options: b.ChangeRequest.filter((c) => c.status !== 'REJECTED' && c.status !== 'INSTRUCTED').map((c) => ({ value: c._refId, label: `${c.reference} · ${String(c.description).slice(0, 50)}` })) },
        { name: 'reason', label: 'Grounds for refusal', type: 'textarea', hint: 'An unexplained rejection gets re-opened' },
      ],
    },
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
        { name: 'start', label: 'Start', type: 'date', value: today(), max: today() },
        { name: 'end', label: 'End', type: 'date', value: today() },
        { name: 'criticalDelayDays', label: 'Critical delay (days)', type: 'number', min: 0 },
        { name: 'noticeDate', label: 'Notice served on', type: 'date', required: false, max: today(),
          hint: 'Leave blank if no notice has been served' },
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
        { name: 'servedDate', label: 'Served on', type: 'date', value: today(), max: today() },
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
}
