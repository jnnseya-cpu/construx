/**
 * The public site's only script: opening the mobile menu.
 *
 * A separate file rather than an inline block, so the site's content-security
 * policy can be `script-src 'self'` with no `unsafe-inline` allowance at all.
 * An inline script would have forced either a per-request nonce or a hash that
 * silently stops matching the first time somebody edits the markup — and the
 * failure mode is a menu that quietly stops opening.
 *
 * Everything else on these pages is markup and works with scripting disabled.
 */

const toggle = document.querySelector('.nav-toggle');
const nav = document.getElementById('mobile-nav');

if (toggle && nav) {
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    nav.hidden = open;
  });
}

// --- the account request form on /contact ------------------------------------
//
// Posts to the request queue the operator works. The result is said on the
// page; the address is not confirmed to exist either way.
const requestForm = document.getElementById('account-request');
if (requestForm) {
  requestForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = requestForm.querySelector('.request-result');
    const data = new FormData(requestForm);
    const payload = {
      organisationName: String(data.get('organisationName') ?? '').trim(),
      contactName: String(data.get('contactName') ?? '').trim(),
      email: String(data.get('email') ?? '').trim(),
      jurisdiction: String(data.get('jurisdiction') ?? 'GB'),
      currency: String(data.get('currency') ?? 'GBP'),
      companies: Number(data.get('companies') ?? 1),
    };
    const phone = String(data.get('phone') ?? '').trim();
    const message = String(data.get('message') ?? '').trim();
    if (phone) payload.phone = phone;
    if (message) payload.message = message;
    if (payload.companies > 1) payload.kind = 'GROUP';
    const button = requestForm.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const response = await fetch('/v1/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.title || 'The request could not be sent');
      result.textContent = `${body.message} Reference ${body.reference}.`;
      requestForm.reset();
    } catch (error) {
      result.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}
