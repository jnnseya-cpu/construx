import { api } from '../lib/api.js';
import { html, initials, raw, render, toast } from '../lib/ui.js';
import { signIn } from '../app.js';

/**
 * Sign-in.
 *
 * The identity picker is a demonstration affordance: signing in as the QS and
 * then as the regulator shows the permission model working, which is far more
 * convincing than a screenshot of a matrix. The authentication itself is real —
 * login issues an MFA challenge, and the token is only minted once it verifies.
 */

const PHASES = ['Concept', 'Design', 'Tender', 'Construction', 'Commissioning', 'Handover', '30-yr O&M'];

export async function login(root) {
  render(
    root,
    html`<div class="login-page">
      <div class="login-brand">
        <div style="display:flex;align-items:center;gap:11px;font-size:20px;font-weight:800;letter-spacing:-.4px">
          <svg width="26" height="26" viewBox="0 0 32 32" fill="none">
            <path d="M4 27 L11 27 L11 12 L16 9 L16 27 L21 27 L21 5 L25 5 L25 27 L28 27" stroke="#8a9099" stroke-width="2.1" stroke-linejoin="round"/>
            <path d="M14 28 L28 6" stroke="#ff6600" stroke-width="4.4" stroke-linecap="square"/>
            <path d="M20 20 L28 28 L20 28 Z" fill="#4b5058"/>
          </svg>
          CONSTRU<span style="color:var(--orange)">X</span>
        </div>
        <h1>The operating system for built assets.</h1>
        <p>
          One immutable data spine and seven AI engines governing the entire lifecycle.
          Every decision hash-chained, every forecast computed rather than guessed.
        </p>
        <div class="rail">${PHASES.map((p) => html`<div>${p}</div>`)}</div>
      </div>

      <div class="login-panel">
        <h2>Sign in</h2>
        <p class="hint">Choose an identity. Each one carries different permissions, and the platform enforces them.</p>
        <div id="identities"><div class="skeleton" style="height:56px;margin-bottom:8px"></div><div class="skeleton" style="height:56px;margin-bottom:8px"></div><div class="skeleton" style="height:56px"></div></div>
      </div>
    </div>`,
  );

  const host = document.getElementById('identities');

  let bootstrap;
  try {
    // The first call seeds a full lifecycle, so it can take a moment.
    bootstrap = await api.post('/v1/console/identities', {}, { anonymous: true });
  } catch (error) {
    render(host, html`<div class="notice err">Could not reach the platform: ${String(error.message)}</div>`);
    return;
  }

  // Order so the roles that best show the model come first.
  const preferred = ['PM', 'QS', 'PLANNER', 'OWNER', 'SAFETY', 'BIM', 'FM', 'QAQC', 'ENTERPRISE_ADMIN', 'REGULATOR'];
  const identities = [...bootstrap.identities].sort(
    (a, b) => preferred.indexOf(a.roles[0]) - preferred.indexOf(b.roles[0]),
  );

  // The operator is a different account layer, not a senior customer role, so it
  // is listed apart from the delivery team rather than mixed in with it.
  const customer = identities.filter((i) => i.layer !== 'PLATFORM_ADMIN');
  const operators = identities.filter((i) => i.layer === 'PLATFORM_ADMIN');

  const card = (identity) => html`<button class="identity" data-email="${identity.email}">
    <span class="avatar">${initials(identity.name)}</span>
    <span class="who"><b>${identity.name}</b><span>${identity.email}</span></span>
    <span class="role">${identity.roles.join(' · ')}</span>
  </button>`;

  render(
    host,
    html`${customer.map(card)}
    ${
      operators.length
        ? html`<div class="nav-group-label" style="margin:16px 0 8px">Platform layer — no access to delivery data</div>
            ${operators.map(card)}`
        : ''
    }
    <p class="hint" style="margin-top:18px">
      Signed in against <b style="color:var(--text-2)">${bootstrap.project ?? bootstrap.portfolio}</b> —
      a live seeded project carried from concept through to operations.
    </p>`,
  );

  host.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-email]');
    if (!button) return;
    button.disabled = true;
    button.style.opacity = '.6';
    try {
      await signIn(identities.find((i) => i.email === button.dataset.email));
    } catch (error) {
      toast('Sign-in failed', error.message, 'err');
      button.disabled = false;
      button.style.opacity = '1';
    }
  });
}
