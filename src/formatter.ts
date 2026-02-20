import {
  ScimUser,
  ScimListResponse,
  ScimErrorBody,
  SCIM_SCHEMA_LIST,
  SCIM_SCHEMA_ERROR,
} from './types';

/**
 * Adds or updates `meta.location` on a SCIM User resource.
 * Call this in route handlers after receiving a user from the backend.
 *
 * @param user       The ScimUser returned by the backend.
 * @param usersBaseUrl  The fully-qualified base URL of the /Users collection,
 *                      e.g. `https://example.com/scim/v2/Users`.
 */
export function withScimMeta(user: ScimUser, usersBaseUrl: string): ScimUser {
  return {
    ...user,
    meta: {
      resourceType: 'User',
      ...user.meta,
      location: `${usersBaseUrl}/${user.id}`,
    },
  };
}

export function formatListResponse(
  users: ScimUser[],
  totalResults: number,
  startIndex: number,
): ScimListResponse<ScimUser> {
  return {
    schemas: [SCIM_SCHEMA_LIST],
    totalResults,
    startIndex,
    itemsPerPage: users.length,
    Resources: users,
  };
}

export function formatError(
  status: number,
  detail: string,
  scimType?: string,
): ScimErrorBody {
  return {
    schemas: [SCIM_SCHEMA_ERROR],
    status,
    ...(scimType ? { scimType } : {}),
    detail,
  };
}
