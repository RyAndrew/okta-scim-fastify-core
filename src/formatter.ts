import {
  ScimUser,
  ScimGroup,
  ScimListResponse,
  ScimErrorBody,
  SCIM_SCHEMA_LIST,
  SCIM_SCHEMA_ERROR,
} from './types';

/**
 * Adds or updates `meta.location` on a SCIM User resource.
 * @param usersBaseUrl  e.g. `https://example.com/scim/v2/Users`
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

/**
 * Adds or updates `meta.location` on a SCIM Group resource.
 * @param groupsBaseUrl  e.g. `https://example.com/scim/v2/Groups`
 */
export function withGroupMeta(group: ScimGroup, groupsBaseUrl: string): ScimGroup {
  return {
    ...group,
    meta: {
      resourceType: 'Group',
      ...group.meta,
      location: `${groupsBaseUrl}/${group.id}`,
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
