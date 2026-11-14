// ---------------------------------------------------------------------------
// SCIM PATCH for groups (RFC 7644 §3.5.2)
//
// A group PATCH is turned into the group's target attributes plus a
// membership delta, so the backend never needs the full member list.
//
// Supported operations (what Okta and Entra send):
//   replace|add  displayName / externalId          (also with the core Group URN prefix)
//   remove       externalId                         (displayName is required → 400)
//   replace|add  (no path) { displayName?, externalId?, id?, members? }
//   add          members  [{ value }]               add these members
//   replace      members  [{ value }]               the complete new member list
//   remove       members                            all members
//   remove       members  [{ value }]               these members
//   remove       members[value eq "id"]             this member
//
// Anything else is a 400. Nothing is guessed.
// ---------------------------------------------------------------------------

import type { MemberChange } from './backend';
import { ScimErrors } from './errors';
import { GroupAttributes, checkGroupAttribute, parseMemberIds } from './group-attributes';
import { SCIM_SCHEMA_GROUP } from './types';
import type { UnsupportedAttributePolicy } from './user-attributes';

type Verb = 'add' | 'remove' | 'replace';

export interface GroupPatchResult {
  group: GroupAttributes;
  /** Absent when no operation touched membership. */
  members?: MemberChange;
  /** Paths dropped under the `ignore` policy. */
  ignored: string[];
}

const MEMBER_FILTER_RE = /^members\[\s*value\s+eq\s+"((?:[^"\\]|\\.)*)"\s*\]$/i;

export function applyGroupPatch(
  groupId: string,
  previous: GroupAttributes,
  operations: unknown[],
  declared: ReadonlySet<string>,
  policy: UnsupportedAttributePolicy,
): GroupPatchResult {
  const group: GroupAttributes = { ...previous };
  const unsupported: string[] = [];

  // Membership delta, folded in operation order
  let replace: Set<string> | undefined;
  let add = new Set<string>();
  let remove = new Set<string>();
  let touchedMembers = false;

  const requireMembers = (): boolean => {
    if (declared.has('members')) return true;
    unsupported.push('members');
    return false;
  };
  const addIds = (ids: string[]): void => {
    touchedMembers = true;
    for (const id of ids) {
      if (replace) replace.add(id);
      else {
        add.add(id);
        remove.delete(id);
      }
    }
  };
  const removeIds = (ids: string[]): void => {
    touchedMembers = true;
    for (const id of ids) {
      if (replace) replace.delete(id);
      else {
        remove.add(id);
        add.delete(id);
      }
    }
  };
  const replaceIds = (ids: string[]): void => {
    touchedMembers = true;
    replace = new Set(ids);
    add = new Set();
    remove = new Set();
  };

  const applyAttribute = (verb: Verb, name: string, value: unknown, index: number): void => {
    const lower = name.toLowerCase();

    if (lower === 'displayname' || lower === 'externalid') {
      const key = lower === 'displayname' ? 'displayName' : 'externalId';
      if (!declared.has(key)) {
        unsupported.push(key);
        return;
      }
      if (verb === 'remove') {
        if (key === 'displayName') throw ScimErrors.invalidValue('displayName is required.');
        delete group.externalId;
      } else {
        group[key] = checkGroupAttribute(key, value);
      }
      return;
    }

    if (lower === 'id') {
      // Okta includes the group's own id in a no-path replace
      if (verb !== 'remove' && value === groupId) return;
      throw ScimErrors.mutability("Attribute 'id' is read-only.");
    }

    if (lower === 'schemas' || lower === 'meta') {
      throw ScimErrors.mutability(`Attribute '${name}' is read-only.`);
    }

    if (lower === 'members') {
      if (!requireMembers()) return;
      if (verb === 'add') addIds(parseMemberIds(value, unsupported));
      else if (verb === 'replace') replaceIds(parseMemberIds(value, unsupported));
      else if (value === undefined) replaceIds([]);
      else removeIds(parseMemberIds(value, unsupported));
      return;
    }

    const filter = MEMBER_FILTER_RE.exec(name);
    if (filter) {
      if (verb !== 'remove') {
        throw ScimErrors.invalidPath(
          `Operations[${index}]: '${verb}' on '${name}' is not supported; use 'add' or 'remove' on members.`,
        );
      }
      if (!requireMembers()) return;
      removeIds([filter[1].replace(/\\(["\\])/g, '$1')]);
      return;
    }

    throw ScimErrors.invalidPath(`Operations[${index}]: unsupported path '${name}'.`);
  };

  operations.forEach((operation, index) => {
    if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
      throw ScimErrors.invalidSyntax(`Operations[${index}] must be an object.`);
    }
    const { op, path, value } = operation as { op?: unknown; path?: unknown; value?: unknown };
    const verb = parseVerb(op, index);

    if (path === undefined || path === null) {
      if (verb === 'remove') {
        throw ScimErrors.noTarget(`Operations[${index}]: 'remove' requires a path.`);
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw ScimErrors.invalidValue(
          `Operations[${index}]: '${verb}' without a path requires an object value.`,
        );
      }
      for (const [key, member] of Object.entries(value)) {
        applyAttribute(verb, stripSchema(key), member, index);
      }
      return;
    }

    if (typeof path !== 'string') {
      throw ScimErrors.invalidPath(`Operations[${index}]: path must be a string.`);
    }
    if (verb !== 'remove' && value === undefined) {
      throw ScimErrors.invalidValue(`Operations[${index}]: '${verb}' requires a value.`);
    }
    applyAttribute(verb, stripSchema(path.trim()), value, index);
  });

  const ignored = [...new Set(unsupported)];
  if (ignored.length > 0 && policy === 'reject') {
    throw ScimErrors.invalidValue(
      `Attributes not supported by this service provider: ${ignored.join(', ')}.`,
    );
  }

  let members: MemberChange | undefined;
  if (touchedMembers) {
    members = replace ? { replace: [...replace] } : { add: [...add], remove: [...remove] };
  }
  return { group, members, ignored };
}

function parseVerb(op: unknown, index: number): Verb {
  const verb = typeof op === 'string' ? op.toLowerCase() : '';
  if (verb !== 'add' && verb !== 'remove' && verb !== 'replace') {
    throw ScimErrors.invalidSyntax(
      `Operations[${index}]: op must be 'add', 'remove' or 'replace'.`,
    );
  }
  return verb;
}

/** A path may be qualified with the Group schema URN. */
function stripSchema(path: string): string {
  const prefix = `${SCIM_SCHEMA_GROUP}:`;
  return path.toLowerCase().startsWith(prefix.toLowerCase()) ? path.slice(prefix.length) : path;
}
