/**
 * The one error type that becomes a SCIM error response. Core throws it for
 * protocol violations; a backend throws it for anything the SCIM client should
 * see (not found, duplicate, value the directory refuses). Any other thrown
 * error is reported to the client as a 500 and logged.
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

/** Factories for the SCIM errors used throughout core and the backends. */
export const ScimErrors = {
  notFound: (id: string) => new ScimBackendError(404, `User ${id} not found.`),
  uniqueness: (detail: string) => new ScimBackendError(409, detail, 'uniqueness'),
  invalidFilter: (detail: string) => new ScimBackendError(400, detail, 'invalidFilter'),
  invalidValue: (detail: string) => new ScimBackendError(400, detail, 'invalidValue'),
  invalidSyntax: (detail: string) => new ScimBackendError(400, detail, 'invalidSyntax'),
  invalidPath: (detail: string) => new ScimBackendError(400, detail, 'invalidPath'),
  noTarget: (detail: string) => new ScimBackendError(400, detail, 'noTarget'),
  mutability: (detail: string) => new ScimBackendError(400, detail, 'mutability'),
  forbidden: (detail: string) => new ScimBackendError(403, detail),
  /** A failure in the directory itself that the client cannot correct. */
  backend: (detail: string) => new ScimBackendError(500, detail),
};
