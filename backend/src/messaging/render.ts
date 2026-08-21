import { randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { featuresFor, STANDING_LINKS, type Feature } from './content.ts';
import { unsubscribeUrl, type Recipient } from './audience.ts';

/**
 * Turning a campaign into an actual email.
 *
 * Email is not the web. Layout is tables because half of the clients that will
 * open this still run a 2007 rendering engine; styling is inline because the
 * others strip `<style>`; and every message carries a plain-text alternative
 * because a text/html-only email is a spam signal and unreadable to anyone
 * using a screen reader with images and HTML off.
 *
 * Both parts are generated from the same feature list, so the text version
 * cannot silently drift into saying something the HTML does not.
 */

const BRAND = {
  black: '#0c0c0e',
  carbon: '#181a1e',
  grey: '#262a30',
  orange: '#ff6600',
  paper: '#f4f4f5',
  ink: '#1a1a1c',
  muted: '#6b7076',
} as const;

/** Escape for HTML text and attribute contexts alike. */
export function esc(value: string): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function absolute(path: string): string {
  return path.startsWith('http') ? path : `${config.publicBaseUrl}${path}`;
}

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

export type CampaignCopy = {
  /** Week key, e.g. 2026-W34. */
  week: string;
  subject: string;
  headline: string;
  intro: string;
};

// --- HTML -------------------------------------------------------------------

function featureBlock(feature: Feature): string {
  const href = esc(absolute(feature.path));
  return `
    <tr>
      <td style="padding:0 0 10px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
               style="background:#ffffff;border:1px solid #e3e4e7;border-radius:10px">
          <tr>
            <td style="padding:18px 20px">
              <a href="${href}" style="color:${BRAND.ink};text-decoration:none">
                <span style="display:block;font-size:16px;line-height:1.35;font-weight:700;margin:0 0 7px 0">${esc(feature.title)}</span>
              </a>
              <p style="margin:0 0 13px 0;font-size:14px;line-height:1.55;color:${BRAND.muted}">${esc(feature.blurb)}</p>
              <a href="${href}"
                 style="display:inline-block;background:${BRAND.orange};color:#ffffff;font-size:13px;font-weight:700;
                        text-decoration:none;padding:9px 15px;border-radius:6px">${esc(feature.cta)} &rarr;</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

function renderHtml(copy: CampaignCopy, recipient: Recipient, features: Feature[]): string {
  const standing = STANDING_LINKS.map(
    (link) =>
      `<a href="${esc(absolute(link.path))}" style="color:${BRAND.muted};text-decoration:underline;white-space:nowrap">${esc(link.label)}</a>`,
  ).join(`<span style="color:#c8cace"> &middot; </span>`);

  const unsubscribe = esc(unsubscribeUrl(recipient.userId));
  const preferences = esc(absolute('/app/newsletter'));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(copy.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.paper};-webkit-text-size-adjust:100%">
  <!-- Preheader: what the inbox shows next to the subject. Hidden in the body. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(copy.intro)}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.paper}">
    <tr>
      <td align="center" style="padding:26px 12px">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
               style="width:100%;max-width:600px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">

          <tr>
            <td style="background:${BRAND.black};border-radius:12px 12px 0 0;padding:22px 24px">
              <a href="${esc(absolute('/'))}" style="text-decoration:none;color:#ffffff">
                <span style="font-size:17px;font-weight:800;letter-spacing:.4px">CONSTRUX<span style="color:${BRAND.orange}">.AI</span></span>
              </a>
              <span style="float:right;font-size:11px;color:#8b9098;padding-top:5px">${esc(copy.week)}</span>
            </td>
          </tr>

          <tr>
            <td style="background:${BRAND.carbon};padding:26px 24px 28px 24px">
              <h1 style="margin:0 0 11px 0;font-size:23px;line-height:1.28;color:#ffffff;font-weight:750">${esc(copy.headline)}</h1>
              <p style="margin:0;font-size:14.5px;line-height:1.6;color:#b9bdc4">${esc(copy.intro)}</p>
            </td>
          </tr>

          <tr>
            <td style="background:${BRAND.paper};padding:20px 16px 6px 16px">
              <p style="margin:0 0 14px 0;font-size:13px;color:${BRAND.muted}">
                ${esc(recipient.name)} &mdash; picked out for ${esc(recipient.roles.join(', ') || 'your account')}
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                ${features.map(featureBlock).join('')}
              </table>
            </td>
          </tr>

          <tr>
            <td style="background:${BRAND.paper};padding:6px 20px 20px 20px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                     style="background:${BRAND.grey};border-radius:10px">
                <tr>
                  <td style="padding:19px 20px" align="center">
                    <p style="margin:0 0 13px 0;font-size:14.5px;line-height:1.5;color:#ffffff;font-weight:650">
                      Everything above runs against your own project data.
                    </p>
                    <a href="${esc(absolute('/app'))}"
                       style="display:inline-block;background:${BRAND.orange};color:#ffffff;font-size:14px;font-weight:700;
                              text-decoration:none;padding:11px 22px;border-radius:6px">Sign in to CONSTRUX.AI &rarr;</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="background:#ffffff;border-radius:0 0 12px 12px;padding:18px 22px;border-top:1px solid #e3e4e7">
              <p style="margin:0 0 11px 0;font-size:12px;line-height:1.9;color:${BRAND.muted}">${standing}</p>
              <p style="margin:0;font-size:11.5px;line-height:1.65;color:#9aa0a6">
                Sent to ${esc(recipient.email)} because you hold a CONSTRUX.AI account.
                <a href="${unsubscribe}" style="color:${BRAND.muted}">Unsubscribe</a> &middot;
                <a href="${preferences}" style="color:${BRAND.muted}">Email preferences</a><br>
                This message carries no project, commercial or safety data.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// --- Plain text -------------------------------------------------------------

function renderText(copy: CampaignCopy, recipient: Recipient, features: Feature[]): string {
  const lines: string[] = [
    `CONSTRUX.AI — ${copy.week}`,
    '='.repeat(58),
    '',
    copy.headline,
    '',
    copy.intro,
    '',
    `${recipient.name} — picked out for ${recipient.roles.join(', ') || 'your account'}`,
    '',
  ];

  for (const feature of features) {
    lines.push(`* ${feature.title}`, `  ${feature.blurb}`, `  ${feature.cta}: ${absolute(feature.path)}`, '');
  }

  lines.push(
    '-'.repeat(58),
    `Sign in: ${absolute('/app')}`,
    ...STANDING_LINKS.map((link) => `${link.label}: ${absolute(link.path)}`),
    '',
    `Sent to ${recipient.email} because you hold a CONSTRUX.AI account.`,
    'This message carries no project, commercial or safety data.',
    `Unsubscribe: ${unsubscribeUrl(recipient.userId)}`,
    `Email preferences: ${absolute('/app/newsletter')}`,
  );

  return lines.join('\n');
}

export function renderCampaign(copy: CampaignCopy, recipient: Recipient): RenderedEmail {
  const features = featuresFor(recipient.roles);
  return {
    subject: copy.subject,
    html: renderHtml(copy, recipient, features),
    text: renderText(copy, recipient, features),
  };
}

// --- The unsubscribe page ---------------------------------------------------

/**
 * The page a person lands on from the unsubscribe link.
 *
 * Deliberately plain: no scripts, no application shell, no sign-in. Someone
 * following this link has already decided, and the page's only job is to make
 * the decision take effect in one press and confirm that it did. The GET only
 * ever shows the confirmation — acting on a GET would let a mail scanner
 * prefetching links unsubscribe people who never clicked.
 */
export function unsubscribePage(input: {
  state: 'CONFIRM' | 'DONE' | 'ALREADY_OUT';
  user: { name: string; email: string };
  u: string;
  t: string;
}): string {
  const action = `/unsubscribe?u=${encodeURIComponent(input.u)}&t=${encodeURIComponent(input.t)}`;

  const bodies: Record<typeof input.state, string> = {
    CONFIRM: `
      <p style="margin:0 0 6px 0;font-size:15px;line-height:1.6;color:#3c4046">
        <b>${esc(input.user.email)}</b> currently receives the CONSTRUX.AI newsletter.
      </p>
      <p style="margin:0 0 20px 0;font-size:14px;line-height:1.6;color:${BRAND.muted}">
        Stopping it does not affect your account, and you will still receive messages about work
        assigned to you inside the platform.
      </p>
      <form method="post" action="${esc(action)}" style="margin:0">
        <button type="submit" style="background:${BRAND.orange};color:#fff;border:0;border-radius:6px;
                padding:12px 20px;font-size:14px;font-weight:700;cursor:pointer">Stop sending me the newsletter</button>
      </form>`,
    DONE: `
      <p style="margin:0 0 6px 0;font-size:15px;line-height:1.6;color:#3c4046">
        Done. <b>${esc(input.user.email)}</b> will not receive the newsletter again.
      </p>
      <p style="margin:0 0 20px 0;font-size:14px;line-height:1.6;color:${BRAND.muted}">
        If this was a mistake, you can turn it back on under email preferences once you are signed in.
      </p>
      <a href="${esc(absolute('/app/newsletter'))}" style="display:inline-block;background:${BRAND.grey};color:#fff;
         border-radius:6px;padding:12px 20px;font-size:14px;font-weight:700;text-decoration:none">Email preferences</a>`,
    ALREADY_OUT: `
      <p style="margin:0 0 20px 0;font-size:15px;line-height:1.6;color:#3c4046">
        <b>${esc(input.user.email)}</b> is already unsubscribed. Nothing further was needed.
      </p>
      <a href="${esc(absolute('/'))}" style="display:inline-block;background:${BRAND.grey};color:#fff;
         border-radius:6px;padding:12px 20px;font-size:14px;font-weight:700;text-decoration:none">CONSTRUX.AI</a>`,
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Email preferences — CONSTRUX.AI</title>
</head>
<body style="margin:0;background:${BRAND.paper};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;padding:48px 18px">
    <div style="background:${BRAND.black};border-radius:12px 12px 0 0;padding:20px 26px">
      <span style="font-size:16px;font-weight:800;letter-spacing:.4px;color:#fff">CONSTRUX<span style="color:${BRAND.orange}">.AI</span></span>
    </div>
    <div style="background:#fff;border-radius:0 0 12px 12px;padding:30px 26px;border:1px solid #e3e4e7;border-top:0">
      <h1 style="margin:0 0 14px 0;font-size:21px;line-height:1.3;color:${BRAND.ink}">Email preferences</h1>
      ${bodies[input.state]}
    </div>
  </div>
</body>
</html>`;
}

// --- MIME -------------------------------------------------------------------

/**
 * Encode a header value that may contain non-ASCII.
 *
 * A raw UTF-8 byte in a header is not legal and is silently mangled by some
 * relays, which shows up as a corrupted display name months later. RFC 2047
 * encoded-words are the fix.
 */
function header(value: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately matching the ASCII range
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * Quoted-printable, because 8-bit bodies are not guaranteed to survive a relay
 * and base64 makes the plain-text part unreadable to anyone inspecting it.
 */
function quotedPrintable(input: string): string {
  const escaped = Buffer.from(input.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'), 'utf8')
    .reduce<string[]>((out, byte) => {
      const char = String.fromCharCode(byte);
      if (char === '\r' || char === '\n') out.push(char);
      else if (byte === 0x3d || byte < 0x20 || byte > 0x7e) out.push(`=${byte.toString(16).toUpperCase().padStart(2, '0')}`);
      else out.push(char);
      return out;
    }, [])
    .join('');

  // Soft-wrap at 76 characters without splitting an =XX escape sequence.
  return escaped
    .split('\r\n')
    .map((line) => {
      const wrapped: string[] = [];
      let current = '';
      for (const piece of line.match(/(=[0-9A-F]{2}|[\s\S])/g) ?? []) {
        if (current.length + piece.length > 73) {
          wrapped.push(`${current}=`);
          current = '';
        }
        current += piece;
      }
      wrapped.push(current);
      return wrapped.join('\r\n');
    })
    .join('\r\n');
}

export type MimeInput = {
  to: string;
  toName: string;
  subject: string;
  html: string;
  text: string;
  /** Absolute URL honoured by one-click unsubscribe (RFC 8058). */
  unsubscribe: string;
  messageId: string;
};

/**
 * Build the full RFC 5322 message.
 *
 * `List-Unsubscribe` with `List-Unsubscribe-Post` is what puts a real
 * unsubscribe control in the client's own chrome. Without it, the only way out
 * of the list is the spam button, which damages delivery for every other
 * recipient — so it is a correctness requirement, not a nicety.
 */
export function buildMime(input: MimeInput): string {
  const boundary = `--=_construx_${randomBytes(12).toString('hex')}`;
  const from = `${header(config.newsletter.fromName)} <${config.newsletter.fromAddress}>`;

  const headers = [
    `From: ${from}`,
    `To: ${header(input.toName)} <${input.to}>`,
    `Subject: ${header(input.subject)}`,
    `Message-ID: <${input.messageId}@construx.ai>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `List-Unsubscribe: <${input.unsubscribe}>`,
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    'Auto-Submitted: auto-generated',
    // Marks the message as bulk so vacation responders stay silent.
    'Precedence: bulk',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  if (config.newsletter.replyTo) headers.push(`Reply-To: ${config.newsletter.replyTo}`);

  const body = [
    '',
    'This is a message in MIME format.',
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintable(input.text),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintable(input.html),
    '',
    `--${boundary}--`,
    '',
  ];

  return [...headers, ...body].join('\r\n');
}
