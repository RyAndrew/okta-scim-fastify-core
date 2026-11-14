// ---------------------------------------------------------------------------
// The contract between core and a backend module.
//
// Core owns the SCIM protocol: validation, filter parsing, PATCH application,
// password separation, read-after-write and response formatting. A backend
// owns the mapping between SCIM attributes and its directory, and the native
// calls. Everything that crosses this boundary is SCIM-shaped.
// ---------------------------------------------------------------------------

import type { FastifyBaseLogger } from 'fastify';
import type { Env } from './env';
import type { GroupAttributePath, GroupAttributes, StoredGroup } from './group-attributes';
import type { StoredUser, UserAttributePath, UserAttributes } from './user-attributes';

export type UserLookupKey = 'id' | 'userName' | 'externalId' | 'email';

export interface UserLookup {
  by: UserLookupKey;
  value: string;
}

export interface UserSort {
  by: 'created';
  order: 'descending';
}

export interface UserQuery {
  /** Absent means all users. */
  lookup?: UserLookup;
  /** 1-based, already validated. */
  startIndex: number;
  /** Already validated; may be 0, which asks for the total only. */
  count: number;
  /** The required ordering. Always passed; ties are broken by id ascending. */
  sort: UserSort;
}

export interface UserPage {
  users: StoredUser[];
  /** Number of users matching the lookup, before paging. */
  totalResults: number;
}

export interface UserUpdate {
  /** The profile as the backend returned it at the start of this request. */
  previous: UserAttributes;
  /** The complete target state. An attribute absent here is to be cleared. */
  user: UserAttributes;
}

/**
 * Implemented once per directory. Throw `ScimBackendError` (see `ScimErrors`)
 * for anything the SCIM client should see; any other error becomes a 500.
 */
export interface ScimUserBackend {
  /** The attribute paths this backend stores. Drives validation and /Schemas. */
  readonly attributes: readonly UserAttributePath[];
  /** The attributes `listUsers` can look up by with `eq`. Must include `id`. */
  readonly lookups: readonly UserLookupKey[];

  /** Verify configuration and connectivity at startup. Throw to abort startup. */
  init(): Promise<void>;
  close(): Promise<void>;

  /** `null` means the user does not exist. */
  getUser(id: string): Promise<StoredUser | null>;
  listUsers(query: UserQuery): Promise<UserPage>;
  /** Returns the new user's id. `password` is given only if `setPassword` exists. */
  createUser(user: UserAttributes, password: string | undefined): Promise<string>;
  /** Called for every PUT and PATCH. The backend decides what to write. */
  updateUser(id: string, update: UserUpdate): Promise<void>;
  deleteUser(id: string): Promise<void>;

  /** Present only if the backend can set passwords; its presence is the capability. */
  setPassword?(id: string, password: string): Promise<void>;

  /** Present only if the backend stores groups; its presence enables /Groups. */
  readonly groups?: ScimGroupBackend;
}

// ---------------------------------------------------------------------------
// Groups (optional)
// ---------------------------------------------------------------------------

export type GroupLookupKey = 'id' | 'displayName' | 'externalId';

export interface GroupLookup {
  by: GroupLookupKey;
  value: string;
}

export interface GroupQuery {
  /** Absent means all groups. */
  lookup?: GroupLookup;
  /** 1-based, already validated. */
  startIndex: number;
  /** Already validated; may be 0, which asks for the total only. */
  count: number;
  /** The required ordering. Always passed; ties are broken by id ascending. */
  sort: UserSort;
  /** `false` when the client sent `excludedAttributes=members`. */
  includeMembers: boolean;
}

export interface GroupPage {
  groups: StoredGroup[];
  /** Number of groups matching the lookup, before paging. */
  totalResults: number;
}

/**
 * A change to a group's membership, as user ids. Membership crosses the
 * boundary as a delta so that a PATCH never loads a large group's full list.
 * - `replace`: the complete new member list.
 * - `add` / `remove`: applied in that order; adding a member already present
 *   and removing one that is absent are no-ops (RFC 7644 §3.5.2).
 */
export type MemberChange = { replace: string[] } | { add: string[]; remove: string[] };

export interface GroupUpdate {
  /** The group as the backend returned it at the start of this request (without members). */
  previous: GroupAttributes;
  /** The complete target state of the group's own attributes. Absent = clear. */
  group: GroupAttributes;
  /** Absent means membership is unchanged. */
  members?: MemberChange;
}

/**
 * Implemented by a backend that stores groups. A member id that is not an
 * existing user must be rejected (400 `invalidValue`), never skipped.
 */
export interface ScimGroupBackend {
  /** The group attributes this backend stores. Must include `displayName`. */
  readonly attributes: readonly GroupAttributePath[];
  /** The attributes `listGroups` can look up by with `eq`. Must include `id`. */
  readonly lookups: readonly GroupLookupKey[];

  /** `null` means the group does not exist. */
  getGroup(id: string, options: { includeMembers: boolean }): Promise<StoredGroup | null>;
  listGroups(query: GroupQuery): Promise<GroupPage>;
  /** Returns the new group's id. */
  createGroup(group: GroupAttributes, memberIds: string[]): Promise<string>;
  /** Called for every PUT and PATCH. */
  updateGroup(id: string, update: GroupUpdate): Promise<void>;
  deleteGroup(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Module packaging
// ---------------------------------------------------------------------------

export interface BackendOperation {
  /** Native operation name, e.g. `search`, `modify`, `Set-ADUser`. */
  operation: string;
  /** What it acted on, e.g. a DN. */
  target?: string;
  /** Parameters, redacted by core before they are stored. Never include secrets. */
  params?: unknown;
}

export interface BackendAudit {
  /** Runs `fn`, records its duration and outcome, and rethrows any error. */
  run<T>(operation: BackendOperation, fn: () => Promise<T>): Promise<T>;
}

export interface BackendContext {
  audit: BackendAudit;
  log: FastifyBaseLogger;
}

export interface BackendModule<TConfig> {
  /** Short name, e.g. `ldap`. Stored with every audit row. */
  name: string;
  /** Read backend settings with `env.require…()`. Must not throw for missing values. */
  loadConfig(env: Env): TConfig;
  create(config: TConfig, context: BackendContext): ScimUserBackend;
}
