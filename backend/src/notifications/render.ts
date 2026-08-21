import { config } from '../config.ts';
import type { ClientBranding } from '../export/exporter.ts';
import { absolute, esc, type RenderedEmail } from '../messaging/render.ts';
import { unsubscribeUrl } from '../messaging/audience.ts';
import { fillTemplate, type NotificationEvent } from './catalogue.ts';

/**
 * The branded transactional email.
 *
 * The tenant's own mark, colour and registered detail on every outbound
 * message, because a notice about somebody's account arriving under a platform
 * nobody recognises is a notice that gets reported as phishing. Branding is the
 * same `ClientBranding` the exporter already uses — one place a tenant's
 * identity is configured, not two that can disagree about their logo.
 *
 * Table layout and inline styles for the same reason the newsletter uses them:
 * half the clients that open this run a rendering engine from 2007, and the
 * others strip `<style>`. Every message carries a plain-text alternative,
 * generated from the same inputs so it cannot drift into saying something
 * different from the HTML.
 *
 * ---
 *
 * **A mandatory notice does not carry an unsubscribe link, and says why.**
 * Offering one would be an unsubscribe that does not work. The footer states
 * that the message was sent because it concerns the security or administration
 * of the account, which is the honest version of the same sentence and is also
 * the exemption every marketing regime relies on.
 */

export type Branding = ClientBranding;

const NEUTRAL = {
  paper: '#f4f4f5',
  ink: '#1a1a1c',
  muted: '#6b7076',
  line: '#e3e4e7',
  card: '#ffffff',
} as const;

/** Severity drives one accent, not a redesign. */
const SEVERITY_TONE: Record<string, { label: string; colour: string; background: string }> = {
  INFO: { label: 'Notice', colour: '#31527a', background: '#eaf0f8' },
  SUCCESS: { label: 'Confirmed', colour: '#1f6b45', background: '#e8f5ee' },
  WARNING: { label: 'Action needed', colour: '#8a5a10', background: '#fdf2e0' },
  CRITICAL: { label: 'Urgent', colour: '#8d2723', background: '#fbe9e8' },
};

function logoBlock(branding: Branding): string {
  if (branding.logoRef) {
    return `<img src="${esc(branding.logoRef)}" alt="${esc(branding.clientName)}" height="30"
                 style="display:block;height:30px;max-height:30px;border:0;outline:none;text-decoration:none">`;
  }
  // No mark configured: the name, set in the tenant's own colour. Not a
  // placeholder image and not the platform's logo standing in for theirs.
  return `<span style="font-size:16px;font-weight:800;letter-spacing:.3px;color:#ffffff">${esc(branding.clientName)}</span>`;
}

/**
 * The body copy for an event.
 *
 * Deliberately derived from the catalogue rather than held as 177 hand-written
 * bodies: the subject already states the fact, and a body that restates it in
 * more words adds nothing a recipient reads. What the body adds is the context
 * a person needs to act — who it concerns, when, and where to go.
 */
function bodyFor(event: NotificationEvent, payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const subject = fillTemplate(event.subject, payload);
  lines.push(subject);

  if (typeof payload.detail === 'string' && payload.detail.trim() !== '') lines.push(payload.detail);

  if (event.mandatory) {
    lines.push(
      'You are receiving this because it concerns the security or administration of your account. ' +
        'Notices of this kind are sent regardless of your notification preferences.',
    );
  }

  return lines;
}

export function renderNotificationEmail(input: {
  event: NotificationEvent;
  subject: string;
  recipient: { id: string; name: string; email: string };
  payload: Record<string, unknown>;
  branding: Branding;
}): RenderedEmail {
  const { event, subject, recipient, payload, branding } = input;
  const tone = SEVERITY_TONE[event.severity] ?? SEVERITY_TONE.INFO!;
  const accent = branding.primaryColour || '#ff6600';
  const body = bodyFor(event, payload);

  const action =
    typeof payload.actionUrl === 'string' && payload.actionUrl !== ''
      ? { url: absolute(payload.actionUrl), label: typeof payload.actionLabel === 'string' ? payload.actionLabel : 'Open CONSTRUX' }
      : undefined;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${NEUTRAL.paper};-webkit-text-size-adjust:100%">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(body[0] ?? subject)}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${NEUTRAL.paper}">
    <tr>
      <td align="center" style="padding:26px 12px">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
               style="width:100%;max-width:600px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">

          <tr>
            <td style="background:#0c0c0e;border-top:3px solid ${esc(accent)};border-radius:12px 12px 0 0;padding:20px 24px">
              ${logoBlock(branding)}
            </td>
          </tr>

          <tr>
            <td style="background:${NEUTRAL.card};padding:24px 24px 8px 24px">
              <span style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;
                           color:${tone.colour};background:${tone.background};padding:4px 9px;border-radius:4px">${esc(tone.label)}</span>
              <h1 style="margin:13px 0 0 0;font-size:21px;line-height:1.3;color:${NEUTRAL.ink};font-weight:750">${esc(subject)}</h1>
            </td>
          </tr>

          <tr>
            <td style="background:${NEUTRAL.card};padding:10px 24px 20px 24px">
              <p style="margin:0 0 12px 0;font-size:14.5px;line-height:1.6;color:${NEUTRAL.ink}">Hello ${esc(recipient.name)},</p>
              ${body
                .slice(1)
                .map(
                  (line) =>
                    `<p style="margin:0 0 12px 0;font-size:14.5px;line-height:1.62;color:${NEUTRAL.muted}">${esc(line)}</p>`,
                )
                .join('\n              ')}
              ${
                action
                  ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 4px 0">
                <tr><td style="background:${esc(accent)};border-radius:7px">
                  <a href="${esc(action.url)}" style="display:inline-block;padding:11px 21px;font-size:14px;font-weight:700;
                     color:#ffffff;text-decoration:none">${esc(action.label)}</a>
                </td></tr>
              </table>`
                  : ''
              }
            </td>
          </tr>

          <tr>
            <td style="background:${NEUTRAL.card};border-top:1px solid ${NEUTRAL.line};border-radius:0 0 12px 12px;padding:16px 24px 20px 24px">
              <p style="margin:0 0 8px 0;font-size:11.5px;line-height:1.6;color:${NEUTRAL.muted}">${esc(branding.legalFooter)}</p>
              <p style="margin:0;font-size:11.5px;line-height:1.6;color:${NEUTRAL.muted}">
                ${
                  event.mandatory
                    ? 'Sent because it concerns the security or administration of your account. Notices of this kind are not subject to notification preferences.'
                    : `<a href="${esc(absolute('/app/settings/notifications'))}" style="color:${NEUTRAL.muted};text-decoration:underline">Notification preferences</a>
                       <span style="color:#c8cace"> &middot; </span>
                       <a href="${esc(unsubscribeUrl(recipient.id))}" style="color:${NEUTRAL.muted};text-decoration:underline">Unsubscribe</a>`
                }
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    branding.clientName,
    '',
    subject,
    '',
    `Hello ${recipient.name},`,
    '',
    ...body.slice(1),
    ...(action ? ['', `${action.label}: ${action.url}`] : []),
    '',
    '—',
    branding.legalFooter,
    event.mandatory
      ? 'Sent because it concerns the security or administration of your account. Notices of this kind are not subject to notification preferences.'
      : `Notification preferences: ${absolute('/app/settings/notifications')}\nUnsubscribe: ${unsubscribeUrl(recipient.id)}`,
  ].join('\n');

  return { subject, html, text };
}

/**
 * A preview of exactly what a recipient receives, for the template QA screen.
 *
 * The same function that builds the real message, not a mock-up of it — a
 * preview rendered by different code is a preview that stops being true the
 * first time either side changes.
 */
export function previewNotification(input: {
  event: NotificationEvent;
  recipient: { id: string; name: string; email: string };
  payload?: Record<string, unknown>;
  branding: Branding;
}): RenderedEmail & { from: string } {
  const payload = input.payload ?? {};
  return {
    ...renderNotificationEmail({
      event: input.event,
      subject: fillTemplate(input.event.subject, payload),
      recipient: input.recipient,
      payload,
      branding: input.branding,
    }),
    from: `${config.newsletter.fromName} <${config.newsletter.fromAddress}>`,
  };
}
