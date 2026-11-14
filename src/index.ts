// Server
export { startScimServer, createScimServer, SCIM_BASE_PATH } from './server';
export type { CreateScimServerOptions } from './server';

// Backend contract
export type {
  ScimUserBackend,
  BackendModule,
  BackendContext,
  BackendAudit,
  BackendOperation,
  UserLookup,
  UserLookupKey,
  UserQuery,
  UserSort,
  UserPage,
  UserUpdate,
} from './backend';

// User profile
export {
  attributesOf,
  changedAttributes,
  primaryValue,
  parseUserAttributes,
  stripUnassigned,
  KNOWN_USER_ATTRIBUTE_PATHS,
} from './user-attributes';
export type {
  UserAttributes,
  StoredUser,
  UserAttributePath,
  UnsupportedAttributePolicy,
} from './user-attributes';

// Errors
export { ScimBackendError, ScimErrors } from './errors';

// Helpers for backends
export { paginate } from './paginate';
export { redact, REDACTED } from './redact';

// Configuration
export { Env, EnvError } from './env';
export { loadCoreConfig } from './config';
export type { CoreConfig } from './config';

// Audit
export type { AuditSink, RequestRecord, BackendOperationRecord } from './audit/sink';
export { SqliteAuditSink } from './audit/sqlite-sink';

// Protocol pieces (exported for tests and for backends that need them)
export { applyPatchOps } from './patch-applier';
export { parseScimFilter, resolveUserLookup } from './filter-parser';
export type { ParsedFilter } from './filter-parser';
export { formatError, formatListResponse, toUserResource, SCIM_CONTENT_TYPE } from './responses';

// SCIM wire types and constants
export {
  SCIM_SCHEMA_USER,
  SCIM_SCHEMA_ENTERPRISE_USER,
  SCIM_SCHEMA_GROUP,
  SCIM_SCHEMA_LIST,
  SCIM_SCHEMA_ERROR,
  SCIM_SCHEMA_PATCH_OP,
} from './types';
export type {
  ScimUser,
  ScimName,
  ScimEmail,
  ScimMultiValue,
  ScimAddress,
  ScimEnterpriseUser,
  ScimMeta,
  ScimGroup,
  ScimGroupMember,
  ScimListResponse,
  ScimErrorBody,
  PatchOperation,
  ScimPatchOp,
} from './types';
