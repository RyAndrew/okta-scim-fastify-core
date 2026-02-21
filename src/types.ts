// ---------------------------------------------------------------------------
// SCIM 2.0 core type definitions (RFC 7643 / RFC 7644)
// ---------------------------------------------------------------------------

export const SCIM_SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_SCHEMA_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCIM_SCHEMA_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_SCHEMA_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCIM_SCHEMA_PATCH_OP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

export interface ScimName {
  formatted?: string;
  familyName?: string;
  givenName?: string;
  middleName?: string;
  honorificPrefix?: string;
  honorificSuffix?: string;
}

export interface ScimEmail {
  value: string;
  display?: string;
  type?: string;
  primary?: boolean;
}

export interface ScimMeta {
  resourceType: string;
  created?: string;
  lastModified?: string;
  location?: string;
  version?: string;
}

// ---------------------------------------------------------------------------
// SCIM User resource (RFC 7643 §4.1)
// ---------------------------------------------------------------------------

export interface ScimUser {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
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
  password?: string;
  emails?: ScimEmail[];
  meta?: ScimMeta;
}

// ---------------------------------------------------------------------------
// SCIM Group resource (RFC 7643 §4.2)
// ---------------------------------------------------------------------------

export interface ScimGroupMember {
  /** User id */
  value: string;
  /** URL reference to the User resource */
  $ref?: string;
  /** Display name of the member */
  display?: string;
  type?: 'User' | 'Group';
}

export interface ScimGroup {
  schemas: string[];
  id: string;
  externalId?: string;
  displayName: string;
  members?: ScimGroupMember[];
  meta?: ScimMeta;
}

// ---------------------------------------------------------------------------
// SCIM List response
// ---------------------------------------------------------------------------

export interface ScimListResponse<T> {
  schemas: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

// ---------------------------------------------------------------------------
// SCIM Error response
// ---------------------------------------------------------------------------

export interface ScimErrorBody {
  schemas: string[];
  status: number;
  scimType?: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// SCIM Patch operation (RFC 7644 §3.5.2)
// ---------------------------------------------------------------------------

export type PatchOpVerb = 'add' | 'remove' | 'replace';

export interface PatchOperation {
  op: PatchOpVerb;
  path?: string;
  value?: unknown;
}

export interface ScimPatchOp {
  schemas: string[];
  Operations: PatchOperation[];
}

// ---------------------------------------------------------------------------
// Backend contracts
// ---------------------------------------------------------------------------

type ParsedFilter = import('./filter-parser').ParsedFilter;

export interface ListUsersOptions {
  filter?: ParsedFilter;
  startIndex: number;
  count: number;
}

export interface ListUsersResult {
  users: ScimUser[];
  totalResults: number;
}

export interface ListGroupsOptions {
  filter?: ParsedFilter;
  startIndex: number;
  count: number;
}

export interface ListGroupsResult {
  groups: ScimGroup[];
  totalResults: number;
}

/**
 * Every downstream user backend must implement this interface.
 * Methods throw {@link ScimBackendError} to signal protocol-level errors.
 */
export interface ScimBackend {
  listUsers(opts: ListUsersOptions): Promise<ListUsersResult>;
  getUser(id: string): Promise<ScimUser>;
  createUser(user: ScimUser): Promise<ScimUser>;
  replaceUser(id: string, user: ScimUser): Promise<ScimUser>;
  patchUser(id: string, patch: ScimPatchOp): Promise<ScimUser>;
  deleteUser(id: string): Promise<void>;
}

/**
 * Every downstream group backend must implement this interface.
 * Methods throw {@link ScimBackendError} to signal protocol-level errors.
 */
export interface ScimGroupBackend {
  listGroups(opts: ListGroupsOptions): Promise<ListGroupsResult>;
  getGroup(id: string): Promise<ScimGroup>;
  createGroup(group: ScimGroup): Promise<ScimGroup>;
  replaceGroup(id: string, group: ScimGroup): Promise<ScimGroup>;
  patchGroup(id: string, patch: ScimPatchOp): Promise<ScimGroup>;
  deleteGroup(id: string): Promise<void>;
}
