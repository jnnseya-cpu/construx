import { api, ApiError } from '../lib/api.js';
import { html, money, render } from '../lib/ui.js';

/**
 * Start an account.
 *
 * The public site has been selling this button since the pricing page was
 * written — "Start with Core Project" links here with the package in the query
 * string — and until now nothing answered. The shell drew the sign-in screen
 * instead, which asks for the credentials of an account the person is trying to
 * create. Every self-serve customer hit that wall.
 *
 * Three things this page will not do, each of which the platform decides rather
 * than the browser:
 *
 * **It does not say whether the address is already in use.** `POST /v1/signup`
 * answers identically either way, and this page shows that answer verbatim. The
 * address owner is told by email; the person at the keyboard learns nothing.
 *
 * **It does not create an account.** It creates a pending registration. The
 * tenancy comes into existence when the link in the confirmation email is
 * pressed, which is the first moment anybody has proved they own the address.
 *
 * **It does not list the packages itself.** They come from
 * `/v1/signup/account-types`, with `selfServe` deciding what can be chosen — so
 * a package that is sold rather than provisioned cannot be bought here by
 * editing the URL, and a price changed on the server changes here too.
 */

export async function signup(root) {
  render(root, html`<div class="login-page"><div class="login-panel">
    <p class="hint">Loading the packages…</p>
  </div></div>`);

  let offer;
  try {
    offer = await api.get('/v1/signup/account-types', { anonymous: true });
  } catch (error) {
    render(
      root,
      html`<div class="login-page"><div class="login-panel">
        <h2>Start an account</h2>
        <div class="notice err"><div>
          <b>The platform did not answer.</b><br>${error.message}
        </div></div>
        <p class="hint" style="margin-top:16px"><a href="/app">Back to sign in</a></p>
      </div></div>`,
    );
    return;
  }

  const packages = offer.accountTypes.filter((type) => type.selfServe);
  // The site links here with the package already chosen. An unknown or
  // non-self-serve value falls back rather than failing — somebody who edited
  // the URL gets the form, not an error page.
  const requested = new URLSearchParams(location.search).get('package');
  const chosen = packages.some((p) => p.package === requested) ? requested : packages[0]?.package;

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
        <h1>Start with a trial, not a sales call.</h1>
        <p>
          Your organisation, your data spine, your engines. No card is held and nothing is charged
          until you choose a paid package.
        </p>
      </div>

      <div class="login-panel">
        <h2>Create your organisation</h2>
        <p class="hint">You will be its administrator and can invite the rest of the team afterwards.</p>

        <form id="signup" novalidate>
          <div class="field">
            <label for="organisationName">Organisation</label>
            <input id="organisationName" name="organisationName" type="text" required
              autocomplete="organization" placeholder="Northgate Civils Ltd">
          </div>

          <div class="field">
            <label for="contactName">Your name</label>
            <input id="contactName" name="contactName" type="text" required
              autocomplete="name" placeholder="Rowan Blake">
          </div>

          <div class="field">
            <label for="email">Work email</label>
            <input id="email" name="email" type="email" required
              autocomplete="email" placeholder="you@company.com">
            <p class="hint" style="margin:6px 0 0">The confirmation link goes here, so it has to be one you can open.</p>
          </div>

          <div class="field">
            <label for="jurisdiction">Jurisdiction</label>
            <select id="jurisdiction" name="jurisdiction">
              ${offer.jurisdictions.map(
                (j) => html`<option value="${j.code}" ${j.code === 'GB' ? 'selected' : ''}>${j.name}</option>`,
              )}
            </select>
            <p class="hint" style="margin:6px 0 0">
              Decides which statutory rules the platform applies — payment periods, notice windows, duty holders.
            </p>
          </div>

          <div class="field">
            <label for="currency">Currency</label>
            <select id="currency" name="currency">
              ${offer.currencies.map(
                (c) => html`<option value="${c.code}" ${c.code === 'GBP' ? 'selected' : ''}>${c.code} — ${c.name}</option>`,
              )}
            </select>
          </div>

          <div class="field">
            <label for="structure">Account structure</label>
            <select id="structure" name="structure">
              ${(offer.structures ?? []).map(
                (s) => html`<option value="${s.structure}" ${s.structure === 'COMPANY' ? 'selected' : ''}>${s.label}</option>`,
              )}
            </select>
            <p class="hint" style="margin:6px 0 0" id="structure-detail"></p>
          </div>

          <div class="field">
            <label for="package">Package</label>
            <select id="package" name="package">
              ${packages.map(
                (p) => html`<option value="${p.package}" ${p.package === chosen ? 'selected' : ''}>
                  ${p.label} — ${p.monthlyPriceMinor === 0 ? 'free' : `${money(p.monthlyPriceMinor, 'GBP')} a month`}
                </option>`,
              )}
            </select>
            <p class="hint" style="margin:6px 0 0" id="package-detail"></p>
          </div>

          <button class="btn" type="submit" id="submit">Create my account</button>
          <div id="signup-error"></div>
        </form>

        <p class="hint" style="margin-top:16px">
          Already have an account? <a href="/app">Sign in</a>.
          Larger deployments are <a href="/get-started">provisioned with an agreement</a>.
        </p>
      </div>
    </div>`,
  );

  wire(packages, offer.structures ?? []);
}

function wire(packages, structures) {
  const form = document.getElementById('signup');
  const structureSelect = document.getElementById('structure');
  const structureDetail = document.getElementById('structure-detail');

  // The two structures in the platform's own words, including how many
  // companies a group holds — a licence term the server publishes, not a
  // number this form remembers.
  const describeStructure = () => {
    const chosen = structures.find((item) => item.structure === structureSelect.value);
    structureDetail.textContent = chosen ? chosen.detail : '';
  };
  structureSelect.addEventListener('change', describeStructure);
  describeStructure();
  const submit = document.getElementById('submit');
  const errorHost = document.getElementById('signup-error');
  const packageSelect = document.getElementById('package');
  const packageDetail = document.getElementById('package-detail');

  // What the chosen package actually includes, from the server's own figures.
  // A signup form that describes the plan from memory is how a price ends up
  // stated in two places and true in one.
  const describe = () => {
    const p = packages.find((item) => item.package === packageSelect.value);
    if (!p) return;
    // Singular where there is one. Both packages aimed at a single person say
    // "1 seats" otherwise, on the page where somebody decides whether this is a
    // serious product.
    const seats =
      p.includedSeats === null
        ? 'Unlimited seats'
        : `${p.includedSeats} seat${p.includedSeats === 1 ? '' : 's'}`;
    packageDetail.textContent =
      `${p.targetCustomer}. ${seats}, ${p.storageGb} GB of evidence storage, ` +
      `${p.export ? 'export enabled' : 'export on a paid package'}.`;
  };
  packageSelect.addEventListener('change', describe);
  describe();

  const fail = (message, fieldErrors = []) => {
    // Per-field detail where the platform gave it, so "A valid email address is
    // required" lands on the email box rather than as a general complaint.
    for (const field of fieldErrors) {
      const input = document.getElementById(field.field ?? field.path);
      if (input) input.setAttribute('aria-invalid', 'true');
    }
    render(
      errorHost,
      html`<div class="notice err" style="margin-top:12px"><div>
        ${message}
        ${fieldErrors.length ? html`<ul style="margin:8px 0 0 16px">
          ${fieldErrors.map((f) => html`<li>${f.field ?? f.path}: ${f.message ?? f.detail}</li>`)}
        </ul>` : ''}
      </div></div>`,
    );
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    render(errorHost, html``);
    for (const input of form.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid');
    submit.disabled = true;
    submit.textContent = 'Creating…';

    const input = {
      email: document.getElementById('email').value.trim(),
      contactName: document.getElementById('contactName').value.trim(),
      organisationName: document.getElementById('organisationName').value.trim(),
      jurisdiction: document.getElementById('jurisdiction').value,
      currency: document.getElementById('currency').value,
      package: packageSelect.value,
      structure: structureSelect.value,
    };

    try {
      const receipt = await api.post('/v1/signup', input, { anonymous: true });
      // The receipt's own words. It is deliberately non-committal about whether
      // the address was new, and rewording it here would leak what the endpoint
      // is built not to say.
      render(
        document.getElementById('signup').parentElement,
        html`<h2>Check your email</h2>
        <div class="notice ok" style="margin-top:12px"><div>
          ${receipt.message}
        </div></div>
        <p class="hint" style="margin-top:18px">
          Sent to <b style="color:var(--text-2)">${input.email}</b>. The link is good for 24 hours.
          Nothing has been charged and no account exists until you press the button in it.
        </p>
        <p class="hint" style="margin-top:12px">
          Wrong address? <a href="/app/signup">Start again</a>. Already confirmed? <a href="/app">Sign in</a>.
        </p>`,
      );
    } catch (error) {
      fail(error.message, error instanceof ApiError ? error.fieldErrors : []);
      submit.disabled = false;
      submit.textContent = 'Create my account';
    }
  });
}
