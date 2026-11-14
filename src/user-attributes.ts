// ---------------------------------------------------------------------------
// The SCIM user profile as it crosses the core ⇄ backend boundary.
//
// A backend declares which attribute paths it stores. Core validates incoming
// profiles against that declaration and against the attribute definitions
// below; the same definitions generate the /Schemas response.
// ---------------------------------------------------------------------------

import { isDeepStrictEqual } from 'util';
import { ScimErrors } from './errors';
import {
  SCIM_SCHEMA_ENTERPRISE_USER,
  ScimAddress,
  ScimEmail,
  ScimEnterpriseUser,
  ScimMultiValue,
  ScimName,
} from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A user's profile in SCIM shape. No id, no meta, no password. */
export interface UserAttributes {
  userName: string;
  externalId?: string;
  name?: ScimName;
  displayName?: string;
  nickName?: string;
  profileUrl?: string;
  title?: string;
  userType?: string;
  preferredLanguage?: string;
  locale?: string;
  timezone?: string;
  active?: boolean;
  emails?: ScimEmail[];
  phoneNumbers?: ScimMultiValue[];
  addresses?: ScimAddress[];
  [SCIM_SCHEMA_ENTERPRISE_USER]?: ScimEnterpriseUser;
}

/** What a backend returns from a read. */
export interface StoredUser extends UserAttributes {
  id: string;
  /** ISO 8601 */
  created: string;
  /** ISO 8601 */
  lastModified: string;
}

type SimpleAttribute =
  | 'userName'
  | 'externalId'
  | 'displayName'
  | 'nickName'
  | 'profileUrl'
  | 'title'
  | 'userType'
  | 'preferredLanguage'
  | 'locale'
  | 'timezone'
  | 'active'
  | 'emails'
  | 'phoneNumbers'
  | 'addresses';

/**
 * One storable attribute. Simple and multi-valued attributes are named by
 * their top-level key; sub-attributes of `name` and of the enterprise
 * extension are named individually (`name.givenName`,
 * `urn:…:enterprise:2.0:User:department`).
 */
export type UserAttributePath =
  | SimpleAttribute
  | `name.${keyof ScimName}`
  | `${typeof SCIM_SCHEMA_ENTERPRISE_USER}:${keyof ScimEnterpriseUser}`;

export type UnsupportedAttributePolicy = 'reject' | 'ignore';

// ---------------------------------------------------------------------------
// Attribute definitions
// ---------------------------------------------------------------------------

/**
 * - `multi`: entries of `value` / `display` / `type` / `primary` (emails, phoneNumbers).
 * - `multiComplex`: entries of the string sub-attributes in `sub`, plus `type` and
 *   `primary`, with no `value` (addresses).
 */
type AttributeKind = 'string' | 'boolean' | 'complex' | 'multi' | 'multiComplex';

interface AttributeDefinition {
  name: string;
  kind: AttributeKind;
  /** Sub-attribute names, for `complex` and `multiComplex`. */
  sub?: readonly string[];
  description: string;
}

const MULTI_VALUE_SUB = ['value', 'display', 'type', 'primary'] as const;
const ADDRESS_SUB = [
  'formatted',
  'streetAddress',
  'locality',
  'region',
  'postalCode',
  'country',
] as const;

export const USER_ATTRIBUTE_DEFINITIONS: readonly AttributeDefinition[] = [
  { name: 'userName', kind: 'string', description: 'Unique identifier for the user.' },
  { name: 'externalId', kind: 'string', description: 'Identifier issued by the provisioning client.' },
  {
    name: 'name',
    kind: 'complex',
    sub: ['formatted', 'familyName', 'givenName', 'middleName', 'honorificPrefix', 'honorificSuffix'],
    description: "The components of the user's name.",
  },
  { name: 'displayName', kind: 'string', description: 'The name of the user, suitable for display.' },
  { name: 'nickName', kind: 'string', description: 'The casual way to address the user.' },
  { name: 'profileUrl', kind: 'string', description: "URL of the user's online profile." },
  { name: 'title', kind: 'string', description: "The user's title." },
  { name: 'userType', kind: 'string', description: 'The relationship between the organization and the user.' },
  { name: 'preferredLanguage', kind: 'string', description: "The user's preferred language." },
  { name: 'locale', kind: 'string', description: "The user's default location for localization." },
  { name: 'timezone', kind: 'string', description: "The user's time zone." },
  { name: 'active', kind: 'boolean', description: "The user's administrative status." },
  { name: 'emails', kind: 'multi', description: 'Email addresses for the user.' },
  { name: 'phoneNumbers', kind: 'multi', description: 'Phone numbers for the user.' },
  {
    name: 'addresses',
    kind: 'multiComplex',
    sub: ADDRESS_SUB,
    description: 'Physical mailing addresses for the user.',
  },
  {
    name: SCIM_SCHEMA_ENTERPRISE_USER,
    kind: 'complex',
    sub: ['employeeNumber', 'costCenter', 'organization', 'division', 'department'],
    description: 'Enterprise user extension.',
  },
];

const DEFINITIONS_BY_NAME = new Map(USER_ATTRIBUTE_DEFINITIONS.map((d) => [d.name, d]));

function subPath(attribute: string, sub: string): string {
  return attribute.startsWith('urn:') ? `${attribute}:${sub}` : `${attribute}.${sub}`;
}

/** Every path core knows how to validate. A backend may declare only these. */
export const KNOWN_USER_ATTRIBUTE_PATHS: ReadonlySet<string> = new Set(
  USER_ATTRIBUTE_DEFINITIONS.flatMap((d) =>
    d.kind === 'complex' ? d.sub!.map((s) => subPath(d.name, s)) : [d.name],
  ),
);

// ---------------------------------------------------------------------------
// Normalisation and validation
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * RFC 7643 §2.5: an unassigned attribute, `null` and an empty array are the
 * same state. This removes them (recursively) so the rest of core only ever
 * sees assigned values. An object left with no assigned members is removed too.
 */
export function stripUnassigned(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const items = value.map(stripUnassigned).filter((v) => v !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      const cleaned = stripUnassigned(member);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return value;
}

export interface ParsedUserAttributes {
  attributes: UserAttributes;
  /** Paths that were present but dropped under the `ignore` policy. */
  ignored: string[];
}

/**
 * Turn an untrusted object into a validated {@link UserAttributes}.
 *
 * - A value of the wrong type is a 400 `invalidValue`.
 * - A path the backend did not declare is rejected or dropped, per `policy`.
 * - `userName` must be present.
 *
 * The caller removes protocol members (`schemas`, `id`, `meta`, `password`)
 * and runs {@link stripUnassigned} first.
 */
export function parseUserAttributes(
  raw: Record<string, unknown>,
  declared: ReadonlySet<string>,
  policy: UnsupportedAttributePolicy,
): ParsedUserAttributes {
  const out: Record<string, unknown> = {};
  const unsupported: string[] = [];

  for (const [key, value] of Object.entries(raw)) {
    const def = DEFINITIONS_BY_NAME.get(key);
    if (!def) {
      unsupported.push(key);
      continue;
    }

    switch (def.kind) {
      case 'string':
      case 'boolean': {
        if (typeof value !== def.kind) {
          throw ScimErrors.invalidValue(`Attribute '${key}' must be a ${def.kind}.`);
        }
        if (declared.has(key)) out[key] = value;
        else unsupported.push(key);
        break;
      }

      case 'complex': {
        if (!isPlainObject(value)) {
          throw ScimErrors.invalidValue(`Attribute '${key}' must be an object.`);
        }
        const kept: Record<string, unknown> = {};
        for (const [sub, subValue] of Object.entries(value)) {
          const path = subPath(key, sub);
          if (!def.sub!.includes(sub)) {
            unsupported.push(path);
            continue;
          }
          if (typeof subValue !== 'string') {
            throw ScimErrors.invalidValue(`Attribute '${path}' must be a string.`);
          }
          if (declared.has(path)) kept[sub] = subValue;
          else unsupported.push(path);
        }
        if (Object.keys(kept).length > 0) out[key] = kept;
        break;
      }

      case 'multi': {
        if (!Array.isArray(value)) {
          throw ScimErrors.invalidValue(`Attribute '${key}' must be an array.`);
        }
        if (!declared.has(key)) {
          unsupported.push(key);
          break;
        }
        const items: Record<string, unknown>[] = [];
        for (const item of value) {
          if (!isPlainObject(item) || typeof item.value !== 'string') {
            throw ScimErrors.invalidValue(
              `Each entry of '${key}' must be an object with a string 'value'.`,
            );
          }
          const kept: Record<string, unknown> = {};
          for (const [sub, subValue] of Object.entries(item)) {
            if (!(MULTI_VALUE_SUB as readonly string[]).includes(sub)) {
              unsupported.push(`${key}.${sub}`);
              continue;
            }
            const expected = sub === 'primary' ? 'boolean' : 'string';
            if (typeof subValue !== expected) {
              throw ScimErrors.invalidValue(`'${key}.${sub}' must be a ${expected}.`);
            }
            kept[sub] = subValue;
          }
          items.push(kept);
        }
        out[key] = items;
        break;
      }

      case 'multiComplex': {
        if (!Array.isArray(value)) {
          throw ScimErrors.invalidValue(`Attribute '${key}' must be an array.`);
        }
        if (!declared.has(key)) {
          unsupported.push(key);
          break;
        }
        const allowed = [...def.sub!, 'type', 'primary'];
        const items: Record<string, unknown>[] = [];
        for (const item of value) {
          if (!isPlainObject(item)) {
            throw ScimErrors.invalidValue(`Each entry of '${key}' must be an object.`);
          }
          const kept: Record<string, unknown> = {};
          for (const [sub, subValue] of Object.entries(item)) {
            if (!allowed.includes(sub)) {
              unsupported.push(`${key}.${sub}`);
              continue;
            }
            const expected = sub === 'primary' ? 'boolean' : 'string';
            if (typeof subValue !== expected) {
              throw ScimErrors.invalidValue(`'${key}.${sub}' must be a ${expected}.`);
            }
            kept[sub] = subValue;
          }
          items.push(kept);
        }
        out[key] = items;
        break;
      }
    }
  }

  const ignored = [...new Set(unsupported)];
  if (ignored.length > 0 && policy === 'reject') {
    throw ScimErrors.invalidValue(
      `Attributes not supported by this service provider: ${ignored.join(', ')}.`,
    );
  }

  if (typeof out.userName !== 'string' || out.userName.length === 0) {
    throw ScimErrors.invalidValue('userName is required.');
  }

  return { attributes: out as unknown as UserAttributes, ignored };
}

// ---------------------------------------------------------------------------
// Helpers for backends
// ---------------------------------------------------------------------------

/** The profile part of a stored user (drops id and timestamps). */
export function attributesOf(user: StoredUser): UserAttributes {
  const { id: _id, created: _created, lastModified: _lastModified, ...attributes } = user;
  return attributes;
}

/**
 * The attribute paths whose value differs between two profiles. Core uses it
 * for the audit record; a backend may use it to write only what differs.
 */
export function changedAttributes(
  previous: UserAttributes,
  next: UserAttributes,
): UserAttributePath[] {
  const a = previous as unknown as Record<string, unknown>;
  const b = next as unknown as Record<string, unknown>;
  const changed: string[] = [];

  for (const def of USER_ATTRIBUTE_DEFINITIONS) {
    if (def.kind === 'complex') {
      const subA = (a[def.name] ?? {}) as Record<string, unknown>;
      const subB = (b[def.name] ?? {}) as Record<string, unknown>;
      for (const sub of def.sub!) {
        if (subA[sub] !== subB[sub]) changed.push(subPath(def.name, sub));
      }
    } else if (!isDeepStrictEqual(a[def.name], b[def.name])) {
      changed.push(def.name);
    }
  }
  return changed as UserAttributePath[];
}

/**
 * The entry marked `primary: true`, or `undefined` if none is. More than one
 * primary entry violates RFC 7643 §2.4 and is a 400.
 */
export function primaryValue<T extends ScimMultiValue>(
  attribute: string,
  entries: readonly T[] | undefined,
): T | undefined {
  const primaries = (entries ?? []).filter((e) => e.primary === true);
  if (primaries.length > 1) {
    throw ScimErrors.invalidValue(`'${attribute}' has more than one primary entry.`);
  }
  return primaries[0];
}

// ---------------------------------------------------------------------------
// /Schemas generation
// ---------------------------------------------------------------------------

function schemaAttribute(name: string, type: string, description: string, extra: object = {}) {
  return {
    name,
    type,
    multiValued: false,
    description,
    required: false,
    caseExact: false,
    mutability: 'readWrite',
    returned: 'default',
    uniqueness: 'none',
    ...extra,
  };
}

/** SCIM schema attribute definitions for the declared paths under `root`. */
export function schemaAttributesFor(
  declared: ReadonlySet<string>,
  root: 'core' | typeof SCIM_SCHEMA_ENTERPRISE_USER,
): object[] {
  const attributes: object[] = [];

  if (root === SCIM_SCHEMA_ENTERPRISE_USER) {
    const def = DEFINITIONS_BY_NAME.get(SCIM_SCHEMA_ENTERPRISE_USER)!;
    for (const sub of def.sub!) {
      if (declared.has(subPath(def.name, sub))) {
        attributes.push(schemaAttribute(sub, 'string', `Enterprise ${sub}.`));
      }
    }
    return attributes;
  }

  for (const def of USER_ATTRIBUTE_DEFINITIONS) {
    if (def.name === SCIM_SCHEMA_ENTERPRISE_USER) continue;

    if (def.kind === 'complex') {
      const subs = def.sub!.filter((s) => declared.has(subPath(def.name, s)));
      if (subs.length === 0) continue;
      attributes.push(
        schemaAttribute(def.name, 'complex', def.description, {
          subAttributes: subs.map((s) => schemaAttribute(s, 'string', `${def.name}.${s}`)),
        }),
      );
    } else if (declared.has(def.name)) {
      if (def.kind === 'multi') {
        attributes.push(
          schemaAttribute(def.name, 'complex', def.description, {
            multiValued: true,
            subAttributes: [
              schemaAttribute('value', 'string', 'The value.'),
              schemaAttribute('display', 'string', 'A human-readable name.'),
              schemaAttribute('type', 'string', 'A label indicating the function of the value.'),
              schemaAttribute('primary', 'boolean', 'Whether this is the primary value.'),
            ],
          }),
        );
      } else if (def.kind === 'multiComplex') {
        attributes.push(
          schemaAttribute(def.name, 'complex', def.description, {
            multiValued: true,
            subAttributes: [
              ...def.sub!.map((s) => schemaAttribute(s, 'string', `${def.name}.${s}`)),
              schemaAttribute('type', 'string', 'A label indicating the function of the value.'),
              schemaAttribute('primary', 'boolean', 'Whether this is the primary value.'),
            ],
          }),
        );
      } else {
        const extra =
          def.name === 'userName' ? { required: true, uniqueness: 'server' } : {};
        attributes.push(schemaAttribute(def.name, def.kind, def.description, extra));
      }
    }
  }
  return attributes;
}
