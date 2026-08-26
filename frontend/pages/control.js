import { api } from '../lib/api.js';
import { badge, drillable, html, humanise, money, pct, raw, render, table, toast } from '../lib/ui.js';
import { blockedReason, can, draw, state } from '../app.js';
import { insightPanel } from '../lib/insight.js';

/**
 * Corporate project control.
 *
 * Three views of one standard: this project against it, every project against
 * it, and what the business learned along the way.
 *
 * The design decision that matters is how the four statuses are shown. A
 * checklist that renders "we do not track this" the same as "you have not done
 * this" trains people to ignore both. Untracked items are greyed and excluded
 * from every percentage on the page, and the reason is printed next to them —
 * they are the platform's gap, not the project's.
 */

const STATUS_TONE = { PRESENT: 'ok', MISSING: 'bad', NOT_YET_DUE: '', NOT_TRACKED: '', NOT_PROPORTIONATE: '' };
const STATUS_LABEL = {
  PRESENT: 'in place',
  MISSING: 'MISSING',
  NOT_YET_DUE: 'not yet due',
  NOT_TRACKED: 'not tracked',
  NOT_PROPORTIONATE: 'not at this size',
};

const KIND_TONE = { WENT_WRONG: 'bad', WENT_WELL: 'ok' };

/**
 * The links of Bid → Contract → Subcontract → Commitment → Application → CVR.
 *
 * Held here rather than derived from the response so that a break in the chain
 * reads differently from a disagreement: the rest of this panel is two records
 * that contradict each other, and these are records attached to nothing.
 */
const CHAIN_CHECKS = new Set([
  'Contract from the winning bid',
  'Subcontract from the awarded enquiry',
  'Commitment against a subcontract',
  'Payment cycle against the contract',
  'Application against a payment cycle',
  'CVR from the contract',
]);

export async function control(root) {
  const projectId = state.session.projectId;

  const [project, estate, lessons] = await Promise.all([
    api.get(`/v1/projects/${projectId}/control`),
    api.get('/v1/control/estate').catch(() => null),
    api.get('/v1/lessons').catch(() => null),
  ]);

  // What the records say against each other. Every module here is right about
  // its own subject and none of them looks at the others, which is where the
  // expensive mistakes live.
  const consistency = await api.get(`/v1/projects/${projectId}/consistency`).catch(() => null);
  const chainBreaks = (consistency?.findings ?? []).filter((finding) => CHAIN_CHECKS.has(finding.check));

  // The records behind the summary counts, collected from the per-item evidence
  // the control report now carries.
  //
  // Three of the five tiles are deliberately not drillable, and for the same
  // reason each time: they count the *absence* of records.
  //
  // A gap is an item with no evidence behind it — that is what makes it a gap —
  // so a drill on it would always open empty. "Not at this size" counts items
  // that do not apply to a project of this value, and "Not tracked here" counts
  // items the platform has no evidence path for at all. None of the three has
  // anything to show, and an affordance promising otherwise is the placeholder
  // rule 9 forbids. The gaps themselves are listed in full below, by name.
  const allItems = project.stages.flatMap((stage) => stage.items);
  const presentSources = allItems
    .filter((item) => item.status === 'PRESENT')
    .flatMap((item) => item.evidenceRefs ?? []);
  const lessonSources = (lessons?.lessons ?? [])
    .map((lesson) => ({ refType: 'LessonLearned', refId: lesson.id ?? lesson._refId }))
    .filter((ref) => ref.refId);

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Project Control</h1>
          <p>
            One standard, every project — sized to the job. ${project.applicableItems} of
            ${project.stages.reduce((n, s) => n + s.items.length, 0)} items apply to a ${project.projectScaleLabel} project, measured
            against what the Golden Thread can actually evidence and honest about what it cannot.
          </p>
        </div>
      </div>

      ${
        consistency
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h3 style="padding:15px 17px 0">Do the records agree?</h3>
              <div style="padding:0 17px"><div class="metric-sub">
                The programme computes a duration, the contract records a date, the estimate prices a scope and the
                field record measures progress. Each is right about its own subject; none of them looks at the others.
              </div></div>
              ${
                consistency.findings.length > 0
                  ? html`<div style="padding:11px 17px 4px">
                      ${consistency.findings.map(
                        (f) => html`<div class="notice ${raw(f.severity === 'CRITICAL' ? 'err' : 'warn')}" style="margin:0 0 9px">
                          <div>
                            <b>${f.check}</b>${f.exposureMinor ? html` · ${money(f.exposureMinor)}` : ''}${f.exposureDays ? html` · ${f.exposureDays} days` : ''}<br>
                            ${f.finding}<br>${f.consequence}
                          </div>
                        </div>`,
                      )}
                    </div>`
                  : html`<div style="padding:11px 17px 4px"><div class="notice ok">${consistency.summary}</div></div>`
              }
              <div style="padding:4px 17px 15px">
                <div class="split-list">
                  ${consistency.passed.map((p) => html`<div class="row"><span class="lbl">${p.split(' — ')[0]}</span><span class="val">${badge('agrees', 'good')}</span></div>`)}
                  ${consistency.skipped.map((sk) => html`<div class="row"><span class="lbl">${sk.check}</span><span class="val">${badge('not run', 'warn')} <span class="metric-sub">${sk.reason}</span></span></div>`)}
                </div>
                ${
                  consistency.skipped.length > 0
                    ? html`<div class="metric-sub" style="margin-top:9px">
                        A check that could not run has not passed. It has not been taken, and the two are different things.
                      </div>`
                    : ''
                }
                ${
                  consistency.commercialWithheld
                    ? html`<div class="metric-sub" style="margin-top:9px">Commercial detail is withheld from your role. The disagreements themselves stand.</div>`
                    : ''
                }
                ${
                  // A break in Bid → Contract → Subcontract → Commitment →
                  // Application → CVR is not two numbers disagreeing; it is a
                  // record attached to nothing, invisible precisely because
                  // nobody is looking at where it should have been. It is raised
                  // as an exception rather than left to be read — and raising it
                  // writes, so it is a button rather than a side effect of
                  // opening this page.
                  chainBreaks.length > 0
                    ? html`<div style="margin-top:12px">
                        <div class="metric-sub" style="margin-bottom:7px">
                          The data flow is broken at ${chainBreaks.length}
                          link${raw(chainBreaks.length === 1 ? '' : 's')}. Raising it records the exception and notifies
                          whoever owns the commercial position. The same break is only ever raised once, and it closes
                          itself when the link traces again.
                        </div>
                        ${
                          can('BUDGET_COST', 'R')
                            ? html`<button class="btn" id="raise-chain">Raise the exception</button>`
                            : html`<button class="btn quiet locked" disabled title="${blockedReason('BUDGET_COST', 'R')}">
                                Raise the exception 🔒
                              </button>`
                        }
                      </div>`
                    : ''
                }
              </div>
            </div>`
          : ''
      }

      <div id="control-insight" style="margin-bottom:14px"></div>

      <div class="grid g5" style="margin-bottom:14px">
        <div ${raw(drillable('This project', presentSources))}>
          <h3>This project</h3>
          <div class="metric ${raw(
            project.completenessPercent === null ? '' : project.completenessPercent >= 90 ? 'good' : project.completenessPercent >= 70 ? 'warn' : 'bad',
          )}">${project.completenessPercent === null ? '—' : pct(project.completenessPercent, 1)}</div>
          <div class="metric-sub">Of what is due and trackable in ${humanise(project.phase)}.</div>
        </div>
        <div class="card">
          <h3>Gaps</h3>
          <div class="metric ${raw(project.gaps.length === 0 ? 'good' : 'warn')}">${project.gaps.length}</div>
          <div class="metric-sub">
            ${project.blockingGaps.length > 0
              ? `${project.blockingGaps.length} of them stop the project moving on.`
              : 'None of them stop the project moving on — the rest is discipline.'}
          </div>
        </div>
        <div class="card">
          <h3>Not at this size</h3>
          <div class="metric">${project.stages.reduce((n, s) => n + s.notProportionate, 0)}</div>
          <div class="metric-sub">
            A ${project.projectScaleLabel} job does not need a programme baseline or a document control procedure. Demanding
            them is how a standard gets ignored.
          </div>
        </div>
        <div class="card">
          <h3>Not tracked here</h3>
          <div class="metric">${project.notTracked.length}</div>
          <div class="metric-sub">Real control items with no home in the platform yet. Excluded from the score, not hidden.</div>
        </div>
        <div ${raw(drillable('Lessons captured', lessonSources))}>
          <h3>Lessons captured</h3>
          <div class="metric orange">${lessons ? lessons.lessons.length : '—'}</div>
          <div class="metric-sub">
            ${lessons ? `Across ${lessons.contributingProjects} project${lessons.contributingProjects === 1 ? '' : 's'}.` : 'Not visible to your role.'}
          </div>
        </div>
      </div>

      ${
        project.blockingGaps.length > 0
          ? html`<div class="notice err" style="margin-bottom:14px">
              <div>
                <b>${project.blockingGaps.length} gap${project.blockingGaps.length === 1 ? '' : 's'} will stop this project at the phase gate.</b><br>
                ${project.blockingGaps.join(', ')}
              </div>
            </div>`
          : ''
      }

      ${project.stages.map(
        (stage) => html`
          <div class="card pad0" style="margin-bottom:14px">
            <h3 style="padding:15px 17px 0">
              ${stage.label}
              ${stage.completenessPercent === null ? badge('not yet due', '') : badge(pct(stage.completenessPercent, 0), stage.completenessPercent === 100 ? 'ok' : stage.completenessPercent >= 70 ? 'warn' : 'bad')}
            </h3>
            <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">${stage.purpose}</p>
            ${table({
              headers: ['Item', 'Status', 'Found', 'Why it is on the list'],
              align: ['', '', 'num', ''],
              rows: stage.items.map((item) => [
                item.status === 'NOT_TRACKED' || item.status === 'NOT_PROPORTIONATE'
                  ? html`<span style="color:var(--text-3)">${item.label}</span>`
                  : html`${item.label}${item.gateEnforced ? badge('gate', 'info') : ''}`,
                badge(STATUS_LABEL[item.status], STATUS_TONE[item.status]),
                item.found === undefined ? '—' : `${item.found} ${item.counts}`,
                html`<span style="font-size:12px;color:var(--text-3)">${
                  item.notTrackedReason ??
                  (item.status === 'NOT_PROPORTIONATE' ? `Applies from ${item.appliesFrom.toLowerCase()} projects upwards` : item.purpose)
                }</span>`,
              ]),
            })}
          </div>
        `,
      )}

      ${
        estate
          ? html`
            <div class="card pad0" style="margin-bottom:14px">
              <h3 style="padding:15px 17px 0">Every project against the same standard</h3>
              <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                Worst first. A project manager can see their own gaps; only this view can see that the business keeps
                missing the same thing.
              </p>
              ${table({
                headers: ['Project', 'Phase', 'Complete', 'Gaps', 'Blocking'],
                align: ['', '', 'num', 'num', ''],
                rows: estate.projects.map((p) => [
                  p.name,
                  badge(humanise(p.phase), ''),
                  p.completenessPercent === null ? '—' : pct(p.completenessPercent, 1),
                  p.gaps,
                  p.blockingGaps.length === 0 ? badge('clear', 'ok') : badge(`${p.blockingGaps.length}`, 'bad'),
                ]),
                empty: 'No projects',
              })}
            </div>

            ${
              estate.systemicGaps.length > 0
                ? html`<div class="card pad0" style="margin-bottom:14px">
                    <h3 style="padding:15px 17px 0">What the business is systematically missing</h3>
                    ${table({
                      headers: ['Item', 'Stage', 'Missing on', 'Why it matters'],
                      align: ['', '', 'num', ''],
                      rows: estate.systemicGaps.map((g) => [
                        g.label,
                        badge(humanise(g.stage), ''),
                        `${g.missingOn} of ${g.ofProjects}`,
                        html`<span style="font-size:12px;color:var(--text-3)">${g.purpose}</span>`,
                      ]),
                    })}
                  </div>`
                : ''
            }
          `
          : ''
      }

      ${
        lessons
          ? html`
            <div class="grid g2" style="margin-bottom:14px">
              <div class="card">
                <h3>What keeps costing money</h3>
                <p style="font-size:12.5px;color:var(--text-3);margin-bottom:11px">
                  One project getting ground conditions wrong is bad luck. The same category recurring across projects is
                  a business problem no project team was in a position to see.
                </p>
                ${
                  lessons.recurring.length === 0
                    ? html`<div class="empty"><b>Nothing recurring yet</b>Too few lessons to see a pattern.</div>`
                    : html`<div class="split-list">
                        ${lessons.recurring.map(
                          (r) => html`<div class="row">
                            <span class="lbl">${humanise(r.category)} — ${r.occurrences} on ${r.projects} project${r.projects === 1 ? '' : 's'}</span>
                            <span class="val">${money(r.costImpactMinor)}</span>
                          </div>`,
                        )}
                      </div>`
                }
              </div>
              <div class="card">
                <h3>Where the library stands</h3>
                ${
                  lessons.observations.length === 0
                    ? html`<div class="empty"><b>Nothing to report</b></div>`
                    : html`<div class="split-list">
                        ${lessons.observations.map((o) => html`<div class="row"><span class="lbl">${o}</span></div>`)}
                      </div>`
                }
              </div>
            </div>

            <div class="card pad0">
              <h3 style="padding:15px 17px 0">Lessons learned</h3>
              <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                Captured on the project that produced it and read from every other one, because a lesson only pays for
                itself on a different job.
              </p>
              ${table({
                headers: ['Lesson', 'Category', 'Stage', 'Cost', 'Days', 'Do this instead'],
                align: ['', '', '', 'num', 'num', ''],
                rows: lessons.lessons.map((l) => [
                  html`${l.title}${badge(l.kind === 'WENT_WELL' ? 'repeat this' : 'avoid this', KIND_TONE[l.kind])}`,
                  humanise(l.category),
                  humanise(l.stage),
                  l.costImpactMinor ? money(l.costImpactMinor) : '—',
                  l.scheduleImpactDays || '—',
                  html`<span style="font-size:12px;color:var(--text-3)">${l.recommendation}</span>`,
                ]),
                empty: 'No lessons captured — the business is paying for the same mistakes without a record of them',
              })}
            </div>
          `
          : ''
      }
    `,
  );

  void insightPanel(root.querySelector('#control-insight'), {
    projectId,
    areas: ['PROJECT_SETUP', 'EVIDENCE_AUDIT', 'RISK_REGISTER'],
    subject: 'project control and assurance',
    onChange: draw,
  });

  root.querySelector('#raise-chain')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await api.post(`/v1/projects/${projectId}/consistency/chain-exceptions`, {});
      // Said as it happened rather than as a generic success. "Raised 2" and
      // "already open, nobody re-notified" are different outcomes and a person
      // deciding whether to chase somebody needs to know which one this was.
      const parts = [];
      if (result.raised.length > 0) parts.push(`${result.raised.length} raised`);
      if (result.alreadyOpen.length > 0) parts.push(`${result.alreadyOpen.length} already open`);
      if (result.cleared.length > 0) parts.push(`${result.cleared.length} closed`);
      toast(
        parts.length > 0 ? 'Chain exception' : 'Nothing to raise',
        parts.length > 0 ? parts.join(' · ') : 'Every link traces end to end.',
        parts.length > 0 ? 'warn' : 'ok',
      );
      if (result.unaddressed) {
        toast(
          'Recorded, but not addressed',
          'Nobody on this tenancy holds Commercial Manager or Project Director, so nobody was told.',
          'warn',
        );
      }
      await draw();
    } catch (error) {
      button.disabled = false;
      toast('The exception could not be raised', error.detail ?? error.message ?? '', 'err');
    }
  });
}
