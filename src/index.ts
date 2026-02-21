// SCIM types and constants
export {
  SCIM_SCHEMA_USER,
  SCIM_SCHEMA_GROUP,
  SCIM_SCHEMA_LIST,
  SCIM_SCHEMA_ERROR,
  SCIM_SCHEMA_PATCH_OP,
  type ScimUser,
  type ScimName,
  type ScimEmail,
  type ScimMeta,
  type ScimGroup,
  type ScimGroupMember,
  type ScimListResponse,
  type ScimErrorBody,
  type PatchOpVerb,
  type PatchOperation,
  type ScimPatchOp,
  type ScimBackend,
  type ScimGroupBackend,
  type ListUsersOptions,
  type ListUsersResult,
  type ListGroupsOptions,
  type ListGroupsResult,
} from './types';

// Error class
export { ScimBackendError } from './errors';

// Filter parser
export { type ParsedFilter, type FilterOperator, parseScimFilter } from './filter-parser';

// Patch applier
export { applyPatchOps, type ApplyPatchResult } from './patch-applier';

// Formatter
export { withScimMeta, withGroupMeta, formatListResponse, formatError } from './formatter';

// Auth plugin factory
export { createAuthPlugin } from './plugins/auth';

// Route factories
export {
  createScimUsersPlugin,
  type ScimUsersPluginOptions,
} from './routes/users';

export {
  createScimGroupsPlugin,
  type ScimGroupsPluginOptions,
} from './routes/groups';
