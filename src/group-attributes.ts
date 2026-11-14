// ---------------------------------------------------------------------------
// The SCIM group as it crosses the core ⇄ backend boundary.
//
// A group's own attributes travel as GroupAttributes; its membership travels
// separately as user ids (see MemberChange in backend.ts), so a backend never
// has to load or rewrite a large member list to apply a PATCH.
// ---------------------------------------------------------------------------

import { ScimErrors } from './errors';
import type { UnsupportedAttributePolicy } from './user-attributes';

/** A group's own attributes. No id, no meta, no members. */
export interface GroupAttributes {
  displayName: string;
  externalId?: string;
}

/** A member as a backend returns it. Members are always users. */
export interface GroupMember {
  /** The member's user id. */
  value: string;
  /** Human-readable name, e.g. the user's userName. */
  display?: string;
}

/** What a backend returns from a read. */
export interface StoredGroup extends GroupAttributes {
  id: string;
  /** ISO 8601 */
  created: string;
  /** ISO 8601 */
  lastModified: string;
  /** Present only when members were asked for. */
  members?: GroupMember[];
}

export type GroupAttributePath = 'displayName' | 'externalId' | 'members';

export const KNOWN_GROUP_ATTRIBUTE_PATHS: ReadonlySet<string> = new Set<GroupAttributePath>([
  'displayName',
  'externalId',
  'members',
]);

/** Member sub-attributes that are read-only (RFC 7643 §4.2) and dropped on input. */
const READ_ONLY_MEMBER_SUB = ['display', '$ref'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Turn a `members` value into a de-duplicated list of user ids.
 *
 * - Each entry needs a string `value`.
 * - `type` may be absent or `User`; `Group` (nested groups) is a 400.
 * - `display` and `$ref` are read-only and dropped; anything else is unsupported.
 */
export function parseMemberIds(value: unknown, unsupported: string[]): string[] {
  if (!Array.isArray(value)) {
    throw ScimErrors.invalidValue("Attribute 'members' must be an array.");
  }
  const ids = new Set<string>();
  for (const entry of value) {
    if (!isPlainObject(entry) || typeof entry.value !== 'string' || entry.value.length === 0) {
      throw ScimErrors.invalidValue("Each entry of 'members' must be an object with a string 'value'.");
    }
    for (const [sub, subValue] of Object.entries(entry)) {
      if (sub === 'value' || READ_ONLY_MEMBER_SUB.includes(sub)) continue;
      if (sub === 'type') {
        if (typeof subValue !== 'string' || subValue.toLowerCase() !== 'user') {
          throw ScimErrors.invalidValue(
            `Member '${entry.value}' has type '${String(subValue)}'; only users can be members (nested groups are not supported).`,
          );
        }
        continue;
      }
      unsupported.push(`members.${sub}`);
    }
    ids.add(entry.value);
  }
  return [...ids];
}

/** Check a group attribute value and require `displayName`. */
export function checkGroupAttribute(name: 'displayName' | 'externalId', value: unknown): string {
  if (typeof value !== 'string') {
    throw ScimErrors.invalidValue(`Attribute '${name}' must be a string.`);
  }
  if (name === 'displayName' && value.length === 0) {
    throw ScimErrors.invalidValue('displayName is required.');
  }
  return value;
}

export interface ParsedGroup {
  group: GroupAttributes;
  /** Present when the body carried `members` (or the backend stores members and none were sent: `[]`). */
  memberIds?: string[];
  /** Paths that were present but dropped under the `ignore` policy. */
  ignored: string[];
}

/**
 * Turn an untrusted POST/PUT body into a group profile and member ids.
 * The caller removes protocol members (`schemas`, `id`, `meta`) and runs
 * `stripUnassigned` first.
 */
export function parseGroupAttributes(
  raw: Record<string, unknown>,
  declared: ReadonlySet<string>,
  policy: UnsupportedAttributePolicy,
): ParsedGroup {
  const group: Partial<GroupAttributes> = {};
  const unsupported: string[] = [];
  let memberIds: string[] | undefined;

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'displayName' || key === 'externalId') {
      const checked = checkGroupAttribute(key, value);
      if (declared.has(key)) group[key] = checked;
      else unsupported.push(key);
    } else if (key === 'members') {
      const ids = parseMemberIds(value, unsupported);
      if (declared.has('members')) memberIds = ids;
      else unsupported.push('members');
    } else {
      unsupported.push(key);
    }
  }

  const ignored = [...new Set(unsupported)];
  if (ignored.length > 0 && policy === 'reject') {
    throw ScimErrors.invalidValue(
      `Attributes not supported by this service provider: ${ignored.join(', ')}.`,
    );
  }
  if (typeof group.displayName !== 'string' || group.displayName.length === 0) {
    throw ScimErrors.invalidValue('displayName is required.');
  }
  if (memberIds === undefined && declared.has('members')) memberIds = [];

  return { group: group as GroupAttributes, memberIds, ignored };
}

/** The profile part of a stored group (drops id, timestamps and members). */
export function groupAttributesOf(group: StoredGroup): GroupAttributes {
  const out: GroupAttributes = { displayName: group.displayName };
  if (group.externalId !== undefined) out.externalId = group.externalId;
  return out;
}
