import { config } from './config.ts';
import type { Role } from './identity/roles.ts';
import type { Platform } from './platform.ts';

/**
 * A second demonstration tenancy, with nothing in it.
 *
 * The seeded programme answers "what does a finished record look like", which
 * is the right first question and not the only one. The second question —
 * always, from anybody evaluating for their own organisation — is "what is it
 * like to actually put something in". A tenancy with eleven stages of work
 * already done cannot answer that: every screen is full, every register has
 * rows, and there is no way to see what the platform asks of you when you start
 * from nothing.
 *
 * So this is the empty one. Same platform, same permission model, same
 * refusals; no project, no records, and three identities at the three
 * authorities that matter — somebody who administers a tenancy, somebody who
 * runs delivery, and somebody who does the work.
 *
 * **It is deliberately not a "trial".** A trial is a real tenancy with a real
 * organisation's name on it and a wallet somebody eventually pays for. This is
 * a shared sandbox anybody may sign into, and the page says so: what one visitor
 * creates, the next one sees.
 *
 * **No project is created.** That is the point of it, and it is also the thing
 * that used to break: the console assumed a project existed and threw on a
 * tenancy with none. It no longer does — the first screen is the one that
 * offers to create one.
 */

export const CLEAN_TENANCY = {
  legalName: 'Clean Workspace (demonstration)',
  enterpriseName: 'Clean Workspace',
  /** Signed into first when somebody takes the default way in. */
  primaryEmail: 'admin@workspace.example',
} as const;

export type CleanWorkspace = {
  tenantId: string;
  users: { id: string; name: string; email: string; roles: readonly Role[] }[];
};

/** The three seats, and why these three. */
const SEATS: { name: string; email: string; roles: Role[]; purpose: string }[] = [
  {
    name: 'Workspace Administrator',
    email: CLEAN_TENANCY.primaryEmail,
    roles: ['ENTERPRISE_ADMIN'],
    // The only one that can create the structure everything else needs, so it
    // is the default way in: signing in as anybody else on an empty tenancy
    // means finding out you cannot make a project.
    purpose: 'Creates the enterprise, the portfolio, the project and the people. Everything starts here.',
  },
  {
    name: 'Delivery Manager',
    email: 'manager@workspace.example',
    roles: ['PM'],
    purpose: 'Runs a project once it exists: programme, cost, risk, and the stage gates that open the next phase.',
  },
  {
    name: 'Team Member',
    email: 'member@workspace.example',
    roles: ['SUPERVISOR'],
    purpose: 'Does the work and records it. The seat that shows what the platform refuses somebody, and why.',
  },
];

export function cleanWorkspaceSeats(): readonly { name: string; email: string; roles: readonly Role[]; purpose: string }[] {
  return SEATS;
}

/**
 * Create it, or adopt the one already on the chain.
 *
 * Adoption first, for the same reason the seeded programme adopts: the memo
 * lives in this process and the ledger lives on disk, so creating
 * unconditionally would build a second empty workspace on every restart until
 * the sign-in page listed a dozen Workspace Administrators and nobody could tell
 * which one held anything.
 */
export function seedCleanWorkspace(platform: Platform): CleanWorkspace {
  const existing = platform.tenants().find((tenant) => tenant.legalName === CLEAN_TENANCY.legalName);
  if (existing) {
    return { tenantId: existing.id, users: platform.users(existing.id) };
  }

  const { tenant } = platform.createTenant({
    legalName: CLEAN_TENANCY.legalName,
    jurisdiction: 'GB',
    defaultCurrency: 'GBP',
    tier: 'ENTERPRISE',
    enterpriseName: CLEAN_TENANCY.enterpriseName,
  });

  // Credit, so AI works here too.
  //
  // An empty workspace where the reasoning engine refuses on an empty wallet
  // would demonstrate the refusal and nothing else, and somebody would
  // reasonably conclude the AI does not work. Through the payment path rather
  // than a bare credit, because that is the only route money takes.
  platform.creditFromPayment({
    tenantId: tenant.id,
    amountMinor: config.demo.acuCreditMinor,
    method: 'BANK_TRANSFER',
    reference: `CLEAN-${tenant.id}`,
    recordedBy: 'seed',
    note: 'Opening credit for the clean demonstration workspace',
  });

  const users = SEATS.map((seat) =>
    platform.createUser({
      tenantId: tenant.id,
      name: seat.name,
      email: seat.email,
      roles: seat.roles,
      // The mark that lets the login route hand back a one-time code rather
      // than emailing it to an address nobody reads. Set here and in the
      // programme seed, and nowhere else in the platform.
      demonstration: true,
    }),
  );

  return { tenantId: tenant.id, users };
}
