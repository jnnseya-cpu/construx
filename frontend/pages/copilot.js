import { api } from '../lib/api.js';
import { aiModeNotice } from '../lib/insight.js';
import { heatmap, pieChart } from '../lib/charts.js';
import { badge, esc, html, humanise, raw, render, table, toast } from '../lib/ui.js';
import { state } from '../app.js';

/**
 * Copilot.
 *
 * Answers are read from project state, and the copilot says the record is empty
 * rather than answering from general construction knowledge. It proposes
 * commands; it never runs them — a suggestion takes the reader to the screen
 * the command is run on, where the same authorisation applies as everywhere
 * else.
 *
 * Suggested actions the current role cannot perform are shown with the
 * authorisation reason on the screen rather than in a tooltip, because "you
 * can't do that, and here is who can" is more useful than a hidden button —
 * but only if it is actually said. For a long time this page printed the
 * command's internal id and put the reason in a `title` attribute, which
 * delivered the clutter of that principle and none of the help.
 */

// Six questions from a desk and three from the workface. The second group is
// the point: everything above is a question somebody asks sitting down, and the
// person hardest for this platform to reach is standing up.
const SUGGESTIONS = [
  'What is our delay exposure and how do we recover it?',
  'How is the margin looking?',
  'Are we safe to keep working at height?',
  'What variations are outstanding?',
  'Show me the claim position',
  'What is left before handover?',
  'Is there a permit open, and who is it for?',
  'Has anybody been briefed on the method statement?',
  'What did the diary record yesterday?',
];

export async function copilot(root) {
  // Published by the platform, not declared here: each engine's name, what it
  // is for, and the phases it may run in. The gap this closes is that the
  // behaviour was already role-specific and the *presentation* was not —
  // nothing told a QS they were talking to a commercial analyst rather than a
  // general assistant, so the specialism was invisible at the point of use.
  const plane = await api.get('/v1/ai/control-plane').catch(() => null);
  const contracts = plane?.engineContracts ?? {};
  const phase = state.project?.phase;

  const modes = Object.entries(contracts).map(([engine, contract]) => ({
    engine,
    ...contract,
    // Whether a *charged* engine run may execute in this phase — `runAI`
    // refuses one outside its phases before any ACU is held. It is not whether
    // the copilot will answer: asking reads project state and spends nothing,
    // so a commercial question at OPERATIONS is answered from the final account
    // even though a paid commercial run would be refused there.
    runsHere: phase === undefined || (contract.activeInPhases ?? []).includes(phase),
  }));

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Copilot</h1>
          <p>Grounded in this project's Golden Thread. It proposes commands rather than executing them, and every figure it quotes names the record it came from.</p>
        </div>
      </div>

      <!--
        Said before the first answer, not after it.

        The copilot's replies are short and factual by construction, and on a
        deployment with no provider configured they are short because nothing
        was asked rather than because a model answered badly. A reader cannot
        tell those apart from the answer alone, and the one who reported this
        page as a prototype had reached the wrong conclusion for exactly that
        reason.
      -->
      ${aiModeNotice(plane)}

      <div class="composer">
        <input type="text" id="question" placeholder="Ask about programme, cost, risk, safety, change, claims, design or handover…" autocomplete="off">
        <button class="btn" id="ask">Ask</button>
      </div>

      <div class="chips" style="margin-bottom:20px" id="suggestions">
        ${SUGGESTIONS.map((s) => html`<button class="chip" data-q="${s}" style="cursor:pointer">${s}</button>`)}
      </div>

      ${copilotCharts(modes, phase)}

      ${
        modes.length > 0
          ? html`<div class="card pad0" style="margin-bottom:20px">
              <h2 style="padding:15px 17px 0">Who you are actually talking to</h2>
              ${table({
                headers: ['Mode', 'What it is for', 'What it reads', 'Engine runs here'],
                rows: modes.map((m) => [
                  html`<b>${m.name}</b>`,
                  m.purpose,
                  html`<span class="metric-sub">${(m.inputs ?? []).join(' · ')}</span>`,
                  m.runsHere
                    ? badge('Yes', 'ok')
                    : badge(`Not in ${humanise(phase ?? '')}`, 'neutral'),
                ]),
              })}
              <div class="metric-sub" style="padding:0 17px 14px">
                One question, routed to the specialist that can answer it. The last column is about <b>charged engine
                runs</b>: one outside its phase is refused before anything is reserved, because an answer assembled
                from nothing is worse than a refusal. Asking here spends nothing and reads project state, so a
                commercial question during operations is still answered — from the final account rather than from a
                live cost report.
              </div>
            </div>`
          : ''
      }

      <div class="chat" id="chat"></div>
    `,
  );

  const input = document.getElementById('question');
  const chat = document.getElementById('chat');

  async function ask(question) {
    if (!question.trim()) return;
    input.value = '';

    chat.insertAdjacentHTML('beforeend', `<div class="bubble me">${escapeHtml(question)}</div>`);
    const pending = document.createElement('div');
    pending.className = 'bubble ai';
    pending.textContent = 'Reading project state…';
    chat.append(pending);
    pending.scrollIntoView({ block: 'end' });

    try {
      const answer = await api.post(`/v1/projects/${state.session.projectId}/ask`, { question });

      // A citation you can open, where the fact came from one record.
      //
      // `[SiteDiary]` names a register and is where this started; it tells the
      // reader which pile the answer came out of and leaves them to go and find
      // it. Where the fact *is* one record, the source carries its id and the
      // delegated drill listener opens that record's own history — the same
      // affordance every KPI on the platform already has, for the same reason:
      // a figure nobody can open is a figure nobody can check.
      //
      // A count over a register has no id and correctly gets no link. Pointing
      // "eleven permits" at one permit would be a citation that does not support
      // the claim it is attached to.
      const grounding = (answer.grounding ?? [])
        .filter((f) => f.value !== '0' && f.label !== 'Project')
        .map((f) => {
          const cite = f.refId
            ? `<span class="src cite" tabindex="0" data-drill='${escapeHtml(JSON.stringify([{ refType: f.source, refId: f.refId }]))}' data-drill-label="${escapeHtml(f.label)}">[${escapeHtml(f.source)} ↗]</span>`
            : `<span class="src">[${escapeHtml(f.source)}]</span>`;
          return `<div>• <b>${escapeHtml(f.label)}:</b> ${escapeHtml(f.value)} ${cite}</div>`;
        })
        .join('');

      /*
       * What to do next, as something that can be done.
       *
       * This rendered `cost:publishCVR · denied` in a span with no handler —
       * a database command id, a refusal, and no way to act on either. A reader
       * asking why margin had eroded got a routing receipt and two dead chips,
       * which is a fair description of a prototype.
       *
       * Three changes, and the header's stated principle — "you can't do that,
       * and here is who can" — is finally what happens:
       *
       * - A permitted suggestion is a button that goes to the screen it is run
       *   on. `goTo` comes from the server, from the capability area the
       *   suggestion already carried.
       * - Everything is named in the engine's published words rather than its
       *   command id.
       * - A refusal is on the screen instead of in a `title` nobody hovers.
       */
      const actions = answer.suggestedActions ?? [];
      const runnable = actions.filter((a) => a.permitted);
      const refused = actions.filter((a) => !a.permitted);

      const chips = [
        ...runnable.map(
          (a) =>
            `<button class="chip" data-goto="${escapeHtml(a.goTo)}" title="${escapeHtml(a.description)}">${escapeHtml(a.label ?? a.command)} →</button>`,
        ),
        ...refused.map(
          (a) =>
            `<span class="chip denied">${escapeHtml(a.label ?? a.command)} — ${escapeHtml(
              (a.reason ?? 'not available to your role').replace(/\.$/, ''),
            )}</span>`,
        ),
      ].join('');

      // Named, not coded. `RESOURCE_COST` is a database column; "Commercial
      // analyst" is a thing a quantity surveyor can decide whether to trust.
      const contract = answer.intent ? contracts[answer.intent.engine] : undefined;
      const engine = answer.intent
        ? `<div class="src" style="margin-bottom:7px"><b>${escapeHtml(contract?.name ?? answer.intent.engine)}</b>${
            contract?.purpose ? ` · ${escapeHtml(contract.purpose.toLowerCase())}` : ''
          } · ${
            // What the number is about, said in words. "match 0.667" reads as
            // confidence in the *answer*, which would be wrong: every figure
            // below is arithmetic over the record. What can be wrong is which
            // subject the question was taken to be about.
            answer.confidence >= 0.66
              ? 'read as a question about this'
              : `read as a question about this, though not confidently${
                  answer.alternatives?.length ? ' — see the other readings below' : ''
                }`
          }</div>`
        : '';

      // The answer text already lists the grounding facts as bullets, and they
      // are rendered again below with their sources. Keep the prose, drop the
      // duplicate bullets.
      const body = String(answer.answer ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('•'))
        .map((line) => `<div>${escapeHtml(line)}</div>`)
        .join('');

      pending.innerHTML = `${engine}${body}${grounding ? `<div style="margin-top:8px">${grounding}</div>` : ''}${chips ? `<div class="chips">${chips}</div>` : ''}`;
    } catch (error) {
      pending.classList.add('err');
      pending.textContent = error.message;
      toast('Copilot failed', error.message, 'err');
    }
    chat.scrollIntoView({ block: 'end' });
  }

  document.getElementById('ask').addEventListener('click', () => ask(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') ask(input.value);
  });
  document.getElementById('suggestions').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-q]');
    if (chip) ask(chip.dataset.q);
  });

  // Open with something on screen rather than an empty panel.
  await ask(SUGGESTIONS[0]);
}

/*
 * The console's one escaper, not a second weaker one.
 *
 * This file used to declare its own `escapeHtml` escaping `&`, `<` and `>` and
 * **not** `"` or `'` — while using it inside two double-quoted attributes
 * (`data-drill-label="…"`, `title="…"`) and one single-quoted one
 * (`data-drill='…'`). A quote reaching any of them closes the attribute and
 * starts a new one.
 *
 * Nothing can reach them today: the grounding labels are literals in
 * `ai/conversation.ts` and the denial reasons are literals in `identity/abac.ts`.
 * But that is a property of data somewhere else, and a safety property that
 * holds only while nobody introduces a label with a quote in it is a safety
 * property with a date on it.
 *
 * `esc` from the design system escapes all five. One escaper, so there is one
 * thing to get right.
 */
const escapeHtml = esc;

/**
 * Which engine answers, and where a charged run would be refused.
 *
 * The distinction this screen has to keep straight is the one the table's last
 * column makes in four words. Asking reads project state and spends nothing, so
 * the copilot answers a commercial question at OPERATIONS from the final
 * account — while a *charged* commercial engine run at OPERATIONS is refused
 * before any ACU is held.
 *
 * The grid is the same fact across every phase at once: a row lit only at
 * TENDER is an engine whose paid runs belong there, not an engine that stops
 * talking to you afterwards. The footnote says so, because a grid of lit and
 * unlit cells reads as "available" and "unavailable" unless it is told not to.
 */
function copilotCharts(modes, phase) {
  if (modes.length === 0) return '';

  const phases = [...new Set(modes.flatMap((mode) => mode.activeInPhases ?? []))];
  if (phases.length === 0) return '';

  const values = modes.map((mode) => phases.map((entry) => ((mode.activeInPhases ?? []).includes(entry) ? 1 : 0)));

  const here = [
    { label: 'Charged runs allowed here', value: modes.filter((mode) => mode.runsHere).length, tone: 'ok' },
    { label: 'Charged runs refused here', value: modes.filter((mode) => !mode.runsHere).length, tone: 'warn' },
  ].filter((slice) => slice.value > 0);

  return html`
    <div class="card" style="margin-bottom:20px">
      <h2>Where each engine's charged runs belong</h2>
      ${raw(
        heatmap({
          title: 'Engines against project phase',
          rows: modes.map((mode) => humanise(String(mode.name ?? mode.engine))),
          columns: phases.map((entry) => humanise(entry)),
          values,
          format: (value) => (value === 1 ? 'a charged run may execute' : 'a charged run is refused'),
          empty: 'No engine publishes a phase contract.',
          footnote:
            `This project is at ${phase ? humanise(phase) : 'no phase'}. ` +
            'An unlit cell is not an engine that stops answering — asking reads project state and spends nothing, so a ' +
            'commercial question at OPERATIONS is answered from the final account. It is where a *paid* run is refused, ' +
            'before any ACU is held.',
        }),
      )}
    </div>

    <div class="card" style="margin-bottom:20px">
      <h2>What would be charged at this phase</h2>
      ${raw(
        pieChart({
          title: 'Engines by whether a paid run may execute here',
          data: here,
          centreLabel: String(modes.length),
          format: (value) => `${value} engine${value === 1 ? '' : 's'}`,
          empty: 'No engine publishes a phase contract.',
          footnote:
            'The copilot proposes commands rather than executing them, and every figure it quotes names the record it ' +
            'came from. Neither half of this chart changes that.',
        }),
      )}
    </div>
  `;
}
