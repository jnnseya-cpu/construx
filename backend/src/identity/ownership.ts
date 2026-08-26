import {
  PERMISSION_MATRIX,
  ROLE_ACCOUNT_LAYER,
  roleAllows,
  type CapabilityArea,
  type PermissionCode,
  type Role,
} from './roles.ts';

/**
 * Who owns the decision.
 *
 * Every command centre asks the same nine questions, and seven of them could be
 * answered from an endpoint while the eighth — *who owns the decision* — could
 * not. The permission matrix resolves a **capability**: it says a QS may approve
 * a payment application. It does not say *which QS*, and an item that names no
 * person is an item nobody picks up. "Awaiting approval" is not an owner.
 *
 * This resolves the capability to named identities in the tenancy, and orders
 * them so the first name is the one to chase.
 *
 * ---
 *
 * **Why specialisation decides the order.** An `ENTERPRISE_ADMIN` holds approval
 * over most of the business, so it appears in the holder list for almost every
 * area. Listing it first would put the same name against every item on every
 * screen, which is the same as naming nobody. The role that holds the *fewest*
 * capability areas is the one whose job this actually is — a QS holds a handful
 * and a director holds nearly all, so the QS is named first and the director is
 * the escalation behind them.
 *
 * That ordering is computed from the matrix rather than hardcoded, so a role
 * whose remit changes moves in the order without anything here being edited.
 *
 * **What this is not.** It is not an assignment and it does not confer anything.
 * Holding the capability is still checked at the point of use by `assertAccess`;
 * this only reads the same matrix to say who could act. A name here has no more
 * authority than the matrix already gave it.
 */

export type DecisionOwner = {
  userId: string;
  name: string;
  email: string;
  /** The role that carries the capability, not every role the person holds. */
  role: Role;
  /** True where this is the escalation rather than the person whose job it is. */
  escalation: boolean;
};

/** The shape this needs from a user. Deliberately narrower than `PlatformUser`. */
export type Identity = {
  id: string;
  name: string;
  email: string;
  roles: readonly string[];
};

/**
 * How many areas a role holds **this permission code** in. Lower is more
 * specialised, and specialisation is what decides who gets named.
 *
 * Counting every area a role touches at all was the obvious version and it does
 * not discriminate: PM touches 22 areas and OWNER touches 21, so a one-area
 * difference — noise — would decide who a screen names. Counting the code
 * separates them properly. For approval, OWNER approves in ten areas and
 * PLANNER in one, so a baseline names the planner, escalating to the PM, with
 * the owner behind both. That is the real chain of authority on a project, and
 * it falls out of the matrix rather than being asserted here.
 */
function remit(role: Role, code: PermissionCode): number {
  const matrix = PERMISSION_MATRIX[role];
  if (!matrix) return 99;
  return Object.values(matrix).filter((codes) => codes.includes(code)).length;
}

/** Roles held by this identity that are real roles in the matrix. */
function rolesOf(identity: Identity): Role[] {
  return identity.roles.filter((role): role is Role => role in PERMISSION_MATRIX);
}

/**
 * Named identities who may take this action, most specialised first.
 *
 * The platform operator is never returned for a delivery capability even where
 * the matrix would allow it — `PLATFORM_ADMIN` is deliberately blind to
 * delivery, and naming it as the owner of a site decision would misrepresent
 * the separation the account layers exist to enforce.
 */
export function ownersFor(
  identities: readonly Identity[],
  area: CapabilityArea,
  code: PermissionCode,
): DecisionOwner[] {
  const holders: DecisionOwner[] = [];

  for (const identity of identities) {
    // The narrowest role the person holds that carries this capability. A PM who
    // is also an enterprise admin owns a programme decision as a PM.
    const carrying = rolesOf(identity)
      .filter((role) => roleAllows(role, area, code))
      .sort((a, b) => remit(a, code) - remit(b, code));

    const role = carrying[0];
    if (role === undefined) continue;
    if (ROLE_ACCOUNT_LAYER[role] === 'PLATFORM_ADMIN' && area !== 'PLATFORM_ADMINISTRATION' && area !== 'BILLING_ACU') {
      continue;
    }

    holders.push({ userId: identity.id, name: identity.name, email: identity.email, role, escalation: false });
  }

  holders.sort((a, b) => remit(a.role, code) - remit(b.role, code) || a.name.localeCompare(b.name));

  // Everyone whose remit is wider than the first holder's is the escalation
  // behind them rather than the person to chase. Where every holder has the same
  // remit there is no escalation — a decision with three equal owners has three
  // equal owners, and saying otherwise would invent a hierarchy.
  const narrowest = holders[0] ? remit(holders[0].role, code) : 0;
  return holders.map((holder) => ({ ...holder, escalation: remit(holder.role, code) > narrowest }));
}

/**
 * Named identities holding one of these roles, most specialised first.
 *
 * A different question from `ownersFor`, and it exists because conflating the
 * two produced an empty answer where there was a real one.
 *
 * `ownersFor` resolves a **capability**: who may approve a payment application.
 * That is the right question when there is a command to run, because approving
 * one means holding what it exercises. But an agent finding is often an
 * observation with no command at all — "this delay event has no notice against
 * it" — and there is no capability to intersect with. Asking `ownersFor` for one
 * anyway means inventing an area, and the invented one named nobody: the
 * fallback used `EVIDENCE_AUDIT` approve, which no role in the matrix holds, so
 * every observation reported that it could not be assigned to anybody.
 *
 * For those, the roles nominated to decide it *are* the answer, and the only
 * thing left to do is order them. Same ordering rule as `ownersFor` — the role
 * holding the fewest areas is the person whose job it is, and the wider remits
 * behind them are the escalation.
 */
export function ownersByRole(
  identities: readonly Identity[],
  roles: readonly string[],
  code: PermissionCode = 'A',
): DecisionOwner[] {
  const wanted = new Set(roles);
  const holders: DecisionOwner[] = [];

  for (const identity of identities) {
    const carrying = rolesOf(identity)
      .filter((role) => wanted.has(role))
      .sort((a, b) => remit(a, code) - remit(b, code));

    const role = carrying[0];
    if (role === undefined) continue;
    // The operator is barred from delivery ownership here for the same reason
    // it is in `ownersFor`: naming it as the owner of a project decision would
    // misrepresent the separation the account layers exist to enforce.
    if (ROLE_ACCOUNT_LAYER[role] === 'PLATFORM_ADMIN') continue;

    holders.push({ userId: identity.id, name: identity.name, email: identity.email, role, escalation: false });
  }

  holders.sort((a, b) => remit(a.role, code) - remit(b.role, code) || a.name.localeCompare(b.name));

  const narrowest = holders[0] ? remit(holders[0].role, code) : 0;
  return holders.map((holder) => ({ ...holder, escalation: remit(holder.role, code) > narrowest }));
}

/**
 * The owner map for a whole tenancy: every capability area against who may
 * create and who may approve in it.
 *
 * One call rather than one per item. A command centre showing forty rows would
 * otherwise make forty round trips to answer the same question, and the answer
 * is the same for every row in an area.
 */
export function ownershipMap(identities: readonly Identity[]): Array<{
  area: CapabilityArea;
  create: DecisionOwner[];
  approve: DecisionOwner[];
  /**
   * Why there is no approver, where there is none.
   *
   * `SEAT_GAP` — roles hold approval here and nobody in this tenancy has one.
   * That is a queue which cannot drain, and the enterprise admin has to fill a
   * seat before anything in the area can be progressed.
   *
   * `NOT_APPROVABLE` — no role holds approval in this area under the matrix,
   * because nothing here is approved. An audit feed is read; a supplier's own
   * submission is theirs; running AI is `X`, not `A`. Reporting these as a gap
   * would send an administrator looking for a seat that does not exist.
   *
   * `undefined` — there is an approver.
   */
  noApprover?: 'SEAT_GAP' | 'NOT_APPROVABLE';
}> {
  const areas = new Set<CapabilityArea>();
  for (const matrix of Object.values(PERMISSION_MATRIX)) {
    for (const area of Object.keys(matrix)) areas.add(area as CapabilityArea);
  }

  /** Does any role at all approve here, whether or not anybody holds that role? */
  const approvableAreas = new Set<string>();
  for (const [role, matrix] of Object.entries(PERMISSION_MATRIX)) {
    if (ROLE_ACCOUNT_LAYER[role as Role] === 'PLATFORM_ADMIN') continue;
    for (const [area, codes] of Object.entries(matrix)) {
      if (codes.includes('A')) approvableAreas.add(area);
    }
  }

  return [...areas].sort().map((area) => {
    const approve = ownersFor(identities, area, 'A');
    return {
      area,
      create: ownersFor(identities, area, 'C'),
      approve,
      ...(approve.length > 0
        ? {}
        : { noApprover: approvableAreas.has(area) ? ('SEAT_GAP' as const) : ('NOT_APPROVABLE' as const) }),
    };
  });
}
