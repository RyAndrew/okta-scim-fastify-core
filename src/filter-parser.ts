// ---------------------------------------------------------------------------
// SCIM filter handling (RFC 7644 §3.4.2.2)
//
// Core supports exactly one filter form: `<attribute> eq "<value>"`, on an
// attribute the backend declared as a lookup. Everything else is a 400
// `invalidFilter` — a filter is never silently dropped.
// ---------------------------------------------------------------------------

import type { UserLookup, UserLookupKey } from './backend';
import { ScimErrors } from './errors';

export interface ParsedFilter {
  attribute: string;
  operator: string;
  value: string;
}

const FILTER_RE = /^(\S+)\s+(\w+)\s+"((?:[^"\\]|\\.)*)"$/;

/** Parse `<attribute> <operator> "<value>"`, or throw 400 `invalidFilter`. */
export function parseScimFilter(filter: string): ParsedFilter {
  const match = FILTER_RE.exec(filter.trim());
  if (!match) {
    throw ScimErrors.invalidFilter(
      `Unsupported filter '${filter}'. Only '<attribute> eq "<value>"' is supported.`,
    );
  }
  const [, attribute, operator, rawValue] = match;
  // JSON string escapes apply inside the quotes (RFC 7644 §3.4.2.2).
  const value = rawValue.replace(/\\(["\\])/g, '$1');
  return { attribute, operator: operator.toLowerCase(), value };
}

const FILTER_ATTRIBUTE_TO_LOOKUP: Record<string, UserLookupKey> = {
  id: 'id',
  username: 'userName',
  externalid: 'externalId',
  emails: 'email',
  'emails.value': 'email',
};

/** Map a filter string to one of the backend's declared lookups, or throw 400. */
export function resolveUserLookup(
  filter: string,
  supported: readonly UserLookupKey[],
): UserLookup {
  const parsed = parseScimFilter(filter);
  const by = FILTER_ATTRIBUTE_TO_LOOKUP[parsed.attribute.toLowerCase()];

  if (parsed.operator !== 'eq' || !by || !supported.includes(by)) {
    throw ScimErrors.invalidFilter(
      `Unsupported filter '${parsed.attribute} ${parsed.operator}'. ` +
        `Only 'eq' on these attributes is supported: ${filterableAttributes(supported).join(', ')}.`,
    );
  }
  return { by, value: parsed.value };
}

/** The SCIM attribute names a client may filter on, for the given lookups. */
export function filterableAttributes(supported: readonly UserLookupKey[]): string[] {
  const names: Record<UserLookupKey, string> = {
    id: 'id',
    userName: 'userName',
    externalId: 'externalId',
    email: 'emails.value',
  };
  return supported.map((key) => names[key]);
}
