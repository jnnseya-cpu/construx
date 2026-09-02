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
  black: '#090a0d',
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
                              text-decoration:none;padding:11px 22px;border-radius:6px">Sign in to CONSTRUX &rarr;</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="background:#ffffff;border-radius:0 0 12px 12px;padding:18px 22px;border-top:1px solid #e3e4e7">
              <p style="margin:0 0 11px 0;font-size:12px;line-height:1.9;color:${BRAND.muted}">${standing}</p>
              <p style="margin:0;font-size:11.5px;line-height:1.65;color:#9aa0a6">
                Sent to ${esc(recipient.email)} because you hold a CONSTRUX account.
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
    `CONSTRUX — ${copy.week}`,
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
    `Sent to ${recipient.email} because you hold a CONSTRUX account.`,
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

// --- Pages reached from a link in an email ----------------------------------

/**
 * The shell every emailed link lands on.
 *
 * Deliberately plain: no scripts, no application shell, no sign-in, nothing
 * that needs a session. Somebody arriving here has clicked a link in a mail
 * client and may well be on a phone, on a corporate network that rewrites URLs,
 * with a browser that blocks third-party anything. The page has one job and
 * does it with a form and a button.
 */
function plainPage(title: string, heading: string, bodyHtml: string, indexable = false): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${indexable ? '' : '<meta name="robots" content="noindex,nofollow">\n'}
<!-- No favicon link, deliberately. These pages run under the SELF_CONTAINED
     policy, whose default-src of none forbids images because a page reached
     from a link in an email is the one most likely to be attacked. The browser
     falls back to /favicon.ico and gets a 404 nobody sees; widening a security
     policy to silence a devtools line is the wrong trade. -->
<title>${esc(title)} — CONSTRUX</title>
</head>
<body style="margin:0;background:${BRAND.paper};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;padding:48px 18px">
    <a href="${esc(absolute('/'))}" style="display:block;background:${BRAND.black};border-radius:12px 12px 0 0;padding:20px 26px;text-decoration:none">
      <span style="font-size:16px;font-weight:800;letter-spacing:.4px;color:#fff;white-space:nowrap">CONSTRU<span style="color:${BRAND.orange}">X</span></span>
    </a>
    <div style="background:#fff;border-radius:0 0 12px 12px;padding:30px 26px;border:1px solid #e3e4e7;border-top:0">
      <h1 style="margin:0 0 14px 0;font-size:21px;line-height:1.3;color:${BRAND.ink}">${esc(heading)}</h1>
      ${bodyHtml}
    </div>
  </div>
</body>
</html>`;
}

/** A primary action styled as a button, whether it is a link or a submit. */
const BUTTON = `background:${BRAND.orange};color:#fff;border:0;border-radius:6px;padding:12px 20px;
        font-size:14px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block`;
const BUTTON_QUIET = `background:${BRAND.grey};color:#fff;border:0;border-radius:6px;padding:12px 20px;
        font-size:14px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block`;
const PARAGRAPH = 'margin:0 0 20px 0;font-size:15px;line-height:1.6;color:#3c4046';
const QUIET = `margin:0 0 20px 0;font-size:14px;line-height:1.6;color:${BRAND.muted}`;

/**
 * The page a person lands on from the verification link in their signup email.
 *
 * This is the last step of registration and, until it existed, the only step
 * with no way to take it: the confirmation email pointed at `/verify`, nothing
 * answered there, and every person who signed up got a 404 at the moment they
 * were being asked to prove their address. The account stayed pending for ever
 * and the sign-in screen then told them, correctly and uselessly, that no such
 * account existed.
 *
 * The GET renders a button and provisions nothing. That is not politeness: the
 * token is single-use and spent on activation, and corporate mail security —
 * Defender, Proofpoint, Mimecast — fetches every link in an inbound message to
 * scan it. A GET that activated would be consumed by the scanner, and the human
 * would click a link that had already been used by a robot on their behalf.
 */
export function verificationPage(input: {
  state: 'CONFIRM' | 'DONE' | 'FAILED';
  /** Carried through the form so the POST has what the GET was given. */
  r: string;
  t: string;
  /** On DONE, who was created. On FAILED, why. */
  organisation?: string;
  email?: string;
  reason?: string;
}): string {
  const action = `/verify?r=${encodeURIComponent(input.r)}&t=${encodeURIComponent(input.t)}`;

  if (input.state === 'CONFIRM') {
    return plainPage(
      'Confirm your account',
      'Confirm your email address',
      `<p style="${PARAGRAPH}">
         One press finishes setting up your organisation and makes you its administrator.
       </p>
       <p style="${QUIET}">
         Nothing is charged and no card is held. You will sign in afterwards with this address and a
         code sent to it.
       </p>
       <form method="post" action="${esc(action)}" style="margin:0">
         <button type="submit" style="${BUTTON}">Confirm and create my account</button>
       </form>`,
    );
  }

  if (input.state === 'DONE') {
    return plainPage(
      'Account created',
      'Your account is ready',
      `<p style="${PARAGRAPH}">
         <b>${esc(input.organisation ?? 'Your organisation')}</b> exists on the platform and
         <b>${esc(input.email ?? '')}</b> is its administrator.
       </p>
       <p style="${QUIET}">
         Sign in with that address. A six-character code will be sent to it — that is the second factor,
         and it is required every time.
       </p>
       <a href="${esc(absolute('/app'))}" style="${BUTTON}">Sign in</a>`,
    );
  }

  // FAILED. The reason is the domain error's own message: already verified, link
  // superseded, link expired, address taken since. Each one has a different next
  // step and saying "invalid link" for all four would strand somebody whose only
  // problem is that they clicked the older of two emails.
  return plainPage(
    'Confirmation link',
    'That link did not work',
    `<p style="${PARAGRAPH}">${esc(input.reason ?? 'That verification link is not valid.')}</p>
     <p style="${QUIET}">
       If the link has expired or been replaced, start again and the newest email will be the one that works.
     </p>
     <a href="${esc(absolute('/get-started'))}" style="${BUTTON}">Start again</a>
     <a href="${esc(absolute('/app'))}" style="${BUTTON_QUIET};margin-left:8px">Sign in</a>`,
  );
}

/**
 * The page a person lands on from the unsubscribe link.
 *
 * Someone following this link has already decided, and the page's only job is to
 * make the decision take effect in one press and confirm that it did. The GET
 * only ever shows the confirmation — acting on a GET would let a mail scanner
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
        <b>${esc(input.user.email)}</b> currently receives the CONSTRUX newsletter.
      </p>
      <p style="margin:0 0 20px 0;font-size:14px;line-height:1.6;color:${BRAND.muted}">
        Stopping it does not affect your account, and you will still receive messages about work
        assigned to you inside the platform.
      </p>
      <form method="post" action="${esc(action)}" style="margin:0">
        <button type="submit" style="${BUTTON}">Stop sending me the newsletter</button>
      </form>`,
    DONE: `
      <p style="margin:0 0 6px 0;font-size:15px;line-height:1.6;color:#3c4046">
        Done. <b>${esc(input.user.email)}</b> will not receive the newsletter again.
      </p>
      <p style="${QUIET}">
        If this was a mistake, you can turn it back on under email preferences once you are signed in.
      </p>
      <a href="${esc(absolute('/app/newsletter'))}" style="${BUTTON_QUIET}">Email preferences</a>`,
    ALREADY_OUT: `
      <p style="${PARAGRAPH}">
        <b>${esc(input.user.email)}</b> is already unsubscribed. Nothing further was needed.
      </p>
      <a href="${esc(absolute('/'))}" style="${BUTTON_QUIET}">CONSTRUX</a>`,
  };

  return plainPage('Email preferences', 'Email preferences', bodies[input.state]);
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
    `Message-ID: <${input.messageId}@construxvg.com>`,
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

/**
 * The page somebody lands on holding a document and nothing else.
 *
 * This is the only screen in the product with no signed-in identity behind it
 * and no relationship to the person reading it. Its whole audience is somebody
 * on the other side of a transaction — a client's solicitor, an adjudicator, an
 * insurer, a framework auditor — who has been handed a PDF and wants to know
 * whether it is the document that was issued.
 *
 * The three fields are the three strings printed on the document. Nothing else
 * is asked for, because anything else would be a barrier between a document and
 * the check that makes it worth anything, and a check nobody performs is a
 * check that does not exist.
 *
 * A failure says one thing for every cause. A code that was mistyped, a
 * tenancy that does not exist and a document with a figure altered in it all
 * produce the same sentence, because a page that distinguished them would tell
 * somebody working on a forgery which half of their attempt was right.
 */
export function documentVerificationPage(input: {
  state: 'FORM' | 'VERIFIED' | 'REFUSED';
  reference?: string;
  contentHash?: string;
  verification?: string;
  /** On VERIFIED, what the record says about the document being checked. */
  issuedBy?: string;
  issuedAt?: string;
  audience?: string;
  documentTitle?: string;
  recorded?: boolean;
  /** On REFUSED, the single sentence every failure gets. */
  finding?: string;
}): string {
  const field = (name: string, label: string, hint: string, value: string) =>
    `<label style="display:block;margin:0 0 16px 0">
       <span style="display:block;font-size:13px;font-weight:700;color:#3c4046;margin-bottom:4px">${esc(label)}</span>
       <span style="display:block;font-size:12px;color:${BRAND.muted};margin-bottom:6px">${esc(hint)}</span>
       <input name="${esc(name)}" value="${esc(value)}" required
              style="width:100%;box-sizing:border-box;padding:10px 12px;font-family:ui-monospace,Menlo,Consolas,monospace;
                     font-size:13px;border:1px solid #d5dbe0;border-radius:6px">
     </label>`;

  const form = `<form method="post" action="/verify-document" style="margin:0">
       ${field('reference', 'Document reference', 'Top of the page, beside the issuer’s name.', input.reference ?? '')}
       ${field('contentHash', 'Content hash', 'Begins sha256: — on the cover and in the footer.', input.contentHash ?? '')}
       ${field('verification', 'Verification code', 'Begins CXV1: — printed beside the content hash.', input.verification ?? '')}
       <button type="submit" style="${BUTTON}">Check this document</button>
     </form>`;

  if (input.state === 'FORM') {
    return plainPage(
      'Verify a document',
      'Check a document you have been given',
      `<p style="${PARAGRAPH}">
         Documents issued through this platform carry a verification code. It proves the document came from the
         organisation named on it and that not one character has changed since.
       </p>
       <p style="${QUIET}">
         The content hash on its own proves nothing — anyone who alters a document can recompute it. The verification
         code cannot be recomputed by anyone but this platform, which is what makes the check worth performing.
       </p>
       ${form}`,
      // Indexable, unlike the unsubscribe and signup-confirmation pages this
      // helper also serves. Those are reached from a link in an email and have
      // no business in a search index; this one is a public utility, and a
      // recipient who has lost the link should be able to find it by searching
      // for it.
      true,
    );
  }

  if (input.state === 'VERIFIED') {
    const rows: Array<[string, string]> = [
      ['Reference', input.reference ?? ''],
      ['Issued by', input.issuedBy ?? ''],
      ['Issued', (input.issuedAt ?? '').slice(0, 16).replace('T', ' ')],
      ['Prepared for', input.audience ?? ''],
      ['Title', input.documentTitle ?? ''],
    ].filter((row): row is [string, string] => row[1] !== '');

    return plainPage(
      'Document verified',
      'This document is genuine',
      `<p style="${PARAGRAPH}">
         <b>${esc(input.reference ?? '')}</b> was issued by this platform with exactly this content. Any alteration
         since would have moved the content hash, and this code would not have matched.
       </p>
       <table style="width:100%;border-collapse:collapse;margin:0 0 20px 0;font-size:14px">
         ${rows
           .map(
             ([label, value]) =>
               `<tr><td style="padding:6px 0;color:${BRAND.muted};width:140px">${esc(label)}</td>` +
               `<td style="padding:6px 0;color:#3c4046"><b>${esc(value)}</b></td></tr>`,
           )
           .join('')}
       </table>
       ${
         input.recorded === false
           ? `<p style="${QUIET}">
                The code is valid, but this deployment’s export register does not hold a matching entry — it has been
                restored from a shorter record than this document is old. The document is genuine; only the
                surrounding detail above is unavailable.
              </p>`
           : ''
       }
       <p style="${QUIET}">
         What this does <b>not</b> establish: that this is the current revision, or that the statements in it are
         correct. It establishes issuance and integrity, which is narrower and more useful than either.
       </p>
       <a href="/verify-document" style="${BUTTON_QUIET}">Check another document</a>`,
      true,
    );
  }

  return plainPage(
    'Document not verified',
    'This does not match an issued document',
    `<p style="${PARAGRAPH}">${esc(input.finding ?? '')}</p>
     <p style="${QUIET}">
       Codes are long and easy to mistype — check the three fields against the document before concluding anything
       about it. If they are right and this page still refuses, the document is not what it claims to be, and the
       organisation named on it is the party to raise that with.
     </p>
     ${form}`,
    true,
  );
}
