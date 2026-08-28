import { api } from '../lib/api.js';
import { head, refusal } from '../lib/estate.js';
import { badge, html, raw, render, table, time, toast } from '../lib/ui.js';

/**
 * Reports.
 *
 * Every figure on this console already exists on some screen. What did not exist
 * was any way to take a *position* away from it — the estate as it stood on a
 * date, in one document, to put in front of a board, an auditor or an investor.
 * Screenshots of five screens are not that.
 *
 * A report is composed at the moment it is asked for, from the same reads the
 * console uses, so a report and the screen it came from cannot disagree. Nothing
 * is stored: a report is a view of the record, not a new fact about it, and
 * committing one would put a second copy of every number inside the thing the
 * numbers are derived from.
 *
 * **Each report prints what it excludes.** The operator layer cannot see
 * delivery data, so an estate report is a commercial and operational document
 * and says so on its face rather than looking like a complete picture.
 */

export async function reports(root) {
  const catalogue = await api.get('/v1/admin/reports').catch((error) => ({ error }));

  if (catalogue.error) {
    render(root, html`${head({ title: 'Reports' })}${refusal('The report catalogue', catalogue.error)}`);
    return;
  }

  const draw = (report) =>
    render(
      root,
      html`
        ${head({
          title: 'Reports',
          intent:
            'Composed when you ask for one, from the same reads every other screen uses — so a report and the screen ' +
            'it came from cannot disagree. Nothing is stored: a report is a view of the record, not a new fact about it.',
        })}

        <section class="grid g3" style="margin-bottom:14px">
          ${(catalogue.reports ?? []).map(
            (definition) => html`<div class="card">
              <h2>${definition.title}</h2>
              <div class="metric-sub" style="margin:8px 0 14px">${definition.purpose}</div>
              <button class="btn ${raw(report?.id === definition.id ? 'primary' : 'quiet')} sm" data-report="${definition.id}">
                ${report?.id === definition.id ? 'Showing' : 'Compose it'}
              </button>
            </div>`,
          )}
        </section>

        ${report
          ? html`
              <div class="card" style="margin-bottom:14px">
                <h2>${report.title}</h2>
                <div class="metric-sub" style="margin:8px 0 0">
                  ${report.purpose}<br />
                  Composed ${time(report.generatedAt)} by ${report.generatedBy} · from live positions, not from a stored copy.
                </div>
                <div class="actions" style="margin-top:12px">
                  <button class="btn quiet sm" id="print-report">Print or save as PDF</button>
                  <button class="btn quiet sm" data-report="${report.id}">Recompose from live figures</button>
                </div>
              </div>

              ${report.sections.map(
                (section) => html`<div class="card pad0" style="margin-bottom:14px">
                  <h2 style="padding:15px 17px 0">${section.heading}</h2>
                  ${section.intent ? html`<div class="metric-sub" style="padding:0 17px 10px">${section.intent}</div>` : ''}
                  ${section.rows
                    ? html`<div style="padding:0 17px 15px">
                        <div class="split-list">
                          ${section.rows.map(
                            (row) => html`<div class="row" style="align-items:flex-start;gap:14px">
                              <span class="lbl" style="flex:1 1 0;min-width:0">
                                ${row.label}
                                ${row.note ? html`<br /><span class="metric-sub">${row.note}</span>` : ''}
                              </span>
                              <span class="val">${row.value}</span>
                            </div>`,
                          )}
                        </div>
                      </div>`
                    : ''}
                  ${section.table
                    ? table({
                        headers: section.table.headers,
                        rows: section.table.rows,
                        empty: section.table.empty,
                      })
                    : ''}
                </div>`,
              )}

              <div class="card">
                <h2>What this report does not contain ${badge(String(report.excludes.length), 'info')}</h2>
                <div class="metric-sub" style="margin:8px 0 12px">
                  Printed on the report rather than left out, so nobody reads it as a complete picture of something it
                  deliberately does not cover.
                </div>
                <div class="split-list">
                  ${report.excludes.map((entry) => html`<div class="row"><span class="lbl">${entry}</span></div>`)}
                </div>
              </div>
            `
          : html`<div class="empty">
              <b>Choose a report.</b>Each one is composed from the live positions when you press it, so it is the estate
              as it stands right now rather than as it stood when somebody last generated one.
            </div>`}
      `,
    );

  const wire = (report) => {
    draw(report);
    for (const button of root.querySelectorAll('[data-report]')) {
      button.addEventListener('click', async () => {
        const id = button.getAttribute('data-report');
        button.disabled = true;
        button.textContent = 'Composing…';
        try {
          const composed = await api.get(`/v1/admin/reports/${id}`);
          wire(composed);
        } catch (error) {
          toast('Could not compose that report', error.message, 'err');
          button.disabled = false;
        }
      });
    }
    // The browser's own print, which is also how it is saved as a PDF. The
    // platform's PDF renderer builds *branded customer documents* against a
    // project; an operator report has no customer and no project, and running it
    // through that path would put a client's branding on the company's own
    // internal position.
    document.getElementById('print-report')?.addEventListener('click', () => window.print());
  };

  wire(null);
}
