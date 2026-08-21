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
