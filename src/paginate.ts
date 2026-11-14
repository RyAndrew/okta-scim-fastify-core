// ---------------------------------------------------------------------------
// In-memory ordering and paging, for directories without offset paging
// (LDAP, Active Directory). A backend that can order and page natively
// (SQL) does not need this.
// ---------------------------------------------------------------------------

import type { UserPage, UserQuery } from './backend';
import type { StoredUser } from './user-attributes';

/**
 * Order the full matching set as `query.sort` requires (newest first, ties
 * broken by id ascending so the order is stable) and return the requested page.
 */
export function paginate(users: readonly StoredUser[], query: UserQuery): UserPage {
  const ordered = [...users].sort(
    (a, b) => compareText(b.created, a.created) || compareText(a.id, b.id),
  );
  const offset = query.startIndex - 1;
  return {
    users: ordered.slice(offset, offset + query.count),
    totalResults: ordered.length,
  };
}

/** Ordinal comparison — ISO 8601 UTC timestamps and ids sort correctly as text. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
