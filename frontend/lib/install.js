/**
 * Home-screen installation prompt.
 *
 * The application is already installable — the manifest, the service worker,
 * the icons and the launch images are all in place, and Chrome and Edge will
 * offer installation on their own. Two things are still missing, and this
 * module is both of them.
 *
 * The first is that the browser's own offer is easy to miss: on Android it is
 * a line in an overflow menu, and a site engineer opening the console on a
 * handset has no reason to look there. Capturing `beforeinstallprompt` lets us
 * put the offer where the work is, and lets us choose the moment.
 *
 * The second is iOS. Safari implements no install prompt of any kind and fires
 * no event — installation is Share → Add to Home Screen, and there is no API
 * that can start it. A page that says nothing therefore reads to an iPhone user
 * as an application that cannot be installed, when in fact it can. The only
 * remedy available is to say so in words, and this is where the platform sniff
 * is legitimate: the instruction genuinely differs by browser, so a generic
 * message would be wrong on every platform rather than right on one.
 *
 * What it must never do is nag. It is shown once, it is dismissed with one
 * touch, and the dismissal is remembered.
 */

const DISMISSED_KEY = 'construx.installDismissed';

/** Deferred `beforeinstallprompt`, if the browser gave us one to hold. */
let deferred = null;

/**
 * Already running as an installed application?
 *
 * Two checks because the two platforms report it differently: the standards
 * route is the `display-mode` media query, and iOS predates it with a
 * non-standard flag on `navigator` that is still the only reliable signal in
 * a Safari home-screen launch.
 */
function installed() {
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  if (window.matchMedia?.('(display-mode: fullscreen)').matches) return true;
  return navigator.standalone === true;
}

/** iOS Safari, where the share sheet is the only way in. */
function iosSafari() {
  const ua = navigator.userAgent;
  const ios =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports itself as a Mac. A touch point tells them apart.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!ios) return false;
  // Chrome and Firefox on iOS are Safari underneath but cannot install at all,
  // so instructing their users to use a share sheet that has no such item
  // would be worse than saying nothing.
  return !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}

function dismissed() {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    // Storage disabled. Showing the hint once per page load is the safe side
    // of that trade: an un-dismissable banner would be the other one.
    return false;
  }
}

function remember() {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    /* nothing to do; the banner is already gone for this page */
  }
}

function close(bar) {
  bar.remove();
  remember();
}

/**
 * Build and attach the bar.
 *
 * `role="dialog"` rather than an alert: it is a standing offer, not something
 * that has happened, and interrupting a screen reader mid-sentence to announce
 * an installation suggestion would be the wrong trade.
 */
function show({ title, body, action }) {
  if (document.getElementById('install-bar')) return;

  const bar = document.createElement('div');
  bar.id = 'install-bar';
  bar.className = 'install-bar';
  bar.setAttribute('role', 'dialog');
  bar.setAttribute('aria-label', 'Install CONSTRUX');

  const mark = document.createElement('div');
  mark.className = 'install-mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.innerHTML =
    '<svg viewBox="0 0 64 64"><path fill="#8b939d" d="M12 14 L22 9 L22 40 L12 40 Z"/>' +
    '<path fill="#a8b0ba" d="M24 12 L31 8 L31 40 L24 40 Z"/>' +
    '<path fill="#ff6a1a" d="M45 30 L56 30 L41 52 L31 52 Z"/></svg>';

  const text = document.createElement('div');
  text.className = 'install-text';
  const h = document.createElement('strong');
  h.textContent = title;
  const p = document.createElement('span');
  p.textContent = body;
  text.append(h, p);

  const actions = document.createElement('div');
  actions.className = 'install-actions';

  if (action) {
    const install = document.createElement('button');
    install.type = 'button';
    install.className = 'btn sm';
    install.textContent = 'Install';
    install.addEventListener('click', async () => {
      install.disabled = true;
      try {
        await action();
      } finally {
        close(bar);
      }
    });
    actions.append(install);
  }

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'btn quiet sm';
  dismiss.textContent = action ? 'Not now' : 'Got it';
  dismiss.addEventListener('click', () => close(bar));
  actions.append(dismiss);

  bar.append(mark, text, actions);
  document.body.append(bar);
}

/**
 * Arm the prompt.
 *
 * Called once on load. It attaches a listener and returns; nothing is shown
 * until either the browser offers an installation or the iOS delay elapses.
 * The delay exists because a banner that appears in the same frame as the
 * first screen competes with the screen for attention and gets dismissed
 * without being read.
 */
export function armInstallPrompt() {
  if (installed() || dismissed()) return;

  // Chromium: hold the event so the offer can be made at our moment rather
  // than buried in a browser menu. `preventDefault` is what defers it.
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event;
    if (dismissed()) return;
    show({
      title: 'Install CONSTRUX',
      body: 'Add it to this device for offline capture and a full-screen launch.',
      action: async () => {
        const prompt = deferred;
        deferred = null;
        if (!prompt) return;
        await prompt.prompt();
        // The outcome is not acted on. Accepted or declined, the bar closes
        // and the dismissal is remembered — the browser will not hand us a
        // second event for an installation the user has already refused.
        await prompt.userChoice.catch(() => {});
      },
    });
  });

  // The browser tells us when it happened, including when it happened through
  // its own menu rather than through us. Nothing more should be offered.
  window.addEventListener('appinstalled', () => {
    remember();
    document.getElementById('install-bar')?.remove();
  });

  if (iosSafari()) {
    window.setTimeout(() => {
      if (installed() || dismissed()) return;
      show({
        title: 'Add CONSTRUX to your home screen',
        body: 'Tap Share, then “Add to Home Screen”, for offline capture and a full-screen launch.',
        action: null,
      });
    }, 4000);
  }
}
