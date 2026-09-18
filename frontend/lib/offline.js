import * as outbox from './outbox.js';

/**
 * Saying the device is offline, and what that means for the person holding it.
 *
 * The outbox and the sync protocol were already built: a record captured with
 * no signal is queued with the device's own timestamp and reconciled when the
 * handset comes back. What was missing is the half the operative can see.
 *
 * With no signal, the console failed to fetch and showed whatever error the
 * screen's own `catch` produced — usually an empty panel. Nothing said the
 * device was offline, nothing said capture still worked, and nothing said that
 * the three records already made were safe. A supervisor in a basement
 * therefore had every reason to believe the platform had lost them, and the
 * rational response to that belief is to write the day on paper.
 *
 * So: a bar that says the state, a count of what is waiting, and a sentence
 * about what still works. It is small on purpose. The mechanism underneath it
 * is real and finished; this is the part that tells somebody so.
 *
 * ---
 *
 * ## It does not cache anything, and it must not
 *
 * `frontend/sw.js` states the rule this file lives under: nothing under `/v1/`
 * is ever cached, because a cached API response is one identity's project data
 * sitting somewhere the access control cannot reach, on a device that is
 * routinely handed to the next operative. This bar reads only the device's own
 * outbox — operations this handset captured and has not yet sent — which is
 * already on the device, was authorised at the moment of capture, and is
 * cleared on sign-out by `outbox.clear()`.
 *
 * That is the honest boundary of offline mode on this platform. **Capture works
 * offline; reading the project does not.** A field app that showed cached
 * project data would be a nicer field app and a tenant-isolation defect, and
 * the standard's line about caching authorised project visuals is the one part
 * of it this platform declines rather than the part it has not reached yet.
 *
 * ## Mounted once, outside the redraw
 *
 * `draw()` replaces the shell's contents on every navigation. A bar rendered
 * inside it would disappear and reappear on each page change, which on a
 * flapping connection is a flashing element rather than a status. It is
 * appended to `document.body` once and updated in place.
 */

const BAR_ID = 'offline-bar';

/**
 * Whether this session has actually been out of signal.
 *
 * So "back in signal" is said only to somebody who lost it. A handset that
 * queued a record while online never went offline, and greeting them with a
 * recovery they did not have is the kind of small untruth that makes the next
 * sentence less believed.
 */
let wasOffline = false;

/** How many operations and files this device is still holding. */
async function waiting() {
  const [operations, files] = await Promise.all([
    outbox.pending().catch(() => []),
    outbox.pendingFiles().catch(() => []),
  ]);
  return { operations: operations.length, files: files.length };
}

/** The sentence, given the connection state and what is queued. */
function sentence(online, held) {
  const parts = [];
  if (held.operations > 0) {
    parts.push(`${held.operations} record${held.operations === 1 ? '' : 's'} waiting on this device`);
  }
  if (held.files > 0) {
    parts.push(`${held.files} file${held.files === 1 ? '' : 's'} waiting to upload`);
  }

  if (!online) {
    const held_ = parts.length > 0 ? `${parts.join(' · ')}. ` : '';
    return (
      `${held_}You can still record work, observations and progress — each one is kept with the time you pressed ` +
      'the button and filed when this device is back in signal. Reading project data needs a connection.'
    );
  }

  // Online with a queue is the interesting case: the flush is either running or
  // has failed, and either way the operative should not be told "synced".
  return parts.length > 0
    ? `${parts.join(' · ')}. Filing now — nothing is lost if this device goes offline again before it finishes.`
    : '';
}

/** Draw the bar, or hide it when there is nothing to say. */
async function paint() {
  const bar = document.getElementById(BAR_ID);
  if (!bar) return;

  const online = navigator.onLine;
  const held = await waiting();
  const text = sentence(online, held);

  // Online and nothing queued is the ordinary state and gets no bar. A
  // permanent "you are online" strip is a strip that stops being read, and then
  // the one that matters is not read either.
  if (online && text === '') {
    bar.hidden = true;
    bar.textContent = '';
    return;
  }

  bar.hidden = false;
  bar.className = `offline-bar ${online ? 'is-sending' : 'is-offline'}`;
  bar.textContent = '';

  const strong = document.createElement('b');
  // "Back in signal" only when it was out of it. A handset that queued a record
  // while online never lost signal, and telling somebody it came back is the
  // kind of small untruth that makes the next sentence less believed.
  strong.textContent = online ? (wasOffline ? 'Back in signal.' : 'Not yet filed.') : 'This device is offline.';
  wasOffline = !online;
  bar.append(strong, ` ${text}`);
}

/**
 * Put the bar up and keep it current.
 *
 * Idempotent: called from the shell, which may run more than once in a session.
 *
 * `construx:outbox` is dispatched by `outbox.js` itself, at the five places the
 * store changes, so the count moves when the queue does rather than on a timer
 * and no caller can forget to say so. There is no polling here on purpose — a
 * timer that wakes a handset every few seconds to count an IndexedDB store is a
 * battery cost on exactly the device that can least afford one.
 */
export function mountOfflineBar() {
  if (document.getElementById(BAR_ID)) {
    void paint();
    return;
  }

  const bar = document.createElement('div');
  bar.id = BAR_ID;
  bar.className = 'offline-bar';
  bar.hidden = true;
  // Announced when it changes rather than read on every repaint: `polite` so it
  // waits for a pause, because a screen-reader user mid-sentence does not need
  // to be interrupted to be told the signal dropped.
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-live', 'polite');
  document.body.prepend(bar);

  window.addEventListener('online', () => void paint());
  window.addEventListener('offline', () => void paint());
  document.addEventListener('construx:outbox', () => void paint());

  void paint();
}
