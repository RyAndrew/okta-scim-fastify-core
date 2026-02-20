/**
 * Throw this from a {@link ScimBackend} implementation to signal a
 * protocol-level error.  The SCIM route factory catches it and returns a
 * well-formed SCIM Error response.
 */
export class ScimBackendError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
    public readonly scimType?: string,
  ) {
    super(detail);
    this.name = 'ScimBackendError';
  }
}
