// ---------------------------------------------------------------------------
// Secret redaction for everything that is written to the audit store.
// ---------------------------------------------------------------------------

export const REDACTED = '***REDACTED***';

const SENSITIVE_KEYS = new Set([
  'password',
  'userpassword',
  'unicodepwd',
  'accountpassword',
  'newpassword',
  'oldpassword',
  'bindpassword',
  'apikey',
  'authorization',
  'secret',
  'token',
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''));
}

/**
 * Deep copy of `value` with secrets replaced by {@link REDACTED}:
 * - any member whose key is a known secret name, at any depth;
 * - the `value` of a SCIM PATCH operation whose `path` targets a password.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== 'object' || value === null) return value;
  if (Buffer.isBuffer(value)) return `<${value.length} bytes>`;

  const source = value as Record<string, unknown>;
  const targetsPassword =
    typeof source.path === 'string' && isSensitiveKey(source.path.split(/[.:]/).pop() ?? '');

  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(source)) {
    if (isSensitiveKey(key) || (targetsPassword && key === 'value')) {
      out[key] = REDACTED;
    } else {
      out[key] = redact(member);
    }
  }
  return out;
}
