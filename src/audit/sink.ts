// ---------------------------------------------------------------------------
// Audit storage interface. Core ships a SQLite implementation; anything that
// implements this interface can replace it.
// ---------------------------------------------------------------------------

export interface RequestRecord {
  requestId: string;
  method: string;
  url: string;
  ip: string;
  /** Redacted JSON text, or null when the request had no body. */
  requestBody: string | null;
  responseStatus: number;
  /** Redacted JSON text, or null when the response had no body. */
  responseBody: string | null;
  durationMs: number;
  /** Facts core recorded while handling the request (changed attributes, …). */
  notes: Record<string, unknown> | null;
  /** ISO 8601 */
  createdAt: string;
}

export interface BackendOperationRecord {
  /** The HTTP request that caused the operation; null for startup work. */
  requestId: string | null;
  /** Backend module name, e.g. `ldap`. */
  backend: string;
  operation: string;
  target: string | null;
  /** Already redacted. */
  params: unknown;
  success: boolean;
  error: string | null;
  durationMs: number;
  /** ISO 8601 */
  createdAt: string;
}

export interface AuditSink {
  /** Prepare storage. Throw to abort startup. */
  init(): Promise<void>;
  close(): Promise<void>;
  recordRequest(record: RequestRecord): Promise<void>;
  recordBackendOperation(record: BackendOperationRecord): Promise<void>;
}
