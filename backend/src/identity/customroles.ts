import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { accessClassOf, isControllerGrant } from './licence.ts';
import {
  CAPABILITY_AREA_LIST,
  OPERATOR_ONLY_ROLES,
  PERMISSION_CODE_LIST,
  PERMISSION_CODE_MEANING,
  TENANT_GRANTABLE_ROLES,
  isCapabilityArea,
  isPermissionCode,
  isRole,
  rolePermissions,
  rolesAllow,
  type CapabilityArea,
  type PermissionCode,
  type Role,
} from './roles.ts';

/**
 * Roles a company defines for itself.
 *
 * ## Why the built-in matrix was not enough
 *
 * `PERMISSION_MATRIX` describes the roles this industry actually has, and for
 * most companies that is the right answer: a quantity surveyor is a quantity
 * surveyor. But an enterprise administrator running a real organisation hits
 * the same two walls every time.
 *
 * **"Our QS does not approve awards."** The built-in role carries an authority
 * their internal governance does not give it, and the only way to take it away
 * was to hand the person a weaker role that also removed things they need.
 *
 * **"Our document controller also raises RFIs."** The reverse: a role that is
 * nearly right, missing one capability, and no way to add it without granting a
 * second whole role and everything else that comes with it.
 *
 * A custom role is a named set of capability grants, defined by the company,
 * held alongside a person's built-in roles.
 *
 * ## The three rules that make it safe
 *
 * A permission system that lets an administrator write their own permissions is
 * a privilege-escalation engine unless it is bounded. Three bounds, and the
 * first is the one that matters:
 *
 * **1. Nobody can grant what they do not hold.** Every grant in a definition is
 * checked against the *creator's* own authority, and again against the
 * *assigner's* when the role is given to somebody. A site manager who is given
 * the governance mandate cannot write themselves a role carrying budget
 * approval, because they do not hold budget approval to give.
 *
 * **2. The operator's layer is not reachable.** `PLATFORM_ADMINISTRATION` is
 * refused outright rather than left to rule 1, because it is the one area where
 * a mistake in rule 1 would cross the account layer rather than widen a role
 * inside a tenancy.
 *
 * **3. A seat is still a seat.** A custom role names the built-in role whose
 * seat class it occupies, so a company cannot compose Controller authority out
 * of grants and avoid paying for a Controller. Which Controller role it is
 * stays a declaration — a company knows whether its new role sits at QS or PM,
 * and deriving it would make the price move whenever somebody ticked a box.
 * Whether it is a Controller seat *at all* is not left to the declaration:
 * `checkSeatClass` refuses a participant seat class on a role carrying
 * Controller authority, and `checkSeatCover` refuses to hand a Controller-class
 * role to somebody who holds no Controller seat. Without the first, a role
 * granting budget approval could be named truthfully after a Viewer and billed
 * as nothing; without the second, it could be given to one.
 *
 * Retirement is immediate: grants are resolved per request from the live
 * record, never baked into a token, so withdrawing a role withdraws it now
 * rather than at the person's next sign-in.
 */

export type CapabilityGrant = { area: CapabilityArea; code: PermissionCode };

export const CUSTOM_ROLE_STATUS = ['ACTIVE', 'RETIRED'] as const;
export type CustomRoleStatus = (typeof CUSTOM_ROLE_STATUS)[number];

export type CustomRole = {
  id: string;
  tenantId: string;
  /** What the company calls it. Unique within the tenancy, case-insensitively. */
  name: string;
  /** Why it exists, in the words of whoever will be asked about it in a year. */
  description: string;
  /**
   * The built-in role whose seat this occupies.
   *
   * Declared rather than derived, but not freely: see rule 3. A price that
   * moves when somebody ticks a capability is a price nobody can plan against,
   * so the company picks the role — and a declaration that understates the
   * grants is refused rather than believed.
   */
  seatClass: Role;
  grants: CapabilityGrant[];
  status: CustomRoleStatus;
  createdBy: string;
  createdAt: string;
  updatedAt?: string;
  /** Present once retired, so the register can say why it went. */
  retiredReason?: string;
};

/** The area no custom role may ever carry, whoever is defining it. */
const NEVER_GRANTABLE: CapabilityArea[] = ['PLATFORM_ADMINISTRATION'];

/**
 * The areas a definition may name.
 *
 * Exported so the route schema offers exactly what the domain will accept. A
 * generated form that lists an area every definition is refused for naming is a
 * form that teaches people the platform is broken.
 */
export const GRANTABLE_AREAS: CapabilityArea[] = CAPABILITY_AREA_LIST.filter(
  (area) => !NEVER_GRANTABLE.includes(area),
);

const NAME_MIN = 3;
const DESCRIPTION_MIN = 12;

/**
 * Everything a set of roles may do, as flat grants.
 *
 * The bound for rules 1 and 2. Derived from the matrix rather than listed, so a
 * capability added to a built-in role is grantable the same day without this
 * file changing.
 */
export function grantsOfRoles(roles: Role[]): CapabilityGrant[] {
  const seen = new Set<string>();
  const grants: CapabilityGrant[] = [];
  for (const role of roles) {
    for (const area of CAPABILITY_AREA_LIST) {
      for (const code of rolePermissions(role, area)) {
        const key = `${area}:${code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        grants.push({ area, code });
      }
    }
  }
  return grants;
}

/** Whether a set of grants covers one particular capability. */
export function grantsAllow(grants: CapabilityGrant[] | undefined, area: CapabilityArea, code: PermissionCode): boolean {
  return (grants ?? []).some((grant) => grant.area === area && grant.code === code);
}

/**
 * Validate a proposed definition against the definer's own authority.
 *
 * Returns the cleaned grants, or throws naming the first capability the definer
 * does not hold — by name, because "not permitted" sends somebody to the wrong
 * person. The message says which capability and that they cannot give away what
 * they were never given.
 */
export function checkGrants(actorRoles: Role[], grants: unknown): CapabilityGrant[] {
  if (!Array.isArray(grants) || grants.length === 0) {
    throw new ValidationError('A role that grants nothing is not a role', [
      { field: 'grants', message: 'Name at least one capability' },
    ]);
  }

  const cleaned: CapabilityGrant[] = [];
  const seen = new Set<string>();
  for (const raw of grants) {
    const entry = raw as { area?: unknown; code?: unknown };
    if (!isCapabilityArea(entry.area)) {
      throw new ValidationError(`${String(entry.area)} is not a capability area this platform grants`, [
        { field: 'grants', message: 'Unknown area' },
      ]);
    }
    if (!isPermissionCode(entry.code)) {
      throw new ValidationError(`${String(entry.code)} is not a permission code this platform uses`, [
        { field: 'grants', message: 'Unknown code' },
      ]);
    }
    if (NEVER_GRANTABLE.includes(entry.area)) {
      throw new ForbiddenError(
        `${entry.area} belongs to the platform operator and is not a capability a company may grant itself`,
        'ACCOUNT_LAYER_SEPARATION',
      );
    }
    // Rule 1. Checked per capability so the refusal can name the one that failed.
    if (!rolesAllow(actorRoles, entry.area, entry.code)) {
      throw new ForbiddenError(
        `You do not hold "${entry.code}" on ${entry.area}, so you cannot put it in a role. Nobody grants what they were not given.`,
        'GRANT_EXCEEDS_AUTHORITY',
      );
    }
    const key = `${entry.area}:${entry.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ area: entry.area, code: entry.code });
  }
  return cleaned;
}

/** The seat class a custom role declares, validated. */
export function checkSeatClass(value: unknown, grants: CapabilityGrant[]): Role {
  if (typeof value !== 'string' || !isRole(value)) {
    throw new ValidationError(`${String(value)} is not a role this platform knows`, [
      { field: 'seatClass', message: 'Name a built-in role whose seat this occupies' },
    ]);
  }
  if (OPERATOR_ONLY_ROLES.includes(value)) {
    throw new ForbiddenError(
      `${value} is an operator role and carries no tenant seat`,
      'ACCOUNT_LAYER_SEPARATION',
    );
  }

  // The declaration has to answer to the contents.
  //
  // Rule 3 said the seat is declared rather than inferred, and that is still
  // true of *which* Controller role it is — a company knows whether its new
  // role sits at QS or PM, and deriving it would make the price move when
  // somebody ticks a box. What cannot be left to the declaration is whether it
  // is a Controller seat at all: a role granting budget approval, named
  // truthfully after a Viewer, would be Controller authority billed as nothing.
  // So the declaration is free above the line and refused below it.
  const controlling = grants.find((grant) => isControllerGrant(grant.area, grant.code));
  if (controlling && accessClassOf([value]) !== 'CONTROLLER') {
    throw new ForbiddenError(
      `This role grants "${controlling.code}" on ${controlling.area}, which is Controller authority. ` +
        `${value} is a participant role and takes no seat, so it cannot be this role's seat class. ` +
        'Name a Controller role, or take the capability out.',
      'CUSTOM_ROLE_SEAT_UNDERSTATED',
    );
  }
  return value;
}

export function checkName(name: unknown, existing: CustomRole[], selfId?: string): string {
  const cleaned = typeof name === 'string' ? name.trim() : '';
  if (cleaned.length < NAME_MIN) {
    throw new ValidationError('Give the role a name people will recognise on a list', [
      { field: 'name', message: `At least ${NAME_MIN} characters` },
    ]);
  }
  const clash = existing.find(
    (role) => role.id !== selfId && role.status === 'ACTIVE' && role.name.toLowerCase() === cleaned.toLowerCase(),
  );
  if (clash) {
    throw new DomainError('CUSTOM_ROLE_NAME_TAKEN', `This company already has a role called "${clash.name}"`, 409);
  }
  return cleaned;
}

export function checkDescription(description: unknown): string {
  const cleaned = typeof description === 'string' ? description.trim() : '';
  if (cleaned.length < DESCRIPTION_MIN) {
    throw new ValidationError('Say what this role is for, so the next administrator does not have to guess', [
      { field: 'description', message: `At least ${DESCRIPTION_MIN} characters` },
    ]);
  }
  return cleaned;
}

/**
 * Build a definition. Pure: the caller writes it to the record.
 */
export function defineCustomRole(input: {
  tenantId: string;
  actorId: string;
  actorRoles: Role[];
  existing: CustomRole[];
  name: unknown;
  description: unknown;
  seatClass: unknown;
  grants: unknown;
  now?: Date;
}): CustomRole {
  // Grants first: the seat class is checked against them.
  const grants = checkGrants(input.actorRoles, input.grants);
  return {
    id: ulid(),
    tenantId: input.tenantId,
    name: checkName(input.name, input.existing),
    description: checkDescription(input.description),
    seatClass: checkSeatClass(input.seatClass, grants),
    grants,
    status: 'ACTIVE',
    createdBy: input.actorId,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

/** Apply an amendment to an existing definition, under the same bounds. */
export function amendCustomRole(
  role: CustomRole,
  input: {
    actorRoles: Role[];
    existing: CustomRole[];
    name?: unknown;
    description?: unknown;
    seatClass?: unknown;
    grants?: unknown;
    now?: Date;
  },
): CustomRole {
  if (role.status === 'RETIRED') {
    throw new DomainError('CUSTOM_ROLE_RETIRED', 'A retired role is not amended. Define a new one.', 409);
  }
  // The pair is checked together, whichever half the amendment names. Adding a
  // Controller capability to a role whose seat class was never touched is the
  // same understatement as declaring the wrong seat class in the first place,
  // and checking only the field that changed would let the amendment do what
  // the definition could not.
  const grants = input.grants !== undefined ? checkGrants(input.actorRoles, input.grants) : role.grants;
  const seatClass = checkSeatClass(input.seatClass !== undefined ? input.seatClass : role.seatClass, grants);
  return {
    ...role,
    ...(input.name !== undefined ? { name: checkName(input.name, input.existing, role.id) } : {}),
    ...(input.description !== undefined ? { description: checkDescription(input.description) } : {}),
    seatClass,
    grants,
    updatedAt: (input.now ?? new Date()).toISOString(),
  };
}

/**
 * The grants a person actually holds from their custom roles.
 *
 * Retired roles contribute nothing, which is what makes retirement immediate.
 * A role id on a person that no longer resolves is skipped rather than thrown
 * on: a definition can be retired while somebody still carries the id, and that
 * person should lose the capability, not their session.
 */
export function resolveGrants(held: string[] | undefined, defined: CustomRole[]): CapabilityGrant[] {
  if (!held || held.length === 0) return [];
  const byId = new Map(defined.map((role) => [role.id, role]));
  const seen = new Set<string>();
  const grants: CapabilityGrant[] = [];
  for (const id of held) {
    const role = byId.get(id);
    if (!role || role.status !== 'ACTIVE') continue;
    for (const grant of role.grants) {
      const key = `${grant.area}:${grant.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      grants.push(grant);
    }
  }
  return grants;
}

/**
 * Whether this actor may hand this role to somebody.
 *
 * Rule 1 again, at the moment it matters most. A role defined by an owner may
 * carry capabilities the administrator assigning it does not hold, and handing
 * it over would be granting through an intermediary what they could not grant
 * directly.
 */
export function checkAssignable(actorRoles: Role[], role: CustomRole): void {
  if (role.status !== 'ACTIVE') {
    throw new DomainError('CUSTOM_ROLE_RETIRED', `"${role.name}" has been retired and cannot be given to anybody`, 409);
  }
  for (const grant of role.grants) {
    if (!rolesAllow(actorRoles, grant.area, grant.code)) {
      throw new ForbiddenError(
        `"${role.name}" carries "${grant.code}" on ${grant.area}, which you do not hold. You cannot pass on an authority you were not given.`,
        'GRANT_EXCEEDS_AUTHORITY',
      );
    }
  }
}

/**
 * Whether this person already holds the seat the role occupies.
 *
 * Rule 3, enforced rather than recorded. The seat model turns on
 * `accessClassOf`, which reads built-in roles — so without this check a company
 * could define a role carrying budget approval, declare its seat class
 * truthfully as `QS`, hand it to a `VIEWER`, and have a person with Controller
 * authority counted as a participant who takes no seat and costs nothing. The
 * declaration would have been honest and the accounting still wrong.
 *
 * The refusal is deliberately not an automatic upgrade. Taking a seat is
 * spending money, and money is not spent as a side effect of ticking a box on a
 * different screen: the administrator is told to give the person a Controller
 * role first, which is the act that consumes the seat and is already refused
 * when none is free.
 */
export function checkSeatCover(role: CustomRole, targetRoles: Role[], targetName: string): void {
  if (accessClassOf([role.seatClass]) !== 'CONTROLLER') return;
  if (accessClassOf(targetRoles) === 'CONTROLLER') return;
  throw new DomainError(
    'CUSTOM_ROLE_SEAT_REQUIRED',
    `"${role.name}" occupies a ${role.seatClass} seat, and ${targetName} holds no Controller role. ` +
      'Give them a Controller role first — that is the act that takes the seat — then this role can be added.',
    409,
  );
}

/** The register, for the screen and for anybody asking what this company has defined. */
export type CustomRoleRegister = {
  roles: CustomRole[];
  /**
   * Every area and code a definition may name, so the form is built from the
   * platform's own vocabulary rather than a list typed into a screen. The areas
   * exclude the one no company may grant itself, so the operator's layer is not
   * even offered.
   */
  vocabulary: { areas: CapabilityArea[]; codes: Array<{ code: PermissionCode; label: string; meaning: string }> };
  /** What the person reading this may put in a role — their own authority, flattened. */
  yours: CapabilityGrant[];
  /** The seat classes a definition may declare. Operator roles carry no tenant seat. */
  seatClasses: Role[];
  summary: string;
};

export function customRoleRegister(roles: CustomRole[], actorRoles: Role[]): CustomRoleRegister {
  const active = roles.filter((role) => role.status === 'ACTIVE');
  const yours = grantsOfRoles(actorRoles).filter((grant) => !NEVER_GRANTABLE.includes(grant.area));
  return {
    roles,
    vocabulary: {
      areas: GRANTABLE_AREAS,
      codes: PERMISSION_CODE_LIST.map((code) => ({ code, ...PERMISSION_CODE_MEANING[code] })),
    },
    yours,
    seatClasses: TENANT_GRANTABLE_ROLES,
    summary:
      active.length === 0
        ? `No roles of your own yet. You may put any of ${yours.length} capabilities you hold into one.`
        : `${active.length} role${active.length === 1 ? '' : 's'} defined by this company` +
          `${roles.length > active.length ? `, ${roles.length - active.length} retired` : ''}. ` +
          `You may put any of ${yours.length} capabilities you hold into one.`,
  };
}

export function requireCustomRole(roles: CustomRole[], id: string): CustomRole {
  const role = roles.find((entry) => entry.id === id);
  if (!role) throw new NotFoundError(`No role ${id} on this company`);
  return role;
}
