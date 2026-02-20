// SCIM types and constants
export {
  SCIM_SCHEMA_USER,
  SCIM_SCHEMA_LIST,
  SCIM_SCHEMA_ERROR,
  SCIM_SCHEMA_PATCH_OP,
  type ScimUser,
  type ScimName,
  type ScimEmail,
  type ScimMeta,
  type ScimListResponse,
  type ScimErrorBody,
  type PatchOpVerb,
  type PatchOperation,
  type ScimPatchOp,
  type ScimBackend,
  type ListUsersOptions,
  type ListUsersResult,
} from './types';

// Error class
export { ScimBackendError } from './errors';

// Filter parser
export { type ParsedFilter, type FilterOperator, parseScimFilter } from './filter-parser';

// Patch applier
export { applyPatchOps, type ApplyPatchResult } from './patch-applier';

// Formatter
export { withScimMeta, formatListResponse, formatError } from './formatter';

// Auth plugin factory
export { createAuthPlugin } from './plugins/auth';

// Route factory
export {
  createScimUsersPlugin,
  type ScimUsersPluginOptions,
} from './routes/users';
