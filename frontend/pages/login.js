import { api } from '../lib/api.js';
import { html, initials, render, toast } from '../lib/ui.js';
import { signIn, signInWithCredentials } from '../app.js';

/**
 * Sign-in.
 *
 * Two paths, and which one appears is decided by the platform rather than by a
 * build flag.
 *
 * **The credential form is the real one** and is always present: email, then
 * the code that arrives by email. It is what a customer uses, and until now it
 * did not exist — this page offered only the identity picker below, so a
 * production deployment had no way in at all. Every credential could be
 * correct and nobody could sign in.
 *
 * **The identity picker is a demonstration affordance.** Signing in as the QS
 * and then as the regulator shows the permission model working, which is far
 * more convincing than a screenshot of a matrix. It needs
 * `/v1/console/identities`, which is refused in production — so the page asks,
 * and simply does not offer it when the answer is no. A refusal there is not an
 * error and is no longer displayed as one: it is the platform saying this is a
 * real deployment.
 *
 * The authentication itself is identical either way. Login issues an MFA
 * challenge and the token is only minted once the code verifies.
 */

const PHASES = ['Concept', 'Design', 'Tender', 'Construction', 'Commissioning', 'Handover', '30-yr O&M'];

export async function login(root) {
  render(
    root,
    html`<div class="login-page">
      <div class="login-brand">
        <a href="/" aria-label="CONSTRUX home"
           style="display:inline-flex;align-items:center;gap:11px;font-size:20px;font-weight:800;
                  letter-spacing:-.4px;color:inherit;text-decoration:none;align-self:flex-start">
          <svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path d="M4 27 L11 27 L11 12 L16 9 L16 27 L21 27 L21 5 L25 5 L25 27 L28 27" stroke="#8a9099" stroke-width="2.1" stroke-linejoin="round"/>
            <path d="M14 28 L28 6" stroke="#ff6600" stroke-width="4.4" stroke-linecap="square"/>
            <path d="M20 20 L28 28 L20 28 Z" fill="#4b5058"/>
          </svg>
          <span style="white-space:nowrap">CONSTRU<span style="color:var(--orange)">X</span></span>
        </a>
        <h1>The operating system for built assets.</h1>
        <p>
          One immutable data spine and seven AI engines governing the entire lifecycle.
          Every decision hash-chained, every forecast computed rather than guessed.
        </p>
        <div class="rail">${PHASES.map((p) => html`<div>${p}</div>`)}</div>
      </div>

      <div class="login-panel">
        <h2>Sign in</h2>

        <form id="credentials" novalidate>
          <div class="field">
            <label for="email">Work email</label>
            <input id="email" name="email" type="email" autocomplete="username" required
              placeholder="you@company.com">
          </div>

          <div class="field" id="code-field" hidden>
            <label for="code">Verification code</label>
            <input id="code" name="code" type="text" inputmode="latin" autocomplete="one-time-code"
              autocapitalize="characters" spellcheck="false" placeholder="6 characters">
            <p class="hint" id="code-hint"></p>
          </div>

          <button class="btn" type="submit" id="submit">Continue</button>
          <div id="login-error"></div>
        </form>

        <p class="hint" style="margin-top:16px">
          No account? <a href="/get-started">Start a trial</a> — no card, no call.
        </p>

        <div id="identities"></div>
      </div>
    </div>`,
  );

  wireCredentials();
  void offerDemonstrationIdentities();
}

// ------------------------------------------------------------ the real form

function wireCredentials() {
  const form = document.getElementById('credentials');
  const emailInput = document.getElementById('email');
  const codeField = document.getElementById('code-field');
  const codeInput = document.getElementById('code');
  const codeHint = document.getElementById('code-hint');
  const submit = document.getElementById('submit');
  const errorHost = document.getElementById('login-error');

  // Held between the two steps. The challenge identifies which sign-in attempt
  // the code belongs to, so a code from an earlier attempt cannot complete a
  // later one.
  let challenge = null;

  const fail = (message) => {
    render(errorHost, html`<div class="notice err" style="margin-top:12px">${message}</div>`);
  };
  const clearError = () => render(errorHost, html``);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();
    submit.disabled = true;

    try {
      if (!challenge) {
        const email = emailInput.value.trim();
        if (!email) {
          fail('Enter the email address your account was created with.');
          return;
        }

        challenge = await api.post('/v1/auth/login', { email }, { anonymous: true });
        challenge.email = email;

        codeField.hidden = false;
        emailInput.readOnly = true;
        submit.textContent = 'Sign in';

        // Outside production the platform returns the code, because there is no
        // mail server on a laptop. Filling it in is a convenience, never a
        // bypass — it still has to be verified.
        if (challenge.devCode) {
          codeInput.value = challenge.devCode;
          codeHint.textContent = 'Development mode: the code is filled in for you.';
        } else {
          codeHint.textContent = `Sent to ${email}. It expires in five minutes.`;
        }
        codeInput.focus();
        return;
      }

      const code = codeInput.value.trim();
      if (!code) {
        fail('Enter the code from your email.');
        return;
      }

      await signInWithCredentials({
        actorId: challenge.actorId,
        challengeId: challenge.challengeId,
        code,
      });
    } catch (error) {
      // A wrong code is worth another attempt against the same challenge; a
      // failure at the email step means starting over.
      if (challenge && /code|challenge|mfa/i.test(String(error.message))) {
        fail(`${error.message} — check the code and try again.`);
      } else {
        challenge = null;
        codeField.hidden = true;
        emailInput.readOnly = false;
        submit.textContent = 'Continue';
        fail(String(error.message));
      }
    } finally {
      submit.disabled = false;
    }
  });
}

// ------------------------------------------------- the demonstration picker

/**
 * Offer the seeded identities, but only where the platform provides them.
 *
 * A refusal here is the expected answer on any real deployment, so it renders
 * nothing at all rather than an error. The previous version showed
 * "Could not reach the platform" on the front door of a working system.
 */
async function offerDemonstrationIdentities() {
  const host = document.getElementById('identities');

  let bootstrap;
  try {
    bootstrap = await api.post('/v1/console/identities', {}, { anonymous: true });
  } catch {
    return;
  }
  if (!bootstrap?.identities?.length) return;

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
    html`<div class="nav-group-label" style="margin:26px 0 10px">Or explore a seeded project</div>
    <p class="hint" style="margin:0 0 12px">
      Each identity carries different permissions, and the platform enforces them.
    </p>
    ${customer.map(card)}
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
