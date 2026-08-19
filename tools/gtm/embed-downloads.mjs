import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Embeds the three downloadable editions into the published page and adds the
 * save bar.
 *
 * The files are base64 in inert <script type="application/octet-stream">
 * blocks: base64's alphabet cannot contain "<", so the payload can never close
 * the tag, and the browser never parses it as code.
 */

const S = new URL('../../docs/go-to-market/', import.meta.url).pathname;
const b64 = (f) => readFileSync(`${S}/${f}`).toString('base64');

const FILES = [
  { id: 'md', file: 'GO-TO-MARKET.md', name: 'GO-TO-MARKET.md', label: 'Markdown', note: 'Always available' },
  { id: 'docx', file: 'GO-TO-MARKET.docx', name: 'GO-TO-MARKET.docx', label: 'Word', note: 'Edit and circulate' },
  { id: 'pdf', file: 'GO-TO-MARKET.pdf', name: 'GO-TO-MARKET.pdf', label: 'PDF', note: 'Send as-is' },
];

let html = readFileSync(`${S}/go-to-market.html`, 'utf8');

const payloads = FILES.map((f) => {
  const data = b64(f.file);
  console.log(`${f.name.padEnd(22)} ${(data.length / 1024).toFixed(0)} kB base64`);
  return `<script type="application/octet-stream" id="blob-${f.id}">${data}</script>`;
}).join('\n');

const CSS = `
/* ── Download bar ─────────────────────────────────────────────────────── */
.dl { margin: 26px 0 0; border: 1px solid var(--rule); border-radius: 3px; background: var(--panel);
  padding: 18px 20px 20px; box-shadow: var(--shadow); }
.dl h4 { margin: 0 0 4px; }
.dl .hint { font-size: 13px; color: var(--ink-3); margin: 0 0 14px;
  font-family: "IBM Plex Mono", monospace; }
.dl-row { display: flex; gap: 10px; flex-wrap: wrap; }
.dl-btn {
  display: flex; flex-direction: column; gap: 2px; align-items: flex-start;
  background: var(--panel-2); color: var(--ink); border: 1px solid var(--rule);
  border-radius: 3px; padding: 11px 16px; cursor: pointer; min-width: 148px;
  font-family: "IBM Plex Mono", monospace; text-align: left;
  transition: border-color .15s ease, background .15s ease;
}
.dl-btn:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-wash); }
.dl-btn:disabled { opacity: .45; cursor: not-allowed; }
.dl-btn b { font-size: 13px; font-weight: 600; letter-spacing: .01em; }
.dl-btn span { font-size: 10.5px; color: var(--ink-3); }
.dl-btn.primary { border-color: var(--accent); }
.dl-btn.primary b { color: var(--accent); }
.dl-msg { margin-top: 12px; font-size: 12.5px; font-family: "IBM Plex Mono", monospace;
  color: var(--ink-3); }
.dl-msg.err { color: var(--crit); }
.dl-msg.ok { color: var(--good); }
`;

const MARKUP = `
      <div class="dl" id="dl" hidden>
        <h4 style="font-family:Archivo,sans-serif;font-size:13px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3)">Download this plan</h4>
        <p class="hint">Same content in every format. Your browser will confirm before saving.</p>
        <div class="dl-row">
          ${FILES.map((f, i) => `<button class="dl-btn${i === 1 ? ' primary' : ''}" data-dl="${f.id}" data-name="${f.name}">
            <b>${f.label}</b><span>${f.note}</span>
          </button>`).join('\n          ')}
        </div>
        <div class="dl-msg" id="dl-msg" role="status" aria-live="polite"></div>
      </div>
`;

const SCRIPT = `
<script>
/**
 * Saving a copy.
 *
 * The viewer sandbox makes an ordinary download link inert, so the page asks
 * the host to hand the file over instead. Three things follow from that:
 *
 *   1. The capability may simply not be granted on this view. Then there is no
 *      save bar at all — an affordance that cannot work is worse than none.
 *   2. Word and PDF live in an extended format set that is not always enabled.
 *      When one is refused the bar says so and points at Markdown, which is in
 *      the base set and always available.
 *   3. The viewer confirms every save and may decline. A decline is a decision,
 *      not an error, and is never retried automatically.
 */
(async () => {
  const bar = document.getElementById('dl');
  const msg = document.getElementById('dl-msg');
  if (!bar) return;

  const downloads = await (window.claude?.use?.('downloads') ?? Promise.resolve(null));
  if (!downloads) return;             // not granted here — leave the bar hidden
  bar.hidden = false;

  const bytes = (id) => {
    const raw = document.getElementById('blob-' + id)?.textContent?.trim();
    if (!raw) return null;
    const bin = atob(raw);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  };

  const say = (text, tone = '') => { msg.textContent = text; msg.className = 'dl-msg ' + tone; };

  bar.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-dl]');
    if (!button) return;

    const data = bytes(button.dataset.dl);
    if (!data) return say('That file is missing from this page.', 'err');

    const label = button.querySelector('b').textContent;
    button.disabled = true;
    say('Waiting for you to confirm the save…');

    try {
      await downloads.save({ filename: button.dataset.name, data });
      say(label + ' saved.', 'ok');
    } catch (error) {
      const code = error?.code ?? 'unavailable';
      if (code === 'declined') say('Save cancelled.');
      else if (code === 'extension_not_enabled')
        say(label + ' is not an enabled format on this account — use Markdown, which always is.', 'err');
      else if (code === 'rate_limited') say('One save at a time. Try again in a moment.', 'err');
      else if (code === 'too_large') say(label + ' is too large to hand over here.', 'err');
      else say('Could not save ' + label + ' (' + code + ').', 'err');
    } finally {
      button.disabled = false;
    }
  });
})();
</script>
`;

// Styles go with the rest of the stylesheet.
html = html.replace('@media (prefers-reduced-motion: reduce)', CSS + '\n@media (prefers-reduced-motion: reduce)');

// The bar sits directly under the contents, where someone looking for the
// document rather than the argument will find it first.
const anchor = '  </nav>\n</header>';
if (!html.includes(anchor)) throw new Error('contents anchor not found');
html = html.replace(anchor, '  </nav>\n' + MARKUP + '</header>');

// Payloads and behaviour at the end of the document.
html = html.replace('</div>\n', '</div>\n');
html = html.trimEnd() + '\n\n' + payloads + '\n' + SCRIPT + '\n';

writeFileSync(`${S}/gtm.html`, html);
console.log('\npage is now', (html.length / 1024 / 1024).toFixed(2), 'MB (16 MB limit)');
