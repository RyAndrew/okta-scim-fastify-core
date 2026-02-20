// ---------------------------------------------------------------------------
// SCIM 2.0 PATCH operation applier (RFC 7644 §3.5.2)
//
// Handles the common patterns sent by Okta:
//   { op: "replace", path: "active", value: false }
//   { op: "replace", value: { active: false, displayName: "..." } }
//   { op: "add",     path: "emails[type eq \"work\"].value", value: "..." }
// ---------------------------------------------------------------------------

import { PatchOperation } from './types';

export interface ApplyPatchResult {
  /** The mutated resource — a new object, does not mutate the original. */
  updated: Record<string, unknown>;
  /** Only the top-level fields that were modified. */
  changedFields: Record<string, unknown>;
}

export function applyPatchOps(
  resource: Record<string, unknown>,
  operations: PatchOperation[],
): ApplyPatchResult {
  const updated: Record<string, unknown> = { ...resource };
  const changedFields: Record<string, unknown> = {};

  for (const op of operations) {
    applyOp(updated, changedFields, op);
  }

  return { updated, changedFields };
}

// ---------------------------------------------------------------------------

function applyOp(
  resource: Record<string, unknown>,
  changed: Record<string, unknown>,
  op: PatchOperation,
): void {
  const verb = op.op.toLowerCase() as 'add' | 'remove' | 'replace';

  if (!op.path) {
    // No path → value is an object of attribute:value pairs (bulk replace)
    if (verb === 'add' || verb === 'replace') {
      const values = op.value as Record<string, unknown>;
      for (const [key, val] of Object.entries(values)) {
        resource[key] = val;
        changed[key] = val;
      }
    }
    return;
  }

  const { topLevelKey } = applyPath(resource, op.path, verb, op.value);
  if (topLevelKey) {
    changed[topLevelKey] = resource[topLevelKey];
  }
}

// ---------------------------------------------------------------------------

interface PathResult {
  topLevelKey: string | null;
}

function applyPath(
  resource: Record<string, unknown>,
  path: string,
  verb: 'add' | 'remove' | 'replace',
  value: unknown,
): PathResult {
  // Simple attribute: "active", "displayName", "userName"
  if (!path.includes('.') && !path.includes('[')) {
    if (verb === 'remove') {
      delete resource[path];
    } else {
      resource[path] = value;
    }
    return { topLevelKey: path };
  }

  // Multi-valued attribute: "emails[type eq "work"].value"
  const mvMatch = /^(\w+)\[([^\]]+)\](?:\.(\w+))?$/.exec(path);
  if (mvMatch) {
    const [, attrName, filterExpr, subAttr] = mvMatch;
    const arr = (resource[attrName] as Record<string, unknown>[] | undefined) ?? [];

    if (verb === 'remove') {
      resource[attrName] = arr.filter((item) => !matchesFilter(item, filterExpr));
    } else {
      const target = arr.find((item) => matchesFilter(item, filterExpr));
      if (target && subAttr) {
        target[subAttr] = value;
        resource[attrName] = arr;
      } else if (!target) {
        const newItem = buildItemFromFilter(filterExpr);
        if (subAttr) newItem[subAttr] = value;
        else Object.assign(newItem, value as Record<string, unknown>);
        resource[attrName] = [...arr, newItem];
      } else {
        const idx = arr.indexOf(target);
        arr[idx] = { ...target, ...(value as Record<string, unknown>) };
        resource[attrName] = arr;
      }
    }
    return { topLevelKey: attrName };
  }

  // Dotted path: "name.givenName"
  const parts = path.split('.');
  if (parts.length === 2) {
    const [parent, child] = parts;
    const parentObj = ((resource[parent] as Record<string, unknown>) ?? {});
    if (verb === 'remove') {
      delete parentObj[child];
    } else {
      parentObj[child] = value;
    }
    resource[parent] = parentObj;
    return { topLevelKey: parent };
  }

  // Fallback: treat as simple key
  if (verb === 'remove') {
    delete resource[path];
  } else {
    resource[path] = value;
  }
  return { topLevelKey: path };
}

// ---------------------------------------------------------------------------

function matchesFilter(item: Record<string, unknown>, filterExpr: string): boolean {
  const m = /^(\w+)\s+eq\s+"?([^"]*)"?$/.exec(filterExpr.trim());
  if (!m) return false;
  const [, attr, val] = m;
  const itemVal = item[attr];
  if (val === 'true') return itemVal === true;
  if (val === 'false') return itemVal === false;
  return String(itemVal) === val;
}

function buildItemFromFilter(filterExpr: string): Record<string, unknown> {
  const m = /^(\w+)\s+eq\s+"?([^"]*)"?$/.exec(filterExpr.trim());
  if (!m) return {};
  const [, attr, val] = m;
  return { [attr]: val };
}
