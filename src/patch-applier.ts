// ---------------------------------------------------------------------------
// SCIM PATCH application (RFC 7644 §3.5.2)
//
// Supported path forms:
//   attr                         active, displayName, emails
//   attr.sub                     name.givenName
//   attr[sub eq "x"]             emails[type eq "work"]
//   attr[sub eq "x"].sub2        emails[type eq "work"].value
//   <schema urn>:attr[.sub]      urn:…:enterprise:2.0:User:department
//   (no path)                    value is an object of path → value
//
// Anything else is a 400. Nothing is guessed.
// ---------------------------------------------------------------------------

import { ScimErrors } from './errors';
import { PatchOperation, SCIM_SCHEMA_ENTERPRISE_USER, SCIM_SCHEMA_USER } from './types';

type Resource = Record<string, unknown>;
type Verb = 'add' | 'remove' | 'replace';

interface ParsedPath {
  /** Top-level key in the resource. */
  attribute: string;
  /** `sub eq "value"` selector for a multi-valued attribute. */
  selector?: { sub: string; value: string | boolean };
  sub?: string;
}

/** Apply the operations to a deep copy of `resource` and return the copy. */
export function applyPatchOps<T extends object>(resource: T, operations: PatchOperation[]): T {
  const target = structuredClone(resource) as Resource;

  operations.forEach((operation, index) => {
    if (typeof operation !== 'object' || operation === null) {
      throw ScimErrors.invalidSyntax(`Operations[${index}] must be an object.`);
    }
    const verb = parseVerb(operation.op, index);

    if (operation.path === undefined || operation.path === null) {
      if (verb === 'remove') {
        throw ScimErrors.noTarget(`Operations[${index}]: 'remove' requires a path.`);
      }
      if (!isPlainObject(operation.value)) {
        throw ScimErrors.invalidValue(
          `Operations[${index}]: '${verb}' without a path requires an object value.`,
        );
      }
      for (const [key, value] of Object.entries(operation.value)) {
        applyAtPath(target, parsePath(key, index), verb, value, index);
      }
      return;
    }

    if (typeof operation.path !== 'string') {
      throw ScimErrors.invalidPath(`Operations[${index}]: path must be a string.`);
    }
    applyAtPath(target, parsePath(operation.path, index), verb, operation.value, index);
  });

  return target as T;
}

// ---------------------------------------------------------------------------

function parseVerb(op: unknown, index: number): Verb {
  const verb = typeof op === 'string' ? op.toLowerCase() : '';
  if (verb !== 'add' && verb !== 'remove' && verb !== 'replace') {
    throw ScimErrors.invalidSyntax(
      `Operations[${index}]: op must be 'add', 'remove' or 'replace'.`,
    );
  }
  return verb;
}

const PATH_RE = /^([A-Za-z$][\w$-]*)(?:\[\s*(\w+)\s+eq\s+("(?:[^"\\]|\\.)*"|true|false)\s*\])?(?:\.(\w+))?$/;

function parsePath(path: string, index: number): ParsedPath {
  let rest = path.trim();
  let attribute: string | undefined;

  // A path may be qualified with a schema URN: "<urn>:<attr>".
  const lower = rest.toLowerCase();
  if (lower.startsWith(`${SCIM_SCHEMA_USER.toLowerCase()}:`)) {
    rest = rest.slice(SCIM_SCHEMA_USER.length + 1);
  } else if (lower === SCIM_SCHEMA_ENTERPRISE_USER.toLowerCase()) {
    return { attribute: SCIM_SCHEMA_ENTERPRISE_USER };
  } else if (lower.startsWith(`${SCIM_SCHEMA_ENTERPRISE_USER.toLowerCase()}:`)) {
    // The extension is one complex attribute; what follows is its sub-attribute.
    attribute = SCIM_SCHEMA_ENTERPRISE_USER;
    rest = rest.slice(SCIM_SCHEMA_ENTERPRISE_USER.length + 1);
    if (!/^\w+$/.test(rest)) {
      throw ScimErrors.invalidPath(`Operations[${index}]: unsupported path '${path}'.`);
    }
    return { attribute, sub: rest };
  }

  const match = PATH_RE.exec(rest);
  if (!match) {
    throw ScimErrors.invalidPath(`Operations[${index}]: unsupported path '${path}'.`);
  }
  const [, name, selectorSub, selectorRaw, sub] = match;

  const parsed: ParsedPath = { attribute: name };
  if (selectorSub !== undefined) {
    const value =
      selectorRaw === 'true'
        ? true
        : selectorRaw === 'false'
          ? false
          : selectorRaw.slice(1, -1).replace(/\\(["\\])/g, '$1');
    parsed.selector = { sub: selectorSub, value };
  }
  if (sub !== undefined) parsed.sub = sub;
  return parsed;
}

function applyAtPath(
  resource: Resource,
  path: ParsedPath,
  verb: Verb,
  value: unknown,
  index: number,
): void {
  const { attribute, selector, sub } = path;

  if (verb !== 'remove' && value === undefined) {
    throw ScimErrors.invalidValue(`Operations[${index}]: '${verb}' requires a value.`);
  }

  // ── attr[selector] / attr[selector].sub ───────────────────────────────────
  if (selector) {
    const current = resource[attribute];
    if (current !== undefined && !Array.isArray(current)) {
      throw ScimErrors.invalidPath(
        `Operations[${index}]: '${attribute}' is not a multi-valued attribute.`,
      );
    }
    const items = ((current as Resource[] | undefined) ?? []).map((item) => ({ ...item }));
    const matches = items.filter((item) => item[selector.sub] === selector.value);

    if (verb === 'remove') {
      if (sub) matches.forEach((item) => delete item[sub]);
      resource[attribute] = sub ? items : items.filter((item) => !matches.includes(item));
      return;
    }

    if (matches.length === 0) {
      if (verb === 'replace') {
        throw ScimErrors.noTarget(
          `Operations[${index}]: no '${attribute}' entry matches the path filter.`,
        );
      }
      // add: create the entry the selector describes
      const created: Resource = { [selector.sub]: selector.value };
      if (sub) created[sub] = value;
      else Object.assign(created, requireObject(value, index));
      resource[attribute] = [...items, created];
      return;
    }

    for (const item of matches) {
      if (sub) item[sub] = value;
      else Object.assign(item, requireObject(value, index));
    }
    resource[attribute] = items;
    return;
  }

  // ── attr.sub ──────────────────────────────────────────────────────────────
  if (sub) {
    const current = resource[attribute];
    if (current !== undefined && !isPlainObject(current)) {
      throw ScimErrors.invalidPath(
        `Operations[${index}]: '${attribute}' is not a complex attribute.`,
      );
    }
    const parent: Resource = { ...(current ?? {}) };
    if (verb === 'remove') delete parent[sub];
    else parent[sub] = value;
    resource[attribute] = parent;
    return;
  }

  // ── attr ──────────────────────────────────────────────────────────────────
  if (verb === 'remove') {
    delete resource[attribute];
    return;
  }

  const current = resource[attribute];
  if (verb === 'add' && Array.isArray(value) && Array.isArray(current)) {
    // RFC 7644 §3.5.2.1: adding to a multi-valued attribute appends
    resource[attribute] = [...current, ...value];
  } else if (isPlainObject(value) && isPlainObject(current)) {
    // RFC 7644 §3.5.2.1/§3.5.2.3: for a complex attribute the given
    // sub-attributes are set and the others are left as they are
    resource[attribute] = { ...current, ...value };
  } else {
    resource[attribute] = value;
  }
}

function isPlainObject(value: unknown): value is Resource {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, index: number): Resource {
  if (!isPlainObject(value)) {
    throw ScimErrors.invalidValue(`Operations[${index}]: value must be an object.`);
  }
  return value;
}
