/**
 * Meta Pixel and Google tag, behind a consent gate.
 *
 * The vendors publish these as inline `<script>` blocks that run the moment the
 * page parses. Neither is used here, for two separate reasons.
 *
 * **Inline would cost the policy.** This site's content-security-policy allows
 * `script-src 'self'` and nothing else — no `unsafe-inline`. Pasting a vendor
 * snippet would mean adding it, which turns off a real protection across every
 * page for the convenience of not writing this file.
 *
 * **Running on parse would be unlawful here.** Both vendors set cookies that
 * are not necessary to provide the service. Under PECR that needs consent
 * *before* the script runs, not a banner that appears while it is already
 * reporting. So nothing is fetched until somebody has answered, and a refusal
 * is remembered rather than asked again on the next page.
 *
 * The ids arrive as data attributes on this script's own tag, put there by the
 * server from `ANALYTICS_META_PIXEL_ID` and `ANALYTICS_GOOGLE_TAG_ID`. With
 * neither configured the server does not emit the tag at all and this file is
 * never requested.
 *
 * ---
 *
 * **Where this runs: the public site, and nowhere else.** The signed-in console
 * has its own stricter policy and never loads this. That is deliberate — `/app`
 * paths carry tenant, project and entity identifiers, so a page view from
 * inside the console would tell two advertising networks which projects a
 * customer is running and how quickly. The last measurable step is the click
 * that leaves for the signup form.
 */

(function () {
  var tag = document.currentScript;
  if (!tag) return;

  var META = tag.getAttribute('data-meta-pixel') || '';
  var GOOGLE = tag.getAttribute('data-google-tag') || '';
  if (!META && !GOOGLE) return;

  /**
   * Whether the Google id is a Tag Manager container rather than a Google tag.
   *
   * `GTM-XXXXXXX` is a container: a different script, a different bootstrap and
   * a different way of receiving events. `G-`, `GT-` and `AW-` are Google tags
   * and take gtag.js. Both are issued by the same vendor from the same console,
   * which is exactly why somebody pastes one where the other belongs.
   *
   * **A container's own tags are still subject to this site's content-security
   * policy.** The policy admits googletagmanager.com and the two beacon hosts
   * and nothing else, so a container configured to load a third vendor's script
   * will have that script blocked. That is the policy working, not a fault —
   * but it means a container is not a way around the measurement decisions this
   * site has already made, and anybody adding a tag should be told so.
   */
  var IS_CONTAINER = /^GTM-/i.test(GOOGLE);

  var KEY = 'construx-measurement-consent';

  /**
   * The stored answer: 'granted', 'denied', or null for never asked.
   *
   * Wrapped because a private window, a browser set to block site data, and
   * some embedded webviews all throw on access rather than returning null. A
   * measurement script is never worth an exception that stops the page.
   */
  function stored() {
    try {
      return localStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
  }
  function remember(value) {
    try {
      localStorage.setItem(KEY, value);
    } catch (e) {
      /* nothing to do, and nothing worth doing */
    }
  }

  // ---------------------------------------------------------------- loading

  var loaded = false;

  function loadVendors() {
    if (loaded) return;
    loaded = true;

    if (META) {
      // fbq's own bootstrap, written out rather than pasted: it is a queue that
      // records calls until the real library replaces it.
      var fbq = function () {
        fbq.callMethod ? fbq.callMethod.apply(fbq, arguments) : fbq.queue.push(arguments);
      };
      fbq.queue = [];
      fbq.loaded = true;
      fbq.version = '2.0';
      window.fbq = window.fbq || fbq;
      window._fbq = window._fbq || window.fbq;

      inject('https://connect.facebook.net/en_US/fbevents.js');
      window.fbq('init', META);
      window.fbq('track', 'PageView');
    }

    if (GOOGLE) {
      // The dataLayer is shared by both Google products and has to exist before
      // either script runs, because both of them drain whatever is already in it.
      window.dataLayer = window.dataLayer || [];

      if (IS_CONTAINER) {
        // Tag Manager. A different product from the Google tag, with a different
        // script and a different bootstrap, and the reason this branch exists:
        // the id validator accepts GTM-XXXXXXX quite happily, so a container id
        // configured here used to load gtag/js, which silently measures nothing
        // — no error, no tag, and a Tag Assistant that never connects.
        //
        // `gtm.start` is the container's own start signal. Without it the
        // container loads and fires no trigger, which is the same silence by a
        // different route.
        window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
        inject('https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(GOOGLE));
      } else {
        window.gtag = function () {
          window.dataLayer.push(arguments);
        };
        window.gtag('js', new Date());
        // The page path only. No query string: the site's own links carry a
        // package name, and there is no reason to hand more than the page.
        window.gtag('config', GOOGLE, { page_path: location.pathname });

        inject('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GOOGLE));
      }
    }

    replay();
  }

  function inject(src) {
    var el = document.createElement('script');
    el.async = true;
    el.src = src;
    document.head.appendChild(el);
  }

  // ----------------------------------------------------------------- events

  /**
   * Events raised before a decision, held rather than dropped.
   *
   * Somebody can click a package button while the banner is still on screen.
   * Discarding that would under-report the one step that matters most; sending
   * it would be reporting without consent. So it waits, and is either replayed
   * on accept or thrown away on decline.
   */
  var pending = [];

  function replay() {
    for (var i = 0; i < pending.length; i++) send(pending[i][0], pending[i][1]);
    pending = [];
  }

  function send(name, params) {
    var meta = MAP[name];
    if (META && meta && window.fbq) window.fbq('track', meta, params || {});
    if (!GOOGLE) return;
    if (IS_CONTAINER) {
      // A container has no gtag. Events reach it as dataLayer pushes, and the
      // tags inside it are triggered on the event name — so the name here is
      // what somebody types into a Tag Manager trigger, and renaming it breaks
      // their container rather than this file.
      if (window.dataLayer) window.dataLayer.push(Object.assign({ event: name }, params || {}));
    } else if (window.gtag) {
      window.gtag('event', name, params || {});
    }
  }

  /**
   * This site's event names, and the Meta standard event each corresponds to.
   *
   * Google takes the name as written; Meta only recognises its own vocabulary,
   * so the mapping is explicit rather than a guess at what the vendor accepts.
   */
  var MAP = {
    view_pricing: 'ViewContent',
    select_package: 'InitiateCheckout',
    begin_signup: 'Lead',
    contact: 'Contact',
    newsletter_subscribe: 'Subscribe',
  };

  /** Raise an event. Held if no decision has been made, dropped if declined. */
  function track(name, params) {
    if (stored() === 'denied') return;
    if (!loaded) {
      pending.push([name, params]);
      return;
    }
    send(name, params);
  }

  // Exposed so `site.js` and any page script can raise an event without knowing
  // whether measurement is configured, consented to, or loaded at all.
  window.construxTrack = track;

  /**
   * The stored measurement choice, for the signup form.
   *
   * True only on an explicit grant. The server reports a verified registration
   * to the Conversions API — a conversion the pixel cannot see, because the
   * pixel does not run inside the console — and it has no way to learn this
   * decision except from the form that carries it. Absent, unanswered and
   * declined all return false, which is the only safe default for a flag that
   * governs whether somebody is named to an advertising network.
   *
   * Undefined where measurement is not configured at all, because this whole
   * file returns before here. A caller therefore tests the function exists.
   */
  window.construxConsent = function () {
    return stored() === 'granted';
  };

  // ------------------------------------------------------------ the banner

  var banner = document.getElementById('consent');

  function decide(answer) {
    remember(answer);
    if (banner) banner.hidden = true;
    if (answer === 'granted') loadVendors();
    else pending = [];
  }

  if (banner) {
    banner.addEventListener('click', function (event) {
      var button = event.target.closest('[data-consent]');
      if (button) decide(button.getAttribute('data-consent') === 'grant' ? 'granted' : 'denied');
    });
  }

  var answer = stored();
  if (answer === 'granted') loadVendors();
  else if (answer !== 'denied' && banner) banner.hidden = false;

  // ------------------------------------------------------- automatic events

  // The pricing page is the one page whose view means something on its own.
  if (location.pathname === '/get-started') track('view_pricing');

  // The click that leaves for the signup form, from wherever it is offered.
  // Captured on the document so it covers links this file never saw.
  document.addEventListener('click', function (event) {
    var link = event.target.closest('a[href]');
    if (!link) return;
    var href = link.getAttribute('href') || '';
    if (href.indexOf('/app/signup') === 0) {
      // The package is already in the URL the site wrote; reading it back is
      // how the event says which one without a second source of truth.
      var match = /package=([A-Z_]+)/.exec(href);
      track('select_package', match ? { package: match[1] } : {});
      track('begin_signup', match ? { package: match[1] } : {});
    }
  });
})();
