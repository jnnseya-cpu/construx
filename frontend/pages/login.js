import { api } from '../lib/api.js';
import { html, initials, render, toast } from '../lib/ui.js';
import { completeSecondFactor, signIn, signInWithCredentials } from '../app.js';

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
  // `/app?as=<email>` — the way in from the demonstration page, where every
  // identity is a card and the card is a link. It is a shortcut through this
  // screen and not around it: the same challenge is issued and the same code is
  // verified, and an address the platform will not hand a code for lands back
  // here with the form filled in rather than signed in.
  const shortcut = new URLSearchParams(location.search).get('as');

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

          <div class="field" id="factor-field" hidden>
            <label for="factor">Authenticator app code</label>
            <input id="factor" name="factor" type="text" inputmode="numeric" autocomplete="one-time-code"
              spellcheck="false" placeholder="6 digits, or a recovery code">
            <p class="hint" id="factor-hint"></p>
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

  const resumeAtCode = wireCredentials();

  if (shortcut) {
    await signInFromLink(shortcut, resumeAtCode);
    return;
  }

  void offerDemonstrationIdentities();
}

// ------------------------------------------------------- the /app?as= link

/**
 * Sign in from a demonstration link.
 *
 * The demonstration page lists identities and each one is an anchor, because an
 * anchor works with scripting disabled and a button does not. So the address
 * arrives in the query string, and this consumes it.
 *
 * Three things it deliberately does not do.
 *
 * **It does not bypass anything.** `/v1/auth/login` issues a real challenge and
 * `/v1/auth/mfa/verify` mints the token. The only difference from typing the
 * address into the form is that the code is already in hand — and the platform
 * decides that, not this page: `devCode` outside production, `demoCode` for an
 * identity the demonstration seed marked, and nothing at all for anybody else.
 *
 * **It does not silently fail.** An address that gets no code back is a real
 * account, and the honest outcome is the ordinary form with that address in it
 * and a line saying the code has to come from the mailbox.
 *
 * **It does not stay in the URL.** The query is cleared before the attempt, so a
 * refresh, a back button or a shared link that has been sitting in somebody's
 * history does not sign a second person in as the first.
 */
async function signInFromLink(email, resumeAtCode) {
  const form = document.getElementById('credentials');
  const emailInput = document.getElementById('email');
  const errorHost = document.getElementById('login-error');

  emailInput.value = email;
  history.replaceState({}, '', '/app');

  const stopHere = (message, tone = 'err') => {
    for (const field of form.elements) field.disabled = false;
    render(errorHost, html`<div class="notice ${tone}" style="margin-top:12px">${message}</div>`);
    void offerDemonstrationIdentities();
  };

  for (const field of form.elements) field.disabled = true;
  render(errorHost, html`<div class="notice" style="margin-top:12px">Signing you in as ${email}…</div>`);

  let challenge;
  try {
    challenge = await api.post('/v1/auth/login', { email }, { anonymous: true });
  } catch (error) {
    stopHere(`${error.message} — sign in with an address that has an account, or start a trial.`);
    return;
  }

  const code = challenge.devCode ?? challenge.demoCode;
  if (!code) {
    // Not a demonstration identity. Worded so it says nothing about whether the
    // address has an account at all — the login route answers the same way
    // either way, on purpose, and a message here that distinguished them would
    // hand back the account check the route refuses to give.
    //
    // The challenge that was just issued is live and any code it produced is in
    // that mailbox, so the form picks up at the second step rather than throwing
    // it away and making them ask for a second one.
    stopHere(
      `${email} is not a demonstration account, so nothing is filled in for you. ` +
        'If it has an account here, the code has gone to that mailbox — enter it below.',
      'warn',
    );
    resumeAtCode(challenge, email);
    return;
  }

  try {
    const outcome = await signInWithCredentials({
      actorId: challenge.actorId,
      challengeId: challenge.challengeId,
      code,
    });
    if (outcome?.secondFactorRequired) {
      // A demonstration identity somebody has enrolled an authenticator on. The
      // form picks up at the app's code rather than pretending it is signed in.
      stopHere('This account holds an authenticator app — enter its code below.', 'warn');
      resumeAtCode(challenge, email, outcome);
    }
  } catch (error) {
    stopHere(`${error.message} — the demonstration sign-in did not complete.`);
  }
}

// ------------------------------------------------------------ the real form

/**
 * Wire the two-step form, and hand back the step-two transition.
 *
 * The challenge is closure state on purpose — nothing outside this function has
 * any business replacing a live sign-in attempt. The one caller that legitimately
 * arrives holding a challenge is the `?as=` link, when the address turned out to
 * belong to a real account: it has already issued the challenge and throwing it
 * away would mean a second code in the mailbox and only one of them working.
 */
function wireCredentials() {
  const form = document.getElementById('credentials');
  const emailInput = document.getElementById('email');
  const codeField = document.getElementById('code-field');
  const codeInput = document.getElementById('code');
  const codeHint = document.getElementById('code-hint');
  const factorField = document.getElementById('factor-field');
  const factorInput = document.getElementById('factor');
  const factorHint = document.getElementById('factor-hint');
  const submit = document.getElementById('submit');
  const errorHost = document.getElementById('login-error');

  // Held between the two steps. The challenge identifies which sign-in attempt
  // the code belongs to, so a code from an earlier attempt cannot complete a
  // later one.
  let challenge = null;
  // The third step, for an account that holds an authenticator app: the
  // emailed code was right, and the platform now wants the app's code before
  // it mints anything.
  let factor = null;

  /**
   * Move to the authenticator step. The emailed code is done with; what is
   * asked for now is something the person holds, not something sent to them.
   */
  const askForFactor = (issued) => {
    factor = issued;
    codeField.hidden = true;
    factorField.hidden = false;
    submit.textContent = 'Sign in';
    if (issued.devFactorCode) {
      factorInput.value = issued.devFactorCode;
      factorHint.textContent = 'Development mode: the authenticator code is filled in for you.';
    } else {
      factorHint.textContent = 'Open your authenticator app and enter the six-digit code for CONSTRUX. Lost the phone? A recovery code works here too.';
    }
    factorInput.focus();
  };

  const fail = (message) => {
    render(errorHost, html`<div class="notice err" style="margin-top:12px">${message}</div>`);
  };
  const clearError = () => render(errorHost, html``);

  /**
   * Move to the code step against an issued challenge.
   *
   * The platform returns the code in two cases, and says which: outside
   * production, where there is no mail server on a laptop; and for a seeded
   * demonstration identity, whose address belongs to nobody. Filling it in is a
   * convenience, never a bypass — it still has to be verified, and typing a real
   * customer's address here gets no code back under either rule.
   */
  const askForCode = (issued, email, secondFactor) => {
    challenge = issued;
    challenge.email = email;
    if (secondFactor) {
      emailInput.value = email;
      emailInput.readOnly = true;
      askForFactor(secondFactor);
      return;
    }

    codeField.hidden = false;
    emailInput.value = email;
    emailInput.readOnly = true;
    submit.textContent = 'Sign in';

    if (challenge.devCode) {
      codeInput.value = challenge.devCode;
      codeHint.textContent = 'Development mode: the code is filled in for you.';
    } else if (challenge.demoCode) {
      codeInput.value = challenge.demoCode;
      codeHint.textContent = 'Demonstration account: the code is filled in for you.';
    } else {
      codeHint.textContent = `Sent to ${email}. It expires in five minutes.`;
    }
    codeInput.focus();
  };

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

        askForCode(await api.post('/v1/auth/login', { email }, { anonymous: true }), email);
        return;
      }

      if (factor) {
        const code = factorInput.value.trim();
        if (!code) {
          fail('Enter the code from your authenticator app, or a recovery code.');
          return;
        }
        await completeSecondFactor({ actorId: factor.actorId, factorChallengeId: factor.factorChallengeId, code });
        return;
      }

      const code = codeInput.value.trim();
      if (!code) {
        fail('Enter the code from your email.');
        return;
      }

      const outcome = await signInWithCredentials({
        actorId: challenge.actorId,
        challengeId: challenge.challengeId,
        code,
      });
      if (outcome?.secondFactorRequired) askForFactor(outcome);
    } catch (error) {
      // A wrong code is worth another attempt against the same challenge; a
      // failure at the email step means starting over.
      if ((challenge || factor) && /code|challenge|mfa|verification/i.test(String(error.message))) {
        // The platform says the same thing for a mistyped code, a code older
        // than five minutes, a code from an earlier request, and a challenge
        // the server no longer holds — it keeps them in memory, so a restart
        // between "send" and "sign in" ends every code in flight. Retyping
        // cannot recover three of those four; a fresh code recovers all of
        // them, so the door to one is here rather than a reload away.
        const email = challenge?.email ?? emailInput.value.trim();
        render(
          errorHost,
          html`<div class="notice err" style="margin-top:12px">
            <div>
              ${error.message}. Check the code — and if it is more than five minutes old, from an earlier request, or the
              platform was updated since it was sent, it will not work again.
              <button class="btn quiet sm" type="button" data-new-code style="margin-left:8px">Send a new code</button>
            </div>
          </div>`,
        );
        errorHost.querySelector('[data-new-code]')?.addEventListener('click', async () => {
          clearError();
          submit.disabled = true;
          try {
            challenge = null;
            factor = null;
            factorField.hidden = true;
            codeInput.value = '';
            askForCode(await api.post('/v1/auth/login', { email }, { anonymous: true }), email);
            codeHint.textContent = `A new code has been sent to ${email}. Codes sent before it no longer work.`;
          } catch (again) {
            fail(String(again.message));
          } finally {
            submit.disabled = false;
          }
        });
      } else {
        challenge = null;
        factor = null;
        codeField.hidden = true;
        factorField.hidden = true;
        emailInput.readOnly = false;
        submit.textContent = 'Continue';
        fail(String(error.message));
      }
    } finally {
      submit.disabled = false;
    }
  });

  return askForCode;
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
    html`<div class="nav-group-label" style="margin:26px 0 10px">Or explore a demonstration project</div>
    <p class="hint" style="margin:0 0 12px">
      Open accounts on a sandbox tenancy — anyone may sign in as any of them. Each carries different
      permissions, and the platform enforces them exactly as it does for a customer.
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
