import { command } from './command.js';
import { toast } from './ui.js';

/**
 * Report a problem — the honest "get help when stuck" control.
 *
 * One place, reused: the copilot's "this didn't help", an error's "report this",
 * a plain "report a problem". It opens the standard command modal (so a field
 * error from the API is shown the same way as everywhere else), posts to
 * `/v1/support/reports`, and — crucially — shows the person the reference and
 * who it reached. The platform never reports anything about the person silently;
 * they press the button and they see where it went.
 *
 * `opts` carries the context the person should not have to type: the screen they
 * are on, the copilot question behind a "stuck" report, and the correlation id of
 * a failed request so a developer can find the exact failure. None of it is shown
 * raw — it rides along on the report.
 */
export async function openReport({ kind = 'FEEDBACK', screen, question, correlationId, prefill } = {}) {
  const sent = await command({
    title: 'Report a problem',
    intent:
      'Tell us what went wrong, in your own words. It goes on your company’s record and to the people who can act on ' +
      'it — and, where support is connected, to the team that fixes it. You send it; nothing about you is reported ' +
      'without you.',
    path: '/v1/support/reports',
    submitLabel: 'Send report',
    fields: [
      {
        name: 'kind',
        label: 'What kind of problem',
        type: 'select',
        value: kind,
        options: [
          { value: 'STUCK', label: 'The AI or guide could not help' },
          { value: 'ERROR', label: 'Something broke or errored' },
          { value: 'FEEDBACK', label: 'Feedback or a suggestion' },
        ],
      },
      {
        name: 'message',
        label: 'What happened',
        type: 'textarea',
        value: prefill ?? '',
        hint: 'A sentence or two — what you were trying to do, and what went wrong.',
      },
    ],
    transform: (v) => ({
      kind: v.kind,
      message: v.message,
      ...(screen ? { screen } : {}),
      ...(question ? { question } : {}),
      ...(correlationId ? { correlationId } : {}),
    }),
  });
  if (!sent) return null;

  const reached = [];
  if (sent.deliveredTo > 0) reached.push('your administrators have been notified');
  if (sent.forwardedToOps) reached.push('it has reached the support team');
  toast(
    'Reported',
    `Thank you — your report is on the record as ${sent.reference}${reached.length > 0 ? `, and ${reached.join(' and ')}` : ''}.`,
    'ok',
  );
  return sent;
}
