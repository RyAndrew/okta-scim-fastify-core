// ---------------------------------------------------------------------------
// SCIM response bodies
// ---------------------------------------------------------------------------

import {
  SCIM_SCHEMA_ENTERPRISE_USER,
  SCIM_SCHEMA_ERROR,
  SCIM_SCHEMA_LIST,
  SCIM_SCHEMA_USER,
  ScimErrorBody,
  ScimListResponse,
  ScimUser,
} from './types';
import { StoredUser } from './user-attributes';

export const SCIM_CONTENT_TYPE = 'application/scim+json';

/** Build the User resource returned to the client. */
export function toUserResource(user: StoredUser, usersUrl: string): ScimUser {
  const { id, created, lastModified, ...attributes } = user;
  const schemas = [SCIM_SCHEMA_USER];
  if (attributes[SCIM_SCHEMA_ENTERPRISE_USER] !== undefined) {
    schemas.push(SCIM_SCHEMA_ENTERPRISE_USER);
  }
  return {
    schemas,
    id,
    ...attributes,
    meta: {
      resourceType: 'User',
      created,
      lastModified,
      location: `${usersUrl}/${encodeURIComponent(id)}`,
    },
  };
}

export function formatListResponse<T>(
  resources: T[],
  totalResults: number,
  startIndex: number,
): ScimListResponse<T> {
  return {
    schemas: [SCIM_SCHEMA_LIST],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

export function formatError(status: number, detail: string, scimType?: string): ScimErrorBody {
  return {
    schemas: [SCIM_SCHEMA_ERROR],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
}
