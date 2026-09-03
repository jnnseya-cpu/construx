import { api } from '../lib/api.js';
import { badge, html, humanise, raw, render, table, toast } from '../lib/ui.js';
import { state } from '../app.js';

/**
 * Copilot.
 *
 * Answers are read from project state, and the copilot says the record is empty
 * rather than answering from general construction knowledge. It proposes
 * commands; it never runs them. Suggested actions the current role cannot
 * perform are shown greyed with the authorisation reason, because "you can't do
 * that, and here is who can" is more useful than a hidden button.
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

      <div class="composer">
        <input type="text" id="question" placeholder="Ask about programme, cost, risk, safety, change, claims, design or handover…" autocomplete="off">
        <button class="btn" id="ask">Ask</button>
      </div>

      <div class="chips" style="margin-bottom:20px" id="suggestions">
        ${SUGGESTIONS.map((s) => html`<button class="chip" data-q="${s}" style="cursor:pointer">${s}</button>`)}
      </div>

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

      const chips = (answer.suggestedActions ?? [])
        .map(
          (a) =>
            `<span class="chip ${a.permitted ? '' : 'denied'}" title="${escapeHtml(a.permitted ? a.description : a.reason ?? '')}">${escapeHtml(a.command)}${a.permitted ? '' : ' · denied'}</span>`,
        )
        .join('');

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

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
