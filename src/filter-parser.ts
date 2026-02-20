// ---------------------------------------------------------------------------
// Minimal SCIM 2.0 filter parser (RFC 7644 §3.4.2.2)
//
// Parses simple single-attribute filters like:
//   userName eq "john.doe@example.com"
//   externalId eq "00u123456"
//   id eq "some-uuid"
//
// Complex filters (and, or, not, parentheses) return null.
// Backends receive the ParsedFilter and apply it however suits their storage.
// ---------------------------------------------------------------------------

export type FilterOperator =
  | 'eq' | 'ne' | 'co' | 'sw' | 'ew' | 'pr' | 'gt' | 'ge' | 'lt' | 'le';

export interface ParsedFilter {
  attribute: string;
  operator: FilterOperator;
  value: string;
}

const FILTER_RE =
  /^(\S+)\s+(eq|ne|co|sw|ew|pr|gt|ge|lt|le)\s+"([^"]*)"$/i;

/**
 * Parse a simple SCIM filter expression.
 * Returns `null` for complex or unsupported filter syntax.
 */
export function parseScimFilter(filter: string): ParsedFilter | null {
  const match = FILTER_RE.exec(filter.trim());
  if (!match) return null;

  const [, attribute, operatorRaw, value] = match;
  return {
    attribute,
    operator: operatorRaw.toLowerCase() as FilterOperator,
    value,
  };
}
