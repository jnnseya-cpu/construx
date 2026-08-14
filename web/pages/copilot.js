import { api } from '../lib/api.js';
import { html, raw, render, toast } from '../lib/ui.js';
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

const SUGGESTIONS = [
  'What is our delay exposure and how do we recover it?',
  'How is the margin looking?',
  'Are we safe to keep working at height?',
  'What variations are outstanding?',
  'Show me the claim position',
  'What is left before handover?',
];

export async function copilot(root) {
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

      const grounding = (answer.grounding ?? [])
        .filter((f) => f.value !== '0' && f.label !== 'Project')
        .map((f) => `<div>• <b>${escapeHtml(f.label)}:</b> ${escapeHtml(f.value)} <span class="src">[${escapeHtml(f.source)}]</span></div>`)
        .join('');

      const chips = (answer.suggestedActions ?? [])
        .map(
          (a) =>
            `<span class="chip ${a.permitted ? '' : 'denied'}" title="${escapeHtml(a.permitted ? a.description : a.reason ?? '')}">${escapeHtml(a.command)}${a.permitted ? '' : ' · denied'}</span>`,
        )
        .join('');

      const engine = answer.intent ? `<div class="src" style="margin-bottom:7px">${escapeHtml(answer.intent.engine)} engine · match ${answer.intent.match}</div>` : '';

      const body = String(answer.answer ?? '')
        .split('\n')
        .filter((line) => line.trim())
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
