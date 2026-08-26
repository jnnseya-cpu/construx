import { esc, html, resolveHtml } from './ui.js';

/**
 * Voice capture on site.
 *
 * The specification calls voice-first an adoption requirement rather than a
 * convenience, and it was the largest gap on the field screen: the platform
 * could transcribe a site recording, classify it, extract the location and the
 * action owner from it, and hand a draft to a person to confirm — and there was
 * no way to make a recording. The whole path existed with nothing at the front
 * of it.
 *
 * `MediaRecorder` and `getUserMedia`, both native. No library: a dependency for
 * something the browser does is exactly what the zero-dependency decision is
 * about, and an audio library on a phone on a building site is bytes over a
 * connection that is already bad.
 *
 * ---
 *
 * **The container is normalised before the file is named.** Chromium records
 * `audio/webm;codecs=opus` and Safari `audio/mp4`; the perception task matches
 * its accepted types by exact string, so a file typed with the codec parameter
 * would be refused after the upload had already happened. The parameter is
 * dropped when the `File` is built.
 *
 * **Recording works with no network at all.** Nothing here touches the API. The
 * bytes become a `File` and follow the same path as a photograph — hashed,
 * filed against a ledger record, uploaded, and queued on the device if the
 * upload cannot happen yet. What needs a connection is the *transcription*, and
 * the screen says so rather than appearing to work and losing the audio.
 *
 * **A recording is kept whether or not it is ever transcribed.** It is evidence
 * in its own right: it is what a delay claim is argued from three years later,
 * and the transcript is a convenience laid over it.
 */

/** Containers the perception task accepts, best first. */
const PREFERRED = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

/** The base type, without codec parameters — what the server matches on. */
function baseType(mime) {
  return String(mime).split(';')[0].trim();
}

/** Whether this browser can record at all, and why not where it cannot. */
export function voiceSupport() {
  if (typeof MediaRecorder === 'undefined') {
    return { available: false, reason: 'This browser cannot record audio.' };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    // The usual cause is an insecure origin. Naming it saves somebody an hour.
    return {
      available: false,
      reason: window.isSecureContext
        ? 'This browser exposes no microphone.'
        : 'Recording needs a secure connection (https). This page is not on one.',
    };
  }
  const mimeType = PREFERRED.find((type) => MediaRecorder.isTypeSupported?.(type));
  if (!mimeType) return { available: false, reason: 'This browser records no audio format the platform accepts.' };
  return { available: true, mimeType };
}

function clock(seconds) {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

/**
 * Record a site note, and return it as a `File`.
 *
 * Resolves to the file, or `null` where the person cancelled or the browser
 * refused. Never throws for a refused microphone: on a phone, a denied
 * permission is a normal thing that happens, and it is shown in the panel.
 *
 * @param {object} options
 * @param {number} [options.maxSeconds] hard stop, so a pocket recording cannot run for an hour
 * @param {string} [options.title]
 * @param {string} [options.intent]
 */
export function recordVoice({ maxSeconds = 300, title = 'Record a site note', intent } = {}) {
  const support = voiceSupport();

  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'modal-host';
    host.innerHTML = resolveHtml(html`<div class="modal">
      <header>
        <div>
          <h3>${title}</h3>
          ${intent ? html`<div class="metric-sub">${intent}</div>` : ''}
        </div>
        <button type="button" data-close aria-label="Close">×</button>
      </header>
      <div class="body">
        <div class="voice">
          <div class="voice-state" data-state>Ready</div>
          <div class="voice-clock" data-clock>00:00</div>
          <div class="voice-meter" aria-hidden="true"><span data-level></span></div>
          <div class="metric-sub" data-hint>
            Speak as you would to a colleague. It is transcribed verbatim and you review it before anything is filed.
          </div>
          <audio data-playback controls hidden></audio>
        </div>
      </div>
      <div class="foot">
        <button type="button" class="btn quiet" data-close>Cancel</button>
        <button type="button" class="btn quiet" data-again hidden>Record again</button>
        <button type="button" class="btn" data-record>Start recording</button>
        <button type="button" class="btn" data-use hidden>Use this recording</button>
      </div>
    </div>`);

    const el = (selector) => host.querySelector(selector);
    const state = el('[data-state]');
    const clockEl = el('[data-clock]');
    const level = el('[data-level]');
    const hint = el('[data-hint]');
    const playback = el('[data-playback]');
    const recordBtn = el('[data-record]');
    const useBtn = el('[data-use]');
    const againBtn = el('[data-again]');

    let recorder;
    let stream;
    let audioCtx;
    let ticker;
    let meter;
    let started = 0;
    let file;
    let objectUrl;

    function stopEverything() {
      clearInterval(ticker);
      cancelAnimationFrame(meter);
      try { recorder?.state === 'recording' && recorder.stop(); } catch { /* already stopped */ }
      for (const track of stream?.getTracks() ?? []) track.stop();
      void audioCtx?.close?.().catch(() => {});
    }

    function close(value) {
      stopEverything();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      host.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    }

    const onKey = (event) => {
      if (event.key === 'Escape') close(null);
    };

    if (!support.available) {
      state.textContent = 'Cannot record here';
      state.classList.add('bad');
      hint.textContent = `${support.reason} Everything on this screen can still be typed.`;
      recordBtn.hidden = true;
    }

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        // The two are different problems with different answers, and saying
        // "refused" to somebody whose headset is unplugged sends them into
        // browser settings to fix something that is not broken.
        const refused = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
        state.textContent = refused ? 'Microphone refused' : 'No microphone found';
        state.classList.add('bad');
        hint.textContent = refused
          ? 'Permission was refused. Allow the microphone for this site, or type the note instead.'
          : 'This device has no microphone available. Plug one in, or type the note instead.';
        recordBtn.hidden = true;
        return;
      }

      // A level that moves is the only honest confirmation that the microphone
      // is live. A red dot proves the button was pressed and nothing else, and
      // on site the difference is a walk repeated.
      try {
        audioCtx = new (window.AudioContext ?? window.webkitAudioContext)();
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        audioCtx.createMediaStreamSource(stream).connect(analyser);
        const samples = new Uint8Array(analyser.frequencyBinCount);
        const draw = () => {
          analyser.getByteTimeDomainData(samples);
          let peak = 0;
          for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128));
          level.style.width = `${Math.min(100, (peak / 128) * 160)}%`;
          meter = requestAnimationFrame(draw);
        };
        draw();
      } catch {
        // No analyser. The recording still works; the bar simply does not move.
      }

      const chunks = [];
      recorder = new MediaRecorder(stream, { mimeType: support.mimeType });
      recorder.ondataavailable = (event) => event.data.size > 0 && chunks.push(event.data);
      recorder.onstop = () => {
        clearInterval(ticker);
        cancelAnimationFrame(meter);
        for (const track of stream.getTracks()) track.stop();
        void audioCtx?.close?.().catch(() => {});
        level.style.width = '0%';

        const type = baseType(support.mimeType);
        const blob = new Blob(chunks, { type });
        if (blob.size === 0) {
          state.textContent = 'Nothing was recorded';
          state.classList.add('bad');
          hint.textContent = 'The microphone produced no audio. Check it is not muted and try again.';
          recordBtn.hidden = false;
          recordBtn.textContent = 'Start recording';
          return;
        }

        const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        // Typed with the base container. The codec parameter would survive into
        // the upload header and the perception task matches by exact string.
        file = new File([blob], `site-note-${stamp}.${extension}`, { type, lastModified: Date.now() });

        objectUrl = URL.createObjectURL(blob);
        playback.src = objectUrl;
        playback.hidden = false;

        state.textContent = 'Recorded';
        state.classList.remove('bad');
        state.classList.add('good');
        hint.textContent = 'Listen back before you use it. Nothing has been sent.';
        useBtn.hidden = false;
        againBtn.hidden = false;
      };

      recorder.start();
      started = Date.now();
      state.textContent = 'Recording';
      state.classList.add('live');
      recordBtn.textContent = 'Stop';
      hint.textContent = 'Say where you are, what you saw, and who needs to do something about it.';

      ticker = setInterval(() => {
        const elapsed = (Date.now() - started) / 1000;
        clockEl.textContent = clock(elapsed);
        // A hard stop, so a phone left in a pocket cannot record for an hour and
        // then fail to upload it over a site connection.
        if (elapsed >= maxSeconds) {
          hint.textContent = `Stopped at the ${Math.round(maxSeconds / 60)}-minute limit.`;
          stop();
        }
      }, 200);
    }

    function stop() {
      state.classList.remove('live');
      recordBtn.hidden = true;
      try { recorder?.stop(); } catch { /* nothing to stop */ }
    }

    host.addEventListener('click', (event) => {
      if (event.target === host || event.target.closest('[data-close]')) return close(null);

      if (event.target.closest('[data-record]')) {
        if (recorder?.state === 'recording') return stop();
        return void start();
      }

      if (event.target.closest('[data-again]')) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = undefined;
        file = undefined;
        playback.hidden = true;
        useBtn.hidden = true;
        againBtn.hidden = true;
        recordBtn.hidden = false;
        recordBtn.textContent = 'Start recording';
        clockEl.textContent = '00:00';
        state.textContent = 'Ready';
        state.classList.remove('good', 'bad');
        return void start();
      }

      if (event.target.closest('[data-use]') && file) close(file);
    });

    document.addEventListener('keydown', onKey);
    document.body.append(host);
    recordBtn.focus();
  });
}

/** A short, honest label for a recording, used as its evidence description. */
export function recordingDescription(file) {
  const size = file.size < 1024 * 1024 ? `${Math.round(file.size / 1024)}KB` : `${(file.size / (1024 * 1024)).toFixed(1)}MB`;
  return `Site voice note, ${size}, captured ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
}

export { baseType as voiceBaseType, esc as escapeForVoicePanel };
