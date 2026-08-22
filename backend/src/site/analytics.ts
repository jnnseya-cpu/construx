import { config } from '../config.ts';

/**
 * Meta Pixel and Google tag on the public site.
 *
 * Three decisions shape everything here, and each of them is the reason a line
 * looks more careful than a copied-in snippet would.
 *
 * ---
 *
 * **Nothing is emitted unless an id is configured.** Both ids default to empty.
 * With neither set this module returns empty strings, the content-security
 * policy keeps its original shape, and no consent banner appears. A development
 * machine, a CI run and a restored backup therefore send nothing to anybody's
 * ad account — which is the same argument that keeps the newsletter sender off
 * by default.
 *
 * **Nothing loads before consent.** Meta Pixel and Google tag both set cookies
 * that are not necessary to provide the service, and under PECR that means
 * consent *before* the script runs, not a banner that appears while it is
 * already reporting. So the ids are handed to the browser as data attributes
 * and the loader in `/analytics.js` decides: with no stored choice it shows the
 * banner and loads nothing at all; on accept it injects the vendors' own
 * scripts; on decline it records the refusal and never asks again.
 *
 * **The snippets are not inline.** The vendors publish theirs as inline
 * `<script>` blocks, which on this site would require `unsafe-inline` in
 * `script-src` — trading a real protection for the convenience of pasting.
 * `/analytics.js` is a file on this origin like `/site.js`, and the only thing
 * the markup carries is two identifiers on a `<script>` tag.
 *
 * ---
 *
 * **What is measured, and what is deliberately not.** The public site and the
 * route to signup: page views, the pricing page, and the click that carries
 * somebody from a package to the signup form. The signed-in console is outside
 * this and stays outside: `/app` paths carry tenant, project and entity
 * identifiers, and a page view from there tells an advertising network which
 * projects a customer is running and how fast they are moving. There is nothing
 * to optimise there either — the conversion is already won.
 *
 * The consequence is stated rather than hidden: **a confirmed registration
 * cannot be attributed from the browser**, because confirmation happens inside
 * the console where no pixel runs. The click to signup is the last measurable
 * step. Closing that gap properly means server-to-server — Meta's Conversions
 * API and GA4's Measurement Protocol, fired from the same code that writes the
 * activation to the ledger, which is both more accurate than a browser and
 * unaffected by ad blockers. That is not built.
 */

/** Hosts the vendors serve their scripts from. */
const SCRIPT_HOSTS = 'https://connect.facebook.net https://www.googletagmanager.com';

/** Hosts they report to — image beacons for Meta, XHR for both. */
const BEACON_HOSTS =
  'https://www.facebook.com https://connect.facebook.net ' +
  'https://www.google-analytics.com https://analytics.google.com https://www.googletagmanager.com';

/** Whether either tag is configured. Everything in this module is inert if not. */
export function analyticsEnabled(): boolean {
  return measurementIds().meta !== '' || measurementIds().google !== '';
}

/**
 * The configured ids, reduced to the characters the vendors actually issue.
 *
 * A Meta pixel id is digits; a Google tag id is `G-`/`GT-`/`AW-` and then
 * alphanumerics. Anything else is dropped rather than escaped, because these
 * values land in an HTML attribute and are handed to a script loader — and the
 * honest answer to "this id has a quote in it" is that it is not an id.
 */
export function measurementIds(): { meta: string; google: string } {
  return {
    meta: /^[0-9]{1,32}$/.test(config.analytics.metaPixelId) ? config.analytics.metaPixelId : '',
    google: /^[A-Z]{1,4}-[A-Z0-9]{1,24}$/i.test(config.analytics.googleTagId) ? config.analytics.googleTagId : '',
  };
}

/**
 * The `script-src`, `img-src` and `connect-src` additions the tags need.
 *
 * Returned as a fragment rather than a whole policy so the caller keeps
 * ownership of its own directives, and returns nothing when no id is set — the
 * policy a deployment without advertising gets is the policy it had before this
 * module existed.
 */
export function analyticsCspHosts(): { script: string; img: string; connect: string } {
  if (!analyticsEnabled()) return { script: '', img: '', connect: '' };
  return {
    script: ` ${SCRIPT_HOSTS}`,
    // Meta's pixel reports by requesting a 1×1 image, so this is not decoration.
    img: ` ${BEACON_HOSTS}`,
    connect: ` ${BEACON_HOSTS}`,
  };
}

/**
 * The tag that carries the ids and loads the consent-gated loader.
 *
 * `defer` rather than `async`: nothing here is urgent, and a measurement script
 * that competes with the page it is measuring is measuring a slower page.
 */
export function analyticsScriptTag(): string {
  if (!analyticsEnabled()) return '';
  const { meta, google } = measurementIds();
  return `<script src="/analytics.js" defer${meta ? ` data-meta-pixel="${meta}"` : ''}${
    google ? ` data-google-tag="${google}"` : ''
  }></script>`;
}

/**
 * The consent banner, rendered server-side and hidden until the loader decides.
 *
 * Server-rendered rather than built by the script for one reason: a banner that
 * only exists once JavaScript has run is a banner that never appears for the
 * people most likely to care. It carries `hidden` and the loader removes it
 * only when there is no stored choice, so somebody who has already answered
 * never sees it flash.
 *
 * Both buttons are real. A banner whose only option is "accept" is not consent,
 * and it is the version regulators have been fining people for.
 */
export function consentBanner(): string {
  if (!analyticsEnabled()) return '';
  return `<div class="consent" id="consent" role="dialog" aria-modal="false" aria-labelledby="consent-title" hidden>
  <div class="consent-body">
    <p id="consent-title"><strong>Measurement cookies</strong></p>
    <p>We would like to measure how people find this site, using Meta and Google. Nothing is loaded until you choose, and this is never used inside the platform itself — your project data is never sent anywhere. See our <a href="/privacy">Privacy Policy</a>.</p>
  </div>
  <div class="consent-actions">
    <button type="button" class="btn" data-consent="grant">Accept</button>
    <button type="button" class="btn ghost" data-consent="deny">Decline</button>
  </div>
</div>`;
}
