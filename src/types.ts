// ---------------------------------------------------------------------------
// SCIM 2.0 wire types (RFC 7643 / RFC 7644)
// ---------------------------------------------------------------------------

export const SCIM_SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_SCHEMA_ENTERPRISE_USER =
  'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
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

/** A multi-valued attribute entry such as an email or phone number. */
export interface ScimMultiValue {
  value: string;
  display?: string;
  type?: string;
  primary?: boolean;
}

export type ScimEmail = ScimMultiValue;

/** A postal address (RFC 7643 §4.1.2). Unlike other multi-valued entries it has no `value`. */
export interface ScimAddress {
  formatted?: string;
  streetAddress?: string;
  locality?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  type?: string;
  primary?: boolean;
}

export interface ScimEnterpriseUser {
  employeeNumber?: string;
  costCenter?: string;
  organization?: string;
  division?: string;
  department?: string;
}

export interface ScimMeta {
  resourceType: string;
  created?: string;
  lastModified?: string;
  location?: string;
  version?: string;
}

/** A User resource as it appears in a response. `password` is never present. */
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
  emails?: ScimEmail[];
  phoneNumbers?: ScimMultiValue[];
  addresses?: ScimAddress[];
  [SCIM_SCHEMA_ENTERPRISE_USER]?: ScimEnterpriseUser;
  meta: ScimMeta;
}

// ---------------------------------------------------------------------------
// Groups (RFC 7643 §4.2) — served when the backend provides `groups`
// ---------------------------------------------------------------------------

export interface ScimGroupMember {
  value: string;
  $ref?: string;
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
// Protocol messages
// ---------------------------------------------------------------------------

export interface ScimListResponse<T> {
  schemas: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

export interface ScimErrorBody {
  schemas: string[];
  /** HTTP status code as a string, per RFC 7644 §3.12. */
  status: string;
  scimType?: string;
  detail: string;
}

export interface PatchOperation {
  op: string;
  path?: string;
  value?: unknown;
}

export interface ScimPatchOp {
  schemas: string[];
  Operations: PatchOperation[];
}
