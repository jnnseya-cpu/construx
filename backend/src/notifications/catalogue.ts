/**
 * The communication event catalogue.
 *
 * One engine, 177 events, fanning out across email, in-app, SMS, push and
 * WhatsApp. It is a closed catalogue for the same reason the Golden Thread's
 * is: a notification that can be fired from anywhere with an arbitrary string
 * is a notification nobody can audit, suppress, translate or reason about. A
 * code that is not in this file cannot be sent.
 *
 * ---
 *
 * **This is not the Golden Thread catalogue.** They share a shape and nothing
 * else. `backend/src/goldenthread/eventTypes.ts` records what happened to a
 * project and is evidence; this records what the platform told somebody, and
 * is a delivery obligation. Conflating them would put marketing sends into a
 * legal record and statutory notices into a mailing list.
 *
 * **Mandatory notices ignore preferences by construction.** Twenty-seven of
 * these tell somebody their account was locked, their password changed, their
 * payment failed, a compliance breach was detected or their data is being
 * deleted. A preference centre that can switch those off is a liability, not a
 * feature, so `mandatory` is read by the engine before preferences are loaded
 * at all rather than being a flag a later branch might forget.
 *
 * **Channels are declared here, not decided at the call site.** The default
 * routing for an event is a property of the event. A caller may narrow it —
 * never widen it — so no code path can quietly start sending SMS.
 */

/**
 * WhatsApp is declared and carries no events. That is deliberate and is stated
 * rather than hidden: the channel exists in the model, there is no provider
 * behind it, and no catalogue event routes to it. It will show as wired-but-
 * unused until both are true.
 */
export const CHANNELS = ['EMAIL', 'INAPP', 'SMS', 'PUSH', 'WHATSAPP'] as const;
export type Channel = (typeof CHANNELS)[number];

export const SEVERITIES = ['INFO', 'SUCCESS', 'WARNING', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  'IDENTITY_ACCOUNT',
  'LOGIN_SECURITY',
  'SUBSCRIPTION_BILLING',
  'USER_MANAGEMENT',
  'APPROVALS',
  'PROJECT_MANAGEMENT',
  'PRODUCT_DELIVERY',
  'PROCUREMENT_CONTRACTS',
  'DOCUMENT_COMPLIANCE',
  'AI_AGENT',
  'REPORTING_BI',
  'SUPPORT_SUCCESS',
  'PLATFORM_ADMINISTRATION',
  'LEGAL_PRIVACY',
  'ENTERPRISE_ONBOARDING',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Human-readable category names, for the console and for preference screens. */
export const CATEGORY_TITLES: Record<Category, string> = {
  IDENTITY_ACCOUNT: 'Identity & Account',
  LOGIN_SECURITY: 'Login & Security',
  SUBSCRIPTION_BILLING: 'Subscription & Billing',
  USER_MANAGEMENT: 'User Management',
  APPROVALS: 'Approvals',
  PROJECT_MANAGEMENT: 'Project Management',
  PRODUCT_DELIVERY: 'Product & Delivery',
  PROCUREMENT_CONTRACTS: 'Procurement & Contracts',
  DOCUMENT_COMPLIANCE: 'Document & Compliance',
  AI_AGENT: 'AI Agent',
  REPORTING_BI: 'Reporting & BI',
  SUPPORT_SUCCESS: 'Support & Success',
  PLATFORM_ADMINISTRATION: 'Platform Administration',
  LEGAL_PRIVACY: 'Legal & Privacy',
  ENTERPRISE_ONBOARDING: 'Enterprise Onboarding',
};

export type NotificationEvent = {
  /** Dotted code. The stable identifier; never renamed once shipped. */
  readonly code: string;
  readonly title: string;
  /** Subject line, with `{{placeholders}}` filled from the payload. */
  readonly subject: string;
  readonly category: Category;
  readonly severity: Severity;
  /** Channels this event fires on by default. */
  readonly channels: readonly Channel[];
  /**
   * Whether the notice overrides the recipient's preferences. Security,
   * money, compliance and data-protection facts a person is entitled to be
   * told regardless of what they have muted.
   */
  readonly mandatory: boolean;
};

const E = 'EMAIL' as const;
const I = 'INAPP' as const;
const S = 'SMS' as const;
const P = 'PUSH' as const;

let current: Category = 'IDENTITY_ACCOUNT';
const built: NotificationEvent[] = [];

function group(category: Category): void {
  current = category;
}

function def(
  code: string,
  title: string,
  subject: string,
  severity: Severity,
  channels: readonly Channel[],
  options: { mandatory?: boolean } = {},
): void {
  built.push({
    code,
    title,
    subject,
    category: current,
    severity,
    channels,
    mandatory: options.mandatory === true,
  });
}

/** Marks a notice that overrides preferences. Reads at the call site as intent. */
const MANDATORY = { mandatory: true } as const;

// ------------------------------------------------------- Identity & Account
group('IDENTITY_ACCOUNT');
def('account.registration.requested', 'Account requested', 'Welcome to CONSTRUX — confirm your account', 'INFO', [E, I]);
def('account.registration.received', 'Registration received', 'We received your registration', 'INFO', [E, I]);
def('account.email_verification_required', 'Email verification required', 'Verify your email address', 'WARNING', [E, I]);
def('account.mobile_verification_required', 'Mobile verification required', 'Verify your mobile number', 'WARNING', [E, I, S]);
def('account.verification.successful', 'Verification successful', 'Your account is verified', 'SUCCESS', [E, I]);
def('account.verification.failed', 'Verification failed', 'Verification could not be completed', 'WARNING', [E, I]);
def('account.verification.expired', 'Verification expired', 'Your verification link expired', 'WARNING', [E, I]);
def('account.registration.abandoned', 'Registration abandoned', 'Finish setting up your CONSTRUX account', 'INFO', [E, I]);
def('enterprise.request.received', 'Enterprise request received', 'Your enterprise application was received', 'INFO', [E, I]);
def('enterprise.verification.started', 'Enterprise verification started', 'Verification of {{enterprise}} has started', 'INFO', [E, I]);
def('enterprise.documents.requested', 'Documents requested', 'Documents needed to verify {{enterprise}}', 'WARNING', [E, I]);
def('enterprise.documents.received', 'Documents received', 'We received your documents', 'INFO', [E, I]);
def('enterprise.documents.approved', 'Documents approved', 'Your documents were approved', 'SUCCESS', [E, I]);
def('enterprise.documents.rejected', 'Documents rejected', 'Documents need attention', 'WARNING', [E, I]);
def('enterprise.activated', 'Enterprise activated', '{{enterprise}} is now live on CONSTRUX', 'SUCCESS', [E, I, P]);
def('invitation.sent', 'User invited', '{{actor}} invited you to {{enterprise}} on CONSTRUX', 'INFO', [E, I]);
def('invitation.reminder', 'Invitation reminder', 'Reminder: your invitation to {{enterprise}}', 'INFO', [E, I]);
def('invitation.accepted', 'Invitation accepted', '{{name}} accepted your invitation', 'SUCCESS', [I]);
def('invitation.declined', 'Invitation declined', '{{name}} declined the invitation', 'INFO', [I]);
def('invitation.expired', 'Invitation expired', 'Your invitation has expired', 'INFO', [E, I]);

// ---------------------------------------------------------- Login & Security
group('LOGIN_SECURITY');
def('auth.login.success', 'Successful login', 'New sign-in to your CONSTRUX account', 'INFO', [I]);
def('auth.login.failed', 'Failed login', 'Failed sign-in attempt', 'WARNING', [I]);
def('auth.login.suspicious', 'Suspicious login', 'Unusual sign-in detected', 'CRITICAL', [E, I, S], MANDATORY);
def('auth.device.new', 'New device detected', 'New device signed in', 'WARNING', [E, I], MANDATORY);
def('auth.device.approved', 'Device approved', 'Device approved', 'SUCCESS', [I]);
def('auth.device.rejected', 'Device rejected', 'Device rejected', 'WARNING', [E, I]);
def('password.forgot', 'Forgot password', 'Reset your CONSTRUX password', 'INFO', [E, I]);
def('password.reset_link', 'Password reset link', 'Your password reset link', 'INFO', [E, I]);
def('password.reset.successful', 'Password reset successful', 'Your password was reset', 'SUCCESS', [E, I, S], MANDATORY);
def('password.changed', 'Password changed', 'Your password was changed', 'SUCCESS', [E, I], MANDATORY);
def('password.expiry_warning', 'Password expiry warning', 'Your password expires soon', 'WARNING', [E, I]);
def('mfa.otp_code', 'OTP code', 'Your CONSTRUX verification code', 'INFO', [E, I, S]);
def('mfa.enabled', 'MFA enabled', 'Two-factor authentication enabled', 'SUCCESS', [E, I], MANDATORY);
def('mfa.disabled', 'MFA disabled', 'Two-factor authentication disabled', 'WARNING', [E, I, S], MANDATORY);
def('mfa.backup_code_generated', 'Backup codes generated', 'New MFA backup codes generated', 'INFO', [E, I]);
def('security.alert', 'Security alert', 'Security alert on your account', 'CRITICAL', [E, I, S], MANDATORY);
def('account.locked', 'Account locked', 'Your account has been locked', 'CRITICAL', [E, I, S], MANDATORY);
def('account.unlocked', 'Account unlocked', 'Your account is unlocked', 'SUCCESS', [E, I]);
def('security.too_many_attempts', 'Too many attempts', 'Too many attempts', 'WARNING', [I]);
def('session.revoked', 'Session revoked', 'A session was signed out', 'WARNING', [E, I], MANDATORY);

// ---------------------------------------------------- Subscription & Billing
group('SUBSCRIPTION_BILLING');
def('subscription.trial_started', 'Trial started', 'Your CONSTRUX trial has started', 'SUCCESS', [E, I]);
def('subscription.trial_ending', 'Trial ending', 'Your trial ends in 3 days', 'WARNING', [E, I]);
def('subscription.trial_expired', 'Trial expired', 'Your trial has ended', 'WARNING', [E, I]);
def('subscription.activated', 'Subscription activated', 'Your {{plan}} subscription is active', 'SUCCESS', [E, I]);
def('subscription.renewed', 'Subscription renewed', 'Your subscription renewed', 'INFO', [E, I]);
def('subscription.cancelled', 'Subscription cancelled', 'Your subscription was cancelled', 'WARNING', [E, I]);
def('subscription.reactivated', 'Subscription reactivated', 'Your subscription is reactivated', 'SUCCESS', [E, I]);
def('payment.pending', 'Payment pending', 'Payment is processing', 'INFO', [I]);
def('payment.successful', 'Payment successful', 'Payment received — {{amount}}', 'SUCCESS', [E, I]);
def('payment.failed', 'Payment failed', 'Your payment failed', 'WARNING', [E, I, S], MANDATORY);
def('payment.retry', 'Payment retry', 'We’ll retry your payment', 'INFO', [E, I]);
def('payment.card_expiring', 'Card expiring', 'Your card expires soon', 'WARNING', [E, I]);
def('payment.card_expired', 'Card expired', 'Your card has expired', 'WARNING', [E, I]);
def('payment.refund_processed', 'Refund processed', 'Your refund was processed', 'SUCCESS', [E, I]);
def('invoice.generated', 'Invoice generated', 'Invoice {{number}} is ready', 'INFO', [E, I]);
def('invoice.overdue', 'Invoice overdue', 'Invoice {{number}} is overdue', 'WARNING', [E, I, S], MANDATORY);
def('invoice.reminder', 'Invoice reminder', 'Reminder: invoice {{number}} due {{date}}', 'INFO', [E, I]);
def('invoice.paid', 'Invoice paid', 'Invoice {{number}} paid', 'SUCCESS', [E, I]);
def('invoice.credit_note_issued', 'Credit note issued', 'Credit note issued', 'INFO', [E, I]);

// ---------------------------------------------------------- User Management
group('USER_MANAGEMENT');
def('user.created', 'User created', 'New user added', 'INFO', [I]);
def('user.activated', 'User activated', 'Your account is active', 'SUCCESS', [E, I]);
def('user.suspended', 'User suspended', 'Your account has been suspended', 'WARNING', [E, I], MANDATORY);
def('user.reactivated', 'User reactivated', 'Your account is reactivated', 'SUCCESS', [E, I]);
def('user.removed', 'User removed', 'Your access has been removed', 'WARNING', [E, I], MANDATORY);
def('role.assigned', 'Role assigned', 'Your role was updated', 'INFO', [E, I]);
def('role.removed', 'Role removed', 'A role was removed', 'INFO', [I]);
def('permission.changed', 'Permission changed', 'Your permissions changed', 'INFO', [I]);
def('team.member_added', 'Added to team', 'You were added to {{item}}', 'INFO', [I, P]);
def('team.member_removed', 'Removed from team', 'You were removed from {{item}}', 'INFO', [I]);
def('team.ownership_changed', 'Team ownership changed', 'Team ownership changed', 'INFO', [E, I]);

// ------------------------------------------------------------------ Approvals
group('APPROVALS');
def('approval.requested', 'Approval requested', 'Approval needed: {{item}}', 'WARNING', [E, I, P]);
def('approval.reminder', 'Approval reminder', 'Reminder: approval pending for {{item}}', 'WARNING', [E, I, P]);
def('approval.escalated', 'Approval escalated', 'Escalated approval: {{item}}', 'WARNING', [E, I, P]);
def('approval.approved', 'Approved', '{{item}} was approved', 'SUCCESS', [E, I, P]);
def('approval.rejected', 'Rejected', '{{item}} was rejected', 'WARNING', [E, I, P]);
def('approval.returned', 'Returned for amendment', '{{item}} returned for changes', 'WARNING', [E, I, P]);
def('approval.sla_breach', 'SLA breach', 'SLA breach: {{item}} approval overdue', 'CRITICAL', [E, I, S], MANDATORY);
def('approval.escalated_manager', 'Escalated to manager', 'Approval escalated to manager', 'WARNING', [E, I, P]);
def('approval.escalated_executive', 'Escalated to executive', 'Approval escalated to executive', 'CRITICAL', [E, I, S], MANDATORY);

// -------------------------------------------------------- Project Management
group('PROJECT_MANAGEMENT');
def('project.created', 'Project created', 'Project created: {{project}}', 'INFO', [I]);
def('project.archived', 'Project archived', 'Project archived: {{project}}', 'INFO', [I]);
def('project.completed', 'Project completed', 'Project completed: {{project}}', 'SUCCESS', [E, I]);
def('project.cancelled', 'Project cancelled', 'Project cancelled: {{project}}', 'WARNING', [E, I]);
def('milestone.due', 'Milestone due', 'Milestone due: {{item}}', 'INFO', [I, P]);
def('milestone.overdue', 'Milestone overdue', 'Milestone overdue: {{item}}', 'WARNING', [E, I, P]);
def('milestone.achieved', 'Milestone achieved', 'Milestone achieved: {{item}}', 'SUCCESS', [I]);
def('task.assigned', 'Task assigned', 'Task assigned: {{task}}', 'INFO', [I, P]);
def('task.accepted', 'Task accepted', 'Task accepted', 'INFO', [I]);
def('task.rejected', 'Task rejected', 'Task rejected', 'WARNING', [I]);
def('task.completed', 'Task completed', 'Task completed: {{task}}', 'SUCCESS', [I]);
def('task.overdue', 'Task overdue', 'Task overdue: {{task}}', 'WARNING', [I, P]);
def('risk.identified', 'Risk identified', 'New risk on {{project}}', 'WARNING', [E, I]);
def('risk.escalated', 'Risk escalated', 'Risk escalated: {{item}}', 'CRITICAL', [E, I, S], MANDATORY);
def('risk.resolved', 'Risk resolved', 'Risk resolved: {{item}}', 'SUCCESS', [I]);

// --------------------------------------------------------- Product & Delivery
group('PRODUCT_DELIVERY');
def('product.created', 'Product created', 'Product created: {{item}}', 'INFO', [I]);
def('product.approved', 'Product approved', 'Product approved: {{item}}', 'SUCCESS', [E, I]);
def('product.archived', 'Product archived', 'Product archived: {{item}}', 'INFO', [I]);
def('roadmap.updated', 'Roadmap updated', 'Roadmap updated', 'INFO', [I]);
def('roadmap.approved', 'Roadmap approved', 'Roadmap approved', 'SUCCESS', [E, I]);
def('story.created', 'Story created', 'Story created: {{item}}', 'INFO', [I]);
def('story.assigned', 'Story assigned', 'Story assigned: {{item}}', 'INFO', [I, P]);
def('story.approved', 'Story approved', 'Story approved: {{item}}', 'SUCCESS', [I]);
def('release.planned', 'Release planned', 'Release planned: {{item}}', 'INFO', [E, I]);
def('release.approved', 'Release approved', 'Release approved: {{item}}', 'SUCCESS', [E, I]);
def('release.deployed', 'Release deployed', 'Release deployed: {{item}}', 'SUCCESS', [E, I, P]);

// --------------------------------------------------- Procurement & Contracts
group('PROCUREMENT_CONTRACTS');
def('procurement.rfq_issued', 'RFQ issued', 'RFQ issued: {{item}}', 'INFO', [E, I]);
def('procurement.bid_received', 'Bid received', 'Bid received for {{item}}', 'INFO', [I]);
def('procurement.bid_accepted', 'Bid accepted', 'Your bid was accepted', 'SUCCESS', [E, I]);
def('procurement.bid_rejected', 'Bid rejected', 'Bid outcome for {{item}}', 'INFO', [E, I]);
def('contract.created', 'Contract created', 'Contract created: {{item}}', 'INFO', [I]);
def('contract.pending_signature', 'Contract pending signature', 'Signature needed: {{item}}', 'WARNING', [E, I, P]);
def('contract.signed', 'Contract signed', 'Contract signed: {{item}}', 'SUCCESS', [E, I]);
def('contract.expiring', 'Contract expiring', 'Contract expiring: {{item}}', 'WARNING', [E, I]);
def('contract.renewed', 'Contract renewed', 'Contract renewed: {{item}}', 'SUCCESS', [E, I]);
// A break in the bid-to-CVR data flow. Mandatory, because it is money standing
// against a record nothing downstream can see — a fact the person who owns the
// commercial position is entitled to be told whatever they have muted.
def(
  'commercial.chain_broken',
  'Data chain broken',
  'Commercial exception on {{project}}: {{item}}',
  'CRITICAL',
  [E, I, P],
  MANDATORY,
);

// ----------------------------------------------------- Document & Compliance
group('DOCUMENT_COMPLIANCE');
def('document.uploaded', 'Document uploaded', 'Document uploaded: {{item}}', 'INFO', [I]);
def('document.approved', 'Document approved', 'Document approved: {{item}}', 'SUCCESS', [E, I]);
def('document.rejected', 'Document rejected', 'Document rejected: {{item}}', 'WARNING', [E, I]);
def('document.expiring', 'Document expiring', 'Document expiring: {{item}}', 'WARNING', [E, I]);
def('document.archived', 'Document archived', 'Document archived: {{item}}', 'INFO', [I]);
def('compliance.document_required', 'Compliance document required', 'Compliance document required', 'WARNING', [E, I, S], MANDATORY);
def('compliance.breach', 'Compliance breach', 'Compliance breach detected', 'CRITICAL', [E, I, S], MANDATORY);
def('compliance.resolved', 'Compliance resolved', 'Compliance issue resolved', 'SUCCESS', [E, I]);

// ------------------------------------------------------------------- AI Agent
group('AI_AGENT');
def('ai.insight_generated', 'Insight generated', 'New insight from {{actor}}', 'INFO', [I, P]);
def('ai.recommendation_available', 'Recommendation available', 'A recommendation is ready', 'INFO', [I, P]);
def('ai.opportunity_identified', 'Opportunity identified', 'Opportunity identified', 'SUCCESS', [E, I]);
def('ai.risk_detected', 'Risk detected', 'AI risk alert', 'WARNING', [E, I, P]);
def('ai.budget_risk', 'Budget risk', 'AI budget alert', 'WARNING', [E, I, P]);
def('ai.schedule_risk', 'Schedule risk', 'AI schedule alert', 'WARNING', [E, I, P]);
def('ai.resource_conflict', 'Resource conflict', 'AI resource alert', 'WARNING', [E, I, P]);
def('ai.supplier_issue', 'Supplier issue', 'AI supplier alert', 'WARNING', [E, I, P]);
def('ai.workflow_completed', 'Workflow completed', 'Workflow completed', 'SUCCESS', [I]);
def('ai.workflow_failed', 'Workflow failed', 'Workflow failed', 'WARNING', [E, I, P]);
def('ai.human_intervention_required', 'Human intervention required', 'Action needed: {{item}}', 'CRITICAL', [E, I, P], MANDATORY);

// -------------------------------------------------------------- Reporting & BI
group('REPORTING_BI');
def('report.generated', 'Report generated', 'Report ready: {{item}}', 'INFO', [I]);
def('report.scheduled_ready', 'Scheduled report ready', 'Your scheduled report is ready', 'INFO', [E, I]);
def('report.export_completed', 'Export completed', 'Your export is ready', 'SUCCESS', [E, I]);
def('kpi.threshold_breached', 'KPI threshold breached', 'KPI alert: {{item}}', 'WARNING', [E, I, P]);
def('kpi.recovered', 'KPI recovered', 'KPI recovered: {{item}}', 'SUCCESS', [I]);
def('executive.alert', 'Executive alert', 'Executive alert', 'CRITICAL', [E, I, S], MANDATORY);

// ----------------------------------------------------------- Support & Success
group('SUPPORT_SUCCESS');
def('support.ticket_created', 'Ticket created', 'Support ticket {{number}} created', 'INFO', [E, I]);
def('support.ticket_assigned', 'Ticket assigned', 'Ticket {{number}} assigned', 'INFO', [I]);
def('support.ticket_updated', 'Ticket updated', 'Update on ticket {{number}}', 'INFO', [E, I]);
def('support.ticket_resolved', 'Ticket resolved', 'Ticket {{number}} resolved', 'SUCCESS', [E, I]);
def('support.ticket_closed', 'Ticket closed', 'Ticket {{number}} closed', 'INFO', [I]);
def('cs.onboarding_started', 'Onboarding started', 'Welcome — let’s get you set up', 'INFO', [E, I]);
def('cs.onboarding_completed', 'Onboarding completed', 'You’re all set up', 'SUCCESS', [E, I]);
def('cs.health_score_warning', 'Health score warning', 'Let’s check in on {{enterprise}}', 'WARNING', [E, I]);
def('cs.renewal_reminder', 'Renewal reminder', 'Your renewal is coming up', 'INFO', [E, I]);

// --------------------------------------------------- Platform Administration
group('PLATFORM_ADMINISTRATION');
def('system.maintenance_scheduled', 'Scheduled maintenance', 'Scheduled maintenance on {{date}}', 'INFO', [E, I]);
def('system.maintenance_emergency', 'Emergency maintenance', 'Emergency maintenance in progress', 'WARNING', [E, I, S], MANDATORY);
def('system.outage', 'System outage', 'Service disruption', 'CRITICAL', [E, I, S], MANDATORY);
def('system.service_restored', 'Service restored', 'Service restored', 'SUCCESS', [E, I]);
def('audit.completed', 'Audit completed', 'Audit completed', 'INFO', [I]);
def('audit.policy_violation', 'Policy violation', 'Policy violation detected', 'CRITICAL', [E, I, S], MANDATORY);
def('audit.investigation_opened', 'Investigation opened', 'Investigation opened', 'WARNING', [E, I], MANDATORY);

// ------------------------------------------------------------- Legal & Privacy
group('LEGAL_PRIVACY');
def('privacy.consent_request', 'Consent request', 'We need your consent', 'INFO', [E, I], MANDATORY);
def('privacy.consent_updated', 'Consent updated', 'Your consent preferences were updated', 'INFO', [E, I]);
def('privacy.data_export_ready', 'Data export ready', 'Your data export is ready', 'SUCCESS', [E, I]);
def('privacy.account_deletion_requested', 'Account deletion requested', 'Account deletion requested', 'WARNING', [E, I], MANDATORY);
def('privacy.account_deletion_completed', 'Account deletion completed', 'Your account has been deleted', 'INFO', [E, I], MANDATORY);
def('regulatory.update', 'Regulatory update', 'Regulatory update', 'INFO', [E, I]);
def('compliance.notification', 'Compliance notification', 'Compliance notification', 'INFO', [E, I]);

// ------------------------------------------------------- Enterprise Onboarding
group('ENTERPRISE_ONBOARDING');
def('onboarding.enterprise_application_received', 'Enterprise application received', 'Application received for {{enterprise}}', 'INFO', [E, I]);
def('onboarding.enterprise_approved', 'Enterprise approved', '{{enterprise}} approved', 'SUCCESS', [E, I]);
def('onboarding.enterprise_rejected', 'Enterprise rejected', 'Update on {{enterprise}}’s application', 'WARNING', [E, I]);
def('onboarding.enterprise_activated', 'Enterprise activated', '{{enterprise}} is live', 'SUCCESS', [E, I, P]);
def('onboarding.admin_invitation', 'Admin invitation', 'You’re the administrator for {{enterprise}}', 'INFO', [E, I]);
def('onboarding.admin_accepted', 'Admin accepted', 'Administrator activated', 'SUCCESS', [I]);
def('onboarding.admin_first_login', 'Admin first login', 'Administrator first sign-in', 'INFO', [I]);
def('onboarding.department_created', 'Department created', 'Department created: {{item}}', 'INFO', [I]);
def('onboarding.department_approved', 'Department approved', 'Department approved: {{item}}', 'SUCCESS', [I]);
def('onboarding.user_invited', 'User invited', 'Join {{enterprise}} on CONSTRUX', 'INFO', [E, I]);
def('onboarding.user_activated', 'User activated', 'User activated', 'SUCCESS', [I]);
def('onboarding.user_completed', 'User completed onboarding', 'Onboarding complete', 'SUCCESS', [I]);
def('onboarding.training_assigned', 'Training assigned', 'Training assigned: {{item}}', 'INFO', [E, I]);
def('onboarding.training_completed', 'Training completed', 'Training completed: {{item}}', 'SUCCESS', [I]);
def('onboarding.certification_achieved', 'Certification achieved', 'Certification achieved: {{item}}', 'SUCCESS', [E, I]);

export const NOTIFICATION_EVENTS: readonly NotificationEvent[] = built;

const byCode = new Map(built.map((event) => [event.code, event]));

/** The event, or undefined. Callers that must have one use `requireEvent`. */
export function findEvent(code: string): NotificationEvent | undefined {
  return byCode.get(code);
}

/**
 * The event, or a throw naming the code. The catalogue is closed: a code that
 * is not in it is a programming error, not a runtime condition to absorb.
 */
export function requireEvent(code: string): NotificationEvent {
  const event = byCode.get(code);
  if (!event) throw new Error(`${code} is not a communication event. The catalogue is closed — add it deliberately.`);
  return event;
}

export function eventsInCategory(category: Category): NotificationEvent[] {
  return built.filter((event) => event.category === category);
}

/** How many catalogue events fire on each channel by default. */
export function channelCoverage(): Record<Channel, number> {
  const counts = Object.fromEntries(CHANNELS.map((c) => [c, 0])) as Record<Channel, number>;
  for (const event of built) for (const channel of event.channels) counts[channel] += 1;
  return counts;
}

/** Notices that override preferences. */
export function mandatoryEvents(): NotificationEvent[] {
  return built.filter((event) => event.mandatory);
}

/**
 * Fill `{{placeholders}}` from a payload.
 *
 * An unresolved placeholder is left visible rather than blanked. "Approval
 * needed: " with nothing after it looks like a bug in the recipient's inbox and
 * tells them nothing; "Approval needed: {{item}}" at least says what is
 * missing, and it fails a template review immediately.
 */
export function fillTemplate(template: string, payload: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
    const value = payload[key];
    return value === undefined || value === null || value === '' ? whole : String(value);
  });
}
